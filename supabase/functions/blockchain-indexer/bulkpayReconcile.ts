// supabase/functions/blockchain-indexer/bulkpayReconcile.ts
//
// BulkPay reconciliation — docs/BULKPAY_RECONCILIATION_IMPLEMENTATION.md,
// implementing Option B-refined from docs/BULKPAY_INTENT_SCOPED_WATCH_DESIGN.md.
//
// ── The one rule this entire file exists to enforce ────────────────────────
// A chain_events row is NEVER created from client-declared data (activity,
// bulk_payments_received, or bulk_payments' own row content beyond its
// tx_hash). bulk_payments.tx_hash is used ONLY as a pointer — "check this
// transaction" — never as authorization. The actual recipient/amount/token
// data always comes from an independently, server-side re-fetched
// transaction receipt, decoded with the exact same logic
// blockchain-indexer's main scan already uses (decodeTransferLog.ts).
//
// This directly closes the gap traced in docs/BULKPAY_INDEXER_FORENSIC_AUDIT.md:
// a BulkPay recipient who isn't in users.wallet_address never gets a
// chain_events row from the main scan (knownWallets filtering, by design).
// This module produces one for them anyway — WITHOUT ever adding their
// address to knownWallets, permanently or temporarily (docs/
// BULKPAY_INTENT_SCOPED_WATCH_DESIGN.md §7's explicit requirement).
//
// ── Dependency injection ─────────────────────────────────────────────────
// No Supabase client and no RPC client is instantiated in this file — both
// are supplied by the caller (index.ts, via new interfaces below), matching
// the exact discipline already used throughout server/ledger/ and
// server/transactionStateMachine/. This is what makes the logic here
// testable without a live database or live RPC endpoint.

import { decodeTransferLog, isMintTransfer, isSelfTransfer, TRANSFER_TOPIC0, type DecodedTransferLog } from './decodeTransferLog.ts'

// Multicall3's canonical, deterministic deployment address — identical on
// every EVM chain, and the exact constant BulkPayoutPage.tsx itself sends
// transactions to (src/features/bulkpayout/BulkPayoutPage.tsx). Used here
// only as a defensive sanity check (see decodeBulkPayReceipt's doc comment)
// — never as the source of recipient data.
export const MULTICALL3_ADDRESS = '0xca11bde05977b3631167028862be2a173976ca11'

/** Minimal shape of a bulk_payments row this module reads — a pointer only, never trusted for recipient data. */
export interface BulkPaymentWorklistRow {
  id: string
  tx_hash: string
  created_at: string
  /**
   * Which table this pointer came from — 'bulk_payments' (client-written,
   * post-broadcast, the original worklist source) or 'transaction_attempt'
   * (server-verified via Phase 4's confirmation sweep, added so a
   * BulkPay transaction that reaches CONFIRMED server-side gets
   * chain_events reconciled even if the client never successfully writes
   * to bulk_payments at all — the exact gap the transaction_intent/attempt
   * architecture was built to survive, docs/
   * BULKPAY_TRANSACTION_INTENT_IMPLEMENTATION.md's Phase 5). Neither
   * source is trusted for recipient/amount data either way — this field
   * only ever routes which "already reconciled" column gets marked.
   */
  source: 'bulk_payments' | 'transaction_attempt'
}

/** Minimal shape of a real, RPC-fetched transaction receipt this module needs. */
export interface RawReceipt {
  transactionHash: string
  status: string // '0x1' success, '0x0' reverted
  to: string | null
  blockNumber: string
  logs: Array<{
    address: string
    topics: string[]
    data: string
    transactionHash: string
    blockNumber: string
    logIndex: string
    blockHash: string
    transactionIndex: string
  }>
}

/** The only RPC operation this module needs — supplied by the caller. */
export interface ReceiptFetcher {
  getTransactionReceipt(txHash: string): Promise<RawReceipt | null>
}

/** A chain_events-shaped row ready to insert, exactly matching the schema the main scan already writes to. */
export interface ReconciledChainEvent {
  chain_id: string
  block_number: number
  tx_hash: string
  event_type: 'deposit_detected' | 'transfer_detected'
  wallet_address: string
  assets: string[]
  metadata: Record<string, unknown>
  status: 'confirmed'
  log_index: number | null
  contract_address: string
  event_signature: string
  block_hash: string | null
  transaction_index: number | null
}

