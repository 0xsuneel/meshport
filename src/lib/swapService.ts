/**
 * swapService.ts — client-side Swap execution engine.
 *
 * SECURITY FIX (private-key exposure, transaction audit 2026-09-17):
 * kit.swap()/kit.estimateSwap() used to run server-side, in
 * api/swap-proxy.js — which meant the raw self-custodial private key was
 * POSTed over the network to a Vercel serverless function on every swap
 * (and even on a fire-and-forget page-mount warm-up call), just so that
 * function could build a signer from it. That broke the private-key-
 * never-leaves-the-device boundary every other feature already respects.
 * Multichain Claim/Transfer already run this exact AppKit +
 * createEthersAdapterFromPrivateKey pattern entirely in the browser (see
 * MultichainClaimPage.tsx's buildAdapter/loadSdk) — Swap moving here too
 * is not a new capability, just closing the one feature that hadn't been
 * migrated. The key never leaves this device now: signing happens
 * locally, exactly like Pay/ChatPay/Claim/Transfer already do.
 *
 * api/swap-proxy.js still exists, but ONLY for the post-swap bookkeeping
 * write (action='recordCompletion') that used to happen server-side as
 * part of the same request — that needs the SERVICE_ROLE key (which must
 * never reach the client), but only ever takes a txHash + amounts, never
 * a private key.
 */
import { ARC_NETWORK, arcRpcJson } from './arc'
import { USDC_CONTRACT, EURC_CONTRACT, CIRBTC_CONTRACT } from './arcService'

const TOKEN_CONTRACTS: Record<string, { address: string; decimals: number }> = {
  USDC:   { address: USDC_CONTRACT,   decimals: 6 },
  EURC:   { address: EURC_CONTRACT,   decimals: 6 },
  cirBTC: { address: CIRBTC_CONTRACT, decimals: 8 },
}
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

// ── Cached SDK modules/kit instance — avoids re-importing/re-constructing
// on every estimate/swap call within the same page session.
let _sdkModules: any = null
async function getSdkModules() {
  if (!_sdkModules) {
    const [
      { AppKit, isKitError, isRpcError, isNetworkError },
      { createEthersAdapterFromPrivateKey },
      { JsonRpcProvider },
    ] = await Promise.all([
      import('@circle-fin/app-kit'),
      import('@circle-fin/adapter-ethers-v6'),
      import('ethers'),
    ])
    _sdkModules = { AppKit, isKitError, isRpcError, isNetworkError, createEthersAdapterFromPrivateKey, JsonRpcProvider }
  }
  return _sdkModules
}

let _kit: any = null
function getKit(AppKit: any) {
  if (!_kit) _kit = new AppKit({ clientKey: import.meta.env.VITE_KIT_KEY, disableErrorReporting: true } as any)
  return _kit
}

