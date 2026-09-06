// supabase/functions/blockchain-indexer/decodeTransferLog.ts
//
// Pure Transfer-log decoding, extracted from scanner.ts's native-transfer-log
// and ERC-20 log branches (docs/BULKPAY_RECONCILIATION_IMPLEMENTATION.md).
//
// This is PARSING ONLY — it does not apply knownWallets filtering, mint
// exclusion, or self-transfer exclusion. Those remain each CALLER's own
// decision:
//   - scanner.ts's main scan loops keep applying knownWallets/mint/self-
//     transfer filtering exactly as before, now via this shared function
//     for the parsing step only — behavior is unchanged, confirmed by the
//     full existing scanner.test.ts suite staying green.
//   - bulkpayReconcile.ts (new) applies mint/self-transfer filtering but
//     deliberately NEVER applies knownWallets filtering — that is the
//     entire point of the BulkPay reconciliation path (docs/
//     BULKPAY_INTENT_SCOPED_WATCH_DESIGN.md §4): a registered-recipient
//     requirement would silently reproduce the exact gap this module exists
//     to close.
//
// No behavior change to the existing indexer is intended or expected from
// this extraction — every existing scanner.test.ts assertion must still
// pass unmodified after scanner.ts is refactored to call this function.

const MINT_FROM_TOPIC = '0x' + '0'.repeat(64)

/**
 * keccak256("Transfer(address,address,uint256)") — the standard ERC-20/native-
 * transfer-log event signature. Exported here so bulkpayReconcile.ts (which
 * needs to filter a transaction receipt's logs down to just the Transfer-
 * shaped ones before decoding) doesn't need its own copy — scanner.ts also
 * has this exact constant inline (used only for eth_getLogs filter
 * construction, unrelated to decoding) and is left untouched rather than
 * refactored to import it, to keep this change minimal. A public, immutable
 * constant — safe to have in two places, same reasoning already accepted for
 * the token contract addresses duplicated elsewhere in this codebase.
 */
export const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/** Decodes a 32-byte, left-zero-padded indexed address topic. Same fixed-width `slice(-40)` scanner.ts already uses. */
function topicToAddress(topic: string | undefined | null): string {
  if (!topic) return ''
  return ('0x' + topic.slice(-40)).toLowerCase()
}

export interface DecodedTransferLog {
  /** The recipient (`to`) address, decoded from topics[2]. */
  wallet: string
  /** The sender (`from`) address, decoded from topics[1]. */
  from: string
  /** The raw, undecoded sender topic — needed for the exact mint check (see isMintTransfer). */
  fromTopic: string
  amount: number
  txHash: string
  blockNumber: number
  logIndex: number | null
  blockHash: string | null
  transactionIndex: number | null
  contractAddress: string
}

/**
 * Decodes one raw eth_getLogs Transfer-topic log entry. Returns null for any
 * log this can't safely interpret (no recipient, unparseable amount, zero/
 * negative amount) — the exact same "silently skip, never throw" contract
 * scanner.ts's inline versions already had, just centralized.
 *
 * Deliberately does NOT check knownWallets, mint-sender, or self-transfer —
 * see this file's header for why those stay with the caller.
 */
export function decodeTransferLog(
  log: { topics?: string[]; data?: string; transactionHash?: string; blockNumber?: string | number; logIndex?: string | number; blockHash?: string; transactionIndex?: string | number },
  decimals: number,
  contractAddress: string,
): DecodedTransferLog | null {
  const fromTopic = (log.topics?.[1] ?? '') as string
  const wallet = topicToAddress(log.topics?.[2])
  const from = topicToAddress(fromTopic)
  if (!wallet) return null

  let amount: number
  try {
    amount = Number(BigInt(log.data ?? '0x0')) / 10 ** decimals
  } catch {
    return null
  }
  if (!Number.isFinite(amount) || amount <= 0) return null

  return {
    wallet,
    from,
    fromTopic,
    amount,
    txHash: (log.transactionHash ?? '').toLowerCase(),
    blockNumber: Number(BigInt(log.blockNumber ?? 0)),
    logIndex: log.logIndex != null ? Number(BigInt(log.logIndex)) : null,
    blockHash: (log.blockHash as string | undefined)?.toLowerCase() ?? null,
    transactionIndex: log.transactionIndex != null ? Number(BigInt(log.transactionIndex)) : null,
    contractAddress,
  }
}

/** True if the decoded log's sender is the zero address (a mint — CCTP claim territory, never a generic transfer). */
export function isMintTransfer(decoded: Pick<DecodedTransferLog, 'fromTopic'>): boolean {
  return decoded.fromTopic.toLowerCase() === MINT_FROM_TOPIC
}

/** True if sender and recipient are the same address (not a real transfer). */
export function isSelfTransfer(decoded: Pick<DecodedTransferLog, 'wallet' | 'from'>): boolean {
  return decoded.from === decoded.wallet
}
