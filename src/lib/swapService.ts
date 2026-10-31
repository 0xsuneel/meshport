/**
 * swapService.ts - client-side Swap execution engine.
 *
 * SECURITY FIX (private-key exposure, transaction audit 2026-09-17):
 * kit.swap()/kit.estimateSwap() used to run server-side, in
 * api/swap-proxy.js - which meant the raw self-custodial private key was
 * POSTed over the network to a Vercel serverless function on every swap
 * (and even on a fire-and-forget page-mount warm-up call), just so that
 * function could build a signer from it. That broke the private-key-
 * never-leaves-the-device boundary every other feature already respects.
 * Multichain Claim/Transfer already run this exact AppKit +
 * Circle App Kit adapter pattern entirely in the browser (see
 * MultichainClaimPage.tsx's buildAdapter/loadSdk) - Swap moving here too
 * is not a new capability, just closing the one feature that hadn't been
 * migrated. The key never leaves this device now: signing happens
 * locally, exactly like Pay/ChatPay/Claim/Transfer already do.
 *
 * api/swap-proxy.js still exists, but ONLY for the post-swap bookkeeping
 * write (action='recordCompletion') that used to happen server-side as
 * part of the same request - that needs the SERVICE_ROLE key (which must
 * never reach the client), but only ever takes a txHash + amounts, never
 * a private key.
 */
import { ARC_NETWORK, arcRpcJson } from './arc'
import type { WalletAccount } from '@/wallet'
import { USDC_CONTRACT, EURC_CONTRACT, CIRBTC_CONTRACT } from './arcService'
import { ARC_EXPLORER } from './chainExplorers'
import { assertAccountUnlocked } from '@/lib/accountLockRule'

// Derive the Arc chain key from env so a mainnet build targets Arc mainnet.
// Hardcoding 'Arc_Testnet' here broke every swap on a mainnet deployment,
// because the AppKit adapter was presented with a chain ID that didn't match
// the live network, causing "chain mismatch" errors on every estimate/swap.
const ARC_CHAIN_KEY = (import.meta.env.VITE_NETWORK_ENV as string | undefined) === 'mainnet'
  ? 'Arc'
  : 'Arc_Testnet'

const TOKEN_CONTRACTS: Record<string, { address: string; decimals: number }> = {
  USDC:   { address: USDC_CONTRACT,   decimals: 6 },
  EURC:   { address: EURC_CONTRACT,   decimals: 6 },
  cirBTC: { address: CIRBTC_CONTRACT, decimals: 8 },
}
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

// ── Cached SDK modules/kit instance - avoids re-importing/re-constructing
// on every estimate/swap call within the same page session.
let _sdkModules: any = null
async function getSdkModules() {
  if (!_sdkModules) {
    const [
      { AppKit, isKitError, isRpcError, isNetworkError },
      , // adapter-ethers-v6: preloaded for createWalletAdapter (src/wallet)
      { JsonRpcProvider, Transaction },
    ] = await Promise.all([
      import('@circle-fin/app-kit'),
      import('@circle-fin/adapter-ethers-v6'),
      import('ethers'),
    ])
    _sdkModules = { AppKit, isKitError, isRpcError, isNetworkError, JsonRpcProvider, Transaction }
  }
  return _sdkModules
}

let _kit: any = null
function getKit(AppKit: any) {
  routeSwapServiceThroughServer()
  if (!_kit) _kit = new AppKit({ disableErrorReporting: true, disableAnalytics: true } as any)
  return _kit
}

