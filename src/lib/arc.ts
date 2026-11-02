import { http, fallback, custom, keccak256, type Hex } from 'viem'
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

/**
 * A viem transport over arcRpcJson: reads try Circle's Arc node directly
 * first, and a proxied read not answered in 2 s is asked of Circle's node too
 * (arcRpcJson). The plain arcTransport goes to the proxy only - a phone's
 * stalled connection to it held Pay's gas estimate 18 s (field 1 Nov 16:56)
 * and every receipt wait (waitForConfirmation) the same way.
 * A node's own error answer keeps its code, so viem maps it as usual.
 */
export function arcJsonTransport(opts: { timeout?: number; retryCount?: number } = {}) {
  return custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      try {
        const json = await arcRpcJson({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }, opts.timeout ?? 10_000)
        if (json?.error) throw json.error
        return json?.result
      } catch (e: any) {
        if (e instanceof Error) throw e
        // A JSON-RPC error object: an Error carrying its code and data.
        throw Object.assign(new Error(String(e?.message ?? 'Arc RPC error')), { code: e?.code, data: e?.data })
      }
    },
  }, { retryCount: opts.retryCount ?? 0 })
}

// Wallet readiness / startup timing: the first time Arc answered (one event,
// no import of the readiness store from this low-level module).
let rpcAnswered = false
// Startup diagnostics (perfTrace, loaded lazily - this module stays light):
// when the first request went out, and how the first direct read ended. The
// field trace showed the first answer at 5-10 s after a cold load while the
// proxy answered in ~0.2 s, so the open question is whether the request was
// sent late or the direct read was what waited.
let rpcSentNoted = false
function noteRpcSent() {
  if (rpcSentNoted) return
  rpcSentNoted = true
  const at = typeof performance !== 'undefined' ? performance.now() : undefined
  void import('./perfTrace').then(m => m.markStartup('rpcSent', at)).catch(() => {})
}
let directOutcomeNoted = false
function noteDirectOutcome(outcome: string, startedAt: number) {
  if (directOutcomeNoted) return
  directOutcomeNoted = true
  const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt)
  void import('./perfTrace').then(m => m.noteStartupDetail('direct', `${outcome}:${ms}ms`)).catch(() => {})
}
function noteRpcAnswered() {
  if (rpcAnswered) return
  rpcAnswered = true
  try { window.dispatchEvent(new Event('meshport:arc-rpc-ok')) } catch { /* no window (tests, server) */ }
}

// ─── Direct read lane ────────────────────────────────────────────────────────
// Every Arc call used to go browser → /api/arc-rpc (a Vercel function) → Arc,
// which added roughly 350 ms to each one (about 410 ms through the proxy
// against 60-70 ms straight to Circle's own Arc endpoint). A transfer makes
// several reads in a row and every balance poll makes one, so that is seconds
// per move. Circle's primary Arc Testnet endpoint is public, keyless and sends
// CORS headers for this app, so plain READS try it first and fall back to the
// proxy on anything unusual (CORS refused on a preview origin, a 429, a node
// error): the proxy stays the one path for sends, relays and everything with
// a credential. A direct failure parks the lane briefly instead of costing
// every call a failed attempt.
const DIRECT_READ_URL = ARC.rpcUrl
const DIRECT_READ_METHODS: ReadonlySet<string> = new Set([
  'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas',
  'eth_getBalance', 'eth_blockNumber', 'eth_getTransactionReceipt',
  // The latest block (fee data before a send - Circle's kit reads it on every
  // deposit/approve): a plain read, it went through the proxy (+~350 ms).
  'eth_getBlockByNumber',
  // Not eth_getTransactionCount: a nonce is read right after a send, and the
  // proxy is the path that knows about that send.
])
const DIRECT_PARK_MS = 60_000
const DIRECT_BLOCKED_PARK_MS = 10 * 60_000 // network / CORS: this origin can't use it
let directParkedUntil = 0

/** True for a single JSON-RPC read the direct lane may serve. Pure. */
export function isDirectReadable(body: unknown): body is { method: string } {
  return !!body && typeof body === 'object' && !Array.isArray(body)
    && typeof (body as { method?: unknown }).method === 'string'
    && DIRECT_READ_METHODS.has((body as { method: string }).method)
}

async function directRead(body: unknown, timeoutMs: number): Promise<any | null> {
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
  if (directParkedUntil > Date.now()) { noteDirectOutcome('parked', startedAt); return null }
  try {
    const res = await fetch(DIRECT_READ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.min(timeoutMs, 4000)),
    })
    if (!res.ok) { noteDirectOutcome(`http${res.status}`, startedAt); if (res.status === 429 || res.status >= 500) directParkedUntil = Date.now() + DIRECT_PARK_MS; return null }
    const json = await res.json()
    if (json?.error) { noteDirectOutcome('node-error', startedAt); return null } // the proxy gives the authoritative answer (reverts, head lag)
    noteDirectOutcome('ok', startedAt)
    noteRpcAnswered()
    return json
  } catch (e) {
    noteDirectOutcome(e instanceof TypeError ? 'blocked' : (e as Error)?.name === 'TimeoutError' ? 'timeout' : 'error', startedAt)
    // fetch rejects with a TypeError for network failures and CORS refusals; a timeout only parks briefly.
    directParkedUntil = Date.now() + (e instanceof TypeError ? DIRECT_BLOCKED_PARK_MS : DIRECT_PARK_MS)
    return null
  }
}

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
// A phone on a weak connection loses a request now and then (field 1 Nov
// 03:57: a Transfer's nonce read never reached /api/arc-rpc - no request in
// Vercel's log, the proxy answering others in ~90 ms - and the Transfer failed
// at 10 s with the browser's "signal timed out"). Reads are safe to ask again,
// so one that times out or drops is retried once on a fresh request (the first
// try gets a shorter wait). Sends are never repeated here: they have their own
// handling (arcService.relaySendTimed).
const NOT_REPEATABLE: ReadonlySet<string> = new Set(['eth_sendRawTransaction', 'meshport_sendRawTransactionAndWait', 'eth_sendTransaction'])
/** True for a single JSON-RPC call that only reads, so it can be asked again. Pure. */
export function isRepeatableRead(body: unknown): boolean {
  return !!body && typeof body === 'object' && !Array.isArray(body)
    && typeof (body as { method?: unknown }).method === 'string'
    && !NOT_REPEATABLE.has((body as { method: string }).method)
}
/** No answer at all (timeout, dropped connection, gateway trouble) - not a node's JSON-RPC answer. */
const isLostRequest = (e: unknown) => e instanceof Error
  && (e.name === 'TimeoutError' || e.name === 'AbortError' || e instanceof TypeError || /^Arc RPC (5\d\d|429) /.test(e.message))

