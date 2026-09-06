/**
 * SyncCoordinator.ts — Phase 6 event-driven refresh.
 *
 * Turns an observed `chain_events` row into the EXACT set of cache
 * invalidations it implies, and nothing more.
 *
 * ── Why this file imports nothing ───────────────────────────────────────────
 * Same rule as shadowEventMap.ts: the mapping half is pure, so it is testable
 * under plain node/tsx without Vite's `import.meta.env` shim or Supabase
 * credentials. The impure half (actually calling refreshScope) is injected by
 * the caller — see `createSyncCoordinator`. That split is what lets
 * scripts/verify-sync-coordinator.ts assert the whole decision table without a
 * browser, a network, or a database.
 *
 * ── Design rule inherited from blockchain/events.ts ─────────────────────────
 * The indexer has no business logic: a 'deposit_detected' event says "funds
 * arrived at address X on chain Y", NOT "refresh Home". Deciding which cache
 * keys that touches is exactly this file's job, and it is the only place that
 * decision is encoded.
 *
 * ── Why 'all' is never emitted for a chain event ────────────────────────────
 * BlockchainManager.refreshScope's contract reserves `{kind:'all'}` for
 * launch / login / wallet-import / explicit manual refresh — it is the only
 * scope that clears an entire wallet. A chain event is by definition narrow
 * (one wallet, one chain, usually one asset), so emitting 'all' would throw
 * away every other chain's cached balance on every deposit and reintroduce the
 * 21-chain rescan storm Phase 2 removed. If a future event type genuinely
 * needs a wallet-wide drop, add it deliberately — do not widen this default.
 *
 * ── Why the coalescing window exists ────────────────────────────────────────
 * deposit-scan-all's sweep can record several activity rows within a couple of
 * seconds (see HomePage.tsx's fireIfReceived comment), and the indexer can
 * publish a matching burst of chain_events in one pass. Without coalescing,
 * a 5-event burst fires 5 invalidate+refetch cycles for the same wallet. The
 * window is deliberately short: long enough to absorb one pass, short enough
 * that a user watching the screen still sees a sub-second update.
 */
import type { RefreshScope, RefreshTrigger } from './types'
import type { ShadowEvent } from './shadowEventMap'

/** Arc's chain id, duplicated as a literal to keep this module import-free. */
const ARC = 'arc'

/**
 * How long to hold a wallet's pending scopes before flushing them.
 * 250ms absorbs a single indexer pass's burst without being perceptible.
 */
export const COALESCE_WINDOW_MS = 250

/**
 * ── Resume policy, from proposal §19 ────────────────────────────────────────
 *
 * | App resume < 5 min  | refresh NOTHING                                  |
 * | App resume ≥ 5 min  | {arc} + {claims}                                 |
 * | App resume ≥ 10 min | ...and {external} as well                        |
 *
 * The sub-5-minute no-op is the point of the rule, not an optimisation
 * detail. Before Phase 6 every tab focus re-triggered work, so flicking
 * between tabs produced a 21-chain scan storm — the exact behaviour §19's
 * "Full 21-chain scans occur only on: login, wallet import, manual refresh…
 * Never on a timer" exists to forbid. Event-driven refresh has already kept
 * the caches warm while the tab was hidden, so a short absence needs nothing.
 *
 * `external` is gated at 10 min because the aggregate cross-chain scan is by
 * far the most expensive read in the app; 5 minutes of staleness on a
 * secondary-chain total is a much smaller cost than paying for that scan on
 * every medium-length absence.
 */
export const RESUME_MIN_MS = 5 * 60_000
export const RESUME_EXTERNAL_MS = 10 * 60_000

/** Which trigger to attribute a refresh to, per event type — for telemetry. */
export function triggerFor(eventType: string): RefreshTrigger {
  switch (eventType) {
    case 'deposit_detected':       return 'deposit-detected'
    case 'transaction_confirmed':  return 'tx-confirmed'
    default:                       return 'chain-event'
  }
}

