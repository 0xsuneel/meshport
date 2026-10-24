import { http, fallback } from 'viem'
import { ARC, ARC_RPCS as REGISTRY_ARC_RPCS, ARC_NETWORK as REGISTRY_ARC_NETWORK, ARC_TOKENS } from '@/blockchain/chains'

// ─── Chain/RPC/token constants now live in the shared registry ──────────────
// src/blockchain/chains.ts is the single client-side source of truth (Phase 0
// of docs/BLOCKCHAIN_ARCHITECTURE_PROPOSAL.md). These re-exports keep every
// existing import of this module working unchanged - values are identical,
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
// Drop-in replacement for `http(ARC_TESTNET.rpcUrl, opts)` - same options,
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
// 429 handling: a single 429 doesn't immediately fail over - it's usually a
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
          break // exhausted in-place retries on this endpoint - fail over
        }
        // A non-2xx status (5xx, etc.) doesn't always come back as
        // JSON-RPC-shaped JSON with an `.error` field - some gateways just
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
// same PBKDF2-HMAC-SHA512 seed internally anyway - ethers' Mnemonic/
// HDNodeWallet below does that itself, correctly, per spec. Keeping a
// second, separate seed-derivation function around risked exactly the
// kind of silent mismatch this whole fix was for.

// Wallet keys are made, imported and derived only inside the wallet frame
// (wallet-frame/src/main.ts, src/wallet): m/44'/60'/0'/0/0 with a real BIP-39
// checksum, so a MeshPort phrase opens the same account in MetaMask, Rabby,
// Trust etc. and vice versa (wallet-frame/src/derivation.test.ts pins this).

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