// Arc RPC provider that forwards through the SAME same-origin, health-
// scored /api/arc-rpc proxy every other Arc-facing feature already uses —
// never a raw third-party RPC URL from the browser, and never the
// in-process forward() swap-proxy.js used server-side (there's no
// same-process call available from the browser — this is the real network
// hop equivalent of it).
function buildArcForwardProvider(JsonRpcProvider: any) {
  class ArcForwardProvider extends JsonRpcProvider {
    constructor() {
      super('/api/arc-rpc', ARC_NETWORK, { staticNetwork: true })
    }
    async _send(payload: any) {
      const isBatch = Array.isArray(payload)
      try {
        const res = await fetch('/api/arc-rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const result = await res.json()
        return isBatch ? result : [result]
      } catch (e: any) {
        const reqs = isBatch ? payload : [payload]
        return reqs.map((p: any) => ({ id: p.id, error: { code: -32603, message: e?.message || 'Arc RPC forward failed' } }))
      }
    }
  }
  return new ArcForwardProvider()
}

// Adapter cache, keyed by a short, non-reversible tail of the private key —
// same pattern MultichainClaimPage.tsx's buildAdapter/_providerCache
// already uses. Avoids rebuilding the adapter on every call for the same
// wallet within this session.
let _adapterCache: { keyTail: string; adapter: any } | null = null
async function getAdapter(privateKey: string) {
  const keyTail = privateKey.slice(-8)
  if (_adapterCache?.keyTail === keyTail) return _adapterCache.adapter
  const { createEthersAdapterFromPrivateKey, JsonRpcProvider } = await getSdkModules()
  const adapter = createEthersAdapterFromPrivateKey({
    privateKey,
    getProvider: () => buildArcForwardProvider(JsonRpcProvider),
  })
  _adapterCache = { keyTail, adapter }
  return adapter
}

// ── Error classification — ported verbatim from api/swap-proxy.js's own
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
        userMessage: "We couldn't confirm this swap finished — it may have already gone through. Check your balance or Activity before retrying to avoid a double swap.",
        isLiquidity: false, isUncertain: true,
      }
    }
  } catch (taxonomyErr: any) {
    console.warn('[Swap] KitError taxonomy check failed, falling back to string matching:', taxonomyErr?.message)
  }

  if (lower.includes('no route') || lower.includes('route or resource not found') ||
      lower.includes('unsupported_route') || lower.includes('input_unsupported_route') ||
      lower.includes('no route available') || lower.includes('route not found')) {
    return { raw, userMessage: 'No swap route available. Arc Testnet pool liquidity is temporarily low — try a smaller amount or wait a few minutes.', isLiquidity: true, isUncertain: false }
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
    return { raw, userMessage: 'Swap is temporarily unavailable — please try again shortly.', isLiquidity: false, isUncertain: false }
  }
  if (lower.includes('rpc endpoint') || lower.includes('rpc error') || lower.includes('network') ||
      lower.includes('timeout') || lower.includes('econnreset') || lower.includes('fetch')) {
    return {
      raw,
      userMessage: "We couldn't confirm this swap finished — it may have already gone through. Check your balance or Activity before retrying to avoid a double swap.",
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
// simplified to a single call through arcRpcJson (src/lib/arc.ts) — that
// already goes through the same health-scored /api/arc-rpc proxy the
// server-side version had to race multiple raw RPC URLs for by hand.
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

// Post-swap bookkeeping — same two writes api/swap-proxy.js's
// recordSwapActivity/markAttemptSubmittedServerSide used to do server-side
// as part of the signing request. Split out into its own tiny endpoint
// (action='recordCompletion') that takes a txHash + amounts, never a
// private key — the SERVICE_ROLE key it needs stays server-only, same as
// before, just no longer bundled into the same request as the signing.
// Awaited (not fire-and-forget) by callers so the same "close the race with
// deposit-scan-all's independent sweep" property is preserved.
async function recordCompletion(params: {
  walletAddress: string; txHash: string; amountIn: number; amountOut: number
  tokenIn: string; tokenOut: string; intentId?: string | null; attemptId?: string | null
}): Promise<void> {
  try {
    await fetch('/api/swap-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'recordCompletion', ...params }),
    })
  } catch (e: any) {
    console.warn('[Swap] recordCompletion failed (non-fatal):', e?.message)
  }
}

export async function estimateSwapLocal(params: {
  privateKey: string
  tokenIn: string; tokenOut: string; amountIn: string; slippageBps: number
}): Promise<{ estimatedOutput: any; stopLimit: any; fees: any[]; gasFees: any[] }> {
  const sdkMods = await getSdkModules()
  const kit = getKit(sdkMods.AppKit)
  const adapter = await getAdapter(params.privateKey)
  const slip = Math.max(Number(params.slippageBps || 500), 300)

  const baseParams = {
    from:     { adapter, chain: 'Arc_Testnet' as any },
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

export async function executeSwapLocal(params: {
  privateKey: string
  walletAddress: string
  tokenIn: string; tokenOut: string; amountIn: string; slippageBps: number
  attemptId?: string | null; intentId?: string | null
}): Promise<{ txHash: string; amountOut: string; explorerUrl: string }> {
  const sdkMods = await getSdkModules()
  const kit = getKit(sdkMods.AppKit)
  const adapter = await getAdapter(params.privateKey)

  const parsedAmt = parseFloat(params.amountIn)
  // Same formatting api/swap-proxy.js used — toFixed(8) then trim trailing
  // zeros handles all three tokens (USDC/EURC/cirBTC) correctly, including
  // cirBTC amounts too small for toFixed(2) to represent without rounding
  // to zero.
  const amountFormatted = parsedAmt.toFixed(8).replace(/\.?0+$/, '')
  const slip = Math.max(Number(params.slippageBps || 500), 300)

  const baseParams = {
    from:     { adapter, chain: 'Arc_Testnet' as any },
    tokenIn:  params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: amountFormatted,
    config:   { slippageBps: slip },
  }

  const finish = (txHash: string, amountOut: number) => recordCompletion({
    walletAddress: params.walletAddress, txHash, amountIn: parsedAmt, amountOut,
    tokenIn: params.tokenIn, tokenOut: params.tokenOut,
    intentId: params.intentId, attemptId: params.attemptId,
  })

  try {
    const result: any = await kit.swap(baseParams)
    if (result?.txHash) await finish(result.txHash, parseFloat(result?.amountOut || '0') || 0)
    return { txHash: result?.txHash || '', amountOut: result?.amountOut || '', explorerUrl: result?.explorerUrl || '' }
  } catch (e1: any) {
    const { raw: raw1, userMessage: msg1, isLiquidity, isUncertain } = extractError(e1, sdkMods)
    console.warn('[Swap] attempt 1 failed:', msg1)

    const possibleHash = extractPossibleTxHash(e1)
    if (possibleHash) {
      console.warn('[Swap] swap threw but a txHash was present — recording activity defensively:', possibleHash)
      await finish(possibleHash, 0)
    } else if (isUncertain) {
      const landed = await verifySwapLanded(params.walletAddress, params.tokenOut)
      if (landed) {
        console.warn('[Swap] verified swap landed on-chain despite the throw:', landed)
        await finish(landed.txHash, landed.amount)
        return { txHash: landed.txHash, amountOut: String(landed.amount), explorerUrl: `https://testnet.arcscan.app/tx/${landed.txHash}` }
      }
    }

    // Retry once at higher slippage — skip for liquidity errors (no point)
    // and uncertain errors (the first attempt may have already landed;
    // firing a second real swap without knowing that is the double-spend
    // risk this whole check exists to prevent).
    if (!isLiquidity && !isUncertain && slip < 2000) {
      try {
        console.log('[Swap] retrying with 2000bps slippage')
        const r2: any = await kit.swap({ ...baseParams, config: { ...baseParams.config, slippageBps: 2000 } })
        if (r2?.txHash) await finish(r2.txHash, parseFloat(r2?.amountOut || '0') || 0)
        return { txHash: r2?.txHash || '', amountOut: r2?.amountOut || '', explorerUrl: r2?.explorerUrl || '' }
      } catch (e2: any) {
        const { userMessage: msg2, isUncertain: isUncertain2 } = extractError(e2, sdkMods)
        console.warn('[Swap] retry failed:', msg2)
        throw Object.assign(new Error(msg2), { isLiquidity: false, isUncertain: isUncertain2 })
      }
    }

    throw Object.assign(new Error(msg1), { isLiquidity, rawError: raw1.slice(0, 200), isUncertain })
  }
}

// Warms the SDK module cache (dynamic imports only — no key, no network
// call) so the user's first real estimate hits a warm module cache instead
// of paying for the parse-the-full-module-graph cost on that first call.
// Replaces the old page-mount warm-up, which used to POST a real private
// key to api/swap-proxy for this same purpose.
export function warmSwapSdk(): void {
  getSdkModules().catch(() => {})
}
