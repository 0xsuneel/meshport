/**
 * server/ledger/interpreter.ts — orchestration. The ONLY code allowed to
 * call `repository.insertLedgerEvent`. Nothing else in this codebase (the
 * frontend, ActivityService, claim-recovery-scan, activity-consumer) may
 * create a ledger_events row — this module is where that rule is enforced
 * in code, not just in documentation.
 *
 * Two entry points, matching the two different sourcing mechanisms
 * documented in types.ts:
 *   - interpretConfirmedChainEvent: the CREDIT/SWAP_CREDIT side, driven by
 *     a confirmed chain_events row.
 *   - interpretConfirmedAttempt: the SWAP_DEBIT side (and, for Pay, is a
 *     no-op — Pay's DEBIT already comes from interpretConfirmedChainEvent,
 *     see classifiers.ts's classifyPayTransfer), driven by a confirmed
 *     transaction_attempts row the caller already has in hand.
 *
 * ── Atomicity, stated honestly, not pretended ───────────────────────────────
 * A Pay transfer's DEBIT and CREDIT are two separate `insertLedgerEvent`
 * calls, not one atomic multi-row write — the `LedgerRepository` interface
 * has no multi-row transactional primitive, and adding one (e.g. a Postgres
 * function called over RPC) would be new production surface this focused
 * phase doesn't build. This is safe, not merely convenient, because of
 * `event_key`/the raw-movement constraint: if DEBIT succeeds and CREDIT
 * fails (or the process crashes between the two calls), the next pass over
 * the same confirmed chain_event will find DEBIT already posted (an
 * `already_posted` result, a no-op) and retry only CREDIT. This is the same
 * "per-log-index, not per-transaction, is the atomic unit" reasoning
 * already established for BulkPay (docs/LEDGER_CANONICAL_EVENT_DESIGN.md
 * §6) — applied here at the DEBIT/CREDIT-pair granularity instead.
 */

import type { LedgerRepository } from './repository'
import { classifyPayTransfer, classifySwapDebit, classifySwapCredit, classifyBulkPayCredit } from './classifiers'
import type { LedgerEventDraft, InsertOutcome, AttemptContext } from './types'

export interface InterpretResult {
  chainEventId?: string
  attemptId?: string
  classification: 'classified' | 'not_applicable' | 'unresolved'
  reason?: string
  inserts: InsertOutcome[]
}

/**
 * Inserts one draft idempotently: a courtesy pre-check via
 * findLedgerEventByRawMovement (cheap, clearer error before any write
 * attempt — mirrors server/transactionStateMachine/apply.ts's own
 * courtesy-check-then-real-write pattern), then the actual insert, which
 * the repository implementation MUST make conflict-safe at the database
 * level regardless of what this pre-check saw (the real enforcement is
 * always the database constraint, never this in-process check alone —
 * exactly the same reasoning `apply.ts`'s own doc comment already states).
 */
async function insertIdempotently(repo: LedgerRepository, draft: LedgerEventDraft): Promise<InsertOutcome> {
  const existing = await repo.findLedgerEventByRawMovement(draft.chain_id, draft.tx_hash ?? '', draft.log_index, draft.wallet_address)
  if (existing) {
    if (existing.event_type === draft.event_type) {
      return { outcome: 'already_posted', id: existing.id }
    }
    // The exact scenario docs/LEDGER_SCHEMA_GAP_AUDIT.md §1 exists to catch:
    // the same raw movement already posted under a DIFFERENT event_type.
    // Surfaced to the caller, never silently swallowed or overwritten.
    return { outcome: 'conflict', existingEventType: existing.event_type }
  }
  return repo.insertLedgerEvent(draft)
}

/**
 * Processes one confirmed chain_events row into its CREDIT/SWAP_CREDIT
 * ledger event(s) (and, for the plain Pay case, the paired DEBIT too — see
 * classifyPayTransfer's own reasoning for why that pairing is safe and
 * correct to do from one chain_event).
 *
 * The confirmation-rule guard here is DEFENSE IN DEPTH — classifiers.ts's
 * own functions already refuse anything but `status === 'confirmed'`
 * (returning `unresolved`) — but this function checks first, before even
 * attempting correlation lookups, so a non-confirmed event costs nothing
 * beyond the initial fetch.
 */