// Circle's swap service (api.circle.com/v1/stablecoinKits/*) needs the kit
// key, but the SDK never sends a key from a browser (server-only secret), so
// every quote came back "Invalid or missing API key" - shown to users as "no
// liquidity". The SDK's calls to that service are sent through
// /api/swap-proxy instead, which adds the key server-side. Only public swap
// details travel (tokens, amount, wallet address); signing stays on-device.
const SWAP_SERVICE = 'https://api.circle.com/v1/stablecoinKits/'
let _routed = false
function routeSwapServiceThroughServer() {
  if (_routed || typeof window === 'undefined') return
  _routed = true
  const orig = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(SWAP_SERVICE)) return orig(input as any, init)
    const u = new URL(url)
    // Once our swap is confirmed on Arc it is done (a same-chain swap settles
    // in that one transaction). The SDK then polls the service's status
    // endpoint (which can hold up to 30s, with 1-2s sleeps between tries)
    // only to learn amountOut - which we read from the swap's own receipt
    // instead (amountOutFromReceipt). A 4xx makes the SDK return DONE at once.
    if (_swapConfirmed && u.pathname.endsWith('/swap/status')) {
      return new Response(JSON.stringify({ code: 400, message: 'Status read on-device' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    }
    const { authApiHeaders } = await import('./supabase')
    const method = init?.method || (input instanceof Request ? input.method : 'GET')
    return orig(`/api/swap-proxy?svc=${encodeURIComponent(u.pathname + u.search)}`, {
      method, headers: await authApiHeaders(), body: method === 'GET' ? undefined : init?.body, signal: init?.signal,
    })
  }
}

// ── Real swap progress ─────────────────────────────────────────────────────
// kit.swap() has no progress events, and depending on the token it approves
// via a permit signature (no transaction), a separate approve() transaction,
// or not at all. Every broadcast and receipt does pass through the provider
// below, though, so the checklist is driven from what actually hits the
// chain: a broadcast whose calldata starts with an allowance selector is the
// approval, any other broadcast is the swap, and a non-null receipt is that
// transaction's confirmation.
export type SwapProgress =
  | { kind: 'approve-sent'; hash: string }
  | { kind: 'swap-sent'; hash: string }
  | { kind: 'confirmed'; hash: string; success: boolean }

// Arc has no permit metadata in the SDK, so every token-in swap sends its own
// approval first: USDC through increaseAllowance(), EURC/cirBTC through
// approve(). Both must read as the approval - an increaseAllowance taken for
// the swap made a USDC swap that failed after its approval look "confirmed"
// (the approval's receipt) and get recorded as a completed swap.
const APPROVAL_SELECTORS = new Set([
  '0x095ea7b3', // approve(address,uint256)
  '0x39509351', // increaseAllowance(address,uint256)
])
export function isApprovalCalldata(data: unknown): boolean {
  return APPROVAL_SELECTORS.has(String(data || '').slice(0, 10).toLowerCase())
}
let _onSwapProgress: ((p: SwapProgress) => void) | null = null
let _confirmedHashes = new Set<string>()
// Set once a swap transaction (not an approve) has actually been broadcast in
// the current executeSwapLocal - a retry must never send a second swap then.
let _swapBroadcast = false
// The swap transaction's hash and receipt, once Arc has confirmed it.
let _swapHash: string | null = null
let _swapConfirmed = false
let _swapReceipt: any = null
// Set as soon as a swap transaction is SENT to the RPC (before any reply), with
// its hash taken from the signed transaction itself. A send whose reply was
// lost (timeout, network blip) may still have reached the chain - this is how
// the error path below finds out what really happened.
let _swapSendAttempted = false
// Swap timing (lib/perfTrace): when it started, when the swap transaction went
// out, when Arc confirmed it.
let _swapTimes: { start: number; sent?: number; confirmed?: number } | null = null

// A different swap hash drops any receipt held for the previous one, so a
// confirmation can only ever belong to the transaction it was read for.
function noteSwapHash(hash: string) {
  const h = hash.toLowerCase()
  if (h !== _swapHash) { _swapConfirmed = false; _swapReceipt = null }
  _swapHash = h
}

function noteSwapSends(reqs: any[], Transaction: any) {
  for (const req of reqs) {
    try {
      if (req?.method !== 'eth_sendRawTransaction') continue
      const tx = Transaction.from(req.params[0])
      if (isApprovalCalldata(tx.data)) continue
      _swapSendAttempted = true
      if (_swapTimes && _swapTimes.sent == null) _swapTimes.sent = performance.now()
      if (tx.hash) noteSwapHash(String(tx.hash))
    } catch { /* bookkeeping only */ }
  }
}

function reportSwapProgress(reqs: any[], results: any[], Transaction: any) {
  const emit = _onSwapProgress ?? (() => {})
  for (const req of reqs) {
    const res = results.find((r: any) => r?.id === req?.id)
    if (!res || res.error) continue
    try {
      if (req.method === 'eth_sendRawTransaction' && typeof res.result === 'string') {
        const isApproval = isApprovalCalldata(Transaction.from(req.params[0]).data)
        if (!isApproval) { _swapBroadcast = true; noteSwapHash(res.result) }
        emit({ kind: isApproval ? 'approve-sent' : 'swap-sent', hash: res.result })
      } else if (req.method === 'eth_getTransactionReceipt' && res.result && !_confirmedHashes.has(res.result.transactionHash)) {
        _confirmedHashes.add(res.result.transactionHash)
        if (_swapHash && String(res.result.transactionHash).toLowerCase() === _swapHash && res.result.status === '0x1') {
          _swapReceipt = res.result
          _swapConfirmed = true
          if (_swapTimes && _swapTimes.confirmed == null) _swapTimes.confirmed = performance.now()
        }
        emit({ kind: 'confirmed', hash: res.result.transactionHash, success: res.result.status === '0x1' })
      }
    } catch { /* progress is display-only - never affects the swap itself */ }
  }
}

// Arc RPC provider that forwards through the SAME same-origin, health-
// scored /api/arc-rpc proxy every other Arc-facing feature already uses -
// never a raw third-party RPC URL from the browser, and never the
// in-process forward() swap-proxy.js used server-side (there's no
// same-process call available from the browser - this is the real network
// hop equivalent of it).
const SWAP_RPC_TIMEOUT_MS = 20_000
function buildArcForwardProvider(JsonRpcProvider: any, Transaction: any) {
  class ArcForwardProvider extends JsonRpcProvider {
    constructor() {
      // pollingInterval: ethers' 4000ms default made every receipt wait inside
      // the SDK (approve + swap) cost ~4s on Arc's sub-second chain.
      super('/api/arc-rpc', ARC_NETWORK, { staticNetwork: true, pollingInterval: 200 })
    }
    async _send(payload: any) {
      const isBatch = Array.isArray(payload)
      noteSwapSends(isBatch ? payload : [payload], Transaction)
      try {
        // Bounded like every other Arc call (arcRpcJson): a request stuck on a
        // dead connection used to hold the swap forever. A send that timed
        // out is settled from Arc itself below (settleSwapTx).
        const res = await fetch('/api/arc-rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(SWAP_RPC_TIMEOUT_MS),
        })
        const result = await res.json()
        const results = isBatch ? result : [result]
        reportSwapProgress(isBatch ? payload : [payload], results, Transaction)
        return results
      } catch (e: any) {
        const reqs = isBatch ? payload : [payload]
        return reqs.map((p: any) => ({ id: p.id, error: { code: -32603, message: e?.message || 'Arc RPC forward failed' } }))
      }
    }
  }
  return new ArcForwardProvider()
}

