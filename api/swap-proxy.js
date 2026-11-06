// swap-proxy.js - CommonJS Vercel serverless function
//
// SECURITY FIX (transaction audit, 2026-09-17): this used to receive the
// user's raw private key in the request body and build a Circle AppKit
// adapter/signer from it SERVER-SIDE, so kit.swap()/kit.estimateSwap()
// could run here - meaning the private key was transmitted over the
// network to this Vercel function on every swap (and even a fire-and-
// forget page-mount warm-up call), breaking the "private key never leaves
// the device" boundary every other feature (Pay, ChatPay, Multichain
// Claim/Transfer) already respects.
//
// Swap now signs and estimates entirely client-side (see
// src/lib/swapService.ts) - the same AppKit + createEthersAdapterFromPrivateKey
// pattern Multichain Claim/Transfer already run in the browser. This
// function's only remaining job is the post-swap bookkeeping write, which
// needs the SUPABASE SERVICE_ROLE key (that must never reach the client)
// but only ever takes a txHash + amounts - never a private key.
const SUPABASE_URL = (
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  ''
).trim()
if (!SUPABASE_URL) console.warn('[swap-proxy] SUPABASE_URL is not set - session verification will fail')
const SUPABASE_SERVICE_KEY = (
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  ''
).trim()

// ── Access control (fixes /cso finding #5 - recordCompletion had NO caller
// check at all: anyone could POST an arbitrary walletAddress + fabricated
// txHash/amounts and it would write a fake "completed swap" into that
// wallet's activity feed via the service-role key, or inject a fake
// tx_hash into another user's in-flight transaction_attempts row). Same
// verify-session-owns-address pattern as api/bridge-relay.ts.
async function verifyOwnsAddress(req, walletAddress) {
  const token = String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '')
  if (!token) return false
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${token}` } })
  if (!r.ok) return false
  const u = await r.json().catch(() => null)
  const authUid = (u && typeof u.id === 'string') ? u.id : ''
  if (!authUid) return false
  const ur = await fetch(`${SUPABASE_URL}/rest/v1/users?auth_uid=eq.${authUid}&select=wallet_address`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  })
  const rows = ur.ok ? await ur.json().catch(() => []) : []
  const row = Array.isArray(rows) ? rows[0] : null
  return !!(row && row.wallet_address && String(row.wallet_address).toLowerCase() === walletAddress.toLowerCase())
}

// Writes the swap's own 'swap' activity row the moment the swap completes.
//
// WHY THIS EXISTS: deposit-scan-all (supabase/functions/deposit-scan-all)
// scans Arc directly for incoming transfers and already knows to skip a
// transfer if a 'swap' row for that same tx_hash already exists - a swap's
// output-token leg is otherwise indistinguishable on-chain from someone
// else sending you that token. But that dedupe check only works if the
// 'swap' row exists BY THE TIME deposit-scan-all's sweep runs. Writing it
// here, synchronously as part of this same request (which the client
// awaits - see swapService.ts's recordCompletion), closes that window down
// to milliseconds instead of a full network round-trip. The client's own
// Activity.swap() call still fires afterward as a fallback (harmless
// no-op via the same on_conflict=ignore-duplicates upsert) in case this
// call fails or Supabase env vars aren't configured for this function.
async function recordSwapActivity(walletAddress, txHash, amountIn, amountOut, tokenIn, tokenOut, intentId) {
  if (!SUPABASE_SERVICE_KEY || !walletAddress || !txHash) return
  try {
    // A row that already exists is kept - except that a real output amount
    // replaces a placeholder 0 written earlier (a swap recorded before its
    // receipt was read).
    const knownAmount = Number(amountOut) > 0
    const r = await fetch(`${SUPABASE_URL}/rest/v1/activity?on_conflict=tx_hash,wallet_address`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        `return=minimal,resolution=${knownAmount ? 'merge-duplicates' : 'ignore-duplicates'}`,
      },
      body: JSON.stringify({
        wallet_address: walletAddress.toLowerCase(),
        tx_hash:        txHash.toLowerCase(),
        activity_type:  'swap',
        amount:         amountIn,
        usd_value:      amountIn,
        token_symbol:   tokenIn,
        status:         'completed',
        explorer_url:   `https://explorer.testnet.arc.io/tx/${txHash}`,
        metadata:       { tokenIn, tokenOut, amountIn, amountOut },
        // Best-effort traceability back to the canonical intent, when the
        // client sent one - never required, on_conflict=ignore means an
        // older client that never sent intentId still writes a valid row.
        ...(intentId ? { transaction_intent_id: intentId } : {}),
      }),
    })
    if (!r.ok) console.warn('[swap-proxy] recordSwapActivity non-200:', r.status, await r.text().catch(() => ''))
  } catch (e) {
    console.warn('[swap-proxy] recordSwapActivity failed (non-fatal):', e?.message)
  }
}

