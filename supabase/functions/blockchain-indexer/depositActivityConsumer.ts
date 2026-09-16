// supabase/functions/blockchain-indexer/depositActivityConsumer.ts
//
// The canonical consumer for the last undocumented gap in the architecture:
//
//   blockchain-indexer -> chain_events -> [THIS] -> Activity
//
// Pay/BulkPay/Swap already each own their half of this (confirm -> ledger ->
// their own purpose-built Activity write). Plain incoming external transfers
// (an exchange withdrawal, a faucet, another wallet, a QR-code receive) have
// never had a canonical consumer -- only deposit-scan-all's own independent
// rescan-and-record path (recordExternalReceive), which duplicates detection
// work the indexer already does. This module is the canonical replacement
// for that path's Activity-writing half; it does NOT rescan the chain --
// chain_events is the only input.
//
// ── Semantics preserved from deposit-scan-all's recordExternalReceive ─────
// Same tx_hash convention (`recv_${txHash}`, so a receive row can never
// collide with a swap/pay/bulkpay row for the same raw hash, and so this
// consumer and the legacy scanner can coexist during a phased cutover
// without ever producing two rows for the same real event -- both upsert
// onto the exact same key). Same activity_type ('receive'), same
// metadata.note ('External deposit' -- HomePage.tsx's notification logic
// matches this string exactly, so it is reproduced verbatim, not
// paraphrased).
//
// ── What "eligible" means here ─────────────────────────────────────────
// A chain_event is eligible for a generic "receive" Activity only if BOTH:
//   1. Its sender is not a known-internal-contract (Kit Adapter, Multicall3,
//      CCTP, etc. -- supabase/functions/_shared/knownInternalContracts.ts).
//      This is the same hard, address-based fact deposit-scan-all's own
//      KNOWN_INTERNAL_CONTRACTS check already relies on: no genuine external
//      sender is ever one of these addresses.
//   2. Its tx_hash is NOT already the tx_hash of a Pay/BulkPay/Swap
//      transaction_attempts row (any wallet, any status) for this chain.
//      This is the canonical intent/attempt correlation the task requires --
//      it is deliberately broader than (1): a Pay transfer's sender is a
//      real user wallet, not a contract, so (1) alone cannot catch it, but
//      the transaction was still initiated through Pay's own tracked
//      pipeline and must not be double-surfaced here as an unrelated,
//      unaccounted-for deposit.
// Both checks live in the live wiring's query/lookup, not in this pure
// module -- see depositActivityConsumerLive.ts.

export interface DepositCandidateChainEvent {
  chainEventId: string
  chainId: string
  txHash: string
  walletAddress: string
  senderAddress: string | null
  amount: number
  tokenSymbol: string
}

export type DepositEligibility =
  | { eligible: true }
  | { eligible: false; reason: 'known_internal_contract_sender' }
  | { eligible: false; reason: 'correlated_to_tracked_feature'; feature: string }
  | { eligible: false; reason: 'missing_sender' }
  | { eligible: false; reason: 'non_positive_amount' }

/**
 * Pure eligibility decision given pre-fetched correlation facts (the live
 * wiring is responsible for actually querying knownInternalContracts and
 * transaction_attempts -- this function only combines the answers). Never
 * fabricates a positive answer: an event with no sender recorded, or a
 * zero/negative amount, is rejected rather than guessed at.
 */
export function assessDepositEligibility(
  event: DepositCandidateChainEvent,
  isInternalContractSender: boolean,
  correlatedTrackedFeature: string | null,
): DepositEligibility {
  if (!event.senderAddress) return { eligible: false, reason: 'missing_sender' }
  if (!Number.isFinite(event.amount) || event.amount <= 0) return { eligible: false, reason: 'non_positive_amount' }
  if (isInternalContractSender) return { eligible: false, reason: 'known_internal_contract_sender' }
  if (correlatedTrackedFeature) return { eligible: false, reason: 'correlated_to_tracked_feature', feature: correlatedTrackedFeature }
  return { eligible: true }
}

