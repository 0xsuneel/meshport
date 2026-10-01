// supabase/functions/blockchain-indexer/compare.ts
//
// Pure comparison logic for shadow mode: does BlockchainIndexer see the same
// on-chain facts the legacy workers record?
//
// Pure (no I/O) so it is testable — this is the logic that decides the cutover
// gate, so it gets the same scrutiny as the cursor math. The DB reads and the
// report persistence live in monitor.ts; this file only classifies.
//
// ── The join key, and why it is not trivial ─────────────────────────────────
// deposit-scan-all writes activity rows with tx_hash = `recv_<lowercase hash>`
// (see recordExternalReceive). The indexer stores the raw lowercase hash.
// So matching requires normalizing the `recv_` prefix away before comparing,
// or every deposit would look like a worker-only mismatch.
//
// ── Why every result carries an explicit status ─────────────────────────────
// The counts alone are ambiguous: `worker_only = 0` means "the indexer missed
// nothing" when a real comparison ran, and "nothing was compared" when it did
// not. Those are opposite conclusions from identical numbers. Reporting a
// status alongside them is what stops an unmeasured window from reading as a
// pass. Zero is never used as a stand-in for "not measured".
//
// ── Two scopes, with different ownership ────────────────────────────────────
//   deposits : indexer deposit_detected/transfer_detected  vs  activity rows
//              where activity_type = 'receive'. A genuine like-for-like
//              comparison — both systems are supposed to detect these.
//              Two populations are narrowed out of this scope before counting,
//              both because the two systems have different remits rather than
//              because either is wrong: rows for unregistered external
//              recipients (see registeredWallets), and indexer events sent by a
//              Circle Kit/CCTP contract, which deposit-scan-all skips outright
//              (see KNOWN_INTERNAL_CONTRACTS). Each is reported as its own
//              count so a narrowed comparison is never silently smaller.
//   claims   : claim-worker owns the claim lifecycle (attestation, retries,
//              settlement). The indexer deliberately skips CCTP mints (a
//              zero-address sender is claim-worker's territory), so it emits
//              no claim events at all. This scope therefore reports
//              NOT_APPLICABLE rather than counting deposits as failed claims.

export type IndexerEventLike = {
  wallet_address: string | null
  tx_hash: string | null
  event_type: string
  block_number?: number | null
  /**
   * Phase 3 (real-state audit finding #1): monitor.ts's query previously had
   * no status filter at all, so compareDeposits could be handed a mix of
   * 'pending' and 'confirmed' indexer events. status is now read and
   * enforced HERE as well as at the query level (monitor.ts) — defense in
   * depth, and what makes this rule unit-testable without a live database.
   * Optional so existing callers/tests that never populate it keep working
   * unchanged (treated as "unknown, don't filter on it" rather than
   * silently excluded).
   */
  status?: string | null
  /** For the TIMING_DIFFERENCE classification — see classifyTiming below. */
  created_at?: string | null
  /**
   * The scanner's event payload. Only the sender is read here, and it is
   * written under TWO different keys depending on which detection path
   * produced the event: `sender` (ERC-20 log path and native-transfer-log
   * path) or `from` (the USDC wrapper path). Both are checked — reading only
   * one would leave that path's swap outputs still counted as indexer_only,
   * which is precisely the failure this exclusion exists to prevent.
   */
  metadata?: Record<string, unknown> | null
}

/**
 * Only a 'confirmed' indexer event may be compared at all. A 'pending' event
 * can still be reorged away and comparing it against activity (which only
 * ever contains confirmed, credited rows) is not a like-for-like comparison.
 * Mirrors activity-consumer/decide.ts's CREDITABLE_STATUS exactly — the two
 * should never disagree about what "confirmed enough to count" means.
 */
export const COMPARABLE_STATUS = 'confirmed'

/**
 * Circle Kit / CCTP infrastructure contracts on Arc.
 *
 * Mirrors KNOWN_INTERNAL_CONTRACTS in deposit-scan-all/index.ts — kept in sync
 * manually, exactly as that set in turn mirrors CIRCLE_CONTRACTS in
 * api/relay-rpc.js. These are static testnet deployment addresses.
 *
 * deposit-scan-all skips a candidate whose sender is one of these OUTRIGHT, on
 * the grounds that it is definitionally not an external deposit: a swap's
 * output leg is a Transfer FROM the Kit Adapter Contract, not from any wallet a
 * person or exchange controls. The indexer has no such rule — it reports the
 * transfer it observed, which is correct behaviour for a general-purpose
 * indexer. The disagreement is therefore a difference in SCOPE, not a defect on
 * either side, and it belongs in the comparison layer rather than in either
 * detector.
 */