// Persists the real tx_hash onto transaction_attempts SYNCHRONOUSLY, in
// this same server-side request - rather than depending solely on the
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
// redundant write - harmless, because both go through the identical
// idempotent guard below (`status=eq.CREATED&tx_hash=is.null`), so
// whichever lands first wins and the second is simply a no-op.
async function markAttemptSubmittedServerSide(attemptId, txHash, walletAddress) {
  if (!SUPABASE_SERVICE_KEY || !attemptId || !txHash) return
  try {
    // wallet_address=eq. scopes this to an attempt the verified caller
    // actually owns - closes the "guess someone else's attemptId" injection.
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/transaction_attempts?id=eq.${encodeURIComponent(attemptId)}&status=eq.CREATED&tx_hash=is.null&wallet_address=eq.${encodeURIComponent(walletAddress.toLowerCase())}`,
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

// ── Circle Stablecoin Service relay (swap quotes + swap transactions) ─────
// Circle's swap service needs the kit key, and the App Kit SDK refuses to
// send a key from a browser (it's a server-only secret). Without it every
// quote fails with "Invalid or missing API key or authorization". So the
// browser's SDK calls to https://api.circle.com/v1/stablecoinKits/* are
// routed here (see swapService.ts) and forwarded with KIT_KEY added. The
// request only carries public swap details (tokens, amount, wallet
// address) - the private key never leaves the device; the SDK still signs
// the returned transaction locally.
const KIT_KEY = (process.env.KIT_KEY || '').trim()
const SVC_ORIGIN = 'https://api.circle.com'
const SVC_PREFIX = '/v1/stablecoinKits/'

// Session check cache (token → { wallet, canSpend, exp }) so each quote
// refresh doesn't cost extra Supabase round-trips. canSpend is
// public.account_can_spend (false for a business account MeshPort hasn't
// approved yet); only accounts that can spend are cached, so an approval or
// revocation is seen on the next request.
const _sessions = new Map()
async function sessionInfo(req) {
  const token = String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '')
  if (!token) return null
  const hit = _sessions.get(token)
  if (hit && hit.exp > Date.now()) return hit
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${token}` } })
  if (!r.ok) return null
  const u = await r.json().catch(() => null)
  const authUid = (u && typeof u.id === 'string') ? u.id : ''
  if (!authUid) return null
  const [ur, cr] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/users?auth_uid=eq.${authUid}&select=wallet_address`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    }),
    fetch(`${SUPABASE_URL}/rest/v1/rpc/account_can_spend`, {
      method: 'POST',
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_auth_uid: authUid }),
    }).catch(() => null),
  ])
  const rows = ur.ok ? await ur.json().catch(() => []) : []
  const wallet = String((Array.isArray(rows) && rows[0] && rows[0].wallet_address) || '').toLowerCase()
  const canSpendRaw = cr && cr.ok ? await cr.json().catch(() => null) : null
  const info = { wallet, canSpend: typeof canSpendRaw === 'boolean' ? canSpendRaw : null, exp: Date.now() + 5 * 60_000 }
  if (info.canSpend === true) {
    // LRU eviction: drop only the oldest entry at the cap, not the whole
    // cache - a full .clear() caused a thundering herd of auth lookups under
    // load (same fix already applied to bridge-relay.ts).
    if (_sessions.size >= 500) {
      const firstKey = _sessions.keys().next().value
      if (firstKey !== undefined) _sessions.delete(firstKey)
    }
    _sessions.set(token, info)
  }
  return info
}

// Express: is `key` one of `owner`'s live session keys? Permit2 allowance
// (owner, token, key) with an amount left and not expired, for USDC, EURC or
// cirBTC on Arc. Cached briefly per pair.
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
const EXPRESS_TOKENS = ['0x3600000000000000000000000000000000000000', '0x89b50855aa3be2f677cd6303cec089b5f319d72a', '0xf0c4a4ce82a5746abaad9425360ab04fbba432bf']
const ARC_RPCS = [(process.env.ARC_RPC_URL || '').trim(), 'https://rpc.testnet.arc.io'].filter(Boolean)
const expressKeyCache = new Map()
async function isExpressKeyOf(owner, key) {
  if (!/^0x[0-9a-f]{40}$/.test(owner) || !/^0x[0-9a-f]{40}$/.test(key)) return false
  const ck = owner + ':' + key
  const hit = expressKeyCache.get(ck)
  if (hit && hit.exp > Date.now()) return hit.ok
  const pad = (a) => a.slice(2).padStart(64, '0')
  const nowS = Math.floor(Date.now() / 1000)
  let ok = false
  for (const token of EXPRESS_TOKENS) {
    // allowance(address owner, address token, address spender) → (uint160 amount, uint48 expiration, uint48 nonce)
    const data = '0x927da105' + pad(owner) + pad(token) + pad(key)
    for (const url of ARC_RPCS) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: PERMIT2, data }, 'latest'] }), signal: AbortSignal.timeout(4000) })
        const j = await r.json()
        const out = String(j && j.result || '')
        if (out.length >= 2 + 64 * 2) {
          const amount = BigInt('0x' + out.slice(2, 66))
          const expiration = Number(BigInt('0x' + out.slice(66, 130)))
          if (amount > 0n && expiration > nowS) ok = true
          break
        }
      } catch { /* next RPC */ }
    }
    if (ok) break
  }
  expressKeyCache.set(ck, { ok, exp: Date.now() + (ok ? 60_000 : 10_000) })
  return ok
}

async function relayStablecoinService(req, res, svcPath) {
  if (!KIT_KEY) return res.status(503).json({ message: 'Swap service key is not configured' })
  // Only the two swap endpoints the App Kit SDK calls. Resolve the URL first
  // and check the result, so encoded dot-segments (%2e%2e) can't walk out of
  // the swap API onto other Circle endpoints with our key.
  if (/%|\\/.test(svcPath)) return res.status(400).json({ message: 'Bad service path' })
  let target
  try { target = new URL(svcPath, SVC_ORIGIN) } catch { return res.status(400).json({ message: 'Bad service path' }) }
  const ALLOWED = ['/v1/stablecoinKits/swap', '/v1/stablecoinKits/swap/status']
  if (target.origin !== SVC_ORIGIN || !ALLOWED.includes(target.pathname)) return res.status(400).json({ message: 'Bad service path' })
  if (target.pathname.endsWith('/swap') && req.method !== 'POST') return res.status(405).json({ message: 'POST only' })
  const session = await sessionInfo(req)
  const wallet = session && session.wallet
  if (!wallet) return res.status(403).json({ message: 'Not signed in' })
  // Business accounts can't swap until MeshPort approves them.
  if (session.canSpend === false) return res.status(403).json({ message: 'Available after your business is approved', error: 'Available after your business is approved' })
  if (session.canSpend !== true) return res.status(503).json({ message: 'Could not check your account - please try again' })
  let body
  if (req.method === 'POST') {
    body = req.body && typeof req.body === 'object' ? req.body : {}
    // A quote/transaction may only be prepared for the caller's own wallet -
    // or for the caller's Express key (lib/fastPay: the session key swaps
    // and the output goes to the wallet), when the output goes to the
    // caller's wallet AND Arc shows the wallet granted that key a live
    // Permit2 allowance.
    const from = String(body.fromAddress || '').toLowerCase()
    if (from && from !== wallet) {
      const to = String(body.toAddress || '').toLowerCase()
      if (to !== wallet || !(await isExpressKeyOf(wallet, from))) return res.status(403).json({ message: 'Wallet mismatch' })
    }
    body = JSON.stringify(body)
  }
  const r = await fetch(target.href, {
    method: req.method === 'POST' ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KIT_KEY}` },
    body,
  })
  const text = await r.text()
  if (!r.ok) console.warn('[swap-proxy] stablecoin service', target.pathname, r.status, text.slice(0, 200))
  return res.status(r.status).send(text)
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  const svc = req.query && req.query.svc
  if (typeof svc === 'string' && svc) {
    try { return await relayStablecoinService(req, res, svc) }
    catch (e) {
      console.error('[swap-proxy] stablecoin relay failed:', e?.message)
      return res.status(502).json({ message: 'Swap service unreachable' })
    }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const { action, walletAddress, txHash, amountIn, amountOut, tokenIn, tokenOut, intentId, attemptId } = req.body || {}

    // The only action this function handles now - see the file header for
    // why 'estimate'/'swap' were removed. A request for either of those
    // (an old cached client, a stale service worker) gets a clear error
    // instead of silently doing nothing.
    if (action !== 'recordCompletion') {
      return res.status(400).json({ error: `Unknown or removed action: ${action}. Swap now executes client-side - see src/lib/swapService.ts.` })
    }
    if (!walletAddress || !txHash) {
      return res.status(400).json({ error: 'Missing required fields: walletAddress, txHash' })
    }
    if (!(await verifyOwnsAddress(req, walletAddress))) {
      console.warn('[swap-proxy] rejected: no session, or session does not own', walletAddress)
      return res.status(403).json({ error: 'Not signed in to this wallet' })
    }

    await Promise.all([
      recordSwapActivity(walletAddress, txHash, amountIn, amountOut, tokenIn, tokenOut, intentId),
      markAttemptSubmittedServerSide(attemptId, txHash, walletAddress),
    ])

    return res.status(200).json({ success: true })
  } catch (err) {
    console.error('[swap-proxy] recordCompletion failed:', err?.message)
    return res.status(500).json({ error: 'Failed to record swap completion' })
  }
}
