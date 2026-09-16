// swap-proxy.js — CommonJS Vercel serverless function
const Module = require('module')
const orig = Module._load
Module._load = function(id, ...a) {
  if (id === 'rpc-websockets' || id.startsWith('rpc-websockets/'))
    return { Client: class { constructor() {} on() {} removeListener() {} send() {} close() {} } }
  if (id === '@solana/web3.js')
    return { Connection: class {}, PublicKey: class { constructor(k) { this.toString=()=>k } }, Transaction: class {}, clusterApiUrl:()=>'', LAMPORTS_PER_SOL:1e9 }
  return orig.apply(this, [id, ...a])
}

// drpc.live API key — set DRPC_KEY in Vercel environment variables (never
// VITE_-prefixed — must stay server-side only).
const DRPC_KEY = process.env.DRPC_KEY ?? ''

// Supabase — used only to record the swap's own activity row immediately on
// completion (see recordSwapActivity below). Best-effort: a failure here
// never blocks the swap response back to the client.
const SUPABASE_URL = (
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  'https://cvvpzfvzweszuuxvaayb.supabase.co'
).trim()
const SUPABASE_SERVICE_KEY = (
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  ''
).trim()

// Optional explicit authenticated RPC URL override — set ARC_RPC_URL (NOT
// VITE_ARC_RPC_URL) in Vercel. VITE_-prefixed vars are bundled into the
// client and are never read here.
const CONFIGURED_ARC_RPC_URL = (process.env.ARC_RPC_URL || '').trim()

// Alchemy — Arc's own partnered node provider. No free keyless endpoint;
// set ALCHEMY_ARC_KEY in Vercel (get one at
// https://dashboard.alchemy.com/chains/arc) to use it. Same pattern as
// api/arc-rpc.js — see that file's comment for the source confirming this
// URL format.
const ALCHEMY_ARC_KEY = (process.env.ALCHEMY_ARC_KEY || '').trim()

// Arc RPC list — authenticated endpoint (when configured) tried first for
// its higher rate limits, then Circle's own official public Arc Testnet RPC
// endpoints as fallback (free, keyless, Circle-operated — see
// https://docs.arc.io/arc/references/rpc-endpoints). Previously this list
// had ONLY the authenticated DRPC_KEY entry, so any rate limit on that one
// key took down swaps entirely with nowhere to fail over to.
const ARC_RPCS = [
  ...(CONFIGURED_ARC_RPC_URL ? [CONFIGURED_ARC_RPC_URL] : []),
  ...(DRPC_KEY ? [`https://lb.drpc.live/arc-testnet/${DRPC_KEY}`] : []), // dRPC authenticated (higher limits)
  ...(ALCHEMY_ARC_KEY ? [`https://arc-testnet.g.alchemy.com/v2/${ALCHEMY_ARC_KEY}`] : []),
  'https://rpc.testnet.arc.network',
  'https://rpc.blockdaemon.testnet.arc.network',
  'https://rpc.drpc.testnet.arc.network',
  'https://rpc.quicknode.testnet.arc.network',
]

