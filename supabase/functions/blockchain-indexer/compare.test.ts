// supabase/functions/blockchain-indexer/compare.test.ts
//
// Phase 3 tests for the shadow-comparison classification logic — the code
// that decides the cutover gate. Run with:
//   deno test supabase/functions/blockchain-indexer/compare.test.ts
//
// Zero external imports — see cursorMath.test.ts's header for why.
import { compareDeposits, compareClaims, assessComparability, normalizeTxHash, internalSenderOf, KNOWN_INTERNAL_CONTRACTS, TIMING_DIFFERENCE_THRESHOLD_MS } from './compare.ts'
import type { IndexerEventLike, WorkerRowLike } from './compare.ts'

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${msg ? msg + ': ' : ''}assertEquals failed\n  actual:   ${a}\n  expected: ${e}`)
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

const comparable = { comparable: true, reason: null, backlogBlocks: 0 }

Deno.test('normalizeTxHash: strips the recv_ prefix and lowercases', () => {
  assertEquals(normalizeTxHash('recv_0xABC123'), '0xabc123')
  assertEquals(normalizeTxHash('0xABC123'), '0xabc123')
  assertEquals(normalizeTxHash(null), '')
  assertEquals(normalizeTxHash(undefined), '')
})

Deno.test('compareDeposits: matched event/worker pair -> PASS, recall 100%', () => {
  const indexerEvents: IndexerEventLike[] = [
    { wallet_address: '0xWallet1', tx_hash: '0xHash1', event_type: 'deposit_detected' },
  ]
  const workerRows: WorkerRowLike[] = [
    { wallet_address: '0xwallet1', tx_hash: 'recv_0xhash1', activity_type: 'receive' },
  ]
  const result = compareDeposits(indexerEvents, workerRows, comparable)
  assertEquals(result.status, 'PASS')
  assertEquals(result.matched, 1)
  assertEquals(result.workerOnly, 0)
  assertEquals(result.indexerOnly, 0)
  assertEquals(result.recallPct, 100)
})

Deno.test('compareDeposits: legacy detected it, indexer did not -> FAIL with workerOnly=1 (the real cutover-blocking case)', () => {
  const indexerEvents: IndexerEventLike[] = []
  const workerRows: WorkerRowLike[] = [
    { wallet_address: '0xwallet1', tx_hash: 'recv_0xhash1', activity_type: 'receive' },
  ]
  const result = compareDeposits(indexerEvents, workerRows, comparable)
  assertEquals(result.status, 'FAIL')
  assertEquals(result.workerOnly, 1)
  assertEquals(result.matched, 0)
  // Fix 3 changed recallPct's formula to (matched+accountedFor)/(matched+
  // accountedFor+trueIndexerOnly) — a measure of the INDEXER's own
  // detection rate, not the old matched/(matched+workerOnly). With zero
  // indexer events at all, that denominator is legitimately 0 (there is
  // nothing to measure the indexer's recall against), so this now
  // correctly reports null ("not measured for this axis") rather than a
  // possibly-misleading 0. See docs/PHASE_3_FIXES_APPLIED.md.
  assertEquals(result.recallPct, null)
})

Deno.test('compareDeposits: indexer detected it, legacy did not -> FAIL with indexerOnly=1', () => {
  const indexerEvents: IndexerEventLike[] = [
    { wallet_address: '0xwallet1', tx_hash: '0xhash1', event_type: 'transfer_detected' },
  ]
  const workerRows: WorkerRowLike[] = []
  const result = compareDeposits(indexerEvents, workerRows, comparable)
  assertEquals(result.status, 'FAIL')
  assertEquals(result.indexerOnly, 1)
  assertEquals(result.matched, 0)
})

Deno.test('compareDeposits: an indexer-only event from a known internal (Circle Kit/CCTP) contract is excluded, not counted as a miss', () => {
  const internalContract = [...KNOWN_INTERNAL_CONTRACTS][0]
  const indexerEvents: IndexerEventLike[] = [
    {
      wallet_address: '0xwallet1', tx_hash: '0xhash1', event_type: 'transfer_detected',
      metadata: { sender: internalContract },
    },
  ]
  const result = compareDeposits(indexerEvents, [], comparable)
  // Not a FAIL from a real miss — this is the documented "different scope,
  // not a defect" case (compare.ts header, Fix C).
  assertEquals(result.status, 'NOT_COMPARABLE')
  assertEquals(result.indexerOnly, 0)
  assertEquals(result.internalExcluded, 1)
})

Deno.test('compareDeposits: internal-sender suppression never masks a REAL worker_only miss (matching happens before suppression)', () => {
  const internalContract = [...KNOWN_INTERNAL_CONTRACTS][0]
  // Same tx/wallet exists on BOTH sides — must match normally, not be
  // suppressed as "internal", even though its sender happens to be a known
  // internal contract too.
  const indexerEvents: IndexerEventLike[] = [
    { wallet_address: '0xwallet1', tx_hash: '0xhash1', event_type: 'transfer_detected', metadata: { sender: internalContract } },
  ]
  const workerRows: WorkerRowLike[] = [
    { wallet_address: '0xwallet1', tx_hash: 'recv_0xhash1', activity_type: 'receive' },
  ]
  const result = compareDeposits(indexerEvents, workerRows, comparable)
  assertEquals(result.status, 'PASS')
  assertEquals(result.matched, 1)
})

Deno.test('compareDeposits: empty window -> NOT_COMPARABLE, never a silent PASS/FAIL', () => {
  const result = compareDeposits([], [], comparable)
  assertEquals(result.status, 'NOT_COMPARABLE')
  assertEquals(result.recallPct, null)
})

Deno.test('compareDeposits: not comparable (indexer too far behind head) is reported honestly, not as PASS', () => {
  const result = compareDeposits([], [], { comparable: false, reason: 'indexer behind head', backlogBlocks: 900 })
  assertEquals(result.status, 'NOT_COMPARABLE')
})

Deno.test('compareClaims: indexer emits no claim events by design -> NOT_APPLICABLE, never counted as a failure', () => {
  const workerRows: WorkerRowLike[] = [
    { wallet_address: '0xwallet1', tx_hash: null, destination_tx_hash: '0xminthash' },
  ]
  const result = compareClaims([], workerRows, comparable)
  assertEquals(result.status, 'NOT_APPLICABLE')
  // workerOnly is factual context here, NOT a failure signal — status is
  // what disambiguates it (compare.ts's own documented contract).
  assertEquals(result.workerOnly, 1)
})

Deno.test('compareClaims: destination_tx_hash as undefined (not just null) is handled — regression test for the type-error fix', () => {
  // Exercises the exact shape that caused a Deno type-check failure before
  // the Phase 3 fix (destination_tx_hash?: string | null, so `undefined` is
  // a real possible value, not just a theoretical one).
  const workerRows: Array<WorkerRowLike> = [
    { wallet_address: '0xwallet1', tx_hash: null, destination_tx_hash: undefined },
  ]
  const result = compareClaims([], workerRows, comparable)
  assertEquals(result.status, 'NOT_APPLICABLE')
})

Deno.test('assessComparability: a window fully within backlog tolerance is comparable', () => {
  const result = assessComparability({ last_indexed_block: 1000, latest_observed_block: 1000, sync_state: 'idle' }, 600)
  assert(result.comparable, 'expected comparable=true when indexer is caught up')
})

Deno.test('assessComparability: indexer too far behind head is not comparable', () => {
  const result = assessComparability({ last_indexed_block: 100, latest_observed_block: 1000, sync_state: 'idle' }, 600)
  assert(!result.comparable, 'expected comparable=false when backlog exceeds max_backlog_blocks')
  assertEquals(result.backlogBlocks, 900)
})

Deno.test('assessComparability: no cursor row at all is not comparable', () => {
  const result = assessComparability(null, 600)
  assert(!result.comparable, 'expected comparable=false with no cursor row')
})

// ── Phase 3 Fix 3: ACCOUNTED_FOR_OTHER_ACTIVITY classification ─────────────

Deno.test('compareDeposits Fix 3: an indexer event matching a swap/bulk/p2p_purchase/p2p_refund row is ACCOUNTED_FOR_OTHER_ACTIVITY, not TRUE_INDEXER_ONLY', () => {
  for (const activityType of ['swap', 'bulk', 'p2p_purchase', 'p2p_refund']) {
    const indexerEvents: IndexerEventLike[] = [
      { wallet_address: '0xwallet1', tx_hash: '0xhash1', event_type: 'transfer_detected', status: 'confirmed' },
    ]
    const workerRows: WorkerRowLike[] = [
      { wallet_address: '0xwallet1', tx_hash: '0xhash1', activity_type: activityType },
    ]
    const result = compareDeposits(indexerEvents, workerRows, comparable, null, Date.now())
    assertEquals(result.trueIndexerOnly, 0, `activity_type=${activityType} must not count as trueIndexerOnly`)
    assertEquals(result.accountedForOtherActivity, 1, `activity_type=${activityType} must be classified as accounted-for`)
    assertEquals(result.accountedForOtherActivityKeys[0]?.activityType, activityType)
    // The whole point of Fix 3: this window is now a PASS, not a FAIL.
    assertEquals(result.status, 'PASS')
  }
})

Deno.test('compareDeposits Fix 3: raw indexerOnly is unchanged (still includes accounted-for items) — nothing is hidden, only reclassified', () => {
  const indexerEvents: IndexerEventLike[] = [
    { wallet_address: '0xwallet1', tx_hash: '0xhash1', event_type: 'transfer_detected', status: 'confirmed' },
  ]
  const workerRows: WorkerRowLike[] = [
    { wallet_address: '0xwallet1', tx_hash: '0xhash1', activity_type: 'p2p_purchase' },
  ]
  const result = compareDeposits(indexerEvents, workerRows, comparable, null, Date.now())
  assertEquals(result.indexerOnly, 1, 'raw indexerOnly must still count the accounted-for item — Fix 3 reclassifies, it does not delete')
  assertEquals(result.indexerOnlyKeys.length, 1)
})

Deno.test('compareDeposits Fix 3: a genuine miss (no activity row of ANY type) is still TRUE_INDEXER_ONLY and still fails the window', () => {
  const oldEnough = new Date(Date.now() - 20 * 60_000).toISOString() // 20 min old, well past the timing threshold
  const indexerEvents: IndexerEventLike[] = [
    { wallet_address: '0xwallet1', tx_hash: '0xhash1', event_type: 'transfer_detected', status: 'confirmed', created_at: oldEnough },
  ]
  const result = compareDeposits(indexerEvents, [], comparable, null, Date.now())
  assertEquals(result.trueIndexerOnly, 1)
  assertEquals(result.accountedForOtherActivity, 0)
  assertEquals(result.timingDifference, 0)
  assertEquals(result.status, 'FAIL')
})

Deno.test('compareDeposits Fix 3: ordering safety — a receive-type match still wins over an accounted-for-other-activity classification', () => {
  // Same tx has BOTH a receive row and (hypothetically) a same-key swap row —
  // receive must win, exactly mirroring Fix C's own safety ordering (real
  // detections/matches always checked before any suppression/reclassification).
  const indexerEvents: IndexerEventLike[] = [
    { wallet_address: '0xwallet1', tx_hash: '0xhash1', event_type: 'transfer_detected', status: 'confirmed' },
  ]
  const workerRows: WorkerRowLike[] = [
    { wallet_address: '0xwallet1', tx_hash: '0xhash1', activity_type: 'receive' },
  ]
  const result = compareDeposits(indexerEvents, workerRows, comparable, null, Date.now())
  assertEquals(result.matched, 1)
  assertEquals(result.accountedForOtherActivity, 0)
})

// ── Phase 3 Fix 3: TIMING_DIFFERENCE classification ─────────────────────────

Deno.test('compareDeposits Fix 3: a very recent one-sided indexer_only is TIMING_DIFFERENCE, not TRUE_INDEXER_ONLY', () => {
  const veryRecent = new Date(Date.now() - 60_000).toISOString() // 1 minute old
  const indexerEvents: IndexerEventLike[] = [
    { wallet_address: '0xwallet1', tx_hash: '0xhash1', event_type: 'transfer_detected', status: 'confirmed', created_at: veryRecent },
  ]
  const result = compareDeposits(indexerEvents, [], comparable, null, Date.now())
  assertEquals(result.trueIndexerOnly, 0)
  assertEquals(result.timingDifference, 1)
  // A window whose ONLY content is a timing-difference item hasn't actually
  // proven anything yet either way — NOT_COMPARABLE ("wait for the next
  // window"), not a false PASS and not a false FAIL.
  assertEquals(result.status, 'NOT_COMPARABLE')
})

Deno.test('compareDeposits Fix 3: the SAME event, once it ages past the threshold, becomes TRUE_INDEXER_ONLY', () => {
  const old = new Date(Date.now() - (TIMING_DIFFERENCE_THRESHOLD_MS + 60_000)).toISOString()
  const indexerEvents: IndexerEventLike[] = [
    { wallet_address: '0xwallet1', tx_hash: '0xhash1', event_type: 'transfer_detected', status: 'confirmed', created_at: old },
  ]
  const result = compareDeposits(indexerEvents, [], comparable, null, Date.now())
  assertEquals(result.timingDifference, 0)
  assertEquals(result.trueIndexerOnly, 1)
  assertEquals(result.status, 'FAIL')
})

Deno.test('compareDeposits Fix 3: timing carve-out applies symmetrically to worker_only', () => {
  const veryRecent = new Date(Date.now() - 60_000).toISOString()
  const workerRows: WorkerRowLike[] = [
    { wallet_address: '0xwallet1', tx_hash: 'recv_0xhash1', activity_type: 'receive', created_at: veryRecent },
  ]
  const result = compareDeposits([], workerRows, comparable, null, Date.now())
  assertEquals(result.status, 'NOT_COMPARABLE', 'a very recent worker_only-only window should not FAIL — the indexer may just not have caught up yet')
  assertEquals(result.timingDifference, 1)
})

Deno.test('compareDeposits Fix 3: missing/unparseable created_at is treated as NOT recent (no benefit of the doubt)', () => {
  const indexerEvents: IndexerEventLike[] = [
    { wallet_address: '0xwallet1', tx_hash: '0xhash1', event_type: 'transfer_detected', status: 'confirmed', created_at: null },
  ]
  const result = compareDeposits(indexerEvents, [], comparable, null, Date.now())
  assertEquals(result.timingDifference, 0)
  assertEquals(result.trueIndexerOnly, 1)
})

// ── Phase 3 Fix 4: confirmed-only filter (defense in depth in compare.ts) ──

Deno.test('compareDeposits Fix 4: a pending indexer event is excluded from comparison entirely', () => {
  const indexerEvents: IndexerEventLike[] = [
    { wallet_address: '0xwallet1', tx_hash: '0xhash1', event_type: 'transfer_detected', status: 'pending' },
  ]
  const result = compareDeposits(indexerEvents, [], comparable, null, Date.now())
  // Excluded entirely -> nothing on either side -> NOT_COMPARABLE, not FAIL.
  assertEquals(result.status, 'NOT_COMPARABLE')
})

Deno.test('compareDeposits Fix 4: a confirmed indexer event IS included in comparison', () => {
  const oldEnough = new Date(Date.now() - 20 * 60_000).toISOString()
  const indexerEvents: IndexerEventLike[] = [
    { wallet_address: '0xwallet1', tx_hash: '0xhash1', event_type: 'transfer_detected', status: 'confirmed', created_at: oldEnough },
  ]
  const result = compareDeposits(indexerEvents, [], comparable, null, Date.now())
  assertEquals(result.status, 'FAIL') // included, and genuinely unmatched -> a real miss
  assertEquals(result.trueIndexerOnly, 1)
})

Deno.test('compareDeposits Fix 4: a reorged indexer event is excluded from comparison entirely', () => {
  const indexerEvents: IndexerEventLike[] = [
    { wallet_address: '0xwallet1', tx_hash: '0xhash1', event_type: 'transfer_detected', status: 'reorged' },
  ]
  const result = compareDeposits(indexerEvents, [], comparable, null, Date.now())
  assertEquals(result.status, 'NOT_COMPARABLE')
})

Deno.test('compareDeposits Fix 4: an event with NO status field at all is not filtered (backward compatibility for callers that never populate it)', () => {
  const oldEnough = new Date(Date.now() - 20 * 60_000).toISOString()
  const indexerEvents: IndexerEventLike[] = [
    { wallet_address: '0xwallet1', tx_hash: '0xhash1', event_type: 'transfer_detected', created_at: oldEnough },
  ]
  const result = compareDeposits(indexerEvents, [], comparable, null, Date.now())
  assertEquals(result.status, 'FAIL')
  assertEquals(result.trueIndexerOnly, 1)
})

Deno.test('internalSenderOf: reads sender from either "sender" or "from" metadata key', () => {
  const internalContract = [...KNOWN_INTERNAL_CONTRACTS][0]
  assertEquals(
    internalSenderOf({ wallet_address: 'w', tx_hash: 't', event_type: 'x', metadata: { sender: internalContract } }),
    internalContract,
  )
  assertEquals(
    internalSenderOf({ wallet_address: 'w', tx_hash: 't', event_type: 'x', metadata: { from: internalContract } }),
    internalContract,
  )
  assertEquals(
    internalSenderOf({ wallet_address: 'w', tx_hash: 't', event_type: 'x', metadata: { sender: '0xnotinternal' } }),
    null,
  )
  // Malformed/missing metadata must never throw — a comparison run must not
  // die on one bad row (compare.ts's own documented contract).
  assertEquals(internalSenderOf({ wallet_address: 'w', tx_hash: 't', event_type: 'x', metadata: null }), null)
  assertEquals(internalSenderOf({ wallet_address: 'w', tx_hash: 't', event_type: 'x' }), null)
})
