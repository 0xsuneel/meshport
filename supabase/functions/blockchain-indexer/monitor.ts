// supabase/functions/blockchain-indexer/monitor.ts
//
// Shadow-mode validation handlers: `compare` and `metrics` modes.
//
// These read the indexer's own tables AND the legacy workers' output
// (activity, claims), classify the overlap with compare.ts, and persist the
// result to indexer_shadow_reports so accuracy is a trend, not a log line.
//
// ── Posture ─────────────────────────────────────────────────────────────────
// This module is OBSERVATION ONLY. It never writes activity, claims, or
// balances, and it never tells any worker what to do. The indexer's
// `authoritative` flag in indexer_config stays false until a human flips it.

import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { compareDeposits, compareClaims, assessComparability, ACCOUNTED_FOR_ACTIVITY_TYPES } from './compare.ts'
import type { IndexerEventLike, WorkerRowLike, ComparisonResult, Comparability } from './compare.ts'

const ARC = 'arc'

/**
 * How far behind head the indexer may be and still produce a trustworthy
 * comparison. Beyond this its events describe blocks older than the window,
 * so its rows and the worker's rows for the same transaction land in
 * different windows and every event is misreported as indexer_only.
 *
 * 600 blocks is roughly five minutes on Arc (~1.96 blocks/sec, measured).
 * Overridable via indexer_config so it can be tuned without a deploy.
 */
const DEFAULT_MAX_BACKLOG_BLOCKS = 600

async function readMaxBacklogBlocks(supabase: SupabaseClient): Promise<number> {
  const { data } = await supabase
    .from('indexer_config').select('value').eq('key', 'comparison').maybeSingle()
  const v = Number((data?.value as Record<string, unknown> | undefined)?.max_backlog_blocks)
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_BACKLOG_BLOCKS
}

/** Cursor row for the chain under comparison, used to gate comparability. */
async function readCursor(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('chain_cursors')
    .select('last_indexed_block, latest_observed_block, sync_state')
    .eq('chain_id', ARC)
    .maybeSingle()
  if (error) {
    console.error('[blockchain-indexer:compare] cursor read failed:', error.message)
    return null
  }
  return data
}

async function recentChainEvents(supabase: SupabaseClient, since: string): Promise<IndexerEventLike[]> {
  const { data, error } = await supabase
    .from('chain_events')
    .select('wallet_address, tx_hash, event_type, block_number, status, created_at, metadata')
    .in('event_type', ['deposit_detected', 'transfer_detected'])
    // Phase 3 Fix 4: only confirmed events are a like-for-like comparison
    // against activity (always confirmed, credited rows) — a 'pending' event
    // can still be reorged away, and a 'reorged' one is explicitly not real.
    // Previously this query had NO status filter at all (found during the
    // Phase 3 forensic audit, docs/PHASE_3_REAL_STATE_AUDIT.md §12 item 1).
    // compare.ts's compareDeposits also re-checks status defensively, so
    // this is belt-and-suspenders, not the only place this is enforced.
    .eq('status', 'confirmed')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(5000)
  if (error) {
    console.error('[blockchain-indexer:compare] chain_events read failed:', error.message)
    return []
  }
  return (data ?? []) as IndexerEventLike[]
}

async function recentWorkerDeposits(supabase: SupabaseClient, since: string): Promise<WorkerRowLike[]> {
  // deposit-scan-all/activity-consumer write activity_type='receive' rows,
  // tx_hash='recv_<hash>'. Phase 3 Fix 3 also fetches swap/bulk/p2p_purchase/
  // p2p_refund rows (unprefixed tx_hash) in the SAME query, so compareDeposits
  // can classify an indexer event that matches one of THOSE as
  // ACCOUNTED_FOR_OTHER_ACTIVITY instead of a false indexer_only — see
  // docs/PHASE_3_REAL_STATE_AUDIT.md §7/§8 for the live-traced evidence this
  // was built from. Previously this query only ever selected activity_type
  // = 'receive'.
  const { data, error } = await supabase
    .from('activity')
    .select('wallet_address, tx_hash, activity_type, created_at')
    .in('activity_type', ['receive', ...ACCOUNTED_FOR_ACTIVITY_TYPES])
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(5000)
  if (error) {
    console.error('[blockchain-indexer:compare] activity read failed:', error.message)
    return []
  }
  return (data ?? []) as WorkerRowLike[]
}

