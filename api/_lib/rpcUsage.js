// RPC usage counters for /api/arc-rpc → public.rpc_usage (admin System page).
//
// Two layers per call:
//   client   - one per JSON-RPC method the app asked the proxy for, with the
//              final outcome (what the app costs)
//   upstream - one per provider request the proxy actually sent, by endpoint
//              host (what providers bill; higher than client because the
//              proxy races up to three endpoints per call)
//
// Counted in memory and written in one batch (rpc_usage_bump) at most every
// FLUSH_MS, so a request never waits on the database except the one that
// happens to flush - and that write is capped at FLUSH_TIMEOUT_MS. Counts
// held by an instance that is frozen or recycled before its next flush are
// lost: the numbers are a close lower bound, not an invoice.

const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://cvvpzfvzweszuuxvaayb.supabase.co').trim()
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()

const FLUSH_MS = 30000
const FLUSH_TIMEOUT_MS = 1500
const MAX_KEYS = 500

const counters = new Map()
let lastFlush = Date.now()
let flushing = null

function bucketNow() {
  const d = new Date()
  d.setUTCSeconds(0, 0)
  d.setUTCMinutes(d.getUTCMinutes() - (d.getUTCMinutes() % 5))
  return d.toISOString()
}

/**
 * outcome: 'ok' | 'error' | 'rate_limited' | 'cancelled'
 * endpoint: a host label (never a URL with a key in it)
 */
function note(layer, endpoint, method, outcome, latencyMs) {
  if (!SERVICE_KEY) return
  const bucket = bucketNow()
  const key = `${bucket}|${layer}|${endpoint}|${method}`
  let c = counters.get(key)
  if (!c) {
    if (counters.size >= MAX_KEYS) return
    c = { bucket, source: 'arc-proxy', layer, endpoint: String(endpoint).slice(0, 120), method: String(method || 'unknown').slice(0, 64), calls: 0, ok: 0, errors: 0, rate_limited: 0, cancelled: 0, latency_ms_total: 0 }
    counters.set(key, c)
  }
  c.calls++
  if (outcome === 'ok') { c.ok++; c.latency_ms_total += Math.max(0, Math.round(latencyMs || 0)) }
  else if (outcome === 'rate_limited') { c.errors++; c.rate_limited++ }
  else if (outcome === 'cancelled') c.cancelled++
  else c.errors++
}

/** The method names in a JSON-RPC body (a batch counts each of its calls). */
function methodsOf(body) {
  const items = Array.isArray(body) ? body : [body]
  return items.map((b) => (b && typeof b.method === 'string' ? b.method : 'unknown'))
}

/** Writes the counters if FLUSH_MS has passed (or `force`). Never throws. */
async function flushIfDue(force = false) {
  if (!SERVICE_KEY || flushing || !counters.size) return
  if (!force && Date.now() - lastFlush < FLUSH_MS) return
  const rows = [...counters.values()]
  counters.clear()
  lastFlush = Date.now()
  flushing = fetch(`${SUPABASE_URL}/rest/v1/rpc/rpc_usage_bump`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_rows: rows }),
    signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
  })
    .then((r) => { if (!r.ok) console.warn(`[rpc-usage] flush failed: HTTP ${r.status}`) })
    .catch((e) => console.warn('[rpc-usage] flush failed:', e?.message ?? e))
    .finally(() => { flushing = null })
  await flushing
}

module.exports = { note, methodsOf, flushIfDue }
