// src/lib/solana.ts
//
// Solana devnet for MeshPort (docs/SOLANA.md): the USDC mint, address checks
// and USDC balances, read straight from Solana's JSON-RPC (no SDK needed).
// Addresses verified against Circle's docs:
// https://developers.circle.com/stablecoins/usdc-contract-addresses

export const SOLANA_CLUSTER = 'devnet' as const
export const SOLANA_RPC = 'https://api.devnet.solana.com'
/** USDC on Solana devnet (Circle). */
export const SOLANA_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
export const SOLANA_EXPLORER = 'https://explorer.solana.com'
/** Solana's chain id across MeshPort (the same name Circle's App Kit uses). */
export const SOLANA_CHAIN = 'Solana_Devnet'
export const isSolanaChain = (chainId: string | null | undefined) => chainId === SOLANA_CHAIN

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Bytes a base58 string decodes to (leading '1's are zero bytes). */
export function base58Length(s: string): number {
  const bytes: number[] = []
  for (const ch of s) {
    let carry = ALPHABET.indexOf(ch)
    if (carry < 0) return -1
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8 }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8 }
  }
  let zeros = 0
  while (zeros < s.length && s[zeros] === '1') zeros++
  return zeros + bytes.length
}

/**
 * A Solana address: base58 that decodes to exactly 32 bytes. Addresses are
 * case-sensitive - the same letters in another case are a different (usually
 * invalid) key, so a lowercased address fails here.
 */
export function isSolanaAddress(s: string): boolean {
  const v = s.trim()
  return BASE58.test(v) && base58Length(v) === 32
}

export function solanaExplorerUrl(kind: 'address' | 'tx', id: string): string {
  return `${SOLANA_EXPLORER}/${kind}/${id}?cluster=${SOLANA_CLUSTER}`
}

async function rpc<T>(method: string, params: unknown[], fetchImpl: typeof fetch = fetch): Promise<T> {
  const r = await fetchImpl(SOLANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!r.ok) throw new Error(`Solana RPC ${method} failed (${r.status})`)
  const j = await r.json() as { result?: T; error?: { message?: string } }
  if (j.error) throw new Error(j.error.message || `Solana RPC ${method} failed`)
  return j.result as T
}

type TokenAccounts = { value: Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string; decimals: number } } } } } }> }

/** USDC held by `owner` on Solana devnet, as a decimal string (6 decimals). */
export async function getSolanaUsdcBalance(owner: string, fetchImpl?: typeof fetch): Promise<string> {
  if (!isSolanaAddress(owner)) throw new Error('Not a Solana address')
  const res = await rpc<TokenAccounts>('getTokenAccountsByOwner',
    [owner, { mint: SOLANA_USDC_MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }], fetchImpl)
  // Usually one (the associated token account); sum in base units to stay exact.
  let units = 0n
  for (const a of res.value) units += BigInt(a.account.data.parsed.info.tokenAmount.amount)
  const whole = units / 1_000_000n
  const frac = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}
