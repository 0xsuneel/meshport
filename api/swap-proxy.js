// swap-proxy.js — CommonJS Vercel serverless function
//
// SECURITY FIX (transaction audit, 2026-09-17): this used to receive the
// user's raw private key in the request body and build a Circle AppKit
// adapter/signer from it SERVER-SIDE, so kit.swap()/kit.estimateSwap()
// could run here — meaning the private key was transmitted over the
// network to this Vercel function on every swap (and even a fire-and-
// forget page-mount warm-up call), breaking the "private key never leaves
// the device" boundary every other feature (Pay, ChatPay, Multichain
// Claim/Transfer) already respects.
//
// Swap now signs and estimates entirely client-side (see
// src/lib/swapService.ts) — the same AppKit + createEthersAdapterFromPrivateKey
// pattern Multichain Claim/Transfer already run in the browser. This
// function's only remaining job is the post-swap bookkeeping write, which
// needs the SUPABASE SERVICE_ROLE key (that must never reach the client)
// but only ever takes a txHash + amounts — never a private key.
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

// Writes the swap's own 'swap' activity row the moment the swap completes.
//
// WHY THIS EXISTS: deposit-scan-all (supabase/functions/deposit-scan-all)
// scans Arc directly for incoming transfers and already knows to skip a
// transfer if a 'swap' row for that same tx_hash already exists — a swap's
// output-token leg is otherwise indistinguishable on-chain from someone
// else sending you that token. But that dedupe check only works if the
// 'swap' row exists BY THE TIME deposit-scan-all's sweep runs. Writing it
// here, synchronously as part of this same request (which the client
// awaits — see swapService.ts's recordCompletion), closes that window down
// to milliseconds instead of a full network round-trip. The client's own
// Activity.swap() call still fires afterward as a fallback (harmless
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
        // client sent one — never required, on_conflict=ignore means an
        // older client that never sent intentId still writes a valid row.
        ...(intentId ? { transaction_intent_id: intentId } : {}),
      }),
    })
  } catch (e) {
    console.warn('[swap-proxy] recordSwapActivity failed (non-fatal):', e?.message)
  }
}

// Persists the real tx_hash onto transaction_attempts SYNCHRONOUSLY, in
// this same server-side request — rather than depending solely on the
// client's own separate, fire-and-forget markSwapAttemptSubmitted call
// (src/lib/swapIntentService.ts), which can be lost to a tab close, a
// crash, or a network failure between the swap landing and that follow-up
// request ever firing. This closes the actual root cause of the
// tx_hash-loss/orphan class of bug (see docs/ORPHANED_SWAP_INCIDENT.md for
// the real production case this was written for).
//
// Best-effort by design, same as recordSwapActivity: never throws, never
// blocks or fails the response for an already-broadcast, already-real
// swap. The client's own call still fires afterward as a second,
// redundant write — harmless, because both go through the identical
// idempotent guard below (`status=eq.CREATED&tx_hash=is.null`), so
// whichever lands first wins and the second is simply a no-op.
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

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const { action, walletAddress, txHash, amountIn, amountOut, tokenIn, tokenOut, intentId, attemptId } = req.body || {}

    // The only action this function handles now — see the file header for
    // why 'estimate'/'swap' were removed. A request for either of those
    // (an old cached client, a stale service worker) gets a clear error
    // instead of silently doing nothing.
    if (action !== 'recordCompletion') {
      return res.status(400).json({ error: `Unknown or removed action: ${action}. Swap now executes client-side — see src/lib/swapService.ts.` })
    }
    if (!walletAddress || !txHash) {
      return res.status(400).json({ error: 'Missing required fields: walletAddress, txHash' })
    }

    await Promise.all([
      recordSwapActivity(walletAddress, txHash, amountIn, amountOut, tokenIn, tokenOut, intentId),
      markAttemptSubmittedServerSide(attemptId, txHash),
    ])

    return res.status(200).json({ success: true })
  } catch (err) {
    console.error('[swap-proxy] recordCompletion failed:', err?.message)
    return res.status(500).json({ error: 'Failed to record swap completion' })
  }
}