export interface DepositActivityRow {
  wallet_address: string
  tx_hash: string
  activity_type: 'receive'
  amount: number
  usd_value: number
  token_symbol: string
  counterparty_address: string
  explorer_url: string
  status: 'completed'
  // receiveKind: 'external_deposit' is the explicit classification
  // HomePage.tsx's notification logic keys off (see ActivityService.ts's
  // own comment on receiveKind for the full cross-writer reasoning this
  // aligns with -- Bug 1's fix). This consumer never has a "quiet, near a
  // recent swap" case the way deposit-scan-all's does: a genuine swap
  // output is already excluded upstream by this module's own
  // known-internal-contract-sender / tracked-attempt-correlation checks,
  // so anything that reaches here is never a swap leg in the first place.
  metadata: { recovered: false; note: 'External deposit'; source: 'chain_events_consumer'; chain_event_id: string; receiveKind: 'external_deposit' }
}

/** recv_<hash> -- see this file's header for why this exact prefix. */
export function receiveTxHashKey(txHash: string): string {
  return `recv_${txHash.toLowerCase()}`
}

export function buildDepositActivityRow(event: DepositCandidateChainEvent, explorerBaseUrl: string): DepositActivityRow {
  return {
    wallet_address: event.walletAddress.toLowerCase(),
    tx_hash: receiveTxHashKey(event.txHash),
    activity_type: 'receive',
    amount: event.amount,
    usd_value: event.amount,
    token_symbol: event.tokenSymbol,
    counterparty_address: (event.senderAddress ?? '').toLowerCase(),
    explorer_url: `${explorerBaseUrl}/tx/${event.txHash}`,
    status: 'completed',
    metadata: { recovered: false, note: 'External deposit', source: 'chain_events_consumer', chain_event_id: event.chainEventId, receiveKind: 'external_deposit' },
  }
}

export interface DepositEligibilityLookup {
  isKnownInternalContractSender(senderAddress: string): Promise<boolean>
  /** Returns the feature name ('pay' | 'bulkpay' | 'swap') if txHash already belongs to a tracked attempt, else null. */
  findCorrelatedTrackedFeature(chainId: string, txHash: string): Promise<string | null>
}

export interface DepositActivityUpdateRepository {
  /**
   * Idempotent by construction: implemented as an upsert on the real
   * UNIQUE(tx_hash, wallet_address) index with ignoreDuplicates -- the same
   * mechanism deposit-scan-all's own recordExternalReceive already uses (no
   * migration needed, no new schema). A second insert attempt for the same
   * (recv_<hash>, wallet) simply no-ops; it is never an error and never a
   * second row.
   */
  insertActivityIfAbsent(row: DepositActivityRow): Promise<'inserted' | 'already_existed'>
}

export interface DepositConsumeResult {
  chainEventId: string
  txHash: string
  outcome: 'created' | 'already_existed' | 'skipped'
  reason?: string
}

/**
 * Sweeps candidate chain_events and, for each eligible one, creates exactly
 * one canonical "receive" Activity row (or confirms one already exists).
 * Never rescans the chain -- every fact here comes from chain_events plus
 * the two correlation lookups above. One event's failure never aborts the
 * rest of the batch.
 */
export async function sweepDepositCandidateChainEvents(
  candidates: DepositCandidateChainEvent[],
  lookup: DepositEligibilityLookup,
  updateRepo: DepositActivityUpdateRepository,
  explorerBaseUrl: string,
): Promise<DepositConsumeResult[]> {
  const results: DepositConsumeResult[] = []
  for (const event of candidates) {
    try {
      const isInternal = event.senderAddress ? await lookup.isKnownInternalContractSender(event.senderAddress) : false
      const correlatedFeature = await lookup.findCorrelatedTrackedFeature(event.chainId, event.txHash)
      const eligibility = assessDepositEligibility(event, isInternal, correlatedFeature)

      if (!eligibility.eligible) {
        results.push({
          chainEventId: event.chainEventId,
          txHash: event.txHash,
          outcome: 'skipped',
          reason: eligibility.reason === 'correlated_to_tracked_feature' ? `correlated_to_tracked_feature:${eligibility.feature}` : eligibility.reason,
        })
        continue
      }

      const row = buildDepositActivityRow(event, explorerBaseUrl)
      const insertOutcome = await updateRepo.insertActivityIfAbsent(row)
      results.push({ chainEventId: event.chainEventId, txHash: event.txHash, outcome: insertOutcome === 'inserted' ? 'created' : 'already_existed' })
    } catch (e) {
      console.error(`[deposit-activity-consumer] chain_event ${event.chainEventId} failed:`, e instanceof Error ? e.message : e)
      results.push({ chainEventId: event.chainEventId, txHash: event.txHash, outcome: 'skipped', reason: 'error' })
    }
  }
  return results
}
