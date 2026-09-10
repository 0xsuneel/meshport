/**
 * /api/arc-rpc — Arc Testnet JSON-RPC proxy
 *
 * This is the SINGLE entry point every frontend Arc RPC call goes through
 * (Home balance polling, Swap, Multichain Transfer, Multichain Claim,
 * Rewards — all via src/lib/arc.ts's arcTransport()/arcRpcJson(), which
 * only ever call this route). It tries an authenticated Arc endpoint first
 * (DRPC_KEY and/or ARC_RPC_URL, both plain server-side env vars, never
 * exposed to the client) for its higher rate limits, then fails over to
 * Circle's own official public Arc Testnet RPC endpoints — see ARC_RPCS
 * below and https://docs.arc.io/arc/references/connect-to-arc. The browser
 * only ever sees this same-origin route either way.
 *
 * Failover mechanics (see forward() below): every upstream's success rate,
 * failure count, average latency, and last success time are tracked
 * in-memory, and each request races the endpoints in order of a live
 * health score (success rate first, latency as a secondary penalty) with
 * a small stagger — so the actually-healthiest endpoint is preferred, not
 * just whichever happened to answer most recently. An endpoint that fails
 * is quarantined with exponential backoff and automatically becomes
 * eligible again once the window passes (no separate recovery step). Every
 * outcome is logged with its current health stats. If every endpoint
 * fails, the existing JSON-RPC-shaped 502 error response is returned
 * (handler below) — same as before, callers never see an unhandled
 * exception.
 */

// drpc.live API key — set DRPC_KEY in Vercel environment variables (never
// VITE_-prefixed — this must stay server-side only).
const DRPC_KEY = process.env.DRPC_KEY ?? ''

// Optional explicit authenticated RPC URL override — set ARC_RPC_URL (NOT
// VITE_ARC_RPC_URL) in Vercel if you want to point at a specific
// authenticated gateway instead of/in addition to DRPC_KEY. This must never
// be a VITE_-prefixed variable: Vite inlines every VITE_* var into the
// client bundle, so a credential placed there would be visible to anyone
// who opens devtools. A plain (non-VITE_) env var is only readable here,
// server-side.
const CONFIGURED_ARC_RPC_URL = (process.env.ARC_RPC_URL || '').trim()

// Alchemy — Arc's own partnered node provider (see
// https://docs.arc.io/arc/references/rpc-endpoints, "Node providers", and
// https://community.arc.network/public/blogs/arc-x-alchemy). Unlike
// Blockdaemon/dRPC/QuickNode below, Alchemy has no free keyless public
// endpoint for Arc — set ALCHEMY_ARC_KEY in Vercel (get one at
// https://dashboard.alchemy.com/chains/arc) to use it. URL format confirmed
// directly from Alchemy's own Arc Testnet page (alchemy.com/rpc/arc-testnet).
const ALCHEMY_ARC_KEY = (process.env.ALCHEMY_ARC_KEY || '').trim()

// Authenticated endpoint(s) tried first (higher rate limits when configured),
// then Circle's own official public Arc Testnet RPC endpoints as fallback —
// see https://docs.arc.io/arc/references/rpc-endpoints ("RPC endpoints").
// These are free, keyless, and Circle-operated specifically for this use
// case, so they're a legitimate fallback (not a random third-party gateway)
// for when the authenticated endpoint above is empty, down, or rate-limited.
// Previously this list had ONLY the authenticated DRPC_KEY entry, which made
// it a single point of failure — any rate limit on that one key took down
// every Arc-facing feature (Home balance polling, Swap, Multichain Transfer/
// Claim, Rewards) at once, with nothing to fail over to.
// Circle appears to have migrated Arc's documented RPC domain from
// *.arc.network to *.arc.io at some point after this proxy was first
// written (docs.arc.io/arc/references/connect-to-arc now lists .arc.io as
// primary for every provider). Keeping BOTH domain families here rather
// than swapping one for the other — if .network is being deprecated/
// under-provisioned that would explain recent 502s, but until that's
// confirmed, having every known-good endpoint in the race is strictly
// safer than guessing which one to drop.
const ARC_RPCS = [
  ...(CONFIGURED_ARC_RPC_URL ? [CONFIGURED_ARC_RPC_URL] : []),
  ...(DRPC_KEY ? [`https://lb.drpc.live/arc-testnet/${DRPC_KEY}`] : []), // dRPC authenticated — tried first
  ...(ALCHEMY_ARC_KEY ? [`https://arc-testnet.g.alchemy.com/v2/${ALCHEMY_ARC_KEY}`] : []),
  // Current official domain (docs.arc.io, as of this writing)
  'https://rpc.testnet.arc.io',             // Circle primary
  'https://rpc.blockdaemon.testnet.arc.io', // Blockdaemon
  'https://rpc.drpc.testnet.arc.io',        // dRPC (Circle-provisioned, keyless)
  'https://rpc.quicknode.testnet.arc.io',   // QuickNode
  // Legacy/alternate domain — kept as extra fallback capacity, harmless if
  // still live, free redundancy if .io ever has its own bad day.
  'https://rpc.testnet.arc.network',
  'https://rpc.blockdaemon.testnet.arc.network',
  'https://rpc.drpc.testnet.arc.network',
  'https://rpc.quicknode.testnet.arc.network',
]

