// wallet/solana.ts for a created / imported wallet: the frame's derived
// Solana key signs the app's real Solana → Arc burn, and the signature lands
// in the sender's slot (verifiable), the fee payer's left for MeshPort.
import { describe, it, expect, vi } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519'
import { getBase58Decoder, getTransactionDecoder } from '@solana/kit'
import { solanaPublicKey, solanaSign } from '@/lib/solanaKey'

const WALLET_KEY = '0x' + '42'.repeat(32)
const EVM = '0x05d0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa26e0'
const hex = (b: Uint8Array) => '0x' + Buffer.from(b).toString('hex')

vi.mock('./frameClient', () => ({
  callWallet: async (method: string, params: any) => {
    if (method === 'solana:key') return { publicKey: hex(solanaPublicKey(WALLET_KEY)) }
    if (method === 'solana:sign') return { signature: hex(solanaSign(WALLET_KEY, Buffer.from(params.message.slice(2), 'hex'))) }
    throw new Error('unexpected ' + method)
  },
}))
vi.mock('@/store', () => ({ useAuthStore: { getState: () => ({ walletSource: 'import-privkey', walletAddress: EVM }) } }))
vi.mock('./privy', () => ({ ensurePrivySolanaWallet: vi.fn(), privySignSolana: vi.fn(), privySolanaAddress: () => null }))

describe('Solana wallet of a created / imported account', () => {
  it('address is the frame-derived key', async () => {
    const { getSolanaAddress } = await import('./solana')
    expect(await getSolanaAddress()).toBe(getBase58Decoder().decode(solanaPublicKey(WALLET_KEY)))
  })

  it('signs the app’s burn: a valid signature in its own slot, the fee payer’s left empty', async () => {
    const { getSolanaAddress, signSolanaTransaction } = await import('./solana')
    const { buildSolanaBurnToArc } = await import('@/lib/solanaCctp')
    const me = await getSolanaAddress()
    const feePayer = '63yAuT3Do4GbQDCVxRX79G1zCXg7FDGn9JEhkU5LhrdA'
    const rpc = (async () => new Response(JSON.stringify({ result: { value: { blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k', lastValidBlockHeight: 10 } } }))) as unknown as typeof fetch
    const wire = await buildSolanaBurnToArc({ owner: me, arcRecipient: EVM, amount: 2_000_000n, maxFee: 170_000n, feePayer, fetchImpl: rpc })
    const tx = getTransactionDecoder().decode(await signSolanaTransaction(wire))
    const sig = tx.signatures[me as keyof typeof tx.signatures]!
    expect(ed25519.verify(sig, new Uint8Array(tx.messageBytes), solanaPublicKey(WALLET_KEY))).toBe(true)
    expect(tx.signatures[feePayer as keyof typeof tx.signatures]).toBeNull()
  })
})