// Adapter cache, keyed by wallet address. Avoids rebuilding the adapter on
// every call for the same wallet within this session. It signs through the
// wallet frame (src/wallet) - no key here.
let _adapterCache: { address: string; adapter: any } | null = null
async function getAdapter(signer: WalletAccount) {
  const address = signer.address.toLowerCase()
  if (_adapterCache?.address === address) return _adapterCache.adapter
  const [{ JsonRpcProvider, Transaction }, { createWalletAdapter }] = await Promise.all([getSdkModules(), import('@/wallet')])
  const adapter = await createWalletAdapter({
    account: signer,
    getProvider: () => buildArcForwardProvider(JsonRpcProvider, Transaction),
  })
  _adapterCache = { address, adapter }
  return adapter
}

// ── Error classification - ported verbatim from api/swap-proxy.js's own
// extractError (see that file's history for the full reasoning behind each
// branch). One difference: the "Invalid KIT_KEY" server-config message
// doesn't make sense shown to an end user now that this runs client-side,
// so that branch reports a generic message instead.
function extractError(err: any, sdkMods: any): { raw: string; userMessage: string; isLiquidity: boolean; isUncertain: boolean } {
  if (!err) return { raw: 'Unknown error', userMessage: 'Unknown error', isLiquidity: false, isUncertain: false }

  const raw = (
    err?.message || err?.shortMessage || err?.reason || err?.details ||
    (err?.cause && String(err.cause)) || String(err)
  ) || ''
  const lower = raw.toLowerCase()
  console.error('[Swap] RAW ERROR:', raw.slice(0, 500))

  try {
    const { isKitError, isRpcError, isNetworkError } = sdkMods
    if (isKitError(err) && (err.recoverability === 'RESUMABLE' || isRpcError(err) || isNetworkError(err))) {
      return {
        raw,
        userMessage: "We couldn't confirm this swap finished - it may have already gone through. Check your balance or Activity before retrying to avoid a double swap.",
        isLiquidity: false, isUncertain: true,
      }
    }
  } catch (taxonomyErr: any) {
    console.warn('[Swap] KitError taxonomy check failed, falling back to string matching:', taxonomyErr?.message)
  }

  // Checked first: a rejected service key must never read as "no liquidity".
  if (lower.includes('api key') || lower.includes('not signed in') || lower.includes('swap service')) {
    return { raw, userMessage: 'Swap is temporarily unavailable - please try again shortly.', isLiquidity: false, isUncertain: false }
  }
  if (lower.includes('no route') || lower.includes('route or resource not found') ||
      lower.includes('unsupported_route') || lower.includes('input_unsupported_route') ||
      lower.includes('no route available') || lower.includes('route not found')) {
    return { raw, userMessage: 'No swap route available. Arc Testnet pool liquidity is temporarily low - try a smaller amount or wait a few minutes.', isLiquidity: true, isUncertain: false }
  }
  if (lower.includes('slippage') || lower.includes('price impact') || lower.includes('stop limit') || lower.includes('stoplimit')) {
    return { raw, userMessage: 'Price moved too much during swap. Try increasing slippage tolerance or use a smaller amount.', isLiquidity: false, isUncertain: false }
  }
  if ((lower.includes('insufficient') && lower.includes('balance')) || lower.includes('exceeds balance')) {
    return { raw, userMessage: 'Insufficient balance to complete this swap.', isLiquidity: false, isUncertain: false }
  }
  if (lower.includes('allowance') || lower.includes('approval')) {
    return { raw, userMessage: 'Token approval failed. Please try again.', isLiquidity: false, isUncertain: false }
  }
  if ((lower.includes('kit') && lower.includes('key')) || lower.includes('unauthorized') || lower.includes('forbidden')) {
    return { raw, userMessage: 'Swap is temporarily unavailable - please try again shortly.', isLiquidity: false, isUncertain: false }
  }
  if (lower.includes('rpc endpoint') || lower.includes('rpc error') || lower.includes('network') ||
      lower.includes('timeout') || lower.includes('econnreset') || lower.includes('fetch')) {
    return {
      raw,
      userMessage: "We couldn't confirm this swap finished - it may have already gone through. Check your balance or Activity before retrying to avoid a double swap.",
      isLiquidity: false, isUncertain: true,
    }
  }
  return { raw, userMessage: raw || 'Swap failed', isLiquidity: false, isUncertain: false }
}

