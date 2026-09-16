// supabase/functions/blockchain-indexer/payReconcile.ts
//
// Pay reconciliation for unregistered recipients (Root Cause #3,
// docs/PAY_TRANSACTION_INTENT_IMPLEMENTATION.md). Same architecture as
// bulkpayReconcile.ts (already production-validated) -- a sibling, not a
// modification to it.
//
// ── Why this exists ────────────────────────────────────────────────────
// The regular scanner (scanner.ts) only ever looks at knownWallets (real
// MeshPort accounts). A Pay send to a wallet that isn't registered is real,
// on-chain, and genuine -- but the regular scanner structurally cannot see
// it, by design (this module does not touch that filter or that scanner in
// any way). This module independently re-reads the real transaction/receipt
// for one specific Pay attempt's tx_hash and produces the one chain_event
// the regular scanner would have produced if the recipient WERE registered.
//
// ── What is and isn't trusted ─────────────────────────────────────────
// tx_hash is only a worklist pointer. Every other field -- sender, actual
// recipient, actual amount, actual token -- comes from an independent RPC
// read (eth_getTransactionByHash for native, eth_getTransactionReceipt's
// logs for ERC20), verified against what the attempt/intent expects, never
// assumed from the intent's own client-declared amount/recipient. A
// mismatch is reported and NOT written.
//
// This module never adds the recipient to knownWallets and never touches
// scanner.ts's own wallet-scoping logic in any way.

import { decodeTransferLog, isMintTransfer, isSelfTransfer, TRANSFER_TOPIC0, type DecodedTransferLog } from './decodeTransferLog.ts'

export interface PayWorklistRow {
  attemptId: string
  txHash: string
  chainId: string
  payerWallet: string
  recipientWallet: string
  isNative: boolean
  tokenAddress: string | null
  tokenSymbol: string | null
}