// RELIABILITY FIX: every known Arc testnet RPC provider (Alchemy,
// Blockdaemon, dRPC, QuickNode) is already represented above — there is no
// 5th/6th distinct official provider to add (confirmed against Circle's own
// docs.arc.io/arc/references/rpc-endpoints). What actually varies is that
// the KEYLESS public endpoints (everything below the authenticated block)
// are shared by every app hitting Arc testnet, and get rate-limited (HTTP
// 429) hard under load — visible directly in this function's own logs.
// The authenticated endpoints (DRPC_KEY, ALCHEMY_ARC_KEY, an explicit
// ARC_RPC_URL override) are paid/private capacity, not shared with the
// public internet's traffic, so they should be preferred structurally —
// not just when orderEndpoints()'s learned health score happens to already
// favor them, which only kicks in AFTER they've accumulated a good track
// record on a warm Lambda instance (cold starts get no such head start).
const AUTHENTICATED_RPCS = new Set([
  ...(CONFIGURED_ARC_RPC_URL ? [CONFIGURED_ARC_RPC_URL] : []),
  ...(DRPC_KEY ? [`https://lb.drpc.live/arc-testnet/${DRPC_KEY}`] : []),
  ...(ALCHEMY_ARC_KEY ? [`https://arc-testnet.g.alchemy.com/v2/${ALCHEMY_ARC_KEY}`] : []),
])
function isAuthenticated(url) { return AUTHENTICATED_RPCS.has(url) }

// ─── Per-endpoint health stats (in-memory, per warm Lambda instance) ───────
// Tracks, for each upstream in ARC_RPCS: how many calls succeeded/failed,
// the running average latency of successful calls, and when it last
// succeeded. Resets on cold start — fine, worst case we just relearn the
// health picture over the next few requests.
function newStats() {
  return {
    success: 0,
    failure: 0,
    totalLatencyMs: 0,   // sum over successful calls; avg = totalLatencyMs / success
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
    quarantinedUntil: 0,
  }
}
const stats = new Map(ARC_RPCS.map((u) => [u, newStats()]))
function getStats(url) {
  if (!stats.has(url)) stats.set(url, newStats())
  return stats.get(url)
}

const STAGGER_MS = 150
// TUNED: Arc finalizes deterministically in ~780ms per Circle's own docs —
// a genuinely healthy node has no reason to take anywhere near 8s to
// answer a simple eth_call/estimateGas/sendRawTransaction. Cut to 5s so a
// struggling endpoint gets abandoned (and the next-ranked one gets its
// turn) faster, rather than eating most of a user-facing button's patience
// on a single doomed attempt.
const RPC_TIMEOUT_MS = 5000
// Quarantine backs off exponentially with repeated failures (10s, 20s,
// 40s, ... capped at 2min) and is lifted the instant a request succeeds —
// this is the "automatic recovery" path: once the window passes, the
// endpoint is simply eligible again on the next request, no separate
// recovery step needed. A single blip only costs it 10s, a genuinely dead
// node backs off further instead of being retried every request forever.
const BASE_QUARANTINE_MS = 10000
const MAX_QUARANTINE_MS = 120000

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// ─── Deterministic on-chain errors are NOT transport failures ─────────────
// THE BUG THIS FIXES: every upstream in ARC_RPCS replays the exact same
// chain state, so a JSON-RPC error that comes from actually EXECUTING the
// call (eth_estimateGas / eth_call hitting a Solidity `require(...)`) is
// not a fluke of one node — it is the correct, authoritative answer, and
// every other endpoint will return the byte-identical message. The old
// code below treated ANY `json.error` (a mis-signed tx, a rate-limit body
// shaped like JSON-RPC, AND a genuine `execution reverted: ...`) the same
// way: throw, quarantine that endpoint, let another one take a turn. For a
// real revert that "another turn" is pointless — it fails the exact same
// way on all 10 endpoints — so every attempt in the race throws, Promise.any
// rejects, and the handler below returns a generic 502 "Bad Gateway".
//
// That 502 is actively misleading: nothing was down. It also produces a
// second-order bug client-side — p2pEscrowContract.ts's own
// isTransientRpcError() sees "502"/"bad gateway" in the message and
// retries the doomed call 2 more times (1s, 2s) before finally giving up,
// throwing away the actual revert reason ("account must already be a
// pauser", "trade not active", "no active escrow for this offer") in favor
// of an opaque gateway error. This is almost entirely a P2P-section
// problem because P2P's admin/dispute/escrow actions are the main place
// this app calls estimateGas against `require()`-heavy contract writes;
// Home/Swap/Transfer mostly do plain reads and transfers that rarely hit
// a revert path at all.
//
// Fix: recognize a revert-shaped JSON-RPC error as a legitimate, authoritative
// answer — record the endpoint as successful (it answered correctly) and
// resolve with that JSON-RPC body immediately, exactly like a real node
// would. Genuinely ambiguous/transient-looking errors (rate limits, range
// limits, malformed bodies) still fall through to the old
// throw-and-fail-over behavior.
function isDeterministicRevertError(errorObj) {
  const msg = String(errorObj?.message ?? '').toLowerCase()
  // eth_estimateGas/eth_call surface a revert this way across every EVM
  // JSON-RPC implementation (Alchemy, dRPC, Blockdaemon, QuickNode, geth,
  // etc.) — it's the one error shape that's actually chain-state, not
  // node-state, so racing/failing over other endpoints can never change it.
  return msg.includes('execution reverted') || msg.includes('always failing transaction')
}