function extractPossibleTxHash(err: any): string | null {
  return err?.txHash || err?.cause?.trace?.txHash || err?.cause?.txHash || err?.data?.txHash || null
}

// Did the expected output token actually land in this wallet in roughly the
// last minute? Ported from api/swap-proxy.js's own verifySwapLanded, but
// simplified to a single call through arcRpcJson (src/lib/arc.ts) - that
// already goes through the same health-scored /api/arc-rpc proxy the
// server-side version had to race multiple raw RPC URLs for by hand.
/** Amount of `tokenOutSymbol` the swap receipt transferred to `walletAddress` (decimal string), or ''. */
export function amountOutFromReceipt(receipt: any, tokenOutSymbol: string, walletAddress: string): string {
  const token = TOKEN_CONTRACTS[tokenOutSymbol]
  if (!receipt || !token || !walletAddress) return ''
  const to = '0x' + walletAddress.toLowerCase().replace('0x', '').padStart(64, '0')
  let total = 0n
  for (const log of receipt.logs ?? []) {
    try {
      if (String(log.address).toLowerCase() !== token.address.toLowerCase()) continue
      if (String(log.topics?.[0]).toLowerCase() !== TRANSFER_TOPIC || String(log.topics?.[2]).toLowerCase() !== to) continue
      total += BigInt(log.data)
    } catch { /* not a Transfer we can read */ }
  }
  if (total === 0n) return ''
  const s = total.toString().padStart(token.decimals + 1, '0')
  return `${s.slice(0, -token.decimals)}.${s.slice(-token.decimals)}`.replace(/\.?0+$/, '')
}

