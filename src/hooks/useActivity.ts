/**
 * useActivity — React hook for the activity feed.
 *
 * ── Update: recent RECEIVED transactions now come directly from the chain ──
 * Deep pagination (loadMore) still reads from Supabase — that index is
 * itself populated FROM the blockchain by deposit-scan-all, not mock or
 * stale data, and re-architecting pagination entirely around the
 * explorer's own cursor would risk the infinite-scroll performance this
 * hook already has. What changed: a bounded, most-recent-transactions
 * layer (see lib/onchainReceivedActivity.ts) now reads directly from
 * ArcScan, merged into `records`, refreshed via polling (60s), on
 * foreground-return, and immediately on the 'meshport:onchain-activity'
 * event — dispatched by HomePage when the polled Arc balance increases. That
 * event used to also come from an Alchemy WebSocket (lib/realtimeDeposits.ts),
 * which was removed once Phase 5/6 superseded it; the listener below is
 * deliberately kept because HomePage still dispatches it.
 * So a deposit sent straight to the wallet address shows up without
 * waiting on any server-mediated hop, using the blockchain itself as the
 * source of truth for "did something just arrive."
 *
 * Features:
 * - Loads from Supabase on mount (instant cross-device) for full history
 * - Direct on-chain read for recent received transactions (see above)
 * - Realtime subscription for new transactions (Supabase)
 * - Pagination / infinite scroll (Supabase-backed, unchanged)
 * - Filter by type, status, search
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  fetchActivity,
  subscribeToActivity,
  ActivityRecord,
  ActivityType,
  ActivityStatus,
  FetchOptions,
} from '@/lib/ActivityService'
import { fetchRecentOnchainReceived, type OnchainReceivedTx } from '@/lib/onchainReceivedActivity'
import { getRecentArcDeposits } from '@/lib/arcDepositWatcher'

const PAGE_SIZE = 100
/**
 * PHASE 6 — lengthened from 12s to 60s, NOT removed.
 *
 * `deposit_detected` / `transfer_detected` now invalidate the `history` scope
 * through SyncCoordinator (see blockchain/SyncCoordinator.ts), so a real
 * deposit surfaces here on the event rather than on the next tick. This poll is
 * retained as the fallback for the cases the event stream cannot cover:
 *   - Realtime disconnected / tab throttled in the background
 *   - an activity row written by a path that emits no chain_event
 *     (p2p, swap, bulk — all worker/client-written)
 *   - SYNC_COORDINATOR_ENABLED flipped off as the Phase 6 rollback
 * Deleting it would make those cases silently stale, which is why the spec
 * says reduce-then-verify rather than remove.
 */
const ONCHAIN_POLL_MS = 60_000

function onchainTxToActivityRecord(walletAddress: string, tx: OnchainReceivedTx): ActivityRecord {
  return {
    id:                  `onchain_${tx.txHash}`,
    walletAddress,
    txHash:              tx.txHash,
    activityType:        'receive',
    tokenSymbol:         tx.tokenSymbol,
    amount:              tx.amount,
    usdValue:            tx.amount,
    counterpartyAddress: tx.fromAddress,
    status:              (tx.status === 'confirmed' ? 'completed' : 'pending') as ActivityStatus,
    metadata:            { note: 'External deposit', source: 'onchain_direct' },
    createdAt:           tx.timestamp,
    updatedAt:           tx.timestamp,
  }
}

/**
 * The pure state reducer behind mergeOnchainReceived below.
 *
 * Lifted out of the setRecords callback it used to live inside so the merge
 * semantics — which records survive, which get deduped, what order they come
 * back in — are directly testable without mounting the hook. The hook itself
 * is unchanged in behaviour: it still calls exactly this, once per merge.
 *
 * Contract: every record in `prev` appears in the output (nothing is ever
 * dropped), on-chain transactions not already present are added, and the
 * result is ordered newest-first by createdAt.
 */
