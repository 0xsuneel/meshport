// src/wallet/solana.ts
//
// This account's Solana wallet, whatever kind of account it is
// (docs/SOLANA.md):
//   - Google / email (Privy): the Privy embedded Solana wallet
//   - created / imported wallets: the Solana key derived from the wallet key
//     inside the wallet frame (lib/solanaKey.ts, 'solana:key' / 'solana:sign')
// Either way the app gets an address and signatures, never a key.

import { getBase58Decoder, getTransactionDecoder, getTransactionEncoder, type Address, type SignatureBytes, type Transaction } from '@solana/kit'
import { useAuthStore } from '@/store'
import { callWallet } from './frameClient'
import { ensurePrivySolanaWallet, privySignSolana, privySolanaAddress } from './privy'

const hex = (b: Uint8Array) => '0x' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
function unhex(h: string): Uint8Array {
  const c = h.startsWith('0x') ? h.slice(2) : h
  const out = new Uint8Array(c.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16)
  return out
}

type Kind = 'privy' | 'frame' | null
function kind(): { kind: Kind; evm: string | null } {
  const s = useAuthStore.getState()
  if (s.walletSource === 'privy') return { kind: 'privy', evm: s.walletAddress }
  if (s.walletSource === 'circle' || !s.walletAddress) return { kind: null, evm: s.walletAddress }
  return { kind: 'frame', evm: s.walletAddress }
}

const frameAddresses = new Map<string, string>()

/** Already-known Solana address, without waiting (null when not known yet). */
export function knownSolanaAddress(): string | null {
  const { kind: k, evm } = kind()
  if (k === 'privy') return privySolanaAddress()
  if (k === 'frame' && evm) return frameAddresses.get(evm.toLowerCase()) ?? null
  return null
}

/** This account's Solana address (creates the Privy Solana wallet the first time). */
export async function getSolanaAddress(): Promise<string> {
  const { kind: k, evm } = kind()
  if (k === 'privy') return ensurePrivySolanaWallet()
  if (k === 'frame' && evm) {
    const cached = frameAddresses.get(evm.toLowerCase())
    if (cached) return cached
    const { publicKey } = await callWallet('solana:key', { address: evm })
    const addr = getBase58Decoder().decode(unhex(publicKey))
    frameAddresses.set(evm.toLowerCase(), addr)
    return addr
  }
  throw new Error('This account has no Solana wallet')
}

/**
 * Sign a Solana transaction (wire format) as this account's Solana wallet -
 * other signatures already on it (e.g. a CCTP event account) are kept. The
 * fee payer's slot stays empty for /api/solana-fee-payer.
 */
export async function signSolanaTransaction(wire: Uint8Array): Promise<Uint8Array> {
  const { kind: k, evm } = kind()
  const me = await getSolanaAddress()
  if (k === 'privy') return privySignSolana(wire, me)
  if (k === 'frame' && evm) {
    const tx = getTransactionDecoder().decode(wire) as Transaction
    if (!(me in tx.signatures)) throw new Error('This Solana wallet is not a signer of the transaction')
    const { signature } = await callWallet('solana:sign', { address: evm, message: hex(new Uint8Array(tx.messageBytes)) as `0x${string}` })
    const signed: Transaction = { ...tx, signatures: { ...tx.signatures, [me as Address]: unhex(signature) as SignatureBytes } }
    return new Uint8Array(getTransactionEncoder().encode(signed))
  }
  throw new Error('This account has no Solana wallet')
}

const published = new Set<string>()
/**
 * Store this account's Solana address on its users row (users.solana_address),
 * so its payment links and request QRs can offer Solana. Once per session;
 * a missing column (migration not applied yet) is ignored.
 */
export async function publishSolanaAddress(userId: string): Promise<void> {
  const address = await getSolanaAddress()
  const key = `${userId}:${address}`
  if (published.has(key)) return
  const { supabase } = await import('@/lib/supabase')
  const { data } = await supabase.from('users').select('solana_address').eq('id', userId).maybeSingle()
  if ((data as { solana_address?: string | null } | null)?.solana_address !== address) {
    const { error } = await supabase.from('users').update({ solana_address: address }).eq('id', userId)
    if (error) return
  }
  published.add(key)
}
