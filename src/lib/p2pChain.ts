// lib/p2pChain.ts
//
// Requirement 3 ("Blockchain Integration — Navigation Activity Page - All
// section"): after escrow release, look up a trade's on-chain confirmation
// state for display — block number, timestamp, live confirmation count,
// and the explorer link. Reuses the exact same viem client construction
// arcService.ts already uses (confirmTransactionInBackground) rather than
// standing up a second RPC pattern — every P2P escrow tx lives on Arc, same
// chain as the rest of the app's transfers.

import { createPublicClient } from 'viem'
import { arcTransport } from './arc'
import { arcExplorerTxUrl } from './chainExplorers'

export interface TxChainInfo {
  txHash: string
  blockNumber: number | null
  timestamp: string | null   // ISO string, from the block itself
  confirmations: number | null
  status: 'success' | 'reverted' | 'pending' | 'unknown'
  explorerUrl: string | null
}

/**
 * Looks up a transaction's current on-chain state. Safe to call for a tx
 * that's still pending (returns confirmations: 0, status: 'pending') or one
 * the RPC can't find at all (status: 'unknown' — e.g. a stale/incorrect
 * hash) — callers should treat both as "don't show confirmation details
 * yet" rather than errors.
 */
export async function fetchTxChainInfo(txHash: string): Promise<TxChainInfo> {
  const explorerUrl = arcExplorerTxUrl(txHash)
  const base: TxChainInfo = { txHash, blockNumber: null, timestamp: null, confirmations: null, status: 'unknown', explorerUrl }
  if (!txHash) return base

  try {
    const client = createPublicClient({ transport: arcTransport({ retryCount: 2, timeout: 12000 }) })
    const [receipt, latestBlock] = await Promise.all([
      client.getTransactionReceipt({ hash: txHash as `0x${string}` }).catch(() => null),
      client.getBlockNumber().catch(() => null),
    ])

    if (!receipt) {
      // No receipt yet could mean genuinely pending, or the RPC just
      // doesn't have it (wrong hash) — either way there's nothing more
      // specific to report than "not confirmed yet".
      return { ...base, status: 'pending' }
    }

    const blockNumber = Number(receipt.blockNumber)
    const confirmations = latestBlock != null ? Math.max(0, Number(latestBlock) - blockNumber + 1) : null

    let timestamp: string | null = null
    try {
      const block = await client.getBlock({ blockNumber: receipt.blockNumber })
      timestamp = new Date(Number(block.timestamp) * 1000).toISOString()
    } catch { /* best-effort — omit timestamp if the block lookup fails */ }

    return {
      txHash, blockNumber, timestamp, confirmations,
      status: receipt.status === 'reverted' ? 'reverted' : 'success',
      explorerUrl,
    }
  } catch (e: any) {
    console.warn('[p2pChain] fetchTxChainInfo failed:', e?.message)
    return base
  }
}
