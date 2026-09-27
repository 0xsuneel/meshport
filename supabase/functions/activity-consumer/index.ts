// supabase/functions/activity-consumer/index.ts
//
// ═══════════════════════════════════════════════════════════════════════════
// The chain_events -> activity consumer. This is what makes Phase 5's
// `authoritative = true` FUNCTIONAL rather than declarative.
//
//   Blockchain -> blockchain-indexer -> chain_events -> [THIS] -> activity
//                                                              -> SyncCoordinator -> UI
//
// ── Why this function exists ────────────────────────────────────────────────
// blockchain-indexer writes ONLY chain_events, indexer_shadow_reports and
// chain_cursors. It never writes `activity` (it reads it with .select only).
// So before this function, `shadow_mode.authoritative = true` changed nothing:
// deposit-scan-all's recordExternalReceive was still the only thing crediting a
// deposit. This closes that gap.
//
// ── Why it does NOT replace deposit-scan-all yet ────────────────────────────
// Both producers now converge on the SAME activity identity —
// tx_hash = 'recv_<hash>' with the unique index on (tx_hash, wallet_address) —
// so whichever sees a deposit first wins and the other's upsert is ignored.
// That makes them safely redundant, not competing, which is exactly what a
// cutover needs: run both, prove this one matches, then retire the old one.
// Retiring deposit-scan-all is a SEPARATE, LATER step and is not done here.
//
// ── Idempotency: no cursor, by design ──────────────────────────────────────
// There is deliberately no cursor table. "Unprocessed" is derived from the data
// itself: an event needs crediting iff no activity row exists for its
// (recv_<hash>, wallet). That is naturally restart-safe, safe under concurrent
// invocations, and impossible to desynchronise — a cursor could skip an event if
// it advanced past a row whose insert later failed. The lookback window bounds
// the scan so history is never re-read in full.
//
// The DURABLE guarantee is the unique index, not this function's logic: even if
// two invocations race on the same event, the second upsert is a no-op.
//
// SAFETY: this function only ever INSERTS activity rows of type 'receive', and
// only via upsert-ignore-duplicates. It never updates or deletes anything, and
// it never touches claims, pending_bridges, or any claim-lifecycle table.
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import {
  decideActivityRow, SWAP_GRACE_SECONDS, MIN_EVENT_AGE_MS,
  CREDIT_EVENT_TYPES, CREDITABLE_STATUS,
  type ChainEventRow, type ActivityRowToInsert,
} from './decide.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function handleOptions(req: Request): Response | null {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  return null
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

const ARC_EXPLORER = 'https://testnet.arcscan.app'

/**
 * How far back to look for uncredited events.
 *
 * Bounded so a pass is O(recent) rather than O(history) — chain_events retention
 * is 14 days, and this stays far inside it. Two hours is many multiples of the
 * indexer's every-2-minutes cadence, so an event cannot age out unprocessed even
 * after a long consumer outage; if one ever did, deposit-scan-all's own
 * reconcile still covers it.
 */
const LOOKBACK_HOURS = 2

/** Per-pass cap, so one invocation cannot run unboundedly. */
const MAX_EVENTS_PER_PASS = 200

function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ fn: 'activity-consumer', event, ts: new Date().toISOString(), ...fields }))
}

/** Registered wallets, lowercased. Mirrors the indexer's loadKnownWallets. */
async function loadRegisteredWallets(supabase: SupabaseClient): Promise<Set<string>> {
  const out = new Set<string>()
  const { data, error } = await supabase.from('users').select('wallet_address')
  if (error) {
    console.error('[activity-consumer] loadRegisteredWallets failed:', error.message)
    return out
  }
  for (const r of data ?? []) {
    const a = (r.wallet_address as string | null)?.toLowerCase()
    if (a) out.add(a)
  }
  return out
}

/**
 * Which (hash, wallet) pairs already have ANY activity row.
 *
 * Checks BOTH the plain and `recv_`-prefixed forms in one query, because a swap
 * records under the unprefixed hash while a receive records under `recv_`. This
 * is the batch equivalent of claim-recovery-scan's existsActivityForTxHash.
 */