export function mergeOnchainIntoRecords(
  walletAddress: string,
  prev: ActivityRecord[],
  onchainTxs: OnchainReceivedTx[],
): ActivityRecord[] {
  const merged = new Map<string, ActivityRecord>()
  // Existing records first, so a Supabase-sourced row (which may carry
  // richer metadata, e.g. a resolved sender username) wins over the
  // synthetic on-chain one for the SAME transaction — the on-chain
  // layer's job is to make sure the transaction is VISIBLE at all,
  // immediately; once Supabase's own copy exists, that becomes the
  // canonical version, same tx either way (deduped by hash, not id).
  //
  // FIX 1 — rows with NO txHash used to be skipped here, and because the
  // return value REPLACES the whole list they were silently dropped from
  // state on every merge. 45 of one wallet's 466 rows had tx_hash = NULL
  // (28 p2p_sell_order, 17 p2p_refund), so every refresh erased them until
  // the next full load(). They are now keyed by id.
  //
  // The `id:` prefix keeps the two keyspaces disjoint: a tx hash is always
  // 0x-prefixed hex, so it can never collide with an `id:<uuid>` key, and a
  // row that HAS a txHash is still keyed by hash alone — so hash-dedup
  // against the on-chain layer below behaves exactly as before.
  //
  // FIX 3 (2026-09-02) — a self-bulk-payout (paying yourself as one of your
  // own batch's recipients) writes TWO rows sharing the exact same
  // activityType ('bulk') AND the exact same stripped on-chain hash — a
  // sent-summary leg and a received leg, distinguished only by
  // metadata.direction. Keying purely by hash (as this map always had)
  // meant the SECOND of those two `prev` rows silently overwrote the
  // first right here, before onchainTxs were even considered — a direct
  // violation of this function's own "every record in prev appears in the
  // output" contract, and the real cause behind reports of a self-paid /
  // self-received bulk row intermittently vanishing from history. Every
  // other type pairing (send vs receive, p2p_purchase vs p2p_refund, a
  // synthetic onchain 'receive' vs a stored 'receive') already has either
  // a different activityType or no conflicting direction, so folding
  // direction into the key only ever disambiguates the bulk self-pay case
  // — it does not change dedup behavior for anything else, including every
  // case pinned by the tests below.
  const keyFor = (r: { txHash?: string | null; id: string; activityType: string; metadata?: any }) =>
    r.txHash ? `${r.activityType}:${r.txHash.toLowerCase()}:${r.metadata?.direction || ''}` : `id:${r.id}`
  for (const r of prev) {
    merged.set(keyFor(r), r)
  }
  for (const tx of onchainTxs) {
    // onchainTxToActivityRecord always produces activityType: 'receive'
    // with no metadata.direction, so this key matches keyFor's shape
    // exactly for the type of record this loop can ever produce.
    const txKey = `receive:${tx.txHash.toLowerCase()}:`
    if (!merged.has(txKey)) {
      merged.set(txKey, onchainTxToActivityRecord(walletAddress, tx))
    } else {
      // Already known (e.g. Supabase caught up since the last poll) —
      // but if the on-chain read now shows 'confirmed' where the
      // existing record was still 'pending', reflect that transition
      // immediately rather than waiting on Supabase's own update.
      const existing = merged.get(txKey)!
      if (existing.status === 'pending' && tx.status === 'confirmed') {
        merged.set(txKey, { ...existing, status: 'completed' })
      }
    }
  }
  // FIX 2 — Map.values() yields INSERTION order, not chronological order, so
  // a freshly-merged on-chain row landed last no matter how recent it was.
  // Combined with ActivityPage's TODAY/YESTERDAY/THIS WEEK grouping that put
  // a brand-new deposit below older entries or in the wrong day group, which
  // is what "the latest activity isn't showing correctly" actually was.
  // fetchActivity already returns created_at DESC; this restores that
  // invariant after merging so the list is always newest-first.
  //
  // Secondary tiebreak on `id` — same reasoning as ActivityPage.tsx's own
  // sort and ActivityService.ts's `order=created_at.desc,id.desc` query:
  // two rows can genuinely tie at createdAt's millisecond resolution (a
  // bulk payout's sent + received legs, written back-to-back), and without
  // a deterministic tiebreak their relative order could visibly change
  // across merges even though neither row's own data changed.
  return Array.from(merged.values())
    .sort((a, b) => {
      const t = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      if (t !== 0) return t
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
    })
}