// Writes the swap's own 'swap' activity row the moment the swap completes,
// server-side — same shape and same plain (unprefixed) tx_hash the client's
// Activity.swap() in src/lib/ActivityService.ts would write.
//
// WHY THIS EXISTS: deposit-scan-all (supabase/functions/deposit-scan-all)
// scans Arc directly for incoming transfers and already knows to skip a
// transfer if a 'swap' row for that same tx_hash already exists — a swap's
// output-token leg is otherwise indistinguishable on-chain from someone
// else sending you that token. But that dedupe check only works if the
// 'swap' row exists BY THE TIME deposit-scan-all's sweep runs. The client
// used to be the only thing writing that row, asynchronously, after
// already receiving this function's HTTP response — deposit-scan-all's
// sweep (which loops independently every ~8s) could win that race and
// record + notify the swap's output leg as a spurious "Payment Received"
// before the client ever got a chance to write the real 'swap' row.
// Writing it here, synchronously as part of this same request, closes that
// window down to milliseconds instead of a full network round-trip. The
// client still writes its own copy afterward as a fallback (harmless
// no-op via the same on_conflict=ignore-duplicates upsert) in case this
// call fails or Supabase env vars aren't configured for this function.
async function recordSwapActivity(walletAddress, txHash, amountIn, amountOut, tokenIn, tokenOut, intentId) {
  if (!SUPABASE_SERVICE_KEY || !walletAddress || !txHash) return
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/activity?on_conflict=tx_hash,wallet_address`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal,resolution=ignore-duplicates',
      },
      body: JSON.stringify({
        wallet_address: walletAddress.toLowerCase(),
        tx_hash:        txHash.toLowerCase(),
        activity_type:  'swap',
        amount:         amountIn,
        usd_value:      amountIn,
        token_symbol:   tokenIn,
        status:         'completed',
        explorer_url:   `https://testnet.arcscan.app/tx/${txHash}`,
        metadata:       { tokenIn, tokenOut, amountIn, amountOut },
        // Best-effort traceability back to the canonical intent, when the
        // client sent one (see markAttemptSubmittedServerSide's own header
        // for why this row is written independently of the ledger rather
        // than projected from it -- this column at least lets a reader
        // join this Activity row back to transaction_intents without
        // guessing by tx_hash). Never required -- on_conflict=ignore means
        // an older client that never sent intentId still writes a valid row.
        ...(intentId ? { transaction_intent_id: intentId } : {}),
      }),
    })
  } catch (e) {
    console.warn('[swap-proxy] recordSwapActivity failed (non-fatal):', e?.message)
  }
}

// Persists the real tx_hash onto transaction_attempts SYNCHRONOUSLY, in this
// same server-side request, the instant kit.swap() (or one of the recovery
// paths below) resolves a real hash -- rather than depending solely on the
// client's own separate, fire-and-forget markSwapAttemptSubmitted call
// (src/lib/swapIntentService.ts), which can be lost to a tab close, a crash,
// or a network failure between the swap landing and that follow-up request
// ever firing. This closes the actual root cause of the tx_hash-loss/orphan
// class of bug (see docs/ORPHANED_SWAP_INCIDENT.md for the real production
// case this was written for: attempt b3eb0389.../intent ff52946c...).
//
// Best-effort by design, same as recordSwapActivity: never throws, never
// blocks or fails the response to an already-broadcast, already-real swap.
// The client's own call still fires afterward as a second, redundant write
// -- harmless, because both go through the identical idempotent guard
// below (`status=eq.CREATED&tx_hash=is.null`), so whichever lands first
// wins and the second is simply a no-op (0 rows matched, not an error).
async function markAttemptSubmittedServerSide(attemptId, txHash) {
  if (!SUPABASE_SERVICE_KEY || !attemptId || !txHash) return
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/transaction_attempts?id=eq.${encodeURIComponent(attemptId)}&status=eq.CREATED&tx_hash=is.null`,
      {
        method: 'PATCH',
        headers: {
          'apikey':        SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'return=minimal',
        },
        body: JSON.stringify({
          tx_hash:      txHash.toLowerCase(),
          status:       'SUBMITTED',
          submitted_at: new Date().toISOString(),
        }),
      }
    )
    if (!res.ok) console.warn('[swap-proxy] markAttemptSubmittedServerSide non-200:', res.status)
  } catch (e) {
    console.warn('[swap-proxy] markAttemptSubmittedServerSide failed (non-fatal):', e?.message)
  }
}

// Best-effort extraction of a txHash a thrown error might still be
// carrying. When kit.swap() throws because a POST-broadcast step failed
// (confirmation polling hitting a dead/rate-limited RPC endpoint, most
// commonly) rather than the transaction itself failing, the underlying
// broadcast can have genuinely succeeded — and some of these error shapes
// still carry the hash that was broadcast. Checked defensively; returns
// null (not a guess) if nothing is present, in which case the caller has
// no choice but to report this as a genuine failure.
function extractPossibleTxHash(err) {
  return err?.txHash || err?.cause?.trace?.txHash || err?.cause?.txHash || err?.data?.txHash || null
}

// Token contracts on Arc, for verifySwapLanded below. Same addresses the
// client uses (src/lib/arcService.ts / SwapPage.tsx) — kept here too since
// this runs server-side and shouldn't depend on a client bundle import.
const TOKEN_CONTRACTS = {
  USDC:   { address: '0x3600000000000000000000000000000000000000', decimals: 6 },
  EURC:   { address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', decimals: 6 },
  cirBTC: { address: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF', decimals: 8 },
}
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

// Read-only race across the same ARC_RPCS candidates the write-side swap
// call already tried. A single eth_getLogs/eth_blockNumber call is much
// less demanding than a full transaction submit-and-confirm, so this stays
// reasonably reliable even right after the write-side call just failed —
// it's a different kind of request, not necessarily hitting the same
// failure.
async function raceArcRpc(body, timeoutMs = 6000) {
  const attempts = ARC_RPCS.map(async (url) => {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`)
    const json = await r.json()
    if (json?.error) throw new Error(json.error.message || 'RPC error')
    return json.result
  })
  return Promise.any(attempts)
}