function isQuarantined(url) {
  return getStats(url).quarantinedUntil > Date.now()
}

function recordSuccess(url, latencyMs) {
  const s = getStats(url)
  s.success += 1
  s.totalLatencyMs += latencyMs
  s.lastSuccessAt = Date.now()
  s.consecutiveFailures = 0
  s.quarantinedUntil = 0
}

function recordFailure(url) {
  const s = getStats(url)
  s.failure += 1
  s.lastFailureAt = Date.now()
  s.consecutiveFailures += 1
  const backoff = Math.min(BASE_QUARANTINE_MS * 2 ** (s.consecutiveFailures - 1), MAX_QUARANTINE_MS)
  s.quarantinedUntil = Date.now() + backoff
}

function successRate(s) {
  const total = s.success + s.failure
  // No data yet → treat as optimistic (1.0) so a fresh/unproven endpoint
  // still gets a fair shot instead of always sorting last.
  return total === 0 ? 1 : s.success / total
}

function avgLatencyMs(s) {
  return s.success === 0 ? 0 : s.totalLatencyMs / s.success
}

// Single score combining success rate and latency so the ranking always
// prefers the actually-healthiest endpoint, not just whichever happened to
// answer last. Success rate dominates (an unreliable-but-fast endpoint
// should still rank below a reliable-but-slower one); latency is a
// secondary tiebreaker/penalty on top of that, capped so one very slow
// outlier can't swing the score more than a reliability difference would.
//
// RELIABILITY FIX: authenticated endpoints get a fixed head-start bonus on
// top of their learned score. Without this, a cold Lambda instance (no
// accumulated stats yet — see successRate()'s "no data = 1.0" default)
// ranks a paid Alchemy/dRPC key EXACTLY the same as a free public endpoint
// that's currently being hammered by every other app on Arc testnet, so
// the race is a coin flip on the very requests where it matters most (right
// after a cold start or a burst of public-endpoint 429s). The bonus is
// smaller than a full reliability tier (0.15, vs. the 0-1 range of rate
// itself) so a genuinely struggling authenticated endpoint can still be
// correctly outranked by a public one with a proven track record — this
// is a thumb on the scale, not an override.
function healthScore(url) {
  const s = getStats(url)
  const rate = successRate(s)
  const latencyPenalty = Math.min(avgLatencyMs(s) / 4000, 1) * 0.25
  const authBonus = isAuthenticated(url) ? 0.15 : 0
  return rate - latencyPenalty + authBonus
}

// Healthiest-first: rank every non-quarantined endpoint by live health
// score, quarantined ones excluded — unless EVERY endpoint is quarantined,
// in which case fail open and try them all anyway (ranked the same way)
// rather than erroring out on a stale quarantine.
function orderEndpoints() {
  const live = ARC_RPCS.filter((u) => !isQuarantined(u))
  const pool = live.length ? live : ARC_RPCS
  return [...pool].sort((a, b) => healthScore(b) - healthScore(a))
}