export async function arcRpcJson(body: unknown, timeoutMs = 10000): Promise<any> {
  noteRpcSent()
  if (isDirectReadable(body)) {
    const fast = await directRead(body, timeoutMs)
    if (fast) return fast
  }
  if (!isRepeatableRead(body)) return rpcPass(body, timeoutMs)
  // Not answered within HEDGE_MS: also ask Circle's Arc node directly - another
  // host, so another connection. A phone's connection to this origin can stall
  // for 15-40 s while every other host answers (field 1 Nov 13:45, 14:30: no
  // request reached the proxy for 37 s / 17 s, then all arrived at once) - a
  // retry here only queued on the same dead connection. First answer wins.
  const proxied = proxiedRead(body, timeoutMs)
  const hedge = new Promise<any>(resolve => {
    const t = setTimeout(() => { void lastResortRead(body, timeoutMs).then(d => { if (d && !d.error) resolve(d) }) }, HEDGE_MS)
    void proxied.then(() => clearTimeout(t), () => clearTimeout(t))
  })
  return Promise.race([proxied, hedge])
}

/** How long a proxied read / send waits before Circle's Arc node is asked too. */
export const HEDGE_MS = 2000

async function proxiedRead(body: unknown, timeoutMs: number): Promise<any> {
  try {
    return await rpcPass(body, Math.max(4000, Math.round(timeoutMs * 0.6)))
  } catch (e) {
    if (!isLostRequest(e)) throw e
    try {
      return await rpcPass(body, timeoutMs)
    } catch (e2) {
      // The proxy can't be reached at all (a phone's dead connection to this
      // origin, field 1 Nov 05:43): a read is asked of Circle's Arc node
      // directly - another host, another connection. The proxy broadcasts
      // every send to that node too, so even a pending nonce agrees.
      if (!isLostRequest(e2)) throw e2
      const direct = await lastResortRead(body, timeoutMs)
      if (!direct) throw e2
      if (direct.error) throw direct.error // that node's answer (a revert, etc.)
      return direct
    }
  }
}

/**
 * A signed Arc transaction sent straight to Circle's Arc node (not through the
 * proxy) - the escape route when the phone's connection to this origin has
 * stalled. True when that node took it (or already had it); null when it
 * didn't say (unreachable, or an error - the proxy's answer decides then).
 * Identical signed bytes: sending them twice is harmless.
 */
export async function directSendRaw(raw: string, timeoutMs = 6000): Promise<true | null> {
  try {
    const res = await fetch(DIRECT_READ_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const json = await res.json()
    if (typeof json?.result === 'string') return true
    if (/already known|known transaction|already imported/i.test(String(json?.error?.message ?? ''))) return true
    return null
  } catch { return null }
}

/** Is this signed transaction already on Arc? Its receipt, read from Circle's Arc node directly. */
async function directlyMined(raw: string, timeoutMs = 4000): Promise<boolean> {
  try {
    const res = await fetch(DIRECT_READ_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [keccak256(raw as Hex)] }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return false
    const json = await res.json()
    return !!json?.result?.blockNumber
  } catch { return false }
}

/**
 * The escape route for a relayed send whose answer hasn't come back (a
 * phone's stalled connection to this origin): from `afterMs`, the same
 * signed bytes go to Circle's Arc node, and its receipt is looked for there
 * about once a second. Resolves true once that node has the transaction or it
 * is on chain; never resolves while neither is true (or once `settled()`).
 * Field 1 Nov 16:13: the relay put the approve on chain in 1.8 s, its answer
 * never reached the phone, the direct send was refused "nonce too low" (it
 * was already mined) - and the app waited out the relay's 20 s timeout.
 */
export function directSendHedge(raw: string, afterMs: number, settled: () => boolean): Promise<true> {
  return new Promise(resolve => {
    let tries = 0
    const step = async () => {
      if (settled() || tries++ > 30) return
      if (await directSendRaw(raw) || await directlyMined(raw)) { resolve(true); return }
      setTimeout(() => { void step() }, 1000)
    }
    setTimeout(() => { void step() }, afterMs)
  })
}

async function lastResortRead(body: unknown, timeoutMs: number): Promise<any | null> {
  try {
    const res = await fetch(DIRECT_READ_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(Math.min(timeoutMs, 6000)),
    })
    if (!res.ok) return null
    const json = await res.json()
    if (!json || typeof json !== 'object') return null
    noteRpcAnswered()
    return json
  } catch { return null }
}

async function rpcPass(body: unknown, timeoutMs: number): Promise<any> {
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
        noteRpcAnswered()
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