export const KNOWN_INTERNAL_CONTRACTS = new Set([
  '0x0077777d7eba4688bdef3e311b846f25870a19b9',
  '0x9f3b8679c73c2fef8b59b4f3444d4e156fb70aa5',
  '0x7865fafc2db2093669d92c0f33aeef291086befd',
  '0xacf1ceef35caac005e15888ddb8a3515c41b4872',
  '0xc5567a5e3370d4dbfb0540025078e283e36a363d', // Kit Bridge Contract testnet
  '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b', // Kit Adapter Contract testnet — swaps route through this
  '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa', // CCTP V2 TokenMessenger
  '0xe737e5cebeeba77efe34d4aa090756590b1ce275', // CCTP V2 MessageTransmitter
  // Multicall3 — BulkPay routes through this. deposit-scan-all's own copy of
  // this list (and activity-consumer's) were both missing this entry until
  // 2026-09-02 (see those files' own comments — live production evidence,
  // tx 0xac28f48b…/0x22b268c5…, both BulkPay self-sends). This file's own
  // header already documents that a KNOWN_INTERNAL_CONTRACTS-excluded sender
  // should be narrowed OUT of the deposit-comparison scope rather than
  // counted as a worker_only discrepancy — without this entry, every future
  // BulkPay self-send would misclassify as exactly that kind of false
  // discrepancy the moment the OTHER two files' fix landed and this one
  // didn't. Added to keep this file in the same state as its two siblings.
  '0xca11bde05977b3631167028862be2a173976ca11',
])

/**
 * The event's sender, if it is a known internal contract — else null.
 * Tolerates a missing/odd-shaped metadata payload rather than throwing: a
 * comparison run must never die on one malformed row.
 */
export function internalSenderOf(event: IndexerEventLike): string | null {
  const meta = event.metadata
  if (!meta || typeof meta !== 'object') return null
  const raw = (meta as Record<string, unknown>).sender ?? (meta as Record<string, unknown>).from
  if (typeof raw !== 'string') return null
  const addr = raw.trim().toLowerCase()
  return KNOWN_INTERNAL_CONTRACTS.has(addr) ? addr : null
}

export type WorkerRowLike = {
  wallet_address: string
  tx_hash: string | null
  activity_type?: string
  status?: string
  destination_tx_hash?: string | null
  /** For the TIMING_DIFFERENCE classification — see classifyTiming below. */
  created_at?: string | null
}

/**
 * PASS            — a real comparison ran and the indexer matched the worker.
 * FAIL            — a real comparison ran and there was a discrepancy.
 * NOT_COMPARABLE  — the comparison could not be trusted (indexer behind head,
 *                   or nothing in the window). Counts are meaningless.
 * NOT_APPLICABLE  — this scope is not the indexer's responsibility at all.
 */
export type ComparisonStatus = 'PASS' | 'FAIL' | 'NOT_COMPARABLE' | 'NOT_APPLICABLE'

/**
 * Fine-grained classification for one mismatch item — Phase 3 Fix 3. The
 * point is to stop the raw indexer_only/worker_only counts from conflating
 * "the indexer or the worker genuinely missed something" with "this was
 * already correctly accounted for, just not under the activity_type this
 * comparison originally checked for" or "the two sides just haven't caught
 * up with each other yet". See docs/PHASE_3_REAL_STATE_AUDIT.md §7/§8 for
 * the live-traced evidence this classification is built from — every
 * `indexer_only` case actually traced in that audit fell into
 * ACCOUNTED_FOR_OTHER_ACTIVITY or TIMING_DIFFERENCE, none into
 * TRUE_INDEXER_ONLY.
 */
export type MismatchClassification =
  | 'RECEIVE_MATCH'
  | 'ACCOUNTED_FOR_OTHER_ACTIVITY'
  | 'TRUE_INDEXER_ONLY'
  | 'WORKER_ONLY'
  | 'TIMING_DIFFERENCE'
  | 'NOT_COMPARABLE'

export interface ClassifiedKey {
  wallet: string
  tx: string
  /** Populated for ACCOUNTED_FOR_OTHER_ACTIVITY — which activity_type covered it. */
  activityType?: string
}

/**
 * How young a one-sided mismatch must be to be treated as "probably just
 * hasn't propagated to the other side yet" rather than a genuine miss.
 *
 * Sized from docs/PHASE_3_REAL_STATE_AUDIT.md §11's measured end-to-end
 * latency: indexer cron (2 min) + activity-consumer settle delay (30s) +
 * activity-consumer cron (1 min) puts normal propagation at roughly 2-3
 * minutes. 5 minutes gives a safety margin above that measured figure
 * without being so wide that a genuine miss hides in this bucket for long.
 */
