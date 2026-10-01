/**
 * shadowEventBus.ts — Phase 4 shadow-mode event observation.
 *
 * Subscribes to Supabase Realtime INSERTs on `chain_events` and reports what
 * BlockchainIndexer publishes, WITHOUT acting on any of it.
 *
 * ── This file deliberately does not refresh anything ────────────────────────
 * Phase 4's rule is that no user-visible behaviour changes. So this bus:
 *   - does NOT call BlockchainManager.invalidate / refresh
 *   - does NOT write to the blockchain store
 *   - does NOT cancel, replace or short-circuit any existing polling
 * It only records observations and measures latency, so Phase 5 can flip a
 * single flag and know what the latency will be BEFORE depending on it.
 *
 * The one thing it does measure that the server cannot: END-TO-END publication
 * latency as the CLIENT experiences it — chain_events.created_at (server insert
 * time) to Realtime delivery in the browser. That number is the whole basis for
 * "can event-driven refresh replace polling", and it is unobservable from a
 * server-side comparison because the network hop to the client is the part in
 * question.
 */
import { supabase } from '@/lib/supabase'
import { mapChainEventRow, latencyStats, type ShadowEvent } from './shadowEventMap'
import { createSyncCoordinator } from './SyncCoordinator'
import { refreshScope } from './BlockchainManager'

export type { ShadowEvent }
export { mapChainEventRow, latencyStats }

/**
 * PHASE 6 kill switch.
 *
 * `true`  — chain events invalidate caches (event-driven refresh active).
 * `false` — observer mode: the coordinator logs exactly what it WOULD
 *           invalidate and applies nothing, so polling alone carries the app.
 *
 * ── Rollback reality, stated precisely ─────────────────────────────────────
 * This is a COMPILE-TIME constant, so the dead branch is tree-shaken from the
 * production bundle (verified: 'WOULD refresh' does not appear in dist/).
 * Flipping it therefore requires a frontend rebuild + redeploy — it is NOT a
 * runtime toggle. No edge-function redeploy is involved either way.
 *
 * The INSTANT fallback, needing no deploy at all, is that Phase 6 deliberately
 * lengthened polling instead of deleting it (useActivity 12s->60s, Home
 * 30s->90s / 60s->120s). If event-driven refresh misbehaves, those ticks still
 * converge the UI, so the worst case is slower updates rather than stale ones.
 */
export const SYNC_COORDINATOR_ENABLED = true

/**
 * The one live coordinator. Bound to BlockchainManager.refreshScope, which is
 * the invalidation primitive Phase 2 built and documented as "the
 * infrastructure Phase 4's event-driven refresh calls when a chain event
 * arrives" (BlockchainManager.ts:191).
 */
export const syncCoordinator = createSyncCoordinator({
  // refreshScope takes only the scope — the trigger is carried for telemetry
  // and logged here rather than passed, so BlockchainManager's signature is
  // left exactly as Phase 2 defined it.
  applyScope: (scope, trigger) => {
    refreshScope(scope)
    if (import.meta.env.DEV) console.debug(`[sync] refreshed ${scope.kind} (${trigger})`)
  },
  enabled: SYNC_COORDINATOR_ENABLED,
})

type Listener = (e: ShadowEvent) => void

const MAX_RETAINED = 200

class ShadowEventBus {
  private channel: ReturnType<typeof supabase.channel> | null = null
  private listeners = new Set<Listener>()
  private observed: ShadowEvent[] = []
  private walletFilter: string | null = null

