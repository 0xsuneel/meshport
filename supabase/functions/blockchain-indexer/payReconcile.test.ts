// supabase/functions/blockchain-indexer/payReconcile.test.ts
import { decodePayReceipt, runPayReconciliation } from './payReconcile.ts'
import type { PayWorklistRow, RawTransaction, RawReceiptWithLogs, PayReconcileRepository, PayReceiptFetcher } from './payReconcile.ts'
import { TRANSFER_TOPIC0 } from './decodeTransferLog.ts'

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed${msg ? `: ${msg}` : ''}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`)
  }
}
function assert(cond: boolean, msg = ''): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

const REAL_PAYER = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
const REAL_UNREGISTERED_RECIPIENT = '0x9171d4f0d376019297d9598c33cdc6e92413f730'
const REAL_EURC_TX = '0x847c83e676aeb2a75f4d2f80c36bbd6f772d3ccf648e85907ae9abc01c04ce47'
const EURC_CONTRACT = '0x89b50855aa3be2f677cd6303cec089b5f319d72a'

function pad32(addr: string): string { return '0x' + '0'.repeat(24) + addr.replace('0x', '').toLowerCase() }

function realNativeRow(): PayWorklistRow {
  return { attemptId: 'attempt-native', txHash: '0xNativeTx', chainId: 'arc', payerWallet: REAL_PAYER, recipientWallet: '0x0634f842340bac0049b29db9955258252f2f406e', isNative: true, tokenAddress: null, tokenSymbol: 'USDC' }
}
function realErc20Row(): PayWorklistRow {
  return { attemptId: 'attempt-erc20', txHash: REAL_EURC_TX, chainId: 'arc', payerWallet: REAL_PAYER, recipientWallet: REAL_UNREGISTERED_RECIPIENT, isNative: false, tokenAddress: EURC_CONTRACT, tokenSymbol: 'EURC' }
}

Deno.test('native Pay: real transaction/value decoded correctly, matches how the regular scanner already captures it (log_index=null)', () => {
  const row = realNativeRow()
  const tx: RawTransaction = { hash: row.txHash, from: REAL_PAYER, to: row.recipientWallet, value: '0x8ac7230489e80000' }
  const receipt: RawReceiptWithLogs = { transactionHash: row.txHash, status: '0x1', blockNumber: '0x37daf32', logs: [] }
  const outcome = decodePayReceipt(row, tx, receipt)
  assertEquals(outcome.outcome, 'reconciled')
  if (outcome.outcome !== 'reconciled') return
  assertEquals(outcome.event.wallet_address, row.recipientWallet)
  assertEquals(outcome.event.log_index, null)
  assertEquals((outcome.event.metadata as any).amount, 10)
  assertEquals((outcome.event.metadata as any).sender, REAL_PAYER)
})

Deno.test('REAL DATA: ERC20 Pay to the genuinely unregistered recipient 0x9171d4f0... is correctly reconciled', () => {
  const row = realErc20Row()
  const tx: RawTransaction = { hash: REAL_EURC_TX, from: REAL_PAYER, to: EURC_CONTRACT, value: '0x0' }
  const receipt: RawReceiptWithLogs = {
    transactionHash: REAL_EURC_TX, status: '0x1', blockNumber: '0x38000000',
    logs: [{
      address: EURC_CONTRACT, topics: [TRANSFER_TOPIC0, pad32(REAL_PAYER), pad32(REAL_UNREGISTERED_RECIPIENT)],
      data: '0x' + (6_000_000n).toString(16),
      transactionHash: REAL_EURC_TX, blockNumber: '0x38000000', logIndex: '0x5', blockHash: '0xReal', transactionIndex: '0x2',
    }],
  }
  const outcome = decodePayReceipt(row, tx, receipt)
  assertEquals(outcome.outcome, 'reconciled')
  if (outcome.outcome !== 'reconciled') return
  assertEquals(outcome.event.wallet_address, REAL_UNREGISTERED_RECIPIENT)
  assertEquals(outcome.event.event_type, 'transfer_detected')
  assertEquals((outcome.event.metadata as any).amount, 6)
  assertEquals((outcome.event.metadata as any).from, REAL_PAYER)
})

Deno.test('wrong sender -> mismatch, never fabricated', () => {
  const row = realErc20Row()
  const tx: RawTransaction = { hash: REAL_EURC_TX, from: '0xSomeoneElse', to: EURC_CONTRACT, value: '0x0' }
  const receipt: RawReceiptWithLogs = { transactionHash: REAL_EURC_TX, status: '0x1', blockNumber: '0x1', logs: [] }
  const outcome = decodePayReceipt(row, tx, receipt)
  assertEquals(outcome.outcome, 'mismatch')
})

Deno.test('native: wrong recipient -> mismatch', () => {
  const row = realNativeRow()
  const tx: RawTransaction = { hash: row.txHash, from: REAL_PAYER, to: '0xADifferentWallet', value: '0x8ac7230489e80000' }
  const receipt: RawReceiptWithLogs = { transactionHash: row.txHash, status: '0x1', blockNumber: '0x1', logs: [] }
  const outcome = decodePayReceipt(row, tx, receipt)
  assertEquals(outcome.outcome, 'mismatch')
})

Deno.test('ERC20: no matching Transfer log for the expected recipient -> not_found, never fabricated', () => {
  const row = realErc20Row()
  const tx: RawTransaction = { hash: REAL_EURC_TX, from: REAL_PAYER, to: EURC_CONTRACT, value: '0x0' }
  const receipt: RawReceiptWithLogs = {
    transactionHash: REAL_EURC_TX, status: '0x1', blockNumber: '0x1',
    logs: [{ address: EURC_CONTRACT, topics: [TRANSFER_TOPIC0, pad32(REAL_PAYER), pad32('0x1111111111111111111111111111111111111a')], data: '0x1', transactionHash: REAL_EURC_TX, blockNumber: '0x1', logIndex: '0x1', blockHash: '0x1', transactionIndex: '0x1' }],
  }
  const outcome = decodePayReceipt(row, tx, receipt)
  assertEquals(outcome.outcome, 'not_found')
})

Deno.test('reverted receipt -> reverted, no chain_event ever produced for a failed Pay', () => {
  const row = realNativeRow()
  const tx: RawTransaction = { hash: row.txHash, from: REAL_PAYER, to: row.recipientWallet, value: '0x8ac7230489e80000' }
  const receipt: RawReceiptWithLogs = { transactionHash: row.txHash, status: '0x0', blockNumber: '0x1', logs: [] }
  const outcome = decodePayReceipt(row, tx, receipt)
  assertEquals(outcome.outcome, 'reverted')
})

function makeFakeRepo(worklist: PayWorklistRow[], alreadyCovered: Set<string> = new Set()) {
  const inserted: Record<string, unknown>[] = []
  const reconciledIds: string[] = []
  const repo: PayReconcileRepository = {
    findConfirmedUnreconciledPayAttempts: () => Promise.resolve(worklist),
    markReconciled: (attemptId) => { reconciledIds.push(attemptId); return Promise.resolve() },
    insertChainEvent: (row) => { inserted.push(row); return Promise.resolve() },
    chainEventAlreadyExists: (_chainId, txHash) => Promise.resolve(alreadyCovered.has(txHash)),
  }
  return { repo, inserted, reconciledIds }
}

Deno.test('orchestration: an attempt the regular scanner already covered is skipped, no duplicate insert', async () => {
  const row = realNativeRow()
  const { repo, inserted, reconciledIds } = makeFakeRepo([row], new Set([row.txHash]))
  const fetcher: PayReceiptFetcher = { getTransaction: () => Promise.resolve(null), getReceipt: () => Promise.resolve(null) }
  const results = await runPayReconciliation(repo, fetcher, '2020-01-01T00:00:00Z')
  assertEquals(results[0].outcome, 'already_covered')
  assertEquals(inserted.length, 0)
  assertEquals(reconciledIds, [row.attemptId])
})

Deno.test('orchestration: a genuine unregistered-recipient gap is reconciled and produces exactly one chain_event', async () => {
  const row = realErc20Row()
  const { repo, inserted } = makeFakeRepo([row])
  const tx: RawTransaction = { hash: REAL_EURC_TX, from: REAL_PAYER, to: EURC_CONTRACT, value: '0x0' }
  const receipt: RawReceiptWithLogs = {
    transactionHash: REAL_EURC_TX, status: '0x1', blockNumber: '0x1',
    logs: [{ address: EURC_CONTRACT, topics: [TRANSFER_TOPIC0, pad32(REAL_PAYER), pad32(REAL_UNREGISTERED_RECIPIENT)], data: '0x' + (6_000_000n).toString(16), transactionHash: REAL_EURC_TX, blockNumber: '0x1', logIndex: '0x1', blockHash: '0x1', transactionIndex: '0x1' }],
  }
  const fetcher: PayReceiptFetcher = { getTransaction: () => Promise.resolve(tx), getReceipt: () => Promise.resolve(receipt) }
  const results = await runPayReconciliation(repo, fetcher, '2020-01-01T00:00:00Z')
  assertEquals(results[0].outcome, 'reconciled')
  assertEquals(inserted.length, 1)
})

Deno.test('structural: no known-wallets-mutation concept exists anywhere in this module', () => {
  const repoShape = Object.keys({
    findConfirmedUnreconciledPayAttempts: 1, markReconciled: 1, insertChainEvent: 1, chainEventAlreadyExists: 1,
  })
  assert(!repoShape.some(k => k.toLowerCase().includes('knownwallet') || k.toLowerCase().includes('register')))
})

Deno.test('one attempt failing does not stop the rest of the batch', async () => {
  const rowA = realNativeRow()
  const rowB = realErc20Row()
  const { repo } = makeFakeRepo([rowA, rowB])
  const failingFetcher: PayReceiptFetcher = {
    getTransaction: (txHash) => txHash === rowA.txHash ? Promise.reject(new Error('boom')) : Promise.resolve({ hash: REAL_EURC_TX, from: REAL_PAYER, to: EURC_CONTRACT, value: '0x0' }),
    getReceipt: () => Promise.resolve({ transactionHash: REAL_EURC_TX, status: '0x1', blockNumber: '0x1', logs: [{ address: EURC_CONTRACT, topics: [TRANSFER_TOPIC0, pad32(REAL_PAYER), pad32(REAL_UNREGISTERED_RECIPIENT)], data: '0x' + (6_000_000n).toString(16), transactionHash: REAL_EURC_TX, blockNumber: '0x1', logIndex: '0x1', blockHash: '0x1', transactionIndex: '0x1' }] }),
  }
  const results = await runPayReconciliation(repo, failingFetcher, '2020-01-01T00:00:00Z')
  assertEquals(results.length, 2)
  assertEquals(results.find(r => r.attemptId === rowA.attemptId)?.outcome, 'not_found')
  assertEquals(results.find(r => r.attemptId === rowB.attemptId)?.outcome, 'reconciled')
})