async function verifySwapLanded(walletAddress: string, tokenOutSymbol: string): Promise<{ txHash: string; amount: number } | null> {
  const token = TOKEN_CONTRACTS[tokenOutSymbol]
  if (!token || !walletAddress) return null
  try {
    const latestJson = await arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })
    const latest = parseInt(latestJson?.result, 16)
    if (!Number.isFinite(latest)) return null
    const fromBlock = '0x' + Math.max(0, latest - 40).toString(16) // ~last minute of blocks
    const paddedTo = '0x' + walletAddress.toLowerCase().replace('0x', '').padStart(64, '0')
    const logsJson = await arcRpcJson({
      jsonrpc: '2.0', id: 2, method: 'eth_getLogs',
      params: [{ address: token.address, fromBlock, toBlock: 'latest', topics: [TRANSFER_TOPIC, null, paddedTo] }],
    })
    const logs = logsJson?.result
    if (!Array.isArray(logs) || logs.length === 0) return null
    const mostRecent = logs[logs.length - 1]
    const amount = parseInt(mostRecent.data, 16) / Math.pow(10, token.decimals)
    return { txHash: mostRecent.transactionHash, amount }
  } catch (e: any) {
    console.warn('[Swap] verifySwapLanded failed:', e?.message)
    return null
  }
}

// Post-swap bookkeeping - same two writes api/swap-proxy.js's
// recordSwapActivity/markAttemptSubmittedServerSide used to do server-side
// as part of the signing request. Split out into its own tiny endpoint
// (action='recordCompletion') that takes a txHash + amounts, never a
// private key - the SERVICE_ROLE key it needs stays server-only, same as
// before, just no longer bundled into the same request as the signing.
// Not awaited by callers: the write starts the moment the swap confirms
// either way (that is what closes the race with deposit-scan-all's sweep);
// holding the success screen until the server answered only added a round
// trip. It never throws.
async function recordCompletion(params: {
  walletAddress: string; txHash: string; amountIn: number; amountOut: number
  tokenIn: string; tokenOut: string; intentId?: string | null; attemptId?: string | null
}): Promise<void> {
  // Retried on a network error or a 5xx; a 4xx (no session) won't improve by
  // repeating - the queued Activity row covers that case.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { authApiHeaders } = await import('./supabase')
      const res = await fetch('/api/swap-proxy', {
        method: 'POST',
        headers: await authApiHeaders(),
        body: JSON.stringify({ action: 'recordCompletion', ...params }),
      })
      if (res.ok || (res.status >= 400 && res.status < 500)) return
    } catch (e: any) {
      console.warn('[Swap] recordCompletion failed (non-fatal):', e?.message)
    }
    await new Promise(r => setTimeout(r, 500 * 2 ** attempt))
  }
}

export async function estimateSwapLocal(params: {
  signer: WalletAccount
  tokenIn: string; tokenOut: string; amountIn: string; slippageBps: number
}): Promise<{ estimatedOutput: any; stopLimit: any; fees: any[]; gasFees: any[] }> {
  const sdkMods = await getSdkModules()
  const kit = getKit(sdkMods.AppKit)
  const adapter = await getAdapter(params.signer)
  const slip = Math.max(Number(params.slippageBps || 500), 300)

  const baseParams = {
    from:     { adapter, chain: ARC_CHAIN_KEY as any },
    tokenIn:  params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: params.amountIn,
    config:   { slippageBps: slip },
  }

  try {
    const est = await kit.estimateSwap(baseParams)
    return { estimatedOutput: est.estimatedOutput, stopLimit: est.stopLimit, fees: est.fees || [], gasFees: est.gasFees || [] }
  } catch (e: any) {
    const { userMessage, isLiquidity, isUncertain, raw } = extractError(e, sdkMods)
    throw Object.assign(new Error(userMessage), { isLiquidity, isUncertain, rawError: raw.slice(0, 200) })
  }
}