export const TIMING_DIFFERENCE_THRESHOLD_MS = 5 * 60_000

export interface ComparisonResult {
  scope: 'deposits' | 'claims'
  status: ComparisonStatus
  /** Why this status was chosen. Always populated for non-PASS. */
  reason: string | null
  /** RECEIVE_MATCH count. */
  matched: number
  /** RAW worker_only total — every worker row with no indexer counterpart, unclassified. Kept for trend continuity with pre-Fix-3 reports. */
  workerOnly: number
  /** RAW indexer_only total — every indexer event with no receive-type worker counterpart, unclassified (this is the number Fix 3 exists to stop being read as "the miss count"). */
  indexerOnly: number
  /**
   * Corrected recall: (matched + accountedForOtherActivity) / (matched +
   * accountedForOtherActivity + trueIndexerOnly). NULL unless a real
   * comparison ran. This is a DIFFERENT formula than before Fix 3 (which was
   * matched / (matched + workerOnly)) — the old formula is still derivable
   * from the raw fields above if needed for historical trend comparison.
   */
  recallPct: number | null
  workerOnlyKeys: Array<{ wallet: string; tx: string }>
  indexerOnlyKeys: Array<{ wallet: string; tx: string }>
  /**
   * Rows dropped because their wallet is not a registered MeshPort wallet —
   * client-written bookkeeping for external recipients. Reported so an
   * operator can see the comparison narrowed, rather than the rows silently
   * vanishing. Absent when no registry was supplied.
   */
  externalExcluded?: number
  /**
   * Indexer events dropped because their sender is a known Circle Kit/CCTP
   * contract, which deposit-scan-all skips outright (Fix C). Reported for the
   * same reason as externalExcluded: a narrowed comparison must be visible,
   * not silent. Absent when nothing was dropped on those grounds.
   */
  internalExcluded?: number
  /**
   * Phase 3 Fix 3 — the refined breakdown. Every item counted in indexerOnly
   * or workerOnly above is classified into exactly one of these three
   * buckets (they sum to indexerOnly + workerOnly). Nothing is hidden —
   * accountedForOtherActivity and timingDifference are still fully visible,
   * just correctly labeled as not being real misses.
   */
  accountedForOtherActivity: number
  accountedForOtherActivityKeys: ClassifiedKey[]
  trueIndexerOnly: number
  trueIndexerOnlyKeys: ClassifiedKey[]
  timingDifference: number
  timingDifferenceKeys: ClassifiedKey[]
}


/** Whether a comparison window can be trusted at all. */
export interface Comparability {
  comparable: boolean
  reason: string | null
  backlogBlocks: number | null
}

/** Strip the recv_ prefix and lowercase, or '' if not a usable hash. */
export function normalizeTxHash(tx: string | null | undefined): string {
  if (!tx) return ''
  const t = tx.trim().toLowerCase()
  return t.startsWith('recv_') ? t.slice(5) : t
}

function keyOf(wallet: string | null, tx: string | null): { wallet: string; tx: string } | null {
  const w = (wallet ?? '').trim().toLowerCase()
  const h = normalizeTxHash(tx)
  if (!w || !h) return null
  return { wallet: w, tx: h }
}

/** Events the indexer emits for external deposits/transfers. */
const DEPOSIT_EVENT_TYPES = new Set(['deposit_detected', 'transfer_detected'])

/**
 * Events the indexer would emit if it owned claim detection.
 *
 * It does not, and that is deliberate — see D-3 and the file header. Keeping
 * this as its own set (rather than reusing DEPOSIT_EVENT_TYPES) is the actual
 * fix for the deployed defect where four ordinary USDC/EURC deposits were
 * counted as rogue claim events, producing indexer_only = 4 in the claims
 * scope: the same four events already counted in the deposits scope.
 */
const CLAIM_EVENT_TYPES = new Set(['claim_completed'])

/**
 * Decide whether a comparison window is trustworthy.
 *
 * The two systems observe the same on-chain event at very different wall-clock
 * times while the indexer is catching up: the worker records a deposit the
 * moment it lands, whereas the indexer writes its row when its cursor reaches
 * that block — potentially hours later. Since both tables are filtered by row
 * creation time, a lagging indexer's events never meet their worker
 * counterparts, and every one is misreported as indexer_only.
 *
 * So a window is only comparable when the indexer is close enough to the head
 * that its detection lag is small relative to the window.
 */