  /**
   * Begin observing. Safe to call repeatedly — re-subscribes only if the
   * wallet actually changed, so a re-render does not churn the channel.
   */
  start(walletAddress?: string | null): void {
    const next = (walletAddress ?? '').toLowerCase() || null
    if (this.channel && this.walletFilter === next) return

    this.stop()
    this.walletFilter = next

    // Wallet-scoped when we know the wallet, so a busy chain does not push
    // every other user's events into this tab. Unfiltered otherwise.
    const filter = next ? `wallet_address=eq.${next}` : undefined

    this.channel = supabase
      .channel(`shadow-chain-events${next ? `-${next.slice(0, 10)}` : ''}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'chain_events', ...(filter ? { filter } : {}) },
        (payload: { new: Record<string, unknown> }) => this.ingest(payload.new),
      )
      // ── PHASE 6 ORDERING FIX — activity INSERT ──────────────────────────
      // The chain_events subscription above is necessary but fires ~53s TOO
      // EARLY for history: after the Phase 5 cutover, activity-consumer writes
      // the activity row well after the indexer publishes the chain_event, so a
      // history refresh at chain_event time re-reads and finds nothing. Measured
      // on live EURC/cirBTC deposits (chain_events 03:02:07 -> activity
      // 03:03:00). This second subscription is the event that means "a row the
      // history view can actually render now exists".
      //
      // Added as a second `.on()` on the SAME channel rather than a new channel:
      // one WebSocket, one subscribe/teardown, and stop() already disposes it.
      // Routed into the SAME SyncCoordinator queue so the two events for one
      // deposit coalesce instead of causing independent refresh cycles.
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'activity', ...(filter ? { filter } : {}) },
        (payload: { new: Record<string, unknown> }) => this.ingestActivity(payload.new),
      )
      .subscribe()

    console.info('[shadow-bus] observing chain_events + activity', next ? `for ${next}` : '(all wallets)')
  }

  stop(): void {
    if (this.channel) {
      supabase.removeChannel(this.channel)
      this.channel = null
    }
  }

  /**
   * PHASE 6 ORDERING FIX — hand an `activity` INSERT to the coordinator.
   *
   * Kept deliberately thin: all filtering (receive-only, completed-only, asset
   * granularity) lives in SyncCoordinator.scopesForActivityRow so it is pure and
   * unit-testable. Wrapped so a coordinator fault cannot break the Realtime
   * stream, matching the chain_events path.
   */
  private ingestActivity(row: Record<string, unknown>): void {
    console.info(
      `[shadow-bus] activity INSERT type=${String(row?.activity_type ?? '?')} ` +
      `token=${String(row?.token_symbol ?? '?')} amount=${String(row?.amount ?? '?')}`,
    )
    try {
      syncCoordinator.handleActivityRow(row)
    } catch (err) {
      console.error('[shadow-bus] syncCoordinator.handleActivityRow threw', err)
    }
  }

  private ingest(row: Record<string, unknown>, now = Date.now()): void {
    const e = mapChainEventRow(row, now)

    this.observed.push(e)
    if (this.observed.length > MAX_RETAINED) this.observed.shift()

    // Latency observation is retained from Phase 4 — it is still the only
    // measurement of client-perceived delivery latency, and Phase 6's decision
    // to shorten polling rests on it.
    console.info(
      `[shadow-bus] ${e.eventType} ${e.chainId} block=${e.blockNumber} ` +
      `status=${e.status} latency=${e.deliveryLatencyMs}ms`,
    )

    // PHASE 6 — hand the event to the coordinator, which decides which cache
    // keys it touches. Wrapped so a coordinator fault can never break the
    // Realtime stream or the latency observation above: polling remains the
    // fallback for anything this misses.
    try {
      syncCoordinator.handle(e)
    } catch (err) {
      console.error('[shadow-bus] syncCoordinator.handle threw', err)
    }

    // ── /investigate (2026-09-05): instant-history nudge ──────────────────
    // syncCoordinator.handle() above invalidates the {kind:'history'} cache
    // prefix, but nothing in BlockchainManager's cache ever WRITES or READS
    // under that prefix (grep-verified — `history:` only ever appears as an
    // invalidatePrefix() argument) — so for history specifically, that call
    // is a no-op. The actual "did a deposit just arrive" signal history
    // relies on is: (1) Realtime INSERT on `activity` (only fires once
    // activity-consumer's cron has actually written the row — bounded by the
    // indexer's 2-minute scan cadence, decide.ts's own 30s settle delay, and
    // the consumer's 1-minute sweep interval, i.e. up to a few minutes for a
    // brand new external deposit), or (2) useActivity.ts's direct-from-
    // explorer layer (onchainReceivedActivity.ts), which bypasses that whole
    // pipeline but only re-checks on mount, every 60s, on tab-focus, or on
    // this exact 'meshport:onchain-activity' event — which until now only
    // HomePage's own 90s balance poll ever dispatched, and only when that
    // poll's own tick happened to land after the deposit. A deposit_detected/
    // transfer_detected chain_event is the indexer's earliest possible signal
    // that something landed for this wallet — reusing it to fire the SAME
    // event balance-poll already dispatches means the fast explorer-backed
    // history layer gets checked within one Realtime round-trip of the
    // indexer noticing the deposit, instead of waiting for whichever of the
    // 60s/90s timers happens to tick next. Deliberately not gated on
    // e.status: a 'pending' native-transfer row is still real signal that
    // something worth checking just happened, and fetchRecentOnchainReceived
    // determines confirmed/pending itself from the explorer directly — an
    // early, empty check here just means the next natural poll catches it,
    // same as before this change existed.
    if (
      typeof window !== 'undefined' &&
      (e.eventType === 'deposit_detected' || e.eventType === 'transfer_detected')
    ) {
      window.dispatchEvent(new CustomEvent('meshport:onchain-activity'))
    }

    for (const l of this.listeners) {
      try { l(e) } catch (err) {
        console.error('[shadow-bus] listener threw', err)
      }
    }
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  /** Client-side latency stats, for the Phase 4 report. */
  stats(): {
    count: number
    byType: Record<string, number>
    latency: { min: number; median: number; p95: number; max: number } | null
  } {
    const byType: Record<string, number> = {}
    for (const e of this.observed) byType[e.eventType] = (byType[e.eventType] ?? 0) + 1

    return {
      count: this.observed.length,
      byType,
      latency: latencyStats(this.observed),
    }
  }

  recent(n = 20): ShadowEvent[] {
    return this.observed.slice(-n)
  }
}

export const shadowEventBus = new ShadowEventBus()

// Dev-console access, so latency can be inspected during testnet traffic
// without building any UI for it (Phase 4 must not change the UI).
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__meshportShadowBus = shadowEventBus
}