async function loadExistingActivity(
  supabase: SupabaseClient, hashes: string[],
): Promise<Set<string>> {
  const seen = new Set<string>()
  if (hashes.length === 0) return seen
  const candidates = [...new Set(hashes.flatMap(h => [h, `recv_${h}`]))]

  const { data, error } = await supabase
    .from('activity')
    .select('tx_hash, wallet_address')
    .in('tx_hash', candidates)
  if (error) {
    // Fail CLOSED: if we cannot prove a row is absent, we must not insert one.
    // Throwing aborts the pass; the next pass retries with nothing written.
    throw new Error(`loadExistingActivity failed: ${error.message}`)
  }
  for (const r of data ?? []) {
    const h = String(r.tx_hash ?? '').toLowerCase().replace(/^recv_/, '')
    const w = String(r.wallet_address ?? '').toLowerCase()
    if (h && w) seen.add(`${h}:${w}`)
  }
  return seen
}

/** Recent swap outputs per wallet. Mirrors deposit-scan-all's version exactly. */
async function recentSwapOutputsByWallet(
  supabase: SupabaseClient, wallets: string[],
): Promise<Map<string, Array<{ token: string; amount: number }>>> {
  const result = new Map<string, Array<{ token: string; amount: number }>>()
  if (wallets.length === 0) return result
  const uniq = [...new Set(wallets.map(w => w.toLowerCase()))]
  const since = new Date(Date.now() - SWAP_GRACE_SECONDS * 1000).toISOString()

  const { data, error } = await supabase
    .from('activity')
    .select('wallet_address, metadata')
    .eq('activity_type', 'swap')
    .gte('created_at', since)
    .in('wallet_address', uniq)
  if (error) {
    // Non-fatal: worst case a swap-adjacent deposit is recorded un-quiet, i.e.
    // it notifies when it ideally would not. Losing the row would be worse.
    console.error('[activity-consumer] recentSwapOutputsByWallet failed:', error.message)
    return result
  }
  for (const r of data ?? []) {
    const w = String(r.wallet_address ?? '').toLowerCase()
    const meta = r.metadata as Record<string, unknown> | null
    const token = meta?.tokenOut
    const amount = Number(meta?.amountOut)
    if (typeof token !== 'string' || !token || !Number.isFinite(amount)) continue
    if (!result.has(w)) result.set(w, [])
    result.get(w)!.push({ token, amount })
  }
  return result
}

async function runPass(supabase: SupabaseClient) {
  const sinceIso = new Date(Date.now() - LOOKBACK_HOURS * 3600_000).toISOString()

  const { data: events, error } = await supabase
    .from('chain_events')
    .select('id, chain_id, event_type, tx_hash, wallet_address, assets, metadata, status, created_at')
    .in('event_type', [...CREDIT_EVENT_TYPES])
    .eq('status', CREDITABLE_STATUS)
    .not('tx_hash', 'is', null)
    .not('wallet_address', 'is', null)
    .gte('created_at', sinceIso)
    .order('id', { ascending: true })
    .limit(MAX_EVENTS_PER_PASS)
  if (error) throw new Error(`chain_events read failed: ${error.message}`)

  const rows = (events ?? []) as ChainEventRow[]
  logEvent('pass_start', { candidates: rows.length, sinceIso, lookbackHours: LOOKBACK_HOURS })
  if (rows.length === 0) return { candidates: 0, credited: 0, skipped: 0, reasons: {} as Record<string, number> }

  const registered = await loadRegisteredWallets(supabase)
  const hashes = rows.map(r => String(r.tx_hash ?? '').toLowerCase()).filter(Boolean)
  const existing = await loadExistingActivity(supabase, hashes)   // throws => abort pass
  const swaps = await recentSwapOutputsByWallet(supabase, rows.map(r => String(r.wallet_address ?? '')))

  const toInsert: ActivityRowToInsert[] = []
  const reasons: Record<string, number> = {}
  let skipped = 0

  for (const ev of rows) {
    const wallet = String(ev.wallet_address ?? '').toLowerCase()
    const hash = String(ev.tx_hash ?? '').toLowerCase()

    const decision = decideActivityRow(ev, {
      isRegisteredWallet: registered.has(wallet),
      hasAnyActivityForTxHash: existing.has(`${hash}:${wallet}`),
      recentSwapOutputs: swaps.get(wallet),
    }, ARC_EXPLORER)

    if (decision.action === 'skip') {
      skipped++
      reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1
      continue
    }
    toInsert.push(decision.row)
    logEvent('credit_decision', {
      chainEventId: ev.id, txHash: hash, wallet,
      amount: decision.row.amount, asset: decision.row.token_symbol, quiet: decision.quiet,
    })
  }

  let credited = 0
  if (toInsert.length > 0) {
    // ignoreDuplicates is the concurrency guarantee: two overlapping passes, or
    // this function racing deposit-scan-all, converge on one row.
    const { error: insErr } = await supabase
      .from('activity')
      .upsert(toInsert, { onConflict: 'tx_hash,wallet_address', ignoreDuplicates: true })
    if (insErr) {
      // Do NOT count these as credited — the next pass retries them, and the
      // unique index means a retry cannot double-credit.
      console.error('[activity-consumer] activity upsert failed:', insErr.message)
      logEvent('insert_failed', { attempted: toInsert.length, error: insErr.message })
    } else {
      credited = toInsert.length
      logEvent('activity_inserted', { count: credited })
    }
  }

  logEvent('pass_done', { candidates: rows.length, credited, skipped })
  return { candidates: rows.length, credited, skipped, reasons }
}