/**
 * The decision table: one chain event -> the scopes it invalidates.
 *
 * Pure and total. An unknown event_type returns [] rather than throwing or
 * falling back to a wide refresh: a vocabulary the client does not recognise
 * must not be able to trigger a wallet-wide cache drop. The event_type CHECK
 * constraint in the Phase 3 migration is the server-side backstop, so an
 * unknown value here means client/server drift — which should degrade to
 * "polling still covers it", not to a stampede.
 */
export function scopesFor(event: ShadowEvent): RefreshScope[] {
  const wallet = (event.walletAddress ?? '').toLowerCase()
  if (!wallet) return []            // unattributable event — nothing to scope

  const chain = event.chainId || ARC

  switch (event.eventType) {
    /**
     * Native-asset credit (Arc USDC, incl. wrapper-routed via 0xffff…fffe).
     * Touches the wallet's Arc balances and its history. `arc` rather than
     * `asset` because the native path carries no reliable per-asset key: the
     * scanner emits assets:['USDC'] for both plain and wrapper routes, and on
     * Arc USDC IS the native currency, so the whole Arc bucket is the honest
     * granularity.
     */
    case 'deposit_detected':
      return [{ kind: 'arc', wallet }, { kind: 'history', wallet }]

    /**
     * ERC-20 credit (EURC / cirBTC). Here the asset IS known, so scope to the
     * single asset key rather than the whole chain — this is the case the
     * `asset` scope exists for.
     */
    case 'transfer_detected': {
      const asset = firstAsset(event)
      return [
        asset ? { kind: 'asset', wallet, chain, asset } : { kind: 'chain', wallet, chain },
        { kind: 'history', wallet },
      ]
    }

    /**
     * A tracked transaction settled. Balance on the originating chain plus
     * history. Claims are refreshed too because a CCTP claim settling arrives
     * as a confirmation on the destination chain and the Claim page reads its
     * own cache bucket.
     */
    case 'transaction_confirmed':
      return [
        { kind: 'chain', wallet, chain },
        { kind: 'claims', wallet },
        { kind: 'history', wallet },
      ]

    /**
     * A failure changes what history should show but not any balance — no
     * value moved. Deliberately NOT a balance invalidation.
     */
    case 'transaction_failed':
      return [{ kind: 'history', wallet }]

    /**
     * Explicit balance-change signal for a non-Arc chain (Hub / Multichain).
     * Also drops the aggregate external scan, which is keyed separately
     * (`external:<wallet>:…`) and would otherwise keep serving a stale total.
     */
    case 'balance_changed':
      return chain === ARC
        ? [{ kind: 'arc', wallet }]
        : [{ kind: 'chain', wallet, chain }, { kind: 'external', wallet, chains: [chain] }]

    default:
      return []
  }
}

/**
 * Scopes to refresh when a new `activity` row is INSERTed — the Phase 6
 * ordering fix.
 *
 * ── Why this exists (production evidence, 2026-08-18) ──────────────────────
 * After the Phase 5 cutover the write order INVERTED. activity-consumer is now
 * the primary writer, and it credits a deposit ~53s AFTER the indexer publishes
 * the chain_event:
 *
 *   03:02:07.582  chain_events 75/76 INSERT  -> bus -> this coordinator
 *                 -> invalidates history -> re-read finds NOTHING, the
 *                    activity row does not exist yet
 *   03:03:00.737  activity rows written by activity-consumer
 *                 -> emits NO chain_event, so nothing re-invalidated history
 *   ~03:04:00     the 60s useActivity poll finally surfaced them
 *
 * Measured on real EURC (20) and cirBTC (0.0001) deposits: both were correct in
 * the database at 03:03:00 yet invisible in the UI for up to another minute. The
 * chain_events event is necessary but fires too early for history; the activity
 * INSERT is the event that actually means "a row the history view can render
 * now exists". Both are needed, which is why the chain_events subscription is
 * kept untouched and this is added alongside it.
 *
 * Deliberately narrow: only `receive` rows. Those are written SERVER-side
 * (activity-consumer / the legacy scanners) with no client involvement, so the
 * UI has no other way to learn about them. Client-authored types (swap, p2p,
 * bulk, send) are written by the tab that is already refreshing itself, and
 * `claim` has its own 6s poll which this change must not disturb.
 */
