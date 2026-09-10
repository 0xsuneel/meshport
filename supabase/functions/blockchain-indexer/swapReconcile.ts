// supabase/functions/blockchain-indexer/swapReconcile.ts
//
// Swap reconciliation. Same architecture as payReconcile.ts / bulkpayReconcile.ts
// (both already production-validated) -- a sibling, not a modification to
// either.
//
// ── Why this exists ────────────────────────────────────────────────────
// classifySwapDebit (server/ledger/classifiers.ts) derives SWAP_DEBIT
// straight from a CONFIRMED transaction_attempt -- no chain_event needed,
// because the swap's input leg is the user's own broadcast transaction,
// already fully described by the attempt/intent. But SWAP_CREDIT requires
// a chain_event: the Kit Adapter Contract's outbound Transfer to the user,
// which the regular scanner (scanner.ts) structurally cannot produce,
// because the Kit Adapter Contract is a KNOWN_INTERNAL_CONTRACT and the
// regular scanner only watches registered `users.wallet_address` wallets as
// RECIPIENTS of transfers from arbitrary senders -- it has no notion of
// "watch this one tx_hash for this one wallet's inbound leg" the way this
// targeted, attempt-scoped reconciliation does. This module closes that
// gap for Swap specifically, the same way bulkpayReconcile.ts closes it for
// unregistered BulkPay recipients and payReconcile.ts closes it for
// unregistered Pay recipients.
//
// ── What is and isn't trusted ─────────────────────────────────────────
// tx_hash is only a worklist pointer (from a CONFIRMED transaction_attempt,
// feature='swap'). Every other field -- actual output token, actual output
// amount, actual log_index -- comes from an independent RPC read of the
// real transaction receipt, decoded with the same decodeTransferLog.ts
// logic every other reconciliation path in this codebase uses. Never
// derived from the intent's own client-declared tokenOut/expectedOutput
// metadata (see swap-intent/logic.ts's header comment -- that metadata is
// explicitly a "what the user asked for" record, never blockchain truth).
//
// ── Correlation safety (PHASE 15 of the task spec this mirrors) ──────────
// Only a Transfer log whose sender is the Kit Adapter Contract AND whose
// recipient is this exact attempt's own wallet_address, on this exact
// attempt's own tx_hash, is ever written. This can NEVER produce a
// chain_event for a different user's swap, or for an unrelated transfer
// that happens to originate from the Kit Adapter Contract for some other
// reason -- the worklist itself is scoped to one CONFIRMED attempt at a
// time, and the tx_hash + sender + recipient must all match that specific
// attempt. KNOWN_INTERNAL_CONTRACTS / isKnownInternalContract is left
// completely untouched by this file -- the Kit Adapter Contract stays in
// that list, exactly as it must (server/ledger/classifiers.ts's
// classifySwapCredit relies on it being there to safely defer an
// uncorrelated Kit Adapter transfer rather than misclassify it).

import { decodeTransferLog, isMintTransfer, TRANSFER_TOPIC0, type DecodedTransferLog } from './decodeTransferLog.ts'

export interface SwapWorklistRow {
  attemptId: string
  intentId: string
  txHash: string
  chainId: string
  walletAddress: string
}

export interface RawReceiptLog {
  address: string
  topics: string[]
  data: string
  transactionHash: string
  blockNumber: string
  logIndex: string
  blockHash: string
  transactionIndex: string
}

export interface RawReceiptWithLogs {
  transactionHash: string
  status: string
  blockNumber: string
  logs: RawReceiptLog[]
}

export interface ReconciledSwapCreditEvent {
  chain_id: string
  block_number: number
  tx_hash: string
  event_type: 'transfer_detected' | 'deposit_detected'
  wallet_address: string
  assets: string[]
  metadata: Record<string, unknown>
  status: 'confirmed'
  log_index: number | null
  contract_address: string | null
  event_signature: string | null
  block_hash: string | null
  transaction_index: number | null
}

export type SwapReconcileOutcome =
  | { outcome: 'reconciled'; event: ReconciledSwapCreditEvent }
  | { outcome: 'reverted' }
  | { outcome: 'not_found'; reason: string }
  | { outcome: 'no_credit_leg_found' }

