import { http, fallback } from 'viem'
import { ARC, ARC_RPCS as REGISTRY_ARC_RPCS, ARC_NETWORK as REGISTRY_ARC_NETWORK, ARC_TOKENS } from '@/blockchain/chains'

// ─── Chain/RPC/token constants now live in the shared registry ──────────────
// src/blockchain/chains.ts is the single client-side source of truth (Phase 0
// of docs/BLOCKCHAIN_ARCHITECTURE_PROPOSAL.md). These re-exports keep every
// existing import of this module working unchanged — values are identical,
// only their definition site moved. See that file for the full reasoning
// behind ARC_RPCS (one same-origin proxy, no VITE_ credential) and
// ARC_NETWORK (static network pinning to avoid ethers' eth_chainId retry
// loop); those explanations are not duplicated here.
export const ARC_TESTNET = {
  chainId:     ARC.chainId,
  name:        ARC.name,
  rpcUrl:      ARC.rpcUrl,
  explorerUrl: ARC.explorerUrl,
}
export const ARC_EXPLORER = ARC_TESTNET.explorerUrl
export const USDC_CONTRACT = ARC_TOKENS.USDC.contract
export const ARC_RPCS = REGISTRY_ARC_RPCS
export const ARC_NETWORK = REGISTRY_ARC_NETWORK

// ─── viem transport that fails over across ARC_RPCS ────────────────────────
// Drop-in replacement for `http(ARC_TESTNET.rpcUrl, opts)` — same options,
// but retries against the next endpoint instead of failing outright when
// one Arc RPC node is down or lagging.
export function arcTransport(opts?: Parameters<typeof http>[1]) {
  return fallback(ARC_RPCS.map(url => http(url, opts)))
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

// ─── Raw JSON-RPC POST with fallback across ARC_RPCS ───────────────────────
// Drop-in replacement for `fetch(ARC_TESTNET.rpcUrl, {...}).then(r => r.json())`
// for call sites that don't go through viem (eth_call / eth_getBalance reads).
//
// 429 handling: a single 429 doesn't immediately fail over — it's usually a
// short-lived burst limit on that one gateway, so we back off in place
// (300ms, then 600ms) and retry the SAME endpoint up to 2 more times before
// giving up on it and moving to the next one in ARC_RPCS. Any other error
// (5xx, timeout, network failure) fails over immediately as before, since
// backing off in place doesn't help a genuinely down endpoint.
export async function arcRpcJson(body: unknown, timeoutMs = 10000): Promise<any> {
  let lastErr: unknown = null
  for (const url of ARC_RPCS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (res.status === 429) {
          lastErr = new Error(`Arc RPC 429 from ${url}`)
          if (attempt < 2) { await sleep(300 * Math.pow(2, attempt)); continue } // 300ms, 600ms
          break // exhausted in-place retries on this endpoint — fail over
        }
        // A non-2xx status (5xx, etc.) doesn't always come back as
        // JSON-RPC-shaped JSON with an `.error` field — some gateways just
        // return a plain {"message": "..."} or non-JSON body. Checking
        // res.ok first means we still fail over to the next endpoint in
        // that case, instead of silently treating an error response as a
        // success.
        if (!res.ok) { lastErr = new Error(`Arc RPC ${res.status} from ${url}`); break }
        const json = await res.json()
        if (json?.error) { lastErr = json.error; break }
        return json
      } catch (e) {
        lastErr = e
        break // network/timeout errors fail over immediately, no in-place retry
      }
    }
  }
  throw lastErr ?? new Error('Arc RPC request failed on all endpoints')
}

// Note: raw PBKDF2 seed derivation used to live here as a separate step
// (mnemonicToSeed), but standard BIP32/BIP44 derivation needs the exact
// same PBKDF2-HMAC-SHA512 seed internally anyway — ethers' Mnemonic/
// HDNodeWallet below does that itself, correctly, per spec. Keeping a
// second, separate seed-derivation function around risked exactly the
// kind of silent mismatch this whole fix was for.

// ─── Derive real EVM wallet from a BIP39 mnemonic via standard BIP32/BIP44 ────
// (m/44'/60'/0'/0/0) — the same derivation path every mainstream wallet
// (MetaMask, Rabby, Trust, etc.) uses for the first account of a seed
// phrase. This REPLACES a previous implementation that took the first 32
// bytes of the raw PBKDF2 seed directly as the private key — that produced
// a technically-valid keypair, but a DIFFERENT address than any standard
// wallet would derive from the exact same 12-word phrase. That meant a
// MeshPort-generated mnemonic imported into MetaMask/Rabby (or vice versa)
// silently landed on a different account, with no error to signal it —
// only a mismatched address the user had to notice themselves. Using
// ethers' HDNodeWallet here (ethers is already a project dependency) makes
// every mnemonic this app generates or imports fully portable with every
// other standard wallet, both directions.
async function seedToWallet(mnemonic: string): Promise<{ privateKey: string; address: string }> {
  const { HDNodeWallet, Mnemonic } = await import('ethers')
  const mnemonicObj = Mnemonic.fromPhrase(mnemonic.trim().toLowerCase())
  const hdNode = HDNodeWallet.fromMnemonic(mnemonicObj, "m/44'/60'/0'/0/0")
  return { privateKey: hdNode.privateKey, address: hdNode.address }
}