export function scopesForActivityRow(row: Record<string, unknown>): RefreshScope[] {
  const wallet = typeof row.wallet_address === 'string' ? row.wallet_address.trim().toLowerCase() : ''
  if (!wallet) return []

  const type = typeof row.activity_type === 'string' ? row.activity_type : ''
  if (type !== 'receive') return []

  // Only a settled row should move balances. A non-completed receive would be
  // speculative, and crediting the UI for it then having it change is worse
  // than waiting for the next poll.
  const status = typeof row.status === 'string' ? row.status : ''
  if (status && status !== 'completed') return []

  const asset = typeof row.token_symbol === 'string' ? row.token_symbol : ''

  // Same granularity rule as the chain_events mapping above: on Arc, USDC IS
  // the native currency, so its balance lives in the whole-Arc bucket rather
  // than under a per-asset key. EURC / cirBTC are genuine ERC-20s with their
  // own asset keys.
  const balanceScope: RefreshScope = (!asset || asset.toUpperCase() === 'USDC')
    ? { kind: 'arc', wallet }
    : { kind: 'asset', wallet, chain: ARC, asset }

  return [balanceScope, { kind: 'history', wallet }]
}

/** First asset on the event, if the row carried one. */
function firstAsset(event: ShadowEvent): string | null {
  const raw = (event as unknown as { assets?: unknown }).assets
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') return raw[0]
  return null
}

/**
 * Scopes to refresh when the app comes back to the foreground — proposal §19.
 *
 * Pure and total, so the whole policy is assertable without a browser. Returns
 * [] for a short absence, which the caller must treat as "do nothing" rather
 * than "fall back to refreshing everything".
 *
 * Never returns `{kind:'all'}`: a resume is not a login. Only login, wallet
 * import and an explicit manual pull-to-refresh may clear a whole wallet.
 */
export function scopesForResume(hiddenMs: number, wallet: string): RefreshScope[] {
  const w = (wallet ?? '').trim().toLowerCase()
  if (!w) return []
  // A negative/NaN elapsed time means the clock is untrustworthy (tab restored
  // from a frozen state, system sleep). Treat it as "unknown, do nothing"
  // rather than guessing a large value and triggering the expensive path.
  if (!Number.isFinite(hiddenMs) || hiddenMs < 0) return []
  if (hiddenMs < RESUME_MIN_MS) return []

  const out: RefreshScope[] = [
    { kind: 'arc', wallet: w },
    { kind: 'claims', wallet: w },
  ]
  if (hiddenMs >= RESUME_EXTERNAL_MS) out.push({ kind: 'external', wallet: w })
  return out
}

/**
 * Merge a batch of scopes, dropping ones another scope already covers.
 *
 * Without this, a 3-deposit burst emits `arc` three times and `history` three
 * times. Ordering of the result is stable (widest-first per wallet) so tests
 * can assert it, and so a `chain` drop cannot be undone by a narrower `asset`
 * drop applied after it.
 */