export function assessComparability(
  cursor: {
    last_indexed_block?: number | null
    latest_observed_block?: number | null
    sync_state?: string | null
  } | null,
  maxBacklogBlocks: number,
): Comparability {
  if (!cursor) {
    return { comparable: false, reason: 'no cursor row — indexer has never run', backlogBlocks: null }
  }
  if (cursor.sync_state === 'paused') {
    return { comparable: false, reason: 'chain is paused', backlogBlocks: null }
  }
  if (cursor.sync_state === 'error') {
    return { comparable: false, reason: 'indexer in error state', backlogBlocks: null }
  }

  const last = Number(cursor.last_indexed_block ?? 0)
  const head = Number(cursor.latest_observed_block ?? 0)
  if (!last || !head) {
    return { comparable: false, reason: 'cursor has no observed head yet', backlogBlocks: null }
  }

  const backlog = head - last
  if (backlog > maxBacklogBlocks) {
    return {
      comparable: false,
      backlogBlocks: backlog,
      reason: `indexer ${backlog} blocks behind head (max ${maxBacklogBlocks}) — ` +
              'its events describe blocks older than this window, so counts would be meaningless',
    }
  }
  return { comparable: true, reason: null, backlogBlocks: backlog }
}

function notComparable(scope: 'deposits' | 'claims', reason: string): ComparisonResult {
  return {
    scope, status: 'NOT_COMPARABLE', reason,
    matched: 0, workerOnly: 0, indexerOnly: 0, recallPct: null,
    workerOnlyKeys: [], indexerOnlyKeys: [],
    accountedForOtherActivity: 0, accountedForOtherActivityKeys: [],
    trueIndexerOnly: 0, trueIndexerOnlyKeys: [],
    timingDifference: 0, timingDifferenceKeys: [],
  }
}

/**
 * activity_types that legitimately represent the SAME underlying on-chain
 * money movement the indexer's generic Transfer scan also incidentally
 * sees, just recorded under a more specific label than 'receive'.
 *
 * Built directly from docs/PHASE_3_REAL_STATE_AUDIT.md §7/§8's traced live
 * cases: every one of the persistently-recurring `indexer_only` mismatches
 * resolved to a correctly-credited row under one of these four types. This
 * is deliberately NOT the same mechanism as Fix C (KNOWN_INTERNAL_CONTRACTS
 * — an indexer-side sender-address exclusion, applied before matching) —
 * this is a worker-side classification, applied only to events that failed
 * to match a 'receive' row, exactly mirroring Fix C's own safety ordering
 * (see the comment on compareDeposits below) so it can only ever reclassify
 * an extra, never manufacture or mask a real miss.
 */
export const ACCOUNTED_FOR_ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  'swap', 'bulk', 'p2p_purchase', 'p2p_refund',
])

/** True if `isoTimestamp` is younger than TIMING_DIFFERENCE_THRESHOLD_MS relative to `now`. Missing/unparseable timestamps are treated as "not recent" (age unknown -> do not give the benefit of the doubt). */
function isRecent(isoTimestamp: string | null | undefined, now: number): boolean {
  if (!isoTimestamp) return false
  const t = Date.parse(isoTimestamp)
  if (!Number.isFinite(t)) return false
  return now - t < TIMING_DIFFERENCE_THRESHOLD_MS
}

/**
 * Compare indexer deposit/transfer events against deposit-scan-all's activity
 * rows. Matching is by (wallet, normalized tx_hash).
 *
 * ── registeredWallets, and why it is required ───────────────────────────────
 * Not every `activity` row with activity_type='receive' represents something
 * the indexer is supposed to detect. When a MeshPort user sends to an ordinary
 * external address, the CLIENT writes BOTH sides of the transfer at send time —
 * a `send_` row for the sender and a `recv_` row for the recipient, inserted
 * milliseconds apart. The recipient may be any valid address; it does not have
 * to be a MeshPort wallet.
 *
 * Confirmed on live data: two transfers to 0x70e3fb28…af8e produced `recv_`
 * rows even though that address appears NOWHERE in the database except
 * `activity` — not in users, not in wallet_vault, not in any other table. The
 * indexer only watches wallets in users.wallet_address, so it correctly emitted
 * nothing for them. Comparing against those rows anyway manufactured permanent
 * worker_only misses that no indexer change could ever clear.
 *
 * So the comparison population is restricted to transactions involving a
 * CURRENTLY-REGISTERED MeshPort wallet. `activity.wallet_address` is emphatically
 * NOT a wallet registry — it contains external counterparties. users.wallet_address
 * is the canonical registry and is what the indexer itself reads.
 *
 * Both sides are filtered, not just worker rows. Filtering only one side would
 * introduce the mirror-image bug: an event for a wallet later removed from
 * `users` would survive on the indexer side with no worker counterpart and be
 * reported as a false indexer_only.
 *
 * Passing `null`/omitting the set disables filtering entirely, which keeps
 * every existing caller and test working unchanged.
 *
 * ── Phase 3 Fix 3/4 additions ────────────────────────────────────────────────
 * `workerRows` is now expected to include non-'receive' activity_types too
 * (swap/bulk/p2p_purchase/p2p_refund) so ACCOUNTED_FOR_OTHER_ACTIVITY can be
 * computed — see ACCOUNTED_FOR_ACTIVITY_TYPES above. Passing only 'receive'
 * rows (the pre-Fix-3 caller shape) still works correctly, it just means
 * accountedForOtherActivity will always be 0 for that caller, which is the
 * same behavior as before Fix 3.
 *
 * `indexerEvents` with a `status` other than 'confirmed' are dropped before
 * anything else (Fix 4) — defense in depth alongside monitor.ts's own query
 * filter. Events with no `status` field at all are NOT dropped, so existing
 * tests/callers that never populate it are unaffected.
 */