Deno.serve(async (req: Request) => {
  const pre = handleOptions(req)
  if (pre) return pre

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
  )

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* cron sends no body */ }

  // Dry run: decide and report, write nothing. Used to validate against live
  // data before the first real pass.
  const dryRun = body?.mode === 'dry-run'

  try {
    if (dryRun) {
      const sinceIso = new Date(Date.now() - LOOKBACK_HOURS * 3600_000).toISOString()
      const { data: events, error } = await supabase
        .from('chain_events')
        .select('id, chain_id, event_type, tx_hash, wallet_address, assets, metadata, status, created_at')
        .in('event_type', [...CREDIT_EVENT_TYPES])
        .eq('status', CREDITABLE_STATUS)
        .not('tx_hash', 'is', null)
        .not('wallet_address', 'is', null)
        .gte('created_at', sinceIso)
        .order('id', { ascending: true })
        .limit(MAX_EVENTS_PER_PASS)
      if (error) throw new Error(error.message)

      const rows = (events ?? []) as ChainEventRow[]
      const registered = await loadRegisteredWallets(supabase)
      const existing = await loadExistingActivity(supabase, rows.map(r => String(r.tx_hash ?? '').toLowerCase()).filter(Boolean))
      const swaps = await recentSwapOutputsByWallet(supabase, rows.map(r => String(r.wallet_address ?? '')))

      const decisions = rows.map(ev => {
        const wallet = String(ev.wallet_address ?? '').toLowerCase()
        const hash = String(ev.tx_hash ?? '').toLowerCase()
        const d = decideActivityRow(ev, {
          isRegisteredWallet: registered.has(wallet),
          hasAnyActivityForTxHash: existing.has(`${hash}:${wallet}`),
          recentSwapOutputs: swaps.get(wallet),
        }, ARC_EXPLORER)
        return {
          chainEventId: ev.id, txHash: hash, wallet, eventType: ev.event_type,
          action: d.action,
          reason: d.action === 'skip' ? d.reason : null,
          wouldInsert: d.action === 'credit'
            ? { amount: d.row.amount, asset: d.row.token_symbol, quiet: d.quiet, note: d.row.metadata.note }
            : null,
        }
      })
      return json({
        ok: true, mode: 'dry-run', wroteNothing: true,
        candidates: rows.length,
        wouldCredit: decisions.filter(d => d.action === 'credit').length,
        settleDelayMs: MIN_EVENT_AGE_MS,
        decisions,
      })
    }

    const result = await runPass(supabase)
    return json({ ok: true, mode: 'consume', ...result })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[activity-consumer] pass failed:', msg)
    logEvent('pass_failed', { error: msg })
    return json({ ok: false, error: msg }, 500)
  }
})