/**
 * Independently decodes ONE confirmed swap attempt's real transaction
 * receipt and finds the ONE Transfer log representing the Kit Adapter
 * Contract paying the user's wallet its swap output -- the SWAP_CREDIT
 * leg. Checks BOTH the native-transfer-log path (0xffff…fffe, 18 decimals
 * -- e.g. swapping into native USDC) and every configured ERC20 `tokens`
 * contract (e.g. EURC, cirBTC), exactly the same two paths the regular
 * scanner and payReconcile.ts already use, so a swap landing in either an
 * ERC20 or the native asset is handled without guessing which.
 *
 * Deliberately picks the FIRST matching (Kit Adapter -> wallet) Transfer
 * log across all candidate contracts/paths, in on-chain log order --
 * multiple internal legs can appear in one swap's receipt (routing through
 * an intermediate pool), but only the log that actually pays the user's own
 * wallet is ever a candidate at all, so there is exactly one economically
 * meaningful "the user received X" event to find, not many to choose
 * between.
 */
export function decodeSwapCreditLeg(
  row: SwapWorklistRow,
  receipt: RawReceiptWithLogs,
  kitAdapterContract: string,
  nativeTransferLogContract: string | null,
  tokens: Array<{ symbol: string; contract: string; decimals: number }>,
): SwapReconcileOutcome {
  const receiptTxHash = (receipt.transactionHash ?? '').toLowerCase()
  if (receiptTxHash && receiptTxHash !== row.txHash.toLowerCase()) {
    return { outcome: 'not_found', reason: `receipt tx_hash (${receiptTxHash}) does not match worklist tx_hash (${row.txHash})` }
  }
  if (receipt.status !== '0x1') {
    return { outcome: 'reverted' }
  }

  const blockNumber = Number(BigInt(receipt.blockNumber ?? '0x0'))
  const kitAdapter = kitAdapterContract.toLowerCase()
  const wallet = row.walletAddress.toLowerCase()

  // Candidate contracts to check, in the same shape as decodeTransferLog's
  // caller convention -- native-transfer-log contract first (18 decimals,
  // symbol left null since the real symbol depends on which native asset
  // this chain uses; Arc's is USDC per chains.ts), then every configured
  // ERC20 token.
  const candidates: Array<{ symbol: string | null; contract: string; decimals: number; isNative: boolean }> = [
    ...(nativeTransferLogContract ? [{ symbol: null, contract: nativeTransferLogContract, decimals: 18, isNative: true }] : []),
    ...tokens.map(t => ({ symbol: t.symbol, contract: t.contract, decimals: t.decimals, isNative: false })),
  ]

  for (const log of receipt.logs) {
    if (!Array.isArray(log.topics) || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC0) continue
    const address = (log.address ?? '').toLowerCase()
    const candidate = candidates.find(c => c.contract.toLowerCase() === address)
    if (!candidate) continue

    const decoded: DecodedTransferLog | null = decodeTransferLog(log, candidate.decimals, address)
    if (!decoded) continue
    if (isMintTransfer(decoded)) continue
    // The one correlation rule this entire function exists to enforce:
    // sender MUST be the Kit Adapter Contract, recipient MUST be this
    // exact attempt's own wallet. Any other combination is not this
    // attempt's SWAP_CREDIT leg, however plausible-looking, and is skipped
    // without being written anywhere.
    if (decoded.from.toLowerCase() !== kitAdapter) continue
    if (decoded.wallet.toLowerCase() !== wallet) continue

    return {
      outcome: 'reconciled',
      event: {
        chain_id: row.chainId,
        block_number: blockNumber,
        tx_hash: decoded.txHash,
        event_type: candidate.isNative ? 'deposit_detected' : 'transfer_detected',
        wallet_address: decoded.wallet,
        assets: [candidate.symbol ?? 'USDC'],
        metadata: candidate.isNative
          ? { recipient: decoded.wallet, sender: decoded.from, amount: decoded.amount, via: 'native-transfer-log', reconciled: true, reconciledFrom: 'swap' }
          : { to: decoded.wallet, from: decoded.from, amount: decoded.amount, reconciled: true, reconciledFrom: 'swap' },
        status: 'confirmed',
        log_index: decoded.logIndex,
        contract_address: address,
        event_signature: 'Transfer(address,address,uint256)',
        block_hash: decoded.blockHash,
        transaction_index: decoded.transactionIndex,
      },
    }
  }

  return { outcome: 'no_credit_leg_found' }
}

