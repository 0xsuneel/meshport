// supabase/functions/blockchain-indexer/swapReconcile.test.ts
import { decodeSwapCreditLeg, runSwapReconciliation } from './swapReconcile.ts'
import type { SwapWorklistRow, RawReceiptWithLogs, SwapReconcileRepository, SwapReceiptFetcher } from './swapReconcile.ts'
import { TRANSFER_TOPIC0 } from './decodeTransferLog.ts'

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed${msg ? `: ${msg}` : ''}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`)
  }
}

const WALLET = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
const KIT_ADAPTER = '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b'
const OTHER_USER_WALLET = '0x9171d4f0d376019297d9598c33cdc6e92413f730'
const EURC_CONTRACT = '0x89b50855aa3be2f677cd6303cec089b5f319d72a'
const NATIVE_TRANSFER_LOG_CONTRACT = '0xfffffffffffffffffffffffffffffffffffffffe'
const TX_HASH = '0xswaptxhash00000000000000000000000000000000000000000000000000'

const TOKENS = [
  { symbol: 'EURC', contract: EURC_CONTRACT, decimals: 6 },
  { symbol: 'cirBTC', contract: '0xf0c4a4ce82a5746abaad9425360ab04fbba432bf', decimals: 8 },
]

function pad32(addr: string): string { return '0x' + '0'.repeat(24) + addr.replace('0x', '').toLowerCase() }

function row(overrides: Partial<SwapWorklistRow> = {}): SwapWorklistRow {
  return { attemptId: 'attempt-1', intentId: 'intent-1', txHash: TX_HASH, chainId: 'arc', walletAddress: WALLET, ...overrides }
}

Deno.test('ERC20 output: Kit Adapter -> wallet Transfer log is reconciled as the SWAP_CREDIT leg with the real log_index preserved', () => {
  const receipt: RawReceiptWithLogs = {
    transactionHash: TX_HASH, status: '0x1', blockNumber: '0x38000000',
    logs: [{
      address: EURC_CONTRACT, topics: [TRANSFER_TOPIC0, pad32(KIT_ADAPTER), pad32(WALLET)],
      data: '0x' + (6_000_000n).toString(16),
      transactionHash: TX_HASH, blockNumber: '0x38000000', logIndex: '0x7', blockHash: '0xReal', transactionIndex: '0x2',
    }],
  }
  const outcome = decodeSwapCreditLeg(row(), receipt, KIT_ADAPTER, NATIVE_TRANSFER_LOG_CONTRACT, TOKENS)
  assertEquals(outcome.outcome, 'reconciled')
  if (outcome.outcome !== 'reconciled') return
  assertEquals(outcome.event.wallet_address, WALLET)
  assertEquals(outcome.event.event_type, 'transfer_detected')
  assertEquals(outcome.event.log_index, 7)
  assertEquals((outcome.event.metadata as any).amount, 6)
  assertEquals((outcome.event.metadata as any).from, KIT_ADAPTER)
})

Deno.test('Native output: Kit Adapter -> wallet native-transfer-log Transfer is reconciled as deposit_detected', () => {
  const receipt: RawReceiptWithLogs = {
    transactionHash: TX_HASH, status: '0x1', blockNumber: '0x38000000',
    logs: [{
      address: NATIVE_TRANSFER_LOG_CONTRACT, topics: [TRANSFER_TOPIC0, pad32(KIT_ADAPTER), pad32(WALLET)],
      data: '0x' + (5_000_000_000_000_000_000n).toString(16), // 5.0 at 18 decimals
      transactionHash: TX_HASH, blockNumber: '0x38000000', logIndex: '0x3', blockHash: '0xReal', transactionIndex: '0x1',
    }],
  }
  const outcome = decodeSwapCreditLeg(row(), receipt, KIT_ADAPTER, NATIVE_TRANSFER_LOG_CONTRACT, TOKENS)
  assertEquals(outcome.outcome, 'reconciled')
  if (outcome.outcome !== 'reconciled') return
  assertEquals(outcome.event.event_type, 'deposit_detected')
  assertEquals(outcome.event.log_index, 3)
  assertEquals((outcome.event.metadata as any).amount, 5)
})

Deno.test('CRITICAL: a Kit Adapter -> DIFFERENT wallet Transfer (someone else\'s swap output) is never attributed to this attempt\'s wallet', () => {
  const receipt: RawReceiptWithLogs = {
    transactionHash: TX_HASH, status: '0x1', blockNumber: '0x1',
    logs: [{
      address: EURC_CONTRACT, topics: [TRANSFER_TOPIC0, pad32(KIT_ADAPTER), pad32(OTHER_USER_WALLET)],
      data: '0x1', transactionHash: TX_HASH, blockNumber: '0x1', logIndex: '0x1', blockHash: '0x1', transactionIndex: '0x1',
    }],
  }
  const outcome = decodeSwapCreditLeg(row({ walletAddress: WALLET }), receipt, KIT_ADAPTER, NATIVE_TRANSFER_LOG_CONTRACT, TOKENS)
  assertEquals(outcome.outcome, 'no_credit_leg_found')
})

Deno.test('CRITICAL: a Transfer FROM some other address TO this wallet (not the Kit Adapter) is never treated as a swap output', () => {
  const receipt: RawReceiptWithLogs = {
    transactionHash: TX_HASH, status: '0x1', blockNumber: '0x1',
    logs: [{
      address: EURC_CONTRACT, topics: [TRANSFER_TOPIC0, pad32(OTHER_USER_WALLET), pad32(WALLET)],
      data: '0x1', transactionHash: TX_HASH, blockNumber: '0x1', logIndex: '0x1', blockHash: '0x1', transactionIndex: '0x1',
    }],
  }
  const outcome = decodeSwapCreditLeg(row(), receipt, KIT_ADAPTER, NATIVE_TRANSFER_LOG_CONTRACT, TOKENS)
  assertEquals(outcome.outcome, 'no_credit_leg_found')
})

Deno.test('reverted receipt -> reverted, no chain_event ever produced for a failed swap', () => {
  const receipt: RawReceiptWithLogs = { transactionHash: TX_HASH, status: '0x0', blockNumber: '0x1', logs: [] }
  const outcome = decodeSwapCreditLeg(row(), receipt, KIT_ADAPTER, NATIVE_TRANSFER_LOG_CONTRACT, TOKENS)
  assertEquals(outcome.outcome, 'reverted')
})

Deno.test('receipt tx_hash mismatch vs worklist tx_hash -> not_found, never decoded', () => {
  const receipt: RawReceiptWithLogs = { transactionHash: '0xDifferentHash', status: '0x1', blockNumber: '0x1', logs: [] }
  const outcome = decodeSwapCreditLeg(row(), receipt, KIT_ADAPTER, NATIVE_TRANSFER_LOG_CONTRACT, TOKENS)
  assertEquals(outcome.outcome, 'not_found')
})

Deno.test('mint transfer (from zero address) is never treated as a Kit Adapter credit even if it lands at this wallet', () => {
  const ZERO = '0x' + '0'.repeat(40)
  const receipt: RawReceiptWithLogs = {
    transactionHash: TX_HASH, status: '0x1', blockNumber: '0x1',
    logs: [{
      address: EURC_CONTRACT, topics: [TRANSFER_TOPIC0, pad32(ZERO), pad32(WALLET)],
      data: '0x1', transactionHash: TX_HASH, blockNumber: '0x1', logIndex: '0x1', blockHash: '0x1', transactionIndex: '0x1',
    }],
  }
  const outcome = decodeSwapCreditLeg(row(), receipt, KIT_ADAPTER, NATIVE_TRANSFER_LOG_CONTRACT, TOKENS)
  assertEquals(outcome.outcome, 'no_credit_leg_found')
})

Deno.test('multiple internal legs in one receipt: only the leg that pays THIS wallet from the Kit Adapter is picked', () => {
  const receipt: RawReceiptWithLogs = {
    transactionHash: TX_HASH, status: '0x1', blockNumber: '0x1',
    logs: [
      // An intermediate pool-routing leg, not this wallet -- must be skipped.
      { address: EURC_CONTRACT, topics: [TRANSFER_TOPIC0, pad32('0x1111111111111111111111111111111111111a'), pad32(KIT_ADAPTER)], data: '0x1', transactionHash: TX_HASH, blockNumber: '0x1', logIndex: '0x2', blockHash: '0x1', transactionIndex: '0x1' },
      // The real leg: Kit Adapter -> this wallet.
      { address: EURC_CONTRACT, topics: [TRANSFER_TOPIC0, pad32(KIT_ADAPTER), pad32(WALLET)], data: '0x' + (1_000_000n).toString(16), transactionHash: TX_HASH, blockNumber: '0x1', logIndex: '0x5', blockHash: '0x1', transactionIndex: '0x1' },
    ],
  }
  const outcome = decodeSwapCreditLeg(row(), receipt, KIT_ADAPTER, NATIVE_TRANSFER_LOG_CONTRACT, TOKENS)
  assertEquals(outcome.outcome, 'reconciled')
  if (outcome.outcome !== 'reconciled') return
  assertEquals(outcome.event.log_index, 5)
})

function makeFakeRepo(worklist: SwapWorklistRow[], alreadyCovered: Set<string> = new Set()) {
  const inserted: Record<string, unknown>[] = []
  const reconciledIds: string[] = []
  const repo: SwapReconcileRepository = {
    findConfirmedUnreconciledSwapAttempts: () => Promise.resolve(worklist),
    markReconciled: (attemptId) => { reconciledIds.push(attemptId); return Promise.resolve() },
    insertChainEvent: (r) => { inserted.push(r); return Promise.resolve() },
    chainEventAlreadyExists: (chainId, txHash, walletAddress) => Promise.resolve(alreadyCovered.has(`${chainId}:${txHash}:${walletAddress}`)),
  }
  return { repo, inserted, reconciledIds }
}

Deno.test('sweep: a genuine confirmed swap attempt is reconciled into exactly one chain_event', async () => {
  const worklist = [row()]
  const { repo, inserted, reconciledIds } = makeFakeRepo(worklist)
  const fetcher: SwapReceiptFetcher = {
    getReceipt: () => Promise.resolve({
      transactionHash: TX_HASH, status: '0x1', blockNumber: '0x1',
      logs: [{ address: EURC_CONTRACT, topics: [TRANSFER_TOPIC0, pad32(KIT_ADAPTER), pad32(WALLET)], data: '0x' + (1_000_000n).toString(16), transactionHash: TX_HASH, blockNumber: '0x1', logIndex: '0x1', blockHash: '0x1', transactionIndex: '0x1' }],
    }),
  }
  const results = await runSwapReconciliation(repo, fetcher, KIT_ADAPTER, NATIVE_TRANSFER_LOG_CONTRACT, TOKENS, new Date(0).toISOString())
  assertEquals(results[0].outcome, 'reconciled')
  assertEquals(inserted.length, 1)
  assertEquals(reconciledIds, ['attempt-1'])
})

Deno.test('idempotent: an attempt whose chain_event already exists is skipped, not duplicated', async () => {
  const worklist = [row()]
  const { repo, inserted } = makeFakeRepo(worklist, new Set([`arc:${TX_HASH}:${WALLET}`]))
  const fetcher: SwapReceiptFetcher = { getReceipt: () => Promise.reject(new Error('should never be called')) }
  const results = await runSwapReconciliation(repo, fetcher, KIT_ADAPTER, NATIVE_TRANSFER_LOG_CONTRACT, TOKENS, new Date(0).toISOString())
  assertEquals(results[0].outcome, 'already_covered')
  assertEquals(inserted.length, 0)
})

Deno.test('one attempt failing does not stop the rest of the batch', async () => {
  const worklist = [row({ attemptId: 'a', txHash: '0xBad' }), row({ attemptId: 'b' })]
  const { repo, reconciledIds } = makeFakeRepo(worklist)
  const fetcher: SwapReceiptFetcher = {
    getReceipt: (txHash) => txHash === '0xBad'
      ? Promise.reject(new Error('boom'))
      : Promise.resolve({
          transactionHash: TX_HASH, status: '0x1', blockNumber: '0x1',
          logs: [{ address: EURC_CONTRACT, topics: [TRANSFER_TOPIC0, pad32(KIT_ADAPTER), pad32(WALLET)], data: '0x1', transactionHash: TX_HASH, blockNumber: '0x1', logIndex: '0x1', blockHash: '0x1', transactionIndex: '0x1' }],
        }),
  }
  const results = await runSwapReconciliation(repo, fetcher, KIT_ADAPTER, NATIVE_TRANSFER_LOG_CONTRACT, TOKENS, new Date(0).toISOString())
  assertEquals(results.find(r => r.attemptId === 'a')?.outcome, 'not_found')
  assertEquals(results.find(r => r.attemptId === 'b')?.outcome, 'reconciled')
  // The failing one is a retryable RPC error -- never marked reconciled.
  assertEquals(reconciledIds.includes('a'), false)
  assertEquals(reconciledIds.includes('b'), true)
})