export function dedupeScopes(scopes: RefreshScope[]): RefreshScope[] {
  const out: RefreshScope[] = []
  const seen = new Set<string>()

  // A wallet-wide arc drop subsumes any per-asset arc drop in the same batch.
  const arcWallets = new Set(
    scopes.filter(s => s.kind === 'arc').map(s => s.wallet.toLowerCase()),
  )
  // A chain drop subsumes per-asset drops on that same chain.
  const chainKeys = new Set(
    scopes.filter(s => s.kind === 'chain')
      .map(s => `${s.wallet.toLowerCase()}:${(s as { chain: string }).chain}`),
  )

  for (const s of scopes) {
    const w = s.wallet.toLowerCase()

    if (s.kind === 'asset') {
      const c = (s as { chain: string }).chain
      if (chainKeys.has(`${w}:${c}`)) continue          // covered by chain
      if (c === ARC && arcWallets.has(w)) continue      // covered by arc
    }

    const key = scopeKey(s)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }

  return out
}

/** Stable identity for a scope, for dedupe and for test assertions. */
export function scopeKey(s: RefreshScope): string {
  const w = s.wallet.toLowerCase()
  switch (s.kind) {
    case 'asset':    return `asset:${w}:${s.chain}:${s.asset}`
    case 'chain':    return `chain:${w}:${s.chain}`
    case 'external': return `external:${w}:${(s.chains ?? []).join(',')}`
    default:         return `${s.kind}:${w}`
  }
}

export interface SyncCoordinatorDeps {
  /** Normally BlockchainManager.refreshScope. */
  applyScope: (scope: RefreshScope, trigger: RefreshTrigger) => void
  /** Injectable for tests; defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => unknown
  /** Injectable for tests; defaults to console.info. */
  log?: (msg: string) => void
  /** Set false to observe and log without applying. Defaults to true. */
  enabled?: boolean
}

export interface SyncCoordinator {
  /** Feed one observed chain_event. Safe to call from the Realtime handler. */
  handle: (event: ShadowEvent) => void
  /**
   * Feed one observed `activity` INSERT — the Phase 6 ordering fix.
   *
   * Routed through the SAME pending queue and 250ms coalescing as chain_events,
   * so a deposit that produces both events cannot cause two independent refresh
   * cycles. It is NOT suppressed by the earlier chain_events refresh: the two
   * arrive ~53s apart, in different flush batches, and the later one is
   * precisely the one that can actually surface the row.
   */
  handleActivityRow: (row: Record<string, unknown>) => void
  /**
   * App returned to the foreground after `hiddenMs` away — proposal §19.
   * Applies immediately (no coalescing): a resume is a single discrete moment,
   * not a burst, and the user is looking at the screen right now.
   */
  handleResume: (hiddenMs: number, wallet: string) => void
  /** Apply everything pending immediately (tests, and visibility-change). */
  flush: () => void
  /** Observability: what has been applied so far. */
  stats: () => {
    received: number; applied: number; coalesced: number; lastTrigger: string | null
    activityRows: number; activityReplaysIgnored: number
  }
}

/**
 * Wire events to invalidations, with coalescing and a kill switch.
 *
 * `enabled: false` makes this a pure observer — it still logs exactly what it
 * WOULD invalidate, which is how Phase 6 can be verified in production before
 * anything depends on it. That is the fallback path referenced in the runbook:
 * flip it off and polling alone carries the app again, with no redeploy.
 */