// extractPossibleTxHash only helps when the thrown error happens to carry
// a txHash — which raw RPC connectivity errors (the actual error text
// behind "RPC endpoint error on Arc Testnet") typically don't, since the
// failure happens at the transport layer before any SDK code gets a
// chance to attach one. This checks the chain directly instead of relying
// on what the error object happens to contain: did the expected output
// token actually land in the wallet in roughly the last minute? If so,
// this turns a false "Swap Failed" into a real, confirmed success —
// exactly the case a screenshot showed (funds genuinely moved, verified
// on the explorer, while the app reported failure).
//
// Trade-off, stated plainly: this can't cryptographically prove the found
// transfer IS this specific swap rather than a coincidental unrelated
// transfer of the same token landing in the same ~1-minute window. Given
// the alternative is the observed bug (a real success reported as a
// false failure, which risks an unnecessary manual retry), this is the
// right side to err on — and the exact-hash write into 'activity' this
// feeds into is what actually protects deposit-scan-all from duplicating
// it either way.
async function verifySwapLanded(walletAddress, tokenOutSymbol) {
  const token = TOKEN_CONTRACTS[tokenOutSymbol]
  if (!token || !walletAddress) return null
  try {
    const latestHex = await raceArcRpc({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })
    const latest = parseInt(latestHex, 16)
    if (!Number.isFinite(latest)) return null
    const fromBlock = '0x' + Math.max(0, latest - 40).toString(16) // ~last minute of blocks
    const paddedTo = '0x' + walletAddress.toLowerCase().replace('0x', '').padStart(64, '0')
    const logs = await raceArcRpc({
      jsonrpc: '2.0', id: 2, method: 'eth_getLogs',
      params: [{ address: token.address, fromBlock, toBlock: 'latest', topics: [TRANSFER_TOPIC, null, paddedTo] }],
    })
    if (!Array.isArray(logs) || logs.length === 0) return null
    const mostRecent = logs[logs.length - 1]
    const amount = parseInt(mostRecent.data, 16) / Math.pow(10, token.decimals)
    return { txHash: mostRecent.transactionHash, amount }
  } catch (e) {
    console.warn('[swap-proxy] verifySwapLanded failed:', e?.message)
    return null
  }
}