export function compareDeposits(
  indexerEvents: IndexerEventLike[],
  workerRows: WorkerRowLike[],
  comparability: Comparability = { comparable: true, reason: null, backlogBlocks: null },
  registeredWallets?: Set<string> | null,
  now: number = Date.now(),
): ComparisonResult {
  if (!comparability.comparable) {
    return notComparable('deposits', comparability.reason ?? 'window not comparable')
  }

  // Fix 4 — defense in depth. A 'pending'/'reorged' event is not a like-for-
  // like comparison against activity (always confirmed, credited rows).
  // Events with no status field at all pass through unfiltered, so this is
  // additive, not a behavior change for any existing caller that doesn't
  // supply status.
  const confirmedOnly = indexerEvents.filter(e => e.status == null || e.status === COMPARABLE_STATUS)

  // No registry supplied -> compare everything (previous behaviour).
  const isRegistered = (w: string | null | undefined): boolean =>
    !registeredWallets || registeredWallets.has((w ?? '').trim().toLowerCase())

  const allRelevant = confirmedOnly.filter(e => DEPOSIT_EVENT_TYPES.has(e.event_type))
  const relevant = allRelevant.filter(e => isRegistered(e.wallet_address))
  const scopedWorkerRows = workerRows.filter(r => isRegistered(r.wallet_address))

  const excludedExternal =
    (allRelevant.length - relevant.length) + (workerRows.length - scopedWorkerRows.length)

  // An empty window proves nothing. Reporting zeros here would let a quiet
  // period read exactly like a perfect result.
  if (relevant.length === 0 && scopedWorkerRows.length === 0) {
    const detail = excludedExternal > 0
      ? ` (${excludedExternal} row(s) excluded: not a registered MeshPort wallet)`
      : ''
    return {
      ...notComparable('deposits', `no deposit events on either side in this window${detail}`),
      externalExcluded: excludedExternal,
    }
  }

  // RECEIVE_MATCH population — unchanged from before Fix 3.
  const receiveRows = scopedWorkerRows.filter(r => (r.activity_type ?? 'receive') === 'receive')
  const workerKeys = new Set<string>()
  for (const r of receiveRows) {
    const k = keyOf(r.wallet_address, r.tx_hash)
    if (k) workerKeys.add(`${k.wallet}:${k.tx}`)
  }

  // ACCOUNTED_FOR_OTHER_ACTIVITY population — Fix 3. Keyed the same way, so
  // it can be consulted with the exact same `full` key used for matching.
  const accountedForByKey = new Map<string, string>() // "wallet:tx" -> activity_type
  for (const r of scopedWorkerRows) {
    const type = r.activity_type
    if (!type || !ACCOUNTED_FOR_ACTIVITY_TYPES.has(type)) continue
    const k = keyOf(r.wallet_address, r.tx_hash)
    if (!k) continue
    const full = `${k.wallet}:${k.tx}`
    if (!accountedForByKey.has(full)) accountedForByKey.set(full, type)
  }

  const matchedKeys = new Set<string>()
  const trueIndexerOnlyKeys: ClassifiedKey[] = []
  const accountedForOtherActivityKeys: ClassifiedKey[] = []
  const timingDifferenceKeys: ClassifiedKey[] = []
  // Fix C. Suppression is applied ONLY to events that failed to match a worker
  // row — never before matching. That ordering is the safety property:
  //
  //   * If a worker row DOES exist for the transaction, the event matches
  //     normally. Filtering internal senders up front would have deleted the
  //     indexer's half of a genuine pair and manufactured a false worker_only
  //     — turning a fix for a cosmetic mismatch into a fake recall drop.
  //   * If no worker row exists, the event is the known scope difference:
  //     deposit-scan-all deliberately never wrote a row for it.
  //
  // ACCOUNTED_FOR_OTHER_ACTIVITY and TIMING_DIFFERENCE below follow the exact
  // same ordering rule for the exact same reason: both are only ever checked
  // AFTER a receive-match attempt fails, so neither can mask a genuine miss
  // that also happens to have a same-tx swap/bulk/p2p row or a recent
  // timestamp for an unrelated reason.
  const internalOnlyKeys: Array<{ wallet: string; tx: string }> = []
  for (const e of relevant) {
    const k = keyOf(e.wallet_address, e.tx_hash)
    if (!k) continue
    const full = `${k.wallet}:${k.tx}`
    if (workerKeys.has(full)) { matchedKeys.add(full); continue }
    if (internalSenderOf(e)) {
      if (!internalOnlyKeys.some(i => i.wallet === k.wallet && i.tx === k.tx)) {
        internalOnlyKeys.push(k)
      }
      continue
    }
    const accountedType = accountedForByKey.get(full)
    if (accountedType) {
      if (!accountedForOtherActivityKeys.some(i => i.wallet === k.wallet && i.tx === k.tx)) {
        accountedForOtherActivityKeys.push({ ...k, activityType: accountedType })
      }
      continue
    }
    if (isRecent(e.created_at, now)) {
      if (!timingDifferenceKeys.some(i => i.wallet === k.wallet && i.tx === k.tx)) {
        timingDifferenceKeys.push(k)
      }
      continue
    }
    if (!trueIndexerOnlyKeys.some(i => i.wallet === k.wallet && i.tx === k.tx)) {
      trueIndexerOnlyKeys.push(k)
    }
  }
  // A key that also arrived from a genuine sender must not be written off as
  // internal: same transaction, two events, only one of them attributable to a
  // Kit contract. Real detections win over suppression.
  const internalExcluded = internalOnlyKeys.filter(
    i => !trueIndexerOnlyKeys.some(o => o.wallet === i.wallet && o.tx === i.tx) &&
         !accountedForOtherActivityKeys.some(o => o.wallet === i.wallet && o.tx === i.tx) &&
         !timingDifferenceKeys.some(o => o.wallet === i.wallet && o.tx === i.tx) &&
         !matchedKeys.has(`${i.wallet}:${i.tx}`),
  ).length

  // indexerOnlyKeys (raw, unclassified) is kept for backward-compatible
  // trend continuity with pre-Fix-3 reports — it is exactly the union of the
  // three classified buckets above.
  const indexerOnlyKeys: Array<{ wallet: string; tx: string }> = [
    ...trueIndexerOnlyKeys, ...accountedForOtherActivityKeys, ...timingDifferenceKeys,
  ].map(({ wallet, tx }) => ({ wallet, tx }))

  const workerOnlyKeys: Array<{ wallet: string; tx: string }> = []
  const workerOnlyTimingKeys: ClassifiedKey[] = []
  for (const r of receiveRows) {
    const k = keyOf(r.wallet_address, r.tx_hash)
    if (!k) continue
    const full = `${k.wallet}:${k.tx}`
    if (matchedKeys.has(full)) continue
    if (workerOnlyKeys.some(w => w.wallet === k.wallet && w.tx === k.tx)) continue
    workerOnlyKeys.push(k)
    // Symmetric timing carve-out: a worker row this recent may just be
    // waiting for the indexer's next scan pass, not a genuine indexer miss.
    if (isRecent(r.created_at, now)) {
      timingDifferenceKeys.push(k)
      workerOnlyTimingKeys.push(k)
    }
  }

  const matched = matchedKeys.size
  const workerOnly = workerOnlyKeys.length
  const indexerOnly = indexerOnlyKeys.length
  const accountedForOtherActivity = accountedForOtherActivityKeys.length
  const trueIndexerOnly = trueIndexerOnlyKeys.length
  const timingDifference = timingDifferenceKeys.length
  const trueWorkerOnly = workerOnlyKeys.length - workerOnlyTimingKeys.length

  // Corrected recall — see the ComparisonResult.recallPct doc comment for
  // why this formula differs from the pre-Fix-3 one.
  const recallDenom = matched + accountedForOtherActivity + trueIndexerOnly
  const recallPct = recallDenom === 0 ? null : Math.round(((matched + accountedForOtherActivity) / recallDenom) * 10000) / 100

  // A window whose entire content was suppressed proves nothing, exactly like
  // the empty window above. Without this, such a window would fall through to
  // the `clean` test, fail it on `matched > 0`, and be reported as a FAIL whose
  // three counts are all zero — "not measured" wearing the costume of a
  // discrepancy. Zero is never a stand-in for "not measured".
  if (matched === 0 && workerOnly === 0 && indexerOnly === 0 && internalExcluded > 0) {
    return {
      ...notComparable('deposits',
        `no comparable deposit events in this window — all ${internalExcluded} indexer ` +
        'event(s) were Circle Kit/CCTP internal-contract transfers, which ' +
        'deposit-scan-all excludes by design'),
      externalExcluded: excludedExternal,
      internalExcluded,
    }
  }

  // A window whose only content is timing-difference items hasn't actually
  // proven anything either way (mirrors the empty-window/all-internal-
  // excluded principle above) — it's not a clean PASS (we don't yet know the
  // true outcome) and forcing it to FAIL would misreport a probably-fine
  // situation as a discrepancy. NOT_COMPARABLE is the honest answer: wait
  // for the next window.
  if (matched === 0 && accountedForOtherActivity === 0 && trueWorkerOnly === 0 &&
      trueIndexerOnly === 0 && timingDifference > 0) {
    return {
      scope: 'deposits',
      status: 'NOT_COMPARABLE',
      reason: `no conclusive comparison in this window — the only discrepancy(ies) (${timingDifference}) ` +
        'are younger than the timing-difference threshold and likely just have not propagated to the other side yet',
      matched, workerOnly, indexerOnly, recallPct: null,
      workerOnlyKeys: workerOnlyKeys.slice(0, 50),
      indexerOnlyKeys: indexerOnlyKeys.slice(0, 50),
      externalExcluded: excludedExternal,
      internalExcluded,
      accountedForOtherActivity,
      accountedForOtherActivityKeys: accountedForOtherActivityKeys.slice(0, 50),
      trueIndexerOnly, trueIndexerOnlyKeys: [],
      timingDifference,
      timingDifferenceKeys: timingDifferenceKeys.slice(0, 50),
    }
  }

  // THE Fix 3 change: status is now driven by trueIndexerOnly/trueWorkerOnly,
  // not the raw indexerOnly/workerOnly totals. A window whose only
  // "mismatches" are all ACCOUNTED_FOR_OTHER_ACTIVITY and/or
  // TIMING_DIFFERENCE is a real PASS, not a FAIL — the money was never at
  // risk, it was just compared against too narrow a worker-side population
  // (or hadn't propagated yet). Nothing is hidden: accountedForOtherActivity
  // and timingDifference remain fully visible in the returned counts/keys,
  // this only changes what counts as "clean" for the PASS/FAIL verdict.
  const clean = trueWorkerOnly === 0 && trueIndexerOnly === 0 && (matched + accountedForOtherActivity) > 0
  return {
    scope: 'deposits',
    status: clean ? 'PASS' : 'FAIL',
    reason: clean
      ? null
      : `${trueWorkerOnly} worker_only, ${trueIndexerOnly} true_indexer_only, ${matched} matched` +
        (accountedForOtherActivity > 0 ? ` (${accountedForOtherActivity} accounted for under another activity_type)` : '') +
        (timingDifference > 0 ? ` (${timingDifference} recent enough to be a timing difference)` : '') +
        (excludedExternal > 0 ? ` (${excludedExternal} external row(s) excluded)` : '') +
        (internalExcluded > 0 ? ` (${internalExcluded} internal-contract event(s) excluded)` : ''),
    matched, workerOnly, indexerOnly, recallPct,
    workerOnlyKeys: workerOnlyKeys.slice(0, 50),
    indexerOnlyKeys: indexerOnlyKeys.slice(0, 50),
    externalExcluded: excludedExternal,
    internalExcluded,
    accountedForOtherActivity,
    accountedForOtherActivityKeys: accountedForOtherActivityKeys.slice(0, 50),
    trueIndexerOnly,
    trueIndexerOnlyKeys: trueIndexerOnlyKeys.slice(0, 50),
    timingDifference,
    timingDifferenceKeys: timingDifferenceKeys.slice(0, 50),
  }
}