export function createSyncCoordinator(deps: SyncCoordinatorDeps): SyncCoordinator {
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const log = deps.log ?? ((m: string) => console.info(m))
  const enabled = deps.enabled !== false

  let pending: RefreshScope[] = []
  let pendingTrigger: RefreshTrigger | null = null
  let timer: unknown = null
  let received = 0
  let applied = 0
  let coalesced = 0
  let activityRows = 0
  let activityReplaysIgnored = 0

  /**
   * Activity row ids already acted on, so a Realtime REPLAY of the same row
   * cannot trigger a second refresh. Bounded FIFO — an unbounded set in a
   * long-lived tab is a slow leak, and only recent ids can plausibly be
   * redelivered.
   */
  const seenActivityIds: string[] = []
  const seenActivitySet = new Set<string>()
  const SEEN_ACTIVITY_MAX = 300

  const flush = () => {
    timer = null
    if (pending.length === 0) return

    const merged = dedupeScopes(pending)
    coalesced += pending.length - merged.length
    const trigger = pendingTrigger ?? 'chain-event'
    pending = []
    pendingTrigger = null

    for (const s of merged) {
      if (enabled) {
        try {
          deps.applyScope(s, trigger)
          applied++
        } catch (e) {
          // A failed invalidation must never break the event stream — the
          // next poll still covers it.
          log(`[sync] applyScope threw for ${scopeKey(s)}: ${e instanceof Error ? e.message : String(e)}`)
        }
      } else {
        log(`[sync] WOULD refresh ${scopeKey(s)} (trigger=${trigger}, observer mode)`)
      }
    }
  }

  return {
    handle(event: ShadowEvent) {
      received++
      const scopes = scopesFor(event)
      if (scopes.length === 0) {
        log(`[sync] no scope for event_type='${event.eventType}' — ignored (polling still covers it)`)
        return
      }
      pending.push(...scopes)
      pendingTrigger = triggerFor(event.eventType)
      if (timer === null) timer = schedule(flush, COALESCE_WINDOW_MS)
    },

    /**
     * PHASE 6 ORDERING FIX — an `activity` row now exists that history can render.
     *
     * Queued through the same coalescing path as chain_events so a burst of rows
     * from one consumer pass (the observed case: EURC + cirBTC inserted in the
     * SAME transaction at 03:03:00.737) collapses into one refresh.
     */
    handleActivityRow(row: Record<string, unknown>) {
      activityRows++

      // Replay guard: Supabase Realtime can redeliver a row. Refreshing twice
      // is harmless but pointless, and an unbounded redelivery loop would be a
      // storm. Keyed on the row's own id.
      const id = row?.id == null ? '' : String(row.id)
      if (id) {
        if (seenActivitySet.has(id)) {
          activityReplaysIgnored++
          log(`[sync] activity row ${id} already handled — replay ignored`)
          return
        }
        seenActivitySet.add(id)
        seenActivityIds.push(id)
        if (seenActivityIds.length > SEEN_ACTIVITY_MAX) {
          const evicted = seenActivityIds.shift()
          if (evicted !== undefined) seenActivitySet.delete(evicted)
        }
      }

      const scopes = scopesForActivityRow(row)
      if (scopes.length === 0) {
        log(`[sync] activity row type='${String(row?.activity_type ?? '')}' not a server-authored receive — ignored`)
        return
      }
      pending.push(...scopes)
      // Deliberately 'deposit-detected': from the UI's perspective this IS the
      // moment the deposit became visible, which is what the trigger records.
      pendingTrigger = 'deposit-detected'
      if (timer === null) timer = schedule(flush, COALESCE_WINDOW_MS)
    },

    handleResume(hiddenMs: number, wallet: string) {
      const scopes = scopesForResume(hiddenMs, wallet)
      if (scopes.length === 0) {
        log(`[sync] resume after ${Math.round(hiddenMs / 1000)}s — nothing to refresh (§19)`)
        return
      }
      // Applied directly rather than queued: a resume is one discrete moment,
      // and deferring it by the coalesce window would show the user stale data
      // at exactly the instant they are looking at the screen.
      for (const s of scopes) {
        if (enabled) {
          try {
            deps.applyScope(s, 'resume')
            applied++
          } catch (e) {
            log(`[sync] resume applyScope threw for ${scopeKey(s)}: ${e instanceof Error ? e.message : String(e)}`)
          }
        } else {
          log(`[sync] WOULD refresh ${scopeKey(s)} (trigger=resume, observer mode)`)
        }
      }
      log(`[sync] resume after ${Math.round(hiddenMs / 1000)}s — refreshed ${scopes.map(scopeKey).join(', ')}`)
    },

    flush,
    stats: () => ({
      received,
      applied,
      coalesced,
      lastTrigger: pendingTrigger,
      activityRows,
      activityReplaysIgnored,
    }),
  }
}
