// The fee payer and the app's own Solana → Arc burn (src/lib/solanaCctp.ts):
// the burn the app builds is accepted; burns MeshPort must not pay for are not.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import {
  createKeyPairFromBytes, getAddressFromPublicKey, getTransactionDecoder, getTransactionEncoder, partiallySignTransaction, type Address,
} from '@solana/kit'
import { checkFeePayerTransaction } from './feePayer'
import { buildSolanaBurnToArc, burnData, evmToBytes32, FORWARD_HOOK } from '../../src/lib/solanaCctp'

function secret64(): Uint8Array {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return new Uint8Array(Buffer.concat([
    privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32),
    publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
  ]))
}
const ARC_ME = '0x05d0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa26e0'
const blockhashRpc = (async () => new Response(JSON.stringify({ result: { value: { blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k', lastValidBlockHeight: 10 } } }))) as unknown as typeof fetch

let payer: Address, user: Address, userKeys: CryptoKeyPair
beforeAll(async () => {
  payer = await getAddressFromPublicKey((await createKeyPairFromBytes(secret64())).publicKey)
  userKeys = await createKeyPairFromBytes(secret64())
  user = await getAddressFromPublicKey(userKeys.publicKey)
})

async function userSigned(wire: Uint8Array): Promise<Uint8Array> {
  const tx = getTransactionDecoder().decode(wire)
  return new Uint8Array(getTransactionEncoder().encode(await partiallySignTransaction([userKeys], tx)))
}

describe('Solana → Arc burn and the fee payer', () => {
  it('the burn the app builds is accepted: MeshPort only as fee and event-rent payer', async () => {
    const wire = await buildSolanaBurnToArc({ owner: user, arcRecipient: ARC_ME, amount: 5_000_000n, maxFee: 160_000n, feePayer: payer, fetchImpl: blockhashRpc })
    const checked = checkFeePayerTransaction(await userSigned(wire), payer)
    expect(checked.burnUnits).toBe(5_000_000n)
    // fee payer, user and the event account sign
    expect(Object.keys(checked.transaction.signatures)).toHaveLength(3)
  })

  it('refused before the user signs', async () => {
    const wire = await buildSolanaBurnToArc({ owner: user, arcRecipient: ARC_ME, amount: 5_000_000n, maxFee: 160_000n, feePayer: payer, fetchImpl: blockhashRpc })
    expect(() => checkFeePayerTransaction(wire, payer)).toThrow(/not signed/)
  })

  it('burn data layout: amount, Arc domain, recipient, empty caller, fee, finality, hook', () => {
    const d = burnData({ amount: 1n, destinationDomain: 26, mintRecipient: evmToBytes32(ARC_ME), maxFee: 2n, minFinality: 1000, hook: FORWARD_HOOK })
    expect(d.length).toBe(8 + 8 + 4 + 32 + 32 + 8 + 4 + 4 + 32)
    expect(d[16]).toBe(26)
    expect(Buffer.from(d.slice(20 + 12, 20 + 32)).toString('hex')).toBe(ARC_ME.slice(2))
    expect(d.slice(52, 84).every(b => b === 0)).toBe(true)
    expect(Buffer.from(d.slice(-32, -20)).toString()).toBe('cctp-forward')
  })

  it('refuses a burn to another chain, or without the forwarding hook', async () => {
    const wire = await buildSolanaBurnToArc({ owner: user, arcRecipient: ARC_ME, amount: 5_000_000n, maxFee: 160_000n, feePayer: payer, fetchImpl: blockhashRpc })
    const tx = getTransactionDecoder().decode(await userSigned(wire))
    const swap = (from: Uint8Array, to: Uint8Array) => {
      const m = new Uint8Array(tx.messageBytes); const at = Buffer.from(m).indexOf(Buffer.from(from))
      m.set(to, at); return new Uint8Array(getTransactionEncoder().encode({ ...tx, messageBytes: m as any }))
    }
    // destination domain 26 → 0 (Ethereum): the bytes right after the amount
    const amountAndDomain = new Uint8Array([0x40, 0x4b, 0x4c, 0, 0, 0, 0, 0, 26, 0, 0, 0])
    expect(() => checkFeePayerTransaction(swap(amountAndDomain, new Uint8Array([0x40, 0x4b, 0x4c, 0, 0, 0, 0, 0, 0, 0, 0, 0])), payer)).toThrow(/only to Arc/)
    expect(() => checkFeePayerTransaction(swap(new TextEncoder().encode('cctp-forward'), new TextEncoder().encode('xxxx-forward')), payer)).toThrow(/Forwarding Service/)
  })
})