export interface RawTransaction {
  hash: string
  from: string
  to: string | null
  value: string
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

export interface ReconciledPayEvent {
  chain_id: string
  block_number: number
  tx_hash: string
  event_type: 'deposit_detected' | 'transfer_detected'
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

export type PayReconcileOutcome =
  | { outcome: 'reconciled'; event: ReconciledPayEvent }
  | { outcome: 'reverted' }
  | { outcome: 'not_found'; reason: string }
  | { outcome: 'mismatch'; reason: string }

/**
 * Independently decodes ONE Pay attempt's real transaction/receipt and
 * produces the ONE real chain_event it represents -- native path from the
 * transaction's own to/value (matching exactly how the regular scanner
 * already captures registered-recipient native Pay, log_index=null), ERC20
 * path from the receipt's real Transfer log. Every field is independently
 * verified against what this specific attempt/intent expects.
 */
export function decodePayReceipt(
  row: PayWorklistRow,
  tx: RawTransaction,
  receipt: RawReceiptWithLogs,
): PayReconcileOutcome {
  const receiptTxHash = (receipt.transactionHash ?? '').toLowerCase()
  if (receiptTxHash && receiptTxHash !== row.txHash.toLowerCase()) {
    return { outcome: 'not_found', reason: `receipt tx_hash (${receiptTxHash}) does not match worklist tx_hash (${row.txHash})` }
  }
  if (receipt.status !== '0x1') {
    return { outcome: 'reverted' }
  }

  const from = (tx.from ?? '').toLowerCase()
  if (from !== row.payerWallet.toLowerCase()) {
    return { outcome: 'mismatch', reason: `transaction sender ${from} does not match expected payer ${row.payerWallet}` }
  }

  const blockNumber = Number(BigInt(receipt.blockNumber ?? '0x0'))

  if (row.isNative) {
    const to = (tx.to ?? '').toLowerCase()
    if (to !== row.recipientWallet.toLowerCase()) {
      return { outcome: 'mismatch', reason: `transaction.to ${to} does not match expected recipient ${row.recipientWallet}` }
    }
    let amount: number
    try { amount = Number(BigInt(tx.value ?? '0x0')) / 1e18 } catch {
      return { outcome: 'mismatch', reason: 'transaction value could not be parsed' }
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return { outcome: 'mismatch', reason: `transaction value ${tx.value} is not a positive amount` }
    }
    return {
      outcome: 'reconciled',
      event: {
        chain_id: row.chainId,
        block_number: blockNumber,
        tx_hash: row.txHash.toLowerCase(),
        event_type: 'deposit_detected',
        wallet_address: row.recipientWallet.toLowerCase(),
        assets: [row.tokenSymbol ?? 'USDC'],
        metadata: { recipient: row.recipientWallet.toLowerCase(), sender: from, amount, via: 'native-transfer-log', reconciled: true, reconciledFrom: 'pay' },
        status: 'confirmed',
        log_index: null,
        contract_address: null,
        event_signature: null,
        block_hash: null,
        transaction_index: null,
      },
    }
  }

  if (!row.tokenAddress) {
    return { outcome: 'mismatch', reason: 'attempt is non-native but has no tokenAddress to verify against' }
  }
  const tokenAddressLower = row.tokenAddress.toLowerCase()

  for (const log of receipt.logs) {
    if (!Array.isArray(log.topics) || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC0) continue
    const address = (log.address ?? '').toLowerCase()
    if (address !== tokenAddressLower) continue

    const decoded: DecodedTransferLog | null = decodeTransferLog(log, 6, address)
    if (!decoded) continue
    if (isMintTransfer(decoded)) continue
    if (isSelfTransfer(decoded)) continue
    if (decoded.wallet.toLowerCase() !== row.recipientWallet.toLowerCase()) continue
    if (decoded.from.toLowerCase() !== row.payerWallet.toLowerCase()) continue

    return {
      outcome: 'reconciled',
      event: {
        chain_id: row.chainId,
        block_number: blockNumber,
        tx_hash: decoded.txHash,
        event_type: 'transfer_detected',
        wallet_address: decoded.wallet,
        assets: [row.tokenSymbol ?? 'TOKEN'],
        metadata: { to: decoded.wallet, from: decoded.from, amount: decoded.amount, reconciled: true, reconciledFrom: 'pay' },
        status: 'confirmed',
        log_index: decoded.logIndex,
        contract_address: address,
        event_signature: 'Transfer(address,address,uint256)',
        block_hash: decoded.blockHash,
        transaction_index: decoded.transactionIndex,
      },
    }
  }

  return { outcome: 'not_found', reason: `no matching Transfer log found for token ${row.tokenAddress}, expected recipient ${row.recipientWallet}` }
}

export interface PayReconcileRepository {
  findConfirmedUnreconciledPayAttempts(sinceIso: string): Promise<PayWorklistRow[]>
  markReconciled(attemptId: string, reconciledAtIso: string): Promise<void>
  insertChainEvent(row: Record<string, unknown>): Promise<void>
  chainEventAlreadyExists(chainId: string, txHash: string, walletAddress: string): Promise<boolean>
}

export interface PayReceiptFetcher {
  getTransaction(txHash: string): Promise<RawTransaction | null>
  getReceipt(txHash: string): Promise<RawReceiptWithLogs | null>
}

export interface PayReconcileResult {
  attemptId: string
  txHash: string
  outcome: PayReconcileOutcome['outcome'] | 'already_covered'
  reason?: string
}

/**
 * Sweeps CONFIRMED pay attempts not yet chain-event-reconciled. Skips any
 * attempt the regular scanner already covered -- this module exists only
 * to fill the unregistered-recipient gap. One attempt's failure never
 * aborts the rest of the sweep.
 */
export async function runPayReconciliation(
  repo: PayReconcileRepository,
  fetcher: PayReceiptFetcher,
  sinceIso: string,
): Promise<PayReconcileResult[]> {
  const worklist = await repo.findConfirmedUnreconciledPayAttempts(sinceIso)
  const results: PayReconcileResult[] = []

  for (const row of worklist) {
    try {
      const already = await repo.chainEventAlreadyExists(row.chainId, row.txHash, row.recipientWallet)
      if (already) {
        results.push({ attemptId: row.attemptId, txHash: row.txHash, outcome: 'already_covered' })
        await repo.markReconciled(row.attemptId, new Date().toISOString())
        continue
      }

      const [tx, receipt] = await Promise.all([
        fetcher.getTransaction(row.txHash),
        fetcher.getReceipt(row.txHash),
      ])
      if (!tx || !receipt) {
        results.push({ attemptId: row.attemptId, txHash: row.txHash, outcome: 'not_found', reason: 'transaction or receipt not found on-chain' })
        continue
      }

      const outcome = decodePayReceipt(row, tx, receipt)
      if (outcome.outcome === 'reconciled') {
        await repo.insertChainEvent(outcome.event as unknown as Record<string, unknown>)
        results.push({ attemptId: row.attemptId, txHash: row.txHash, outcome: 'reconciled' })
      } else {
        results.push({ attemptId: row.attemptId, txHash: row.txHash, outcome: outcome.outcome, reason: 'reason' in outcome ? outcome.reason : undefined })
      }
      await repo.markReconciled(row.attemptId, new Date().toISOString())
    } catch (e) {
      results.push({ attemptId: row.attemptId, txHash: row.txHash, outcome: 'not_found', reason: `unexpected error, will retry: ${e instanceof Error ? e.message : String(e)}` })
    }
  }

  return results
}