export type ReconcileOutcome =
  | { outcome: 'reconciled'; events: ReconciledChainEvent[] }
  | { outcome: 'not_found'; reason: string }
  | { outcome: 'reverted' }
  | { outcome: 'not_bulkpay'; reason: string }
  | { outcome: 'no_legs_found' }

/**
 * Independently decodes ONE real, already-broadcast transaction's actual
 * recipients — the core of Option B-refined. `worklistRow.tx_hash` is used
 * only to know WHICH transaction to fetch; every other field in the
 * returned events comes from `receipt`, fetched by the caller via
 * `ReceiptFetcher`, never from `worklistRow` or any other client-declared
 * table.
 *
 * `nativeTransferLogContract` and `tokens` mirror chains.ts's own
 * `IndexedChain` shape — passed in rather than imported, so this function
 * has no dependency on chains.ts's Deno-specific env-var reads and stays
 * trivially unit-testable.
 *
 * Why check receipt.to === Multicall3 (Phase 5 test 8): a tx_hash is
 * globally unique on a real chain, so this check can never be defeated by
 * an attacker (they cannot cause a real, unrelated transaction to also
 * match a tx_hash they control) — but it IS a meaningful defense against a
 * bulk_payments row whose tx_hash was copy-pasted incorrectly, or points at
 * a real transaction that was never actually a BulkPay batch. Returning
 * not_bulkpay rather than silently decoding whatever logs a wrong-but-real
 * transaction happens to have keeps this reconciliation scoped to what it
 * claims to do.
 *
 * Why status='confirmed' directly, not 'pending': this function is only
 * ever called for a receipt whose status is '0x1' (checked before this
 * point) — a mined, successful transaction, on a chain with
 * confirmationDepth = 0 (Arc). There is no meaningful 'pending' state to
 * represent here; the main scan's own 'pending' status exists for blocks
 * that haven't yet crossed the confirmation-depth frontier, which for Arc
 * is immediate.
 */