// After kit.swap() throws: what actually happened to the swap transaction?
//   'not-sent'  - no swap transaction was ever sent: nothing was swapped.
//   'confirmed' - Arc confirmed it (status 1): the swap went through.
//   'reverted'  - Arc confirmed it failed (status 0): nothing was swapped.
//   'unknown'   - sent, but Arc has no receipt after ~30s (SUBMITTED_UNKNOWN -
//                 never reported as failed, it may still confirm).
async function settleSwapTx(): Promise<{ kind: 'not-sent' | 'unknown' } | { kind: 'confirmed' | 'reverted'; hash: string; receipt: any }> {
  if (!_swapSendAttempted || !_swapHash) return { kind: _swapSendAttempted ? 'unknown' : 'not-sent' }
  const hash = _swapHash
  if (_swapConfirmed && _swapReceipt) return { kind: 'confirmed', hash, receipt: _swapReceipt }
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const j = await arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] })
      const r = j?.result
      if (r) return { kind: r.status === '0x1' ? 'confirmed' : 'reverted', hash, receipt: r }
    } catch { /* keep trying until the deadline */ }
    // Arc blocks are ~0.5s: a 1.5s gap kept a confirmed swap waiting.
    await new Promise(res => setTimeout(res, 300))
  }
  return { kind: 'unknown' }
}

type ExecuteSwapParams = {
  signer: WalletAccount
  walletAddress: string
  tokenIn: string; tokenOut: string; amountIn: string; slippageBps: number
  attemptId?: string | null; intentId?: string | null
  /** Real on-chain progress for the checklist - see SwapProgress above. */
  onProgress?: (p: SwapProgress) => void
}

/** What a confirmed swap returns. `blockNumber` (0x hex) is the block the swap landed in - balances are read AT it. */
export type SwapOutcome = { txHash: string; amountOut: string; explorerUrl: string; blockNumber?: string }

/** Block (0x hex) the swap transaction was mined in, from its receipt (fetched when not already seen). */
async function swapBlockNumber(hash: string, receipt?: any): Promise<string | undefined> {
  if (receipt?.blockNumber && String(receipt.transactionHash).toLowerCase() === hash.toLowerCase()) return String(receipt.blockNumber)
  for (let i = 0; i < 4; i++) {
    try {
      const j = await arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] })
      if (j?.result?.blockNumber) return String(j.result.blockNumber)
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 700))
  }
  return undefined
}

export async function executeSwapLocal(params: ExecuteSwapParams): Promise<SwapOutcome> {
  assertAccountUnlocked() // business not approved yet: nothing moves
  _onSwapProgress = params.onProgress ?? null
  _confirmedHashes = new Set()
  _swapBroadcast = false; _swapSendAttempted = false
  _swapHash = null; _swapConfirmed = false; _swapReceipt = null
  const times = _swapTimes = { start: performance.now() } as NonNullable<typeof _swapTimes>
  let outcome = 'failed'
  try {
    const out = await runSwap(params)
    outcome = 'success'
    return out
  } finally {
    _onSwapProgress = null
    _swapConfirmed = false
    _swapTimes = null
    const { reportSwap } = await import('./perfTrace')
    reportSwap(times.sent != null ? times.sent - times.start : undefined,
      times.sent != null && times.confirmed != null ? times.confirmed - times.sent : undefined,
      times.sent == null ? `${outcome}, not sent` : outcome)
  }
}