// ─── Public: derive real EVM address from any private key ─────────────────────
// This is the canonical address for a given key — always matches what viem uses
export async function deriveAddressFromPrivateKey(privateKey: string): Promise<string> {
  const { privateKeyToAccount } = await import('viem/accounts')
  const key = (privateKey.startsWith('0x') ? privateKey : '0x' + privateKey) as `0x${string}`
  const account = privateKeyToAccount(key)
  return account.address
}

// ─── Public: generate new BIP39 wallet ────────────────────────────────────────
// Used to build the mnemonic itself via a hand-rolled entropy→words bit-slice
// against this repo's own BIP39_WORDLIST — which turned out to have only
// 1915 of the required 2048 words (a corrupted/incomplete copy of the
// standard list). That silently shifted which word each 11-bit chunk mapped
// to, so a "valid-looking" 12-word mnemonic (all words defined, non-empty —
// the only thing that custom wordlist could actually check) could still not
// match the REAL BIP39 checksum. seedToWallet() below re-validates via
// ethers' Mnemonic.fromPhrase() against ethers' own complete, correct
// wordlist, which then correctly threw "invalid mnemonic checksum" — as an
// uncaught rejection, since that call wasn't wrapped in try/catch. Now
// building the mnemonic via ethers' own Mnemonic.fromEntropy() directly:
// same entropy source, but checksummed against the one complete wordlist
// everything else in this file already trusts, instead of a second,
// independently-maintained copy that can drift out of sync.
export async function generateWallet(): Promise<{ address: string; privateKey: string; mnemonic: string }> {
  const { Mnemonic, HDNodeWallet } = await import('ethers')
  const entropy = crypto.getRandomValues(new Uint8Array(16))
  const mnemonicObj = Mnemonic.fromEntropy(entropy)
  const hdNode = HDNodeWallet.fromMnemonic(mnemonicObj, "m/44'/60'/0'/0/0")
  return { address: hdNode.address, privateKey: hdNode.privateKey, mnemonic: mnemonicObj.phrase }
}

// ─── Public: import from BIP39 mnemonic ───────────────────────────────────────
export async function importFromMnemonic(mnemonic: string): Promise<{ address: string; privateKey: string } | null> {
  const words = mnemonic.trim().split(/\s+/)
  if (![12, 15, 18, 21, 24].includes(words.length)) return null
  // ethers' Mnemonic.fromPhrase validates the real BIP39 checksum against
  // the full standard wordlist — a strictly correct check our own
  // wordlist file can't fully replicate — so an invalid/mistyped phrase
  // now fails here explicitly instead of silently deriving *some*
  // technically-valid-looking but wrong keypair.
  try {
    const result = await seedToWallet(words.join(' '))
    return result
  } catch { return null }
}

// ─── Public: import from private key (uses viem for real address) ─────────────
export async function importFromPrivateKey(pk: string): Promise<{ address: string; privateKey: string } | null> {
  try {
    const key = (pk.startsWith('0x') ? pk.trim() : '0x' + pk.trim()) as `0x${string}`
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) return null
    const { privateKeyToAccount } = await import('viem/accounts')
    const account = privateKeyToAccount(key)
    return { address: account.address, privateKey: key }
  } catch { return null }
}

// ─── Validate mnemonic ────────────────────────────────────────────────────────
export function validateMnemonic(mnemonic: string): { valid: boolean; invalidWords: string[]; wordCount: number } {
  const words = mnemonic.trim().toLowerCase().split(/\s+/).filter(Boolean)
  // Only flag words that are clearly not alphabetic (numbers, symbols, etc.)
  // We don't reject valid-looking words just because our wordlist is incomplete
  const invalidWords = words.filter(w => !/^[a-z]+$/.test(w))
  const validLengths = [12, 15, 18, 21, 24]
  return {
    valid: validLengths.includes(words.length) && invalidWords.length === 0,
    invalidWords,
    wordCount: words.length,
  }
}

// Re-export from arcService
export { getUSDCBalance, sendUSDC } from './arcService'
export async function estimateUSDCTransferGas(_p: { from?: string; to?: string; amount?: number }) {
  const { estimateTransferFee } = await import('./arcService')
  return { gasCostUSDC: await estimateTransferFee(_p.amount || 0) }
}