export function decodeBulkPayReceipt(
  worklistRow: BulkPaymentWorklistRow,
  receipt: RawReceipt,
  chainId: string,
  nativeTransferLogContract: string | null,
  tokens: Array<{ symbol: string; contract: string; decimals: number }>,
): ReconcileOutcome {
  // Defense in depth: confirms the fetched receipt actually corresponds to
  // the tx_hash this worklist row pointed at, not a caller bug (e.g. the
  // wrong receipt passed in). worklistRow itself still never supplies any
  // recipient/amount data — this is the ONLY thing it's used for.
  const receiptTxHash = (receipt.transactionHash ?? '').toLowerCase()
  if (receiptTxHash && receiptTxHash !== worklistRow.tx_hash.toLowerCase()) {
    return { outcome: 'not_found', reason: `receipt tx_hash (${receiptTxHash}) does not match worklist tx_hash (${worklistRow.tx_hash})` }
  }

  if (receipt.status !== '0x1') {
    return { outcome: 'reverted' }
  }
  if (!receipt.to || receipt.to.toLowerCase() !== MULTICALL3_ADDRESS) {
    return { outcome: 'not_bulkpay', reason: `receipt.to (${receipt.to}) is not Multicall3` }
  }

  const blockNumber = Number(BigInt(receipt.blockNumber ?? '0x0'))
  const events: ReconciledChainEvent[] = []

  for (const log of receipt.logs) {
    if (!Array.isArray(log.topics) || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC0) continue
    const address = (log.address ?? '').toLowerCase()

    const isNativePath = !!nativeTransferLogContract && address === nativeTransferLogContract.toLowerCase()
    const token = tokens.find(t => t.contract.toLowerCase() === address)
    if (!isNativePath && !token) continue

    const decimals = isNativePath ? 18 : token!.decimals
    const decoded: DecodedTransferLog | null = decodeTransferLog(log, decimals, address)
    if (!decoded) continue
    if (isMintTransfer(decoded)) continue
    if (isSelfTransfer(decoded)) continue
    // BUG FIX (found against a real production transaction,
    // 0x517e432c...): a real Multicall3 batch's native-transfer-log wrapper
    // also emits a Transfer for the PAYER'S OWN deposit INTO Multicall3
    // itself (the msg.value funding step), before Multicall3 forwards it to
    // each real recipient. The regular scanner (scanner.ts) never sees this
    // leg, because Multicall3 is never a registered `users.wallet_address`
    // and its own knownWallets filter excludes it structurally -- but this
    // reconciliation path has no such filter (deliberately, so unregistered
    // REAL recipients are still captured), so it decoded this leg too,
    // producing a wallet_address === Multicall3 chain_event. If that ever
    // reached the Ledger, classifyBulkPayCredit's self-transfer check
    // (payer === recipient) would NOT catch it (Multicall3 is neither the
    // payer nor a real recipient), producing a spurious CREDIT to
    // Multicall3's own address for the full batch total. Excluded here,
    // explicitly, at the source -- Multicall3 receiving funds as an
    // intermediate step is never a real "recipient" for accounting
    // purposes; only its own downstream transfers to end-users are.
    if (decoded.wallet.toLowerCase() === MULTICALL3_ADDRESS) continue

    events.push({
      chain_id: chainId,
      block_number: blockNumber,
      tx_hash: decoded.txHash,
      event_type: isNativePath ? 'deposit_detected' : 'transfer_detected',
      wallet_address: decoded.wallet,
      assets: isNativePath ? ['USDC'] : [token!.symbol],
      metadata: isNativePath
        ? { recipient: decoded.wallet, sender: decoded.from, amount: decoded.amount, via: 'native-transfer-log', reconciled: true, reconciledFrom: 'bulkpay' }
        : { to: decoded.wallet, from: decoded.from, amount: decoded.amount, reconciled: true, reconciledFrom: 'bulkpay' },
      status: 'confirmed',
      log_index: decoded.logIndex,
      contract_address: address,
      event_signature: 'Transfer(address,address,uint256)',
      block_hash: decoded.blockHash,
      transaction_index: decoded.transactionIndex,
    })
  }

  if (events.length === 0) return { outcome: 'no_legs_found' }
  return { outcome: 'reconciled', events }
}

// ── Orchestration ────────────────────────────────────────────────────────

import type { BulkpayReconcileRepository, ArcReceiptFetcher } from './bulkpayReconcileRepository.ts'

export interface WorklistItemResult {
  bulkPaymentId: string
  txHash: string
  outcome: ReconcileOutcome['outcome']
  eventsWritten: number
  reason?: string
}

/**
 * Processes the reconciliation worklist: recent, unverified `bulk_payments`
 * rows. For each, independently re-fetches and decodes the real transaction
 * (never trusting the row's own claimed content beyond its `tx_hash`), and
 * writes whatever real chain_events rows the actual on-chain data supports.
 *
 * Idempotent by construction: `insertChainEvent` relies on the existing
 * chain_events dedup constraint (Phase 6), and `markVerified` is only ever
 * called after a `tx_hash`'s legs are fully processed for this pass — a
 * crash mid-batch simply means the next invocation re-processes the same
 * still-unverified rows, safely (§ "resume after crash" below).
 *
 * `not_found`/`reverted`/`not_bulkpay`/`no_legs_found` outcomes still mark
 * the row verified — there is nothing more this reconciliation can ever
 * learn about a `tx_hash` that doesn't resolve, reverted, or wasn't really
 * a BulkPay call; retrying it forever would not change the outcome. This is
 * a deliberate, bounded "give up cleanly" behavior, not silent data loss —
 * every outcome is returned to the caller to log/alert on.
 */