export interface SwapReconcileRepository {
  findConfirmedUnreconciledSwapAttempts(sinceIso: string): Promise<SwapWorklistRow[]>
  markReconciled(attemptId: string, reconciledAtIso: string): Promise<void>
  insertChainEvent(row: Record<string, unknown>): Promise<void>
  chainEventAlreadyExists(chainId: string, txHash: string, walletAddress: string): Promise<boolean>
}

export interface SwapReceiptFetcher {
  getReceipt(txHash: string): Promise<RawReceiptWithLogs | null>
}

export interface SwapReconcileResult {
  attemptId: string
  txHash: string
  outcome: SwapReconcileOutcome['outcome'] | 'already_covered'
  reason?: string
}

/**
 * Sweeps CONFIRMED swap attempts not yet chain-event-reconciled. Idempotent
 * by construction: chainEventAlreadyExists / the chain_events dedup
 * constraint (event_key, spanning chain_id:tx_hash:log_index:wallet:type)
 * means re-running this sweep on an already-reconciled attempt is a safe
 * no-op, matching payReconcile.ts's own idempotency exactly. One attempt's
 * failure never aborts the rest of the sweep.
 */
export async function runSwapReconciliation(
  repo: SwapReconcileRepository,
  fetcher: SwapReceiptFetcher,
  kitAdapterContract: string,
  nativeTransferLogContract: string | null,
  tokens: Array<{ symbol: string; contract: string; decimals: number }>,
  sinceIso: string,
): Promise<SwapReconcileResult[]> {
  const worklist = await repo.findConfirmedUnreconciledSwapAttempts(sinceIso)
  const results: SwapReconcileResult[] = []

  for (const row of worklist) {
    try {
      const already = await repo.chainEventAlreadyExists(row.chainId, row.txHash, row.walletAddress)
      if (already) {
        results.push({ attemptId: row.attemptId, txHash: row.txHash, outcome: 'already_covered' })
        await repo.markReconciled(row.attemptId, new Date().toISOString())
        continue
      }

      let receipt: RawReceiptWithLogs | null
      try {
        receipt = await fetcher.getReceipt(row.txHash)
      } catch (e) {
        // RPC failure -- retryable. Deliberately does NOT call
        // markReconciled here, so this row is retried on the next pass
        // rather than given up on due to a transient network problem.
        results.push({ attemptId: row.attemptId, txHash: row.txHash, outcome: 'not_found', reason: `RPC error, will retry: ${e instanceof Error ? e.message : String(e)}` })
        continue
      }

      if (!receipt) {
        results.push({ attemptId: row.attemptId, txHash: row.txHash, outcome: 'not_found', reason: 'transaction receipt not found on-chain' })
        continue
      }

      const outcome = decodeSwapCreditLeg(row, receipt, kitAdapterContract, nativeTransferLogContract, tokens)
      if (outcome.outcome === 'reconciled') {
        await repo.insertChainEvent(outcome.event as unknown as Record<string, unknown>)
        results.push({ attemptId: row.attemptId, txHash: row.txHash, outcome: 'reconciled' })
      } else {
        results.push({ attemptId: row.attemptId, txHash: row.txHash, outcome: outcome.outcome, reason: 'reason' in outcome ? outcome.reason : undefined })
      }
      // Every terminal outcome (including reverted/no_credit_leg_found)
      // marks the row reconciled -- nothing further can be learned by
      // retrying a transaction that has already been definitively read.
      // A genuinely transient "not found" case above never reaches here.
      await repo.markReconciled(row.attemptId, new Date().toISOString())
    } catch (e) {
      results.push({ attemptId: row.attemptId, txHash: row.txHash, outcome: 'not_found', reason: `unexpected error, will retry: ${e instanceof Error ? e.message : String(e)}` })
    }
  }

  return results
}