async function runSwap(params: ExecuteSwapParams): Promise<SwapOutcome> {
  const sdkMods = await getSdkModules()
  const kit = getKit(sdkMods.AppKit)
  const adapter = await getAdapter(params.signer)

  const parsedAmt = parseFloat(params.amountIn)
  // Same formatting api/swap-proxy.js used - toFixed(8) then trim trailing
  // zeros handles all three tokens (USDC/EURC/cirBTC) correctly, including
  // cirBTC amounts too small for toFixed(2) to represent without rounding
  // to zero.
  const amountFormatted = parsedAmt.toFixed(8).replace(/\.?0+$/, '')
  const slip = Math.max(Number(params.slippageBps || 500), 300)

  const baseParams = {
    from:     { adapter, chain: ARC_CHAIN_KEY as any },
    tokenIn:  params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: amountFormatted,
    config:   { slippageBps: slip },
  }

  // The swap is on Arc: its Activity row is queued on this device first, so a
  // dropped connection or a closed tab can't lose it, then written.
  const finish = (txHash: string, amountOut: number) => {
    void import('./swapActivityOutbox').then(({ enqueueSwapActivity, flushSwapActivityOutbox }) => {
      enqueueSwapActivity({
        walletAddress: params.walletAddress, txHash, amountIn: parsedAmt, amountOut,
        tokenIn: params.tokenIn, tokenOut: params.tokenOut,
      })
      return flushSwapActivityOutbox(params.walletAddress)
    }).catch(() => {})
    void recordCompletion({
      walletAddress: params.walletAddress, txHash, amountIn: parsedAmt, amountOut,
      tokenIn: params.tokenIn, tokenOut: params.tokenOut,
      intentId: params.intentId, attemptId: params.attemptId,
    })
  }

  try {
    const result: any = await kit.swap(baseParams)
    // amountOut from the confirmed swap's own Transfer log to this wallet (the
    // service's status poll is skipped - see routeSwapServiceThroughServer).
    // The receipt's own Transfer is what actually landed in the wallet; the SDK's
    // figure can be the quote, so it is only the fallback.
    const amountOut = amountOutFromReceipt(_swapReceipt, params.tokenOut, params.walletAddress) || result?.amountOut || ''
    if (result?.txHash) finish(result.txHash, parseFloat(amountOut || '0') || 0)
    const blockNumber = result?.txHash ? await swapBlockNumber(result.txHash, _swapReceipt) : undefined
    return { txHash: result?.txHash || '', amountOut, explorerUrl: result?.explorerUrl || '', blockNumber }
  } catch (e1: any) {
    const { raw: raw1, userMessage: msg1, isLiquidity, isUncertain } = extractError(e1, sdkMods)
    console.warn('[Swap] attempt 1 failed:', msg1)

    // Ask Arc about the swap transaction itself before telling the user
    // anything: a lost RPC reply must not read as "couldn't confirm" when the
    // swap actually went through (or was never sent at all).
    const settled = await settleSwapTx()
    if (settled.kind === 'confirmed') {
      const amountOut = amountOutFromReceipt(settled.receipt, params.tokenOut, params.walletAddress)
      console.warn('[Swap] kit.swap threw but the swap confirmed on Arc:', settled.hash)
      finish(settled.hash, parseFloat(amountOut || '0') || 0)
      return { txHash: settled.hash, amountOut, explorerUrl: `${ARC_EXPLORER}/tx/${settled.hash}`, blockNumber: await swapBlockNumber(settled.hash, settled.receipt) }
    }
    if (settled.kind === 'reverted') {
      throw Object.assign(new Error('The swap was rejected on Arc (the price or liquidity moved) - nothing was swapped. Please try again.'),
        { isLiquidity: false, rawError: raw1.slice(0, 200), isUncertain: false })
    }
    if (settled.kind === 'not-sent' && isUncertain) {
      throw Object.assign(new Error("The swap didn't go through - nothing was swapped. Please try again."),
        { isLiquidity: false, rawError: raw1.slice(0, 200), isUncertain: false })
    }

    const possibleHash = extractPossibleTxHash(e1)
    if (possibleHash) {
      console.warn('[Swap] swap threw but a txHash was present - recording activity defensively:', possibleHash)
      finish(possibleHash, 0)
    } else if (isUncertain) {
      const landed = await verifySwapLanded(params.walletAddress, params.tokenOut)
      if (landed) {
        console.warn('[Swap] verified swap landed on-chain despite the throw:', landed)
        finish(landed.txHash, landed.amount)
        return { txHash: landed.txHash, amountOut: String(landed.amount), explorerUrl: `${ARC_EXPLORER}/tx/${landed.txHash}`, blockNumber: await swapBlockNumber(landed.txHash) }
      }
    }

    // No automatic retry at a higher slippage: the user approved a specific
    // minimum output, and silently re-signing at 20% would accept a far
    // worse price without asking. They can retry (or raise slippage) themselves.
    throw Object.assign(new Error(msg1), { isLiquidity, rawError: raw1.slice(0, 200), isUncertain })
  }
}

// Warms the SDK module cache (dynamic imports only - no key, no network
// call) so the user's first real estimate hits a warm module cache instead
// of paying for the parse-the-full-module-graph cost on that first call.
// Replaces the old page-mount warm-up, which used to POST a real private
// key to api/swap-proxy for this same purpose.
export function warmSwapSdk(): void {
  getSdkModules().catch(() => {})
}