/**
 * Claims scope.
 *
 * claim-worker owns claim orchestration end to end. The indexer emits no
 * claim_completed events by design, so there is nothing of its own to compare
 * and this reports NOT_APPLICABLE. worker_only is still surfaced as factual
 * context (how many claims completed in the window) but must never be read as
 * an indexer failure — the status field is what disambiguates that.
 *
 * The implementation is written generally rather than hardcoded to "always
 * NOT_APPLICABLE", so that if the indexer is ever given claim ownership the
 * comparison becomes meaningful without another rewrite.
 */
export function compareClaims(
  indexerEvents: IndexerEventLike[],
  completedClaims: WorkerRowLike[],
  comparability: Comparability = { comparable: true, reason: null, backlogBlocks: null },
): ComparisonResult {
  const claimEvents = indexerEvents.filter(e => CLAIM_EVENT_TYPES.has(e.event_type))

  // Checked BEFORE comparability: the scope not being the indexer's job is a
  // stronger, more permanent statement than a transient sync lag, and saying
  // "not comparable right now" would imply it becomes comparable later.
  if (claimEvents.length === 0) {
    return {
      scope: 'claims',
      status: 'NOT_APPLICABLE',
      reason: 'BlockchainIndexer does not own claim detection — claim-worker handles ' +
              'attestation, retries and settlement, and the indexer deliberately skips ' +
              'CCTP mints. No indexer claim events exist to compare, so this scope is ' +
              'not a valid cutover metric.',
      matched: 0,
      workerOnly: completedClaims.length,   // factual context, not a failure
      indexerOnly: 0,
      recallPct: null,
      workerOnlyKeys: [],
      indexerOnlyKeys: [],
      accountedForOtherActivity: 0, accountedForOtherActivityKeys: [],
      trueIndexerOnly: 0, trueIndexerOnlyKeys: [],
      timingDifference: 0, timingDifferenceKeys: [],
    }
  }

  if (!comparability.comparable) {
    return notComparable('claims', comparability.reason ?? 'window not comparable')
  }

  const workerKeys = new Set<string>()
  for (const c of completedClaims) {
    // destination_tx_hash is an OPTIONAL field on WorkerRowLike (`?:`), so its
    // effective type includes `undefined` as well as `null` — keyOf only
    // accepts `string | null`. Found as a genuine pre-existing type error
    // while Deno-typechecking this file during the Phase 3 indexer audit
    // (see docs/PHASE_3_INDEXER_AUDIT.md); fixed here as a one-line,
    // behavior-preserving null-coalesce (undefined and null both already
    // mean "no hash" to keyOf's own null check) rather than left for a
    // future phase, since it blocks clean `deno check` of this file.
    const k = keyOf(c.wallet_address, c.destination_tx_hash ?? null)
    if (k) workerKeys.add(`${k.wallet}:${k.tx}`)
  }

  const matchedKeys = new Set<string>()
  const indexerOnlyKeys: Array<{ wallet: string; tx: string }> = []
  for (const e of claimEvents) {
    const k = keyOf(e.wallet_address, e.tx_hash)
    if (!k) continue
    const full = `${k.wallet}:${k.tx}`
    if (workerKeys.has(full)) matchedKeys.add(full)
    else if (!indexerOnlyKeys.some(i => i.wallet === k.wallet && i.tx === k.tx)) {
      indexerOnlyKeys.push(k)
    }
  }

  const workerOnlyKeys: Array<{ wallet: string; tx: string }> = []
  for (const c of completedClaims) {
    const k = keyOf(c.wallet_address, c.destination_tx_hash ?? null)
    if (!k) continue
    const full = `${k.wallet}:${k.tx}`
    if (matchedKeys.has(full)) continue
    if (workerOnlyKeys.some(w => w.wallet === k.wallet && w.tx === k.tx)) continue
    workerOnlyKeys.push(k)
  }

  const matched = matchedKeys.size
  const workerOnly = workerOnlyKeys.length
  const indexerOnly = indexerOnlyKeys.length
  const denom = matched + workerOnly
  const recallPct = denom === 0 ? null : Math.round((matched / denom) * 10000) / 100

  const clean = workerOnly === 0 && indexerOnly === 0 && matched > 0
  return {
    scope: 'claims',
    status: clean ? 'PASS' : 'FAIL',
    reason: clean ? null : `${workerOnly} worker_only, ${indexerOnly} indexer_only, ${matched} matched`,
    matched, workerOnly, indexerOnly, recallPct,
    workerOnlyKeys: workerOnlyKeys.slice(0, 50),
    indexerOnlyKeys: indexerOnlyKeys.slice(0, 50),
    // Fix 3's classification (ACCOUNTED_FOR_OTHER_ACTIVITY/TIMING_DIFFERENCE)
    // is deposits-scope specific — claims has no equivalent "other activity
    // type" concept, so this branch (unreachable today, since claimEvents is
    // always empty per the indexer's deliberate CCTP-mint skip) reports the
    // classified counts as equal to the raw ones rather than inventing a
    // claims-specific classification that was never asked for.
    accountedForOtherActivity: 0, accountedForOtherActivityKeys: [],
    trueIndexerOnly: indexerOnly, trueIndexerOnlyKeys: indexerOnlyKeys.slice(0, 50),
    timingDifference: 0, timingDifferenceKeys: [],
  }
}