export async function interpretConfirmedChainEvent(
  repo: LedgerRepository,
  chainEventId: string,
): Promise<InterpretResult> {
  const chainEvent = await repo.getChainEvent(chainEventId)
  if (!chainEvent) {
    return { chainEventId, classification: 'not_applicable', reason: 'chain_event not found', inserts: [] }
  }
  if (chainEvent.status !== 'confirmed') {
    return { chainEventId, classification: 'unresolved', reason: `status is '${chainEvent.status}', not 'confirmed'`, inserts: [] }
  }

  const chainId = chainEvent.chain_id
  const txHash = (chainEvent.tx_hash ?? '').trim()
  const attempt = txHash ? await repo.findAttemptByTxHash(chainId, txHash) : null
  const intent = attempt ? await repo.getIntent(attempt.intent_id) : null

  const correlated = attempt && intent ? { attempt, intent } : null

  // Priority 1: transaction_intent correlation decides which classifier
  // owns this event. Swap and BulkPay checked before the Pay fallback — a
  // swap- or bulkpay-feature intent must never fall through to the Pay
  // classifier and become a plain CREDIT (BulkPay's sender is Multicall3,
  // a known-internal-contract — see classifyBulkPayCredit's own header for
  // why this correlation is the ONLY path that may treat it as CREDIT;
  // docs/BULKPAY_LEDGER_CLASSIFICATION_AUDIT.md).
  const outcome = correlated && intent!.feature === 'swap'
    ? classifySwapCredit(chainEvent, correlated)
    : correlated && intent!.feature === 'bulkpay'
    ? classifyBulkPayCredit(chainEvent, correlated)
    : classifyPayTransfer(chainEvent, intent ?? null)

  if (outcome.outcome !== 'classified') {
    return { chainEventId, classification: outcome.outcome, reason: outcome.reason, inserts: [] }
  }

  const inserts: InsertOutcome[] = []
  for (const draft of outcome.drafts) {
    inserts.push(await insertIdempotently(repo, draft))
  }
  return { chainEventId, classification: 'classified', inserts }
}

/**
 * Processes one confirmed transaction_attempts row into its SWAP_DEBIT
 * ledger event, if applicable (a no-op for any non-swap feature — Pay's
 * debit leg is created by interpretConfirmedChainEvent instead, see
 * classifyPayTransfer). The caller supplies the attempt directly (it
 * presumably just transitioned it to CONFIRMED via
 * server/transactionStateMachine — see that module's transitionAttempt),
 * rather than this function looking it up itself; this keeps
 * LedgerRepository's surface small (no "getAttemptById" needed) and matches
 * how a real caller (a reconciler) would naturally already have the object
 * in hand.
 */
export async function interpretConfirmedAttempt(
  repo: LedgerRepository,
  attempt: AttemptContext,
): Promise<InterpretResult> {
  if (attempt.status !== 'CONFIRMED') {
    return { attemptId: attempt.id, classification: 'unresolved', reason: `status is '${attempt.status}', not 'CONFIRMED'`, inserts: [] }
  }
  const intent = await repo.getIntent(attempt.intent_id)
  if (!intent) {
    return { attemptId: attempt.id, classification: 'not_applicable', reason: 'no matching transaction_intent', inserts: [] }
  }
  if (intent.feature !== 'swap') {
    return { attemptId: attempt.id, classification: 'not_applicable', reason: `feature='${intent.feature}' — this entry point only produces SWAP_DEBIT`, inserts: [] }
  }

  const outcome = classifySwapDebit(intent, attempt)
  if (outcome.outcome !== 'classified') {
    return { attemptId: attempt.id, classification: outcome.outcome, reason: outcome.reason, inserts: [] }
  }
  const inserts: InsertOutcome[] = []
  for (const draft of outcome.drafts) {
    inserts.push(await insertIdempotently(repo, draft))
  }
  return { attemptId: attempt.id, classification: 'classified', inserts }
}