export async function runBulkpayReconciliation(
  repo: BulkpayReconcileRepository,
  fetcher: ArcReceiptFetcher,
  chainId: string,
  nativeTransferLogContract: string | null,
  tokens: Array<{ symbol: string; contract: string; decimals: number }>,
  sinceIso: string,
): Promise<WorklistItemResult[]> {
  // Two worklist sources, merged and deduplicated by tx_hash -- bulk_payments
  // (the original, client-written pointer) and transaction_attempts
  // (server-verified via Phase 4, closing the gap where a client never
  // successfully writes to bulk_payments at all). If BOTH sources happen to
  // reference the same real tx_hash (the common case once both paths are
  // live), the bulk_payments-sourced row is kept and the attempt-sourced
  // duplicate is dropped -- processing it once is sufficient; which pointer
  // "wins" the dedup has no effect on the actual reconciliation outcome,
  // since the real recipient/amount data always comes from the
  // independently-decoded receipt either way, never from either pointer.
  const [fromBulkPayments, fromAttempts] = await Promise.all([
    repo.findUnverifiedBulkPayments(sinceIso),
    repo.findConfirmedBulkPayAttempts(sinceIso),
  ])
  const seenTxHashes = new Set(fromBulkPayments.map(r => r.tx_hash.toLowerCase()))
  const worklist = [
    ...fromBulkPayments,
    ...fromAttempts.filter(r => !seenTxHashes.has(r.tx_hash.toLowerCase())),
  ]
  const results: WorklistItemResult[] = []

  for (const row of worklist) {
    try {
      if (!row.tx_hash) {
        results.push({ bulkPaymentId: row.id, txHash: '', outcome: 'not_found', eventsWritten: 0, reason: 'no tx_hash on this row' })
        await repo.markVerified(row, new Date().toISOString())
        continue
      }

      let receipt: RawReceipt | null
      try {
        receipt = await fetcher.getTransactionReceipt(row.tx_hash)
      } catch (e) {
        // RPC failure — retryable, per Phase 5 test 9. Deliberately does NOT
        // call markVerified here, so this exact row is picked up again on the
        // next pass rather than being given up on due to a transient network
        // problem.
        results.push({ bulkPaymentId: row.id, txHash: row.tx_hash, outcome: 'not_found', eventsWritten: 0, reason: `RPC error, will retry: ${e instanceof Error ? e.message : String(e)}` })
        continue
      }

      if (!receipt) {
        // Genuinely unresolvable — a fabricated tx_hash, or one that hasn't
        // landed yet. This function itself stays simple and always retries
        // an unresolved receipt on the next pass, since `sinceIso` already
        // bounds how long that can go on for (docs/
        // BULKPAY_INTENT_SCOPED_WATCH_DESIGN.md §8).
        results.push({ bulkPaymentId: row.id, txHash: row.tx_hash, outcome: 'not_found', eventsWritten: 0, reason: 'transaction receipt not found on-chain' })
        continue
      }

      const outcome = decodeBulkPayReceipt(row, receipt, chainId, nativeTransferLogContract, tokens)

      if (outcome.outcome === 'reconciled') {
        for (const event of outcome.events) {
          await repo.insertChainEvent(event as unknown as Record<string, unknown>)
        }
        results.push({ bulkPaymentId: row.id, txHash: row.tx_hash, outcome: 'reconciled', eventsWritten: outcome.events.length })
      } else {
        results.push({ bulkPaymentId: row.id, txHash: row.tx_hash, outcome: outcome.outcome, eventsWritten: 0, reason: 'reason' in outcome ? outcome.reason : undefined })
      }

      // Every terminal outcome (including reverted/not_bulkpay/no_legs_found)
      // marks the row verified — nothing further can be learned by retrying a
      // transaction that has already been definitively read and classified.
      await repo.markVerified(row, new Date().toISOString())
    } catch (e) {
      // A single row's unexpected failure (e.g. insertChainEvent throwing)
      // must never abort the rest of the batch — matching the same
      // resilience already established throughout this codebase (e.g.
      // cursors.ts's insertEvents, scanner.ts's per-chunk error isolation).
      // Deliberately NOT marked verified, so this row is retried next pass —
      // this is exactly what makes a partially-processed batch safe to
      // resume (Phase 5 test 10).
      results.push({ bulkPaymentId: row.id, txHash: row.tx_hash ?? '', outcome: 'not_found', eventsWritten: 0, reason: `unexpected error, will retry: ${e instanceof Error ? e.message : String(e)}` })
    }
  }

  return results
}