async function recentCompletedClaims(supabase: SupabaseClient, since: string): Promise<WorkerRowLike[]> {
  const { data, error } = await supabase
    .from('claims')
    .select('wallet_address, destination_tx_hash')
    .eq('status', 'completed')
    .not('destination_tx_hash', 'is', null)
    .gte('completed_at', since)
    .order('completed_at', { ascending: false })
    .limit(5000)
  if (error) {
    console.error('[blockchain-indexer:compare] claims read failed:', error.message)
    return []
  }
  return (data ?? []) as WorkerRowLike[]
}

async function persistReport(
  supabase: SupabaseClient,
  scope: 'deposits' | 'claims',
  windowMinutes: number,
  r: ComparisonResult,
  comparability: Comparability,
): Promise<void> {
  const { error } = await supabase.from('indexer_shadow_reports').insert({
    scope,
    window_minutes: windowMinutes,
    status: r.status,
    reason: r.reason,
    matched: r.matched,
    worker_only: r.workerOnly,
    indexer_only: r.indexerOnly,
    recall_pct: r.recallPct,
    details: {
      workerOnly: r.workerOnlyKeys,
      indexerOnly: r.indexerOnlyKeys,
      // Recorded so a historical row can be re-read later without guessing
      // why it was or wasn't comparable at the time.
      comparability: {
        comparable: comparability.comparable,
        reason: comparability.reason,
        backlogBlocks: comparability.backlogBlocks,
      },
      // How many rows were dropped as external-recipient bookkeeping, so a
      // narrowed comparison is visible rather than silently smaller.
      externalExcluded: r.externalExcluded ?? 0,
      // Same rationale for the Circle Kit/CCTP internal-contract exclusion.
      internalExcluded: r.internalExcluded ?? 0,
      // Phase 3 Fix 3 — the refined classification, persisted in full so a
      // historical report row shows the same breakdown the live response
      // does, not just the raw pre-Fix-3 counts.
      accountedForOtherActivity: r.accountedForOtherActivity,
      accountedForOtherActivityKeys: r.accountedForOtherActivityKeys,
      trueIndexerOnly: r.trueIndexerOnly,
      trueIndexerOnlyKeys: r.trueIndexerOnlyKeys,
      timingDifference: r.timingDifference,
      timingDifferenceKeys: r.timingDifferenceKeys,
    },
  })
  if (error) console.error('[blockchain-indexer:compare] report persist failed:', error.message)
}

/**
 * Every currently-registered MeshPort wallet address, lowercased.
 *
 * `users.wallet_address` is the canonical registry and is exactly what the
 * indexer's own loadKnownWallets() reads, so the comparison judges the indexer
 * against the same population it watches.
 *
 * NOT `activity.wallet_address`: that table contains rows for EXTERNAL
 * counterparties. When a user sends to an ordinary address, the client writes
 * both sides at send time, so `activity` accumulates `recv_` rows for addresses
 * that were never MeshPort wallets. Confirmed live: 0x70e3fb28…af8e has two
 * activity rows and appears nowhere else in the database.
 *
 * NOT `wallet_vault` either: it holds 8 rows against users' 9 — a strict subset,
 * so it would wrongly exclude a real registered wallet.
 *
 * Returns null on error rather than an empty set. An empty set would filter
 * EVERYTHING out and render the window trivially empty, which reads like
 * "nothing to compare" instead of "the registry lookup failed". Null disables
 * filtering, preserving the previous, louder behaviour.
 */
async function readRegisteredWallets(supabase: SupabaseClient): Promise<Set<string> | null> {
  const { data, error } = await supabase
    .from('users')
    .select('wallet_address')
    .not('wallet_address', 'is', null)
  if (error) {
    console.error('[blockchain-indexer:compare] wallet registry read failed:', error.message)
    return null
  }
  const out = new Set<string>()
  for (const row of data ?? []) {
    const a = (row as { wallet_address?: string }).wallet_address
    if (a) out.add(a.trim().toLowerCase())
  }
  return out
}