function extractError(err) {
  if (!err) return { raw: 'Unknown error', userMessage: 'Unknown error', isLiquidity: false, isUncertain: false }

  // Pull every possible error field from Circle SDK errors
  const raw = (
    err?.message ||
    err?.shortMessage ||
    err?.reason ||
    err?.details ||
    (err?.cause && String(err.cause)) ||
    String(err)
  ) || ''

  const lower = raw.toLowerCase()

  // Log the FULL raw error for Vercel logs
  console.error('[swap-proxy] RAW ERROR:', raw.slice(0, 500))
  if (err?.stack) console.error('[swap-proxy] STACK:', err.stack.slice(0, 300))

  // Circle's SDK exposes a structured error taxonomy (isKitError,
  // .recoverability, isRpcError, isNetworkError — see
  // node_modules/@circle-fin/app-kit's re-exports) that the classification
  // below never checked, relying purely on string-matching raw.toLowerCase()
  // instead. That's how an RPC/confirmation-check failure ended up reported
  // as a flat "Swap Failed" with no distinction from a genuine on-chain
  // revert: RPC errors routinely surface AFTER a transaction has already
  // been broadcast (the broadcast itself succeeded; the SUBSEQUENT
  // wait-for-confirmation call is what actually hit the dead/rate-limited
  // endpoint) — kit.swap()'s own RESUMABLE recoverability flag exists
  // specifically to say "a multi-phase operation completed some phases
  // before failing." Telling the user "Swap Failed" with a "Try Again"
  // button in that situation risks a double-spend if the first attempt
  // actually landed — which is exactly what was observed: a "failed" swap
  // whose output showed up on-chain and in Activity moments later.
  // Route these to the same "uncertain, verify before retrying" messaging
  // the client-side AbortController timeout case already uses, instead of
  // a hard failure.
  try {
    const { isKitError, isRpcError, isNetworkError } = require('@circle-fin/app-kit')
    if (isKitError(err) && (err.recoverability === 'RESUMABLE' || isRpcError(err) || isNetworkError(err))) {
      return {
        raw,
        userMessage: "We couldn't confirm this swap finished — it may have already gone through. Check your balance or Activity before retrying to avoid a double swap.",
        isLiquidity: false,
        isUncertain: true,
      }
    }
  } catch (taxonomyErr) {
    // Defensive only — if the taxonomy helpers aren't available for any
    // reason, fall through to the string-based classification below
    // rather than losing error reporting entirely.
    console.warn('[swap-proxy] KitError taxonomy check failed, falling back to string matching:', taxonomyErr?.message)
  }

  // Classify for user-facing message
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
  if (lower.includes('kit') && lower.includes('key') || lower.includes('unauthorized') || lower.includes('forbidden')) {
    return { raw, userMessage: 'Invalid KIT_KEY — check your Circle Console kit key in Vercel env vars.', isLiquidity: false, isUncertain: false }
  }
  // Raw RPC/network-flavored errors that didn't get caught by the
  // structured taxonomy check above (e.g. a plain thrown Error, not a
  // KitError) — same "uncertain" treatment, since the same
  // broadcast-then-confirmation-check-fails scenario applies regardless of
  // whether the SDK wrapped it in a KitError.
  if (lower.includes('rpc endpoint') || lower.includes('rpc error') || lower.includes('network') ||
      lower.includes('timeout') || lower.includes('econnreset') || lower.includes('fetch')) {
    return { raw, userMessage: "We couldn't confirm this swap finished — it may have already gone through. Check your balance or Activity before retrying to avoid a double swap.", isLiquidity: false, isUncertain: true }
  }
  // Return the raw Circle SDK message directly — most useful for debugging
  return { raw, userMessage: raw || 'Swap failed — check Vercel function logs for details', isLiquidity: false, isUncertain: false }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const { action, privateKey, tokenIn, tokenOut, amountIn, slippageBps, attemptId, intentId } = req.body || {}

    if (!action || !privateKey || !tokenIn || !tokenOut || !amountIn)
      return res.status(400).json({ error: 'Missing required fields: action, privateKey, tokenIn, tokenOut, amountIn' })

    const KIT_KEY = (process.env.KIT_KEY || process.env.VITE_KIT_KEY || '').trim()
    if (!KIT_KEY) {
      console.error('[swap-proxy] KIT_KEY not configured')
      return res.status(500).json({ error: 'KIT_KEY not configured — add it to Vercel environment variables' })
    }

    const parsedAmt = parseFloat(amountIn)
    if (isNaN(parsedAmt) || parsedAmt <= 0)
      return res.status(400).json({ error: 'Invalid amount: ' + amountIn })

    // Circle SDK: use 6 decimal places to handle small amounts like cirBTC (0.000170)
    // toFixed(2) would round 0.000170 → "0.00" which Circle rejects as "must be > 0"
    // toFixed(8) then trim trailing zeros handles all three tokens correctly
    // (previously toFixed(2) for amounts >= 0.01 truncated/rounded cirBTC
    // amounts like 0.05234567 down to "0.05").
    const amountFormatted = parsedAmt.toFixed(8).replace(/\.?0+$/, '')
    const slip = Math.max(Number(slippageBps || 500), 300)

    console.log(`[swap-proxy] ${action} | ${tokenIn} → ${tokenOut} | amt: ${amountFormatted} | slip: ${slip}bps`)

    const { AppKit } = require('@circle-fin/app-kit')
    const { createEthersAdapterFromPrivateKey } = require('@circle-fin/adapter-ethers-v6')
    const { JsonRpcProvider, FallbackProvider, Wallet } = require('ethers')

    const kit = new AppKit({ disableErrorReporting: true })
    const normalizedKey = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey
    // Cheap, no RPC call needed — just derives the address from the key,
    // used only to attribute the server-side activity row (see
    // recordSwapActivity) to the right wallet.
    const walletAddress = new Wallet(normalizedKey).address

    // Arc's chain ID is fixed and known — passing it as a static network
    // stops ethers from calling eth_chainId to auto-detect on every provider
    // construction. That auto-detect call retries every ~1s FOREVER if it
    // ever fails once (a transient hiccup or rate limit), which is itself
    // enough extra traffic to keep an already-limited RPC key rate-limited.
    // This function runs fresh per invocation (no module-level provider
    // cache here, unlike the frontend), so without staticNetwork every
    // single swap attempt pays for — and risks triggering — that detection
    // call from scratch.
    const ARC_NETWORK = { chainId: 5042002, name: 'arc-testnet' }

    // Custom provider that delegates every RPC call to arc-rpc.js's own
    // forward() — a same-process function call, not an extra HTTP hop —
    // giving the swap's Arc RPC calls the SAME health-scored, quarantine-
    // aware racing across all 4+ endpoints that every other Arc-facing
    // feature already gets through /api/arc-rpc, instead of this file's
    // own separate, simpler FallbackProvider construction below.
    //
    // WHY THIS MATTERS HERE SPECIFICALLY: a swap that had already broadcast
    // and confirmed on-chain was still surfacing as "RPC endpoint error on
    // Arc Testnet" — a transient hiccup on whichever single provider
    // ethers' plain FallbackProvider happened to be using for the
    // confirmation-check step, not a real failure. arc-rpc.js's forward()
    // already solves exactly this class of problem (that's what it was
    // built for), it just wasn't being reused here.
    let ArcRpcForwardProvider = null
    try {
      const { forward } = require('./arc-rpc')
      class _ArcRpcForwardProvider extends JsonRpcProvider {
        constructor() {
          // This URL is never actually fetched from — _send is fully
          // overridden below. staticNetwork avoids a real network-detection
          // call against it on construction.
          super('http://arc-rpc.internal', ARC_NETWORK, { staticNetwork: true })
        }
        async _send(payload) {
          const isBatch = Array.isArray(payload)
          try {
            const result = await forward(payload)
            return isBatch ? result : [result]
          } catch (e) {
            // Match ethers' expected per-request error shape (an array of
            // JsonRpcError objects, not a rejected promise) so
            // JsonRpcApiProvider's own error-mapping logic still applies
            // normally on top of this.
            const reqs = isBatch ? payload : [payload]
            return reqs.map(p => ({ id: p.id, error: { code: -32603, message: e?.message || 'Arc RPC forward failed' } }))
          }
        }
      }
      ArcRpcForwardProvider = _ArcRpcForwardProvider
    } catch (e) {
      console.warn('[swap-proxy] could not load arc-rpc forward(), falling back to local FallbackProvider:', e?.message)
    }

    const adapter = createEthersAdapterFromPrivateKey({
      privateKey: normalizedKey,
      getProvider: ({ chain }) => {
        if (chain?.name?.toLowerCase().includes('arc')) {
          if (ArcRpcForwardProvider) return new ArcRpcForwardProvider()
          // Defensive fallback only — should not normally be reached.
          // quorum: 1 — treat this purely as failover, not multi-node consensus
          return new FallbackProvider(ARC_RPCS.map(url => new JsonRpcProvider(url, ARC_NETWORK, { staticNetwork: true })), undefined, { quorum: 1 })
        }
        return new JsonRpcProvider(chain?.rpcEndpoints?.[0] || ARC_RPCS[0])
      },
    })

    const baseParams = {
      from:     { adapter, chain: 'Arc_Testnet' },
      tokenIn:  String(tokenIn),
      tokenOut: String(tokenOut),
      amountIn: amountFormatted,
      config: {
        kitKey:      KIT_KEY,
        slippageBps: slip,
        // allowanceStrategy defaults to 'permit' (gasless EIP-2612 signature)
        // with automatic fallback to 'approve'. DO NOT force 'approve' — it adds
        // an extra on-chain transaction per swap (5–15s + extra gas).
      },
    }

    // ── ESTIMATE ──────────────────────────────────────────────────────────
    if (action === 'estimate') {
      try {
        const est = await kit.estimateSwap(baseParams)
        console.log('[swap-proxy] estimate OK:', JSON.stringify(est?.estimatedOutput))
        return res.status(200).json({
          estimatedOutput: est.estimatedOutput,
          stopLimit:       est.stopLimit,
          fees:            est.fees || [],
          // Circle's provider SDK reports gas separately from protocol/
          // forwarder fees (same shape MultichainSendPage's estimateBridge
          // already relies on for its gasFees). Forwarding it here lets the
          // frontend reserve the real network cost instead of guessing.
          gasFees:         est.gasFees || [],
        })
      } catch (e) {
        const { raw, userMessage, isLiquidity, isUncertain } = extractError(e)
        console.warn('[swap-proxy] estimate failed:', userMessage)
        return res.status(422).json({ error: userMessage, rawError: raw.slice(0, 200), isLiquidity, isUncertain })
      }
    }

    // ── SWAP ──────────────────────────────────────────────────────────────
    if (action === 'swap') {
      // Attempt 1: configured slippage, NO stopLimit
      // stopLimit from estimate causes false "no route" failures when pool
      // moves slightly between estimate and execute. Let the SDK decide.
      try {
        const result = await kit.swap(baseParams)
        console.log('[swap-proxy] ✓ swap OK txHash:', result?.txHash)
        if (result?.txHash) {
          await Promise.all([
            recordSwapActivity(walletAddress, result.txHash, parsedAmt, parseFloat(result?.amountOut || '0') || 0, String(tokenIn), String(tokenOut), intentId),
            markAttemptSubmittedServerSide(attemptId, result.txHash),
          ])
        }
        return res.status(200).json({
          txHash:      result?.txHash      || '',
          amountOut:   result?.amountOut   || '',
          explorerUrl: result?.explorerUrl || '',
        })
      } catch (e1) {
        const { raw: raw1, userMessage: msg1, isLiquidity, isUncertain } = extractError(e1)
        console.warn('[swap-proxy] attempt 1 failed:', msg1)

        // If the thrown error still carries a txHash, the underlying
        // transaction was genuinely broadcast — this is a confirmation-
        // check failure, not an on-chain failure. Record it now so
        // deposit-scan-all's exact-hash dedupe has something to match
        // against, same as the normal success path does below. Without
        // this, a swap that actually landed but whose confirmation-check
        // threw would never get its own 'swap' activity row created at
        // all — which is what let a "Swap Failed" screen coexist with a
        // real, successful on-chain swap that then got misfiled as a
        // spurious "Payment Received" external deposit (deposit-scan-all
        // had nothing to compare against, so both the exact-hash check and
        // the amount-based backstop had nothing to work with).
        const possibleHash = extractPossibleTxHash(e1)
        if (possibleHash) {
          console.warn('[swap-proxy] swap threw but a txHash was present — recording activity defensively:', possibleHash)
          await Promise.all([
            recordSwapActivity(walletAddress, possibleHash, parsedAmt, 0, String(tokenIn), String(tokenOut), intentId),
            markAttemptSubmittedServerSide(attemptId, possibleHash),
          ])
        } else if (isUncertain) {
          // No txHash on the error object at all — the common case for a
          // raw RPC connectivity error ("RPC endpoint error on Arc
          // Testnet"), since the failure happens at the transport layer
          // before any SDK code gets a chance to attach one. Check the
          // chain directly instead of giving up: did the expected output
          // token actually land in this wallet in roughly the last
          // minute? If so, this IS a real success, not a failure — return
          // it as one instead of making the user check manually.
          const landed = await verifySwapLanded(walletAddress, String(tokenOut))
          if (landed) {
            console.warn('[swap-proxy] verified swap landed on-chain despite the throw:', landed)
            await Promise.all([
              recordSwapActivity(walletAddress, landed.txHash, parsedAmt, landed.amount, String(tokenIn), String(tokenOut), intentId),
              markAttemptSubmittedServerSide(attemptId, landed.txHash),
            ])
            return res.status(200).json({
              txHash:      landed.txHash,
              amountOut:   String(landed.amount),
              explorerUrl: `https://testnet.arcscan.app/tx/${landed.txHash}`,
            })
          }
        }

        // Attempt 2: higher slippage (skip for liquidity errors — no point;
        // skip for uncertain errors — the first swap may have already
        // landed, and firing a second real swap attempt without knowing
        // that is exactly the double-spend risk this whole check exists to
        // prevent. Uncertain failures return immediately below instead.)
        if (!isLiquidity && !isUncertain && slip < 2000) {
          try {
            console.log('[swap-proxy] retrying with 2000bps slippage')
            const r2 = await kit.swap({ ...baseParams, config: { ...baseParams.config, slippageBps: 2000 } })
            console.log('[swap-proxy] ✓ retry OK txHash:', r2?.txHash)
            if (r2?.txHash) {
              await Promise.all([
                recordSwapActivity(walletAddress, r2.txHash, parsedAmt, parseFloat(r2?.amountOut || '0') || 0, String(tokenIn), String(tokenOut), intentId),
                markAttemptSubmittedServerSide(attemptId, r2.txHash),
              ])
            }
            return res.status(200).json({
              txHash:      r2?.txHash      || '',
              amountOut:   r2?.amountOut   || '',
              explorerUrl: r2?.explorerUrl || '',
            })
          } catch (e2) {
            const { userMessage: msg2, isUncertain: isUncertain2 } = extractError(e2)
            console.warn('[swap-proxy] retry failed:', msg2)
            return res.status(422).json({ error: msg2, isLiquidity: false, isUncertain: isUncertain2 })
          }
        }

        return res.status(422).json({ error: msg1, rawError: raw1.slice(0, 200), isLiquidity, isUncertain })
      }
    }

    return res.status(400).json({ error: 'Unknown action: ' + action })

  } catch (err) {
    const { raw, userMessage, isUncertain } = extractError(err)
    return res.status(500).json({ error: userMessage, rawError: raw.slice(0, 200), isUncertain })
  }
}