async function forward(body) {
  if (ARC_RPCS.length === 0) {
    throw new Error('No authenticated Arc RPC configured — set ARC_RPC_URL or DRPC_KEY')
  }

  // PERF: this used to try each endpoint SEQUENTIALLY with a 10s timeout
  // per hop — if the first (authenticated) endpoint was merely slow, not
  // even down, every call through this proxy paid the full 10s before it
  // even started the next one. Since this is the single entry point every
  // Arc-facing feature goes through (see file header), that tax applied to
  // balance polling, nonce fetches, and every RPC call inside Multichain
  // Transfer — not just the rare case where an endpoint is fully dead.
  //
  // Racing every configured endpoint at once and taking whichever answers
  // first fixes both the common case and the rare one: happy path is as
  // fast as the single fastest endpoint (never slower than a healthy
  // primary was before), and a degraded/dead primary just loses the race
  // instead of blocking anything. This mirrors the ethers
  // FallbackProvider(quorum: 1) pattern already used in swap-proxy.js and
  // relay-deposit.js — applied by hand here since this function forwards
  // raw JSON-RPC bodies rather than using ethers Provider objects.
  //
  // Safe for every method here, including eth_sendRawTransaction: sending
  // the same signed tx to multiple nodes at once is a standard broadcast
  // pattern (the network dedupes it) — it's not a double-send risk the way
  // re-signing or re-calling bridge() would be.
  //
  // On top of the pure race, each attempt is staggered by its rank
  // (STAGGER_MS apart) instead of firing simultaneously, and ranked by
  // live health score (see orderEndpoints/healthScore above) rather than
  // just "last one that worked" — an endpoint with a bad success rate or
  // creeping latency gradually sinks in priority even if its most recent
  // call happened to succeed. A healthy top-ranked endpoint still wins in
  // ~1 round trip; a slow/unstable one just loses the race a beat sooner
  // than lower-ranked ones start — without reintroducing the full
  // sequential-timeout tax the comment above describes fixing.
  const ordered = orderEndpoints()

  const attempts = ordered.map((url, i) => (async () => {
    if (i > 0) await sleep(i * STAGGER_MS)
    const startedAt = Date.now()
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`)
      const json = await r.json()
      const latencyMs = Date.now() - startedAt
      // A JSON-RPC-shaped error is USUALLY treated the same as a transport
      // failure for a single request — another endpoint may still answer
      // correctly (a mis-shaped body, a rate-limit response dressed up as
      // JSON-RPC, etc). The one exception is a genuine on-chain revert
      // (see isDeterministicRevertError's own comment above) — that IS the
      // correct answer, identical on every endpoint, so it's recorded as a
      // success and returned immediately rather than raced/failed-over.
      // Batch (array) bodies are returned as-is either way; per-item errors
      // are the caller's problem, same as any other JSON-RPC gateway.
      if (!Array.isArray(json) && json?.error) {
        if (isDeterministicRevertError(json.error)) {
          recordSuccess(url, latencyMs)
          console.log(`[arc-rpc] ${url} returned an on-chain revert (${latencyMs}ms) — authoritative, not a failure: ${json.error.message}`)
          return json
        }
        throw new Error(json.error.message || 'RPC error')
      }
      recordSuccess(url, latencyMs)
      const s = getStats(url)
      console.log(`[arc-rpc] served by ${url} (${latencyMs}ms, ${(successRate(s) * 100).toFixed(0)}% success, avg ${avgLatencyMs(s).toFixed(0)}ms)`)
      return json
    } catch (e) {
      recordFailure(url)
      console.error(`[arc-rpc] ${url} failed: ${e?.message ?? e} (quarantined ${Math.round((getStats(url).quarantinedUntil - Date.now()) / 1000)}s)`)
      throw e
    }
  })())

  try {
    return await Promise.any(attempts)
  } catch (aggErr) {
    // Promise.any rejects with an AggregateError when every attempt fails —
    // surface the first underlying error rather than the wrapper so
    // callers/logs see an actual RPC error message.
    throw (aggErr && aggErr.errors && aggErr.errors[0]) || aggErr || new Error('All Arc RPC endpoints failed')
  }
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || ''
  res.setHeader('Access-Control-Allow-Origin', origin.includes('localhost') ? origin : (process.env.ALLOWED_ORIGIN || '*'))
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  try {
    const result = await forward(req.body)
    return res.status(200).json(result)
  } catch (e) {
    console.error('[arc-rpc] failed:', e?.message)
    return res.status(502).json({ error: e?.message ?? 'Arc RPC proxy failed' })
  }
}

// Exposed so other server-side functions in this deployment (e.g.
// swap-proxy.js) can call the same health-scored, quarantine-aware racing
// logic directly — a same-process function call, not an extra HTTP hop —
// instead of maintaining their own separate, simpler RPC failover.
module.exports.forward = forward