export interface UseActivityResult {
  records:     ActivityRecord[]
  loading:     boolean
  loadingMore: boolean
  error:       string
  hasMore:     boolean
  total:       number
  filter:      ActivityType | undefined
  search:      string
  setFilter:   (f: ActivityType | undefined) => void
  setSearch:   (s: string) => void
  loadMore:    () => void
  refresh:     () => void
}

export function useActivity(walletAddress: string | null): UseActivityResult {
  const [records,     setRecords]     = useState<ActivityRecord[]>([])
  const [loading,     setLoading]     = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error,       setError]       = useState('')
  const [hasMore,     setHasMore]     = useState(true)
  const [total,       setTotal]       = useState(0)
  const [filter,      setFilter]      = useState<ActivityType | undefined>()
  const [search,      setSearch]      = useState('')
  const offsetRef = useRef(0)
  // Bumped on every load() call (reset or loadMore) so an in-flight request
  // can tell, once it resolves, whether it's still the most recent request
  // in flight. Without this, a slow "all" response landing after a fast
  // "swap" filter switch would silently overwrite the newer, correct
  // results with the stale ones — a genuine, previously-unmitigated race
  // between filter/search/wallet changes and network latency. Cheap
  // sequence-number guard, same idea as an AbortController but doesn't
  // require fetchActivity/Supabase's client to support cancellation.
  const requestIdRef = useRef(0)

  // ── Initial load ───────────────────────────────────────────────────────────
  const load = useCallback(async (reset = false) => {
    if (!walletAddress) return
    if (reset) { setLoading(true); offsetRef.current = 0 }
    setError('')

    const opts: FetchOptions = {
      limit:        PAGE_SIZE,
      offset:       reset ? 0 : offsetRef.current,
      activityType: filter,
      search:       search || undefined,
    }

    const myRequestId = ++requestIdRef.current
    try {
      const data = await fetchActivity(walletAddress, opts)
      // A newer load() (filter change, search change, wallet switch, or
      // another loadMore) started while this one was in flight — its
      // result is stale by definition and must not be applied, no matter
      // which one actually resolves first.
      if (myRequestId !== requestIdRef.current) return

      let addedCount = data.length
      if (reset) {
        // A reset REPLACES the whole list (mount, filter/search change, and
        // the Activity page's Refresh button all route here). Re-apply the
        // real-time watcher's buffered deposits so a just-arrived Receive
        // that the Supabase row hasn't caught up to (still 2-4 min out)
        // isn't wiped by the reload — the "history disappears when I hit
        // Refresh, then comes back later" bug. mergeOnchainIntoRecords
        // dedupes by hash, so once the real row lands this is a no-op.
        const buffered = getRecentArcDeposits()
        setRecords(buffered.length ? mergeOnchainIntoRecords(walletAddress, data, buffered) : data)
      } else {
        setRecords(prev => {
          const existingIds = new Set(prev.map(r => r.id))
          const fresh = data.filter(r => !existingIds.has(r.id))
          addedCount = fresh.length
          return [...prev, ...fresh]
        })
      }
      setHasMore(data.length === PAGE_SIZE)
      offsetRef.current = (reset ? 0 : offsetRef.current) + data.length
      // Use addedCount (post-dedup), not the raw page size, so `total`
      // doesn't drift upward when a realtime insert during active
      // pagination causes this page's window to overlap the previous one
      // by one row (see the realtime-subscription effect below) — that
      // overlap is filtered out of `records` above and must be filtered
      // out of the displayed total too.
      setTotal(t => reset ? data.length : t + addedCount)
    } catch (e: any) {
      if (myRequestId !== requestIdRef.current) return
      setError(e.message ?? 'Failed to load activity')
    } finally {
      if (myRequestId === requestIdRef.current) setLoading(false)
    }
  }, [walletAddress, filter, search])

  // Reset and reload when filter/search/wallet changes
  useEffect(() => { load(true) }, [walletAddress, filter, search])

  // ── Realtime subscription ──────────────────────────────────────────────────
  useEffect(() => {
    if (!walletAddress) return
    const unsub = subscribeToActivity(walletAddress, (newRecord) => {
      setRecords(prev => {
        // Avoid duplicates
        if (prev.some(r => r.id === newRecord.id)) return prev
        return [newRecord, ...prev]
      })
      setTotal(t => t + 1)
    })
    return unsub
  }, [walletAddress])

  // ── Direct on-chain received layer ──────────────────────────────────────────
  // Merges bounded, recent on-chain-sourced received transactions into
  // `records` — see file header and lib/onchainReceivedActivity.ts for the
  // full reasoning. Runs independently of the Supabase pagination above;
  // never touches offsetRef or hasMore. The merge itself is
  // mergeOnchainIntoRecords above.
  const mergeOnchainReceived = useCallback(async () => {
    if (!walletAddress) return
    const onchainTxs = await fetchRecentOnchainReceived(walletAddress)
    if (onchainTxs.length === 0) return
    setRecords(prev => mergeOnchainIntoRecords(walletAddress, prev, onchainTxs))
  }, [walletAddress])

  useEffect(() => {
    if (!walletAddress) return
    mergeOnchainReceived() // instant check on mount — the actual fix for "doesn't appear immediately"

    const poll = setInterval(mergeOnchainReceived, ONCHAIN_POLL_MS)

    const onVisible = () => { if (document.visibilityState === 'visible') mergeOnchainReceived() }
    document.addEventListener('visibilitychange', onVisible)

    // The existing WebSocket listener (AppLayout.tsx) already detects
    // real-time chain activity and dispatches this event — reusing it here
    // as the "real-time blockchain event subscription" trigger rather than
    // opening a second, redundant connection just for this page.
    const onChainActivity = () => mergeOnchainReceived()
    window.addEventListener('meshport:onchain-activity', onChainActivity)

    return () => {
      clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('meshport:onchain-activity', onChainActivity)
    }
  }, [walletAddress, mergeOnchainReceived])

  // ── Real-time on-chain deposit layer (fed by the session-wide watcher) ─────
  // The Arc eth_subscribe(logs) watcher runs once for the whole session in
  // AppLayout (see lib/arcDepositWatcher.ts), not here — so it keeps working
  // on every route, not only while this page is mounted. It drops each
  // confirmed external deposit into a module buffer and dispatches
  // 'meshport:arc-deposit'. This effect merges that buffer through the exact
  // same mergeOnchainIntoRecords() path as the ArcScan layer above, on mount
  // and on every fresh deposit. Reading the buffer on mount is what makes a
  // just-arrived deposit survive ActivityPage's refresh()-on-mount instead of
  // vanishing until the ~2-4 min server row lands. Deep pagination, dedup and
  // filtering are untouched.
  useEffect(() => {
    if (!walletAddress) return
    const mergeFromWatcher = () => {
      const txs = getRecentArcDeposits()
      if (txs.length === 0) return
      setRecords(prev => mergeOnchainIntoRecords(walletAddress, prev, txs))
    }
    mergeFromWatcher() // seed from the buffer immediately (survives remounts)
    const onDeposit = () => mergeFromWatcher()
    window.addEventListener('meshport:arc-deposit', onDeposit)
    return () => window.removeEventListener('meshport:arc-deposit', onDeposit)
  }, [walletAddress])

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    load(false).finally(() => setLoadingMore(false))
  }, [load, loadingMore, hasMore])

  const refresh = useCallback(() => {
    setRecords([])
    setHasMore(true)
    offsetRef.current = 0
    load(true)
  }, [load])

  const handleSetFilter = useCallback((f: ActivityType | undefined) => {
    setFilter(f)
    offsetRef.current = 0
  }, [])

  const handleSetSearch = useCallback((s: string) => {
    setSearch(s)
    offsetRef.current = 0
  }, [])

  return {
    records, loading, loadingMore, error,
    hasMore, total, filter, search,
    setFilter: handleSetFilter,
    setSearch: handleSetSearch,
    loadMore, refresh,
  }
}