export async function runCompare(
  supabase: SupabaseClient,
  windowMinutes = 60,
): Promise<Record<string, unknown>> {
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString()

  const [events, deposits, claims, cursor, maxBacklog, registered] = await Promise.all([
    recentChainEvents(supabase, since),
    recentWorkerDeposits(supabase, since),
    recentCompletedClaims(supabase, since),
    readCursor(supabase),
    readMaxBacklogBlocks(supabase),
    readRegisteredWallets(supabase),
  ])

  // Gate BOTH scopes on the same comparability verdict, so a lagging indexer
  // can never produce a number that looks like a result.
  const comparability = assessComparability(cursor, maxBacklog)

  // Deposits are scoped to registered wallets (see readRegisteredWallets).
  // Claims are NOT: that scope is NOT_APPLICABLE by design and its behaviour is
  // deliberately left untouched.
  const depositsReport = compareDeposits(events, deposits, comparability, registered)
  const claimsReport = compareClaims(events, claims, comparability)

  await Promise.all([
    persistReport(supabase, 'deposits', windowMinutes, depositsReport, comparability),
    persistReport(supabase, 'claims', windowMinutes, claimsReport, comparability),
  ])

  const shape = (r: ComparisonResult) => ({
    status: r.status,
    reason: r.reason,
    matched: r.matched,
    workerOnly: r.workerOnly,
    indexerOnly: r.indexerOnly,
    recallPct: r.recallPct,
    workerOnlyKeys: r.workerOnlyKeys,
    indexerOnlyKeys: r.indexerOnlyKeys,
    externalExcluded: r.externalExcluded ?? 0,
    internalExcluded: r.internalExcluded ?? 0,
    // Phase 3 Fix 3. TRUE_INDEXER_ONLY is the metric that matters — see
    // docs/PHASE_3_REAL_STATE_AUDIT.md's final verdict and
    // docs/PHASE_3_FIXES_APPLIED.md — not the raw indexerOnly above.
    accountedForOtherActivity: r.accountedForOtherActivity,
    accountedForOtherActivityKeys: r.accountedForOtherActivityKeys,
    trueIndexerOnly: r.trueIndexerOnly,
    trueIndexerOnlyKeys: r.trueIndexerOnlyKeys,
    timingDifference: r.timingDifference,
    timingDifferenceKeys: r.timingDifferenceKeys,
  })

  return {
    ok: true,
    mode: 'compare',
    windowMinutes,
    since,
    comparability: {
      comparable: comparability.comparable,
      reason: comparability.reason,
      backlogBlocks: comparability.backlogBlocks,
      maxBacklogBlocks: maxBacklog,
    },
    deposits: shape(depositsReport),
    claims: shape(claimsReport),
  }
}

/** Aggregated operational metrics from the indexer's own tables. */
export async function runMetrics(supabase: SupabaseClient): Promise<Record<string, unknown>> {
  const [cursors, events, reports, shadowCfg] = await Promise.all([
    supabase.from('chain_cursors').select('*'),
    supabase.from('chain_events')
      .select('status, event_type, created_at')
      .order('created_at', { ascending: false })
      .limit(10000),
    supabase.from('indexer_shadow_reports')
      .select('scope, status, reason, matched, worker_only, indexer_only, recall_pct, generated_at')
      .order('generated_at', { ascending: false })
      .limit(1000),
    supabase.from('indexer_config').select('key, value').eq('key', 'shadow_mode'),
  ])

  const rows = events.data ?? []
  const byType: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  for (const e of rows) {
    byType[e.event_type] = (byType[e.event_type] ?? 0) + 1
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1
  }

  // Latest report per scope, for "what is the current accuracy".
  const latestByScope: Record<string, unknown> = {}
  for (const rep of reports.data ?? []) {
    if (!latestByScope[rep.scope]) latestByScope[rep.scope] = {
      generatedAt: rep.generated_at,
      // Surfaced first: without it, matched/workerOnly zeros are ambiguous
      // between "indexer missed nothing" and "nothing was measured".
      status: rep.status ?? 'UNKNOWN',
      reason: rep.reason ?? null,
      matched: rep.matched,
      workerOnly: rep.worker_only,
      indexerOnly: rep.indexer_only,
      recallPct: rep.recall_pct,
    }
  }

  return {
    ok: true,
    mode: 'metrics',
    chainCursors: (cursors.data ?? []).map((c: Record<string, unknown>) => ({
      chain: c.chain_id,
      lastIndexedBlock: c.last_indexed_block,
      latestObserved: c.latest_observed_block,
      lag: c.latest_observed_block && c.last_indexed_block
        ? Number(c.latest_observed_block) - Number(c.last_indexed_block) : null,
      syncState: c.sync_state,
      consecutiveFailures: c.consecutive_failures,
      reorgCount: c.reorg_count,
      lastReorgAt: c.last_reorg_at,
      lastError: c.last_error,
    })),
    chainEvents: {
      totalInSample: rows.length,
      byType,
      byStatus,
    },
    shadowReports: {
      count: (reports.data ?? []).length,
      latestByScope,
    },
    shadowMode: shadowCfg.data?.[0]?.value ?? { enabled: true, authoritative: false },
    note: 'metrics are operational observability only; nothing here is authoritative',
  }
}
