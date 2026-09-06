// supabase/functions/blockchain-indexer/bulkpayReconcile.test.ts
import { decodeBulkPayReceipt, runBulkpayReconciliation, MULTICALL3_ADDRESS } from './bulkpayReconcile.ts'
import type { RawReceipt, BulkPaymentWorklistRow } from './bulkpayReconcile.ts'
import type { BulkpayReconcileRepository, ArcReceiptFetcher } from './bulkpayReconcileRepository.ts'

function assert(cond: boolean, msg = ''): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}
function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed${msg ? `: ${msg}` : ''}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`)
  }
}

const CHAIN_ID = 'arc'
const NATIVE_LOG_CONTRACT = '0xfffffffffffffffffffffffffffffffffffffffe'
const EURC_CONTRACT = '0x89b50855aa3be2f677cd6303cec089b5f319d72a'
const TOKENS = [{ symbol: 'EURC', contract: EURC_CONTRACT, decimals: 6 }]
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const pad32 = (addr: string) => '0x' + addr.replace(/^0x/, '').padStart(64, '0')

// ── PHASE 4 — real transaction regression ───────────────────────────────
//
// Real facts, from docs/BULKPAY_INDEXER_FORENSIC_AUDIT.md and live
// production chain_events/activity data: tx 0xb179c4f0..., block 58592562,
// Multicall3 sender, recipient A (0xebe52519..., log_index 6, 10 USDC) --
// this row is REAL, taken verbatim from the actual chain_events row (id 125).
//
// Recipient B's log (0x9171d4f0..., 14 USDC) could NOT be independently
// fetched -- disclosed explicitly in docs/BULKPAY_INDEXER_FORENSIC_AUDIT.md's
// own "access limitation" section (no RPC/explorer access available in that
// investigation). Per this task's explicit instruction ("use a fixture
// based on an independently captured real receipt... clearly document that
// limitation"), recipient B's log below is RECONSTRUCTED from every real
// fact that IS known (real wallet address, real amount, real tx_hash, same
// contract/block as recipient A's real log) with log_index=7 assumed
// adjacent to recipient A's real log_index=6 -- NOT independently verified.
// This is disclosed here and in docs/BULKPAY_RECONCILIATION_IMPLEMENTATION.md,
// not presented as fully verified data.
const REAL_TX_HASH = '0xb179c4f0691199d5a1fdfc49d5086cf587f5440b13c768629a2913f7f783714c'
const RECIPIENT_A = '0xebe52519a38e857a744e65d01f23137e22fb784b' // REAL -- verbatim from chain_events id 125
const RECIPIENT_B = '0x9171d4f0d376019297d9598c33cdc6e92413f730' // REAL address (from activity), log RECONSTRUCTED (see above)

function realWorklistRow(): BulkPaymentWorklistRow {
  return { id: 'bp-1', tx_hash: REAL_TX_HASH, created_at: '2026-08-24T06:30:33Z', source: 'bulk_payments' as const }
}

function realBulkPayReceipt(): RawReceipt {
  return {
    transactionHash: REAL_TX_HASH,
    status: '0x1',
    to: MULTICALL3_ADDRESS,
    blockNumber: '0x37daf32', // 58592562
    logs: [
      { // REAL -- recipient A, verbatim shape from chain_events id 125
        address: NATIVE_LOG_CONTRACT,
        topics: [TRANSFER_TOPIC0, pad32(MULTICALL3_ADDRESS), pad32(RECIPIENT_A)],
        data: '0x' + (10_000_000_000_000_000_000n).toString(16), // 10 USDC, 18 decimals
        transactionHash: REAL_TX_HASH,
        blockNumber: '0x37daf32',
        logIndex: '0x6',
        blockHash: '0xRealBlockHash',
        transactionIndex: '0x2',
      },
      { // RECONSTRUCTED -- recipient B, per the disclosure above
        address: NATIVE_LOG_CONTRACT,
        topics: [TRANSFER_TOPIC0, pad32(MULTICALL3_ADDRESS), pad32(RECIPIENT_B)],
        data: '0x' + (14_000_000_000_000_000_000n).toString(16), // 14 USDC, 18 decimals
        transactionHash: REAL_TX_HASH,
        blockNumber: '0x37daf32',
        logIndex: '0x7',
        blockHash: '0xRealBlockHash',
        transactionIndex: '0x2',
      },
    ],
  }
}

Deno.test('PHASE 4: real BulkPay transaction -- both recipients decoded, neither depends on registration status', () => {
  const outcome = decodeBulkPayReceipt(realWorklistRow(), realBulkPayReceipt(), CHAIN_ID, NATIVE_LOG_CONTRACT, TOKENS)
  assertEquals(outcome.outcome, 'reconciled')
  if (outcome.outcome !== 'reconciled') return
  assertEquals(outcome.events.length, 2, 'both legs must be captured, including the unregistered recipient')
  const wallets = outcome.events.map(e => e.wallet_address).sort()
  assertEquals(wallets, [RECIPIENT_A, RECIPIENT_B].sort())
  const amounts = outcome.events.reduce((acc, e) => { acc[e.wallet_address] = (e.metadata as { amount: number }).amount; return acc }, {} as Record<string, number>)
  assertEquals(amounts[RECIPIENT_A], 10)
  assertEquals(amounts[RECIPIENT_B], 14)
  for (const e of outcome.events) {
    assertEquals(e.status, 'confirmed')
    assert(Object.keys(e).every(k => k !== 'is_registered' && k !== 'known_wallet'))
  }
})

// ── PHASE 5 -- SECURITY TESTS ─────────────────────────────────────────────

function makeFakeRepo(seedWorklist: BulkPaymentWorklistRow[] = []) {
  const worklist = [...seedWorklist]
  const inserted: Record<string, unknown>[] = []
  const verifiedIds: string[] = []
  const rawKey = (r: Record<string, unknown>) =>
    `${r.chain_id}:${String(r.tx_hash).toLowerCase()}:${r.log_index ?? -1}:${String(r.wallet_address).toLowerCase()}`

  const repo: BulkpayReconcileRepository = {
    findUnverifiedBulkPayments(_sinceIso) {
      return Promise.resolve(worklist)
    },
    findConfirmedBulkPayAttempts(_sinceIso) {
      return Promise.resolve([]) // empty by default -- existing tests target the bulk_payments source only; the merge/dedup itself is tested separately below
    },
    markVerified(row) {
      verifiedIds.push(row.id)
      return Promise.resolve()
    },
    insertChainEvent(row) {
      const key = rawKey(row)
      if (!inserted.some(r => rawKey(r) === key)) inserted.push(row)
      return Promise.resolve()
    },
  }
  return { repo, inserted, verifiedIds }
}

Deno.test('1. fake/unresolvable tx_hash produces zero chain_events', async () => {
  const worklistRow: BulkPaymentWorklistRow = { id: 'bp-fake', tx_hash: '0xFakeTxThatDoesNotExist', created_at: new Date().toISOString(), source: 'bulk_payments' }
  const { repo, inserted } = makeFakeRepo([worklistRow])
  const fetcher: ArcReceiptFetcher = { getTransactionReceipt() { return Promise.resolve(null) } }
  const results = await runBulkpayReconciliation(repo, fetcher, CHAIN_ID, NATIVE_LOG_CONTRACT, TOKENS, '2020-01-01T00:00:00Z')
  assertEquals(inserted.length, 0)
  assertEquals(results[0].outcome, 'not_found')
})

Deno.test('2/3. client-declared recipient data (activity/bulk_payments_received-shaped) has NO influence on the decoded output', () => {
  const fabricatedClaimWallet = '0xfabricatedattackeraddress'
  const receipt = realBulkPayReceipt()
  const outcome = decodeBulkPayReceipt(realWorklistRow(), receipt, CHAIN_ID, NATIVE_LOG_CONTRACT, TOKENS)
  assertEquals(outcome.outcome, 'reconciled')
  if (outcome.outcome !== 'reconciled') return
  assert(!outcome.events.some(e => e.wallet_address === fabricatedClaimWallet), 'a client-claimed address with no real log must never appear')
})

Deno.test('4/5. real tx with one registered + one unregistered recipient: BOTH captured, from receipt data alone', async () => {
  const { repo, inserted, verifiedIds } = makeFakeRepo([realWorklistRow()])
  const fetcher: ArcReceiptFetcher = { getTransactionReceipt() { return Promise.resolve(realBulkPayReceipt()) } }
  const results = await runBulkpayReconciliation(repo, fetcher, CHAIN_ID, NATIVE_LOG_CONTRACT, TOKENS, '2020-01-01T00:00:00Z')
  assertEquals(results[0].outcome, 'reconciled')
  assertEquals(results[0].eventsWritten, 2)
  assertEquals(inserted.length, 2)
  assertEquals(verifiedIds, ['bp-1'])
})

Deno.test('6. re-running reconciliation over the same worklist row is idempotent', async () => {
  const { repo, inserted } = makeFakeRepo([realWorklistRow()])
  const fetcher: ArcReceiptFetcher = { getTransactionReceipt() { return Promise.resolve(realBulkPayReceipt()) } }
  await runBulkpayReconciliation(repo, fetcher, CHAIN_ID, NATIVE_LOG_CONTRACT, TOKENS, '2020-01-01T00:00:00Z')
  const firstCount = inserted.length
  await runBulkpayReconciliation(repo, fetcher, CHAIN_ID, NATIVE_LOG_CONTRACT, TOKENS, '2020-01-01T00:00:00Z')
  assertEquals(inserted.length, firstCount, 'second pass must not add any new rows')
})

Deno.test('7. multiple logs in one real tx retain distinct log_index identity', () => {
  const outcome = decodeBulkPayReceipt(realWorklistRow(), realBulkPayReceipt(), CHAIN_ID, NATIVE_LOG_CONTRACT, TOKENS)
  assertEquals(outcome.outcome, 'reconciled')
  if (outcome.outcome !== 'reconciled') return
  const logIndexes = outcome.events.map(e => e.log_index)
  assertEquals(new Set(logIndexes).size, 2, 'log_index values must be distinct')
})

Deno.test('8. a real, confirmed, but non-Multicall3 transaction is rejected, not decoded', () => {
  const notBulkPay: RawReceipt = { ...realBulkPayReceipt(), to: '0xSomeOtherContractEntirely' }
  const outcome = decodeBulkPayReceipt(realWorklistRow(), notBulkPay, CHAIN_ID, NATIVE_LOG_CONTRACT, TOKENS)
  assertEquals(outcome.outcome, 'not_bulkpay')
})

Deno.test('8b. a reverted transaction produces zero events, regardless of what its logs contain', () => {
  const reverted: RawReceipt = { ...realBulkPayReceipt(), status: '0x0' }
  const outcome = decodeBulkPayReceipt(realWorklistRow(), reverted, CHAIN_ID, NATIVE_LOG_CONTRACT, TOKENS)
  assertEquals(outcome.outcome, 'reverted')
})

Deno.test('9. RPC failure leaves the row unverified (retryable), writes nothing', async () => {
  const { repo, inserted, verifiedIds } = makeFakeRepo([realWorklistRow()])
  const fetcher: ArcReceiptFetcher = { getTransactionReceipt() { return Promise.reject(new Error('simulated RPC timeout')) } }
  const results = await runBulkpayReconciliation(repo, fetcher, CHAIN_ID, NATIVE_LOG_CONTRACT, TOKENS, '2020-01-01T00:00:00Z')
  assertEquals(inserted.length, 0)
  assertEquals(verifiedIds.length, 0, 'a row that failed on RPC error must NOT be marked verified, so it is retried')
  assert((results[0].reason ?? '').includes('will retry'))
})

Deno.test('10. one row failing unexpectedly does not stop the rest of the batch, and the failed row stays unverified for retry', async () => {
  const rowA: BulkPaymentWorklistRow = { id: 'bp-a', tx_hash: '0xTxA', created_at: new Date().toISOString(), source: 'bulk_payments' }
  const rowB: BulkPaymentWorklistRow = { id: 'bp-b', tx_hash: REAL_TX_HASH, created_at: new Date().toISOString(), source: 'bulk_payments' }
  const { repo, inserted, verifiedIds } = makeFakeRepo([rowA, rowB])
  const failingRepo: BulkpayReconcileRepository = {
    ...repo,
    insertChainEvent(row) {
      if (row.tx_hash === '0xtxa') return Promise.reject(new Error('simulated insert failure for row A'))
      return repo.insertChainEvent(row)
    },
  }
  const fetcher: ArcReceiptFetcher = {
    getTransactionReceipt(txHash) {
      if (txHash === '0xTxA') return Promise.resolve({ transactionHash: '0xTxA', status: '0x1', to: MULTICALL3_ADDRESS, blockNumber: '0x1', logs: realBulkPayReceipt().logs.slice(0, 1).map(l => ({ ...l, transactionHash: '0xTxA' })) })
      return Promise.resolve(realBulkPayReceipt())
    },
  }
  const results = await runBulkpayReconciliation(failingRepo, fetcher, CHAIN_ID, NATIVE_LOG_CONTRACT, TOKENS, '2020-01-01T00:00:00Z')
  assert(!verifiedIds.includes('bp-a'), 'failed row must not be marked verified')
  assert(verifiedIds.includes('bp-b'), 'the OTHER row must still complete successfully despite row A failing')
  assertEquals(inserted.length, 2, "row B's 2 real events were still written")
  assert(results.some(r => r.bulkPaymentId === 'bp-a' && (r.reason ?? '').includes('will retry')))
})

// ── Second worklist source: transaction_attempts (Phase 5, closing the gap
// where a confirmed attempt has no corresponding bulk_payments row) ────────
Deno.test('merges the transaction_attempts source alongside bulk_payments, processing rows from both', async () => {
  const bulkPaymentsRow: BulkPaymentWorklistRow = { id: 'bp-x', tx_hash: '0xFromBulkPayments', created_at: new Date().toISOString(), source: 'bulk_payments' }
  const attemptRow: BulkPaymentWorklistRow = { id: 'attempt-y', tx_hash: REAL_TX_HASH, created_at: new Date().toISOString(), source: 'transaction_attempt' }
  const { repo, inserted, verifiedIds } = makeFakeRepo([bulkPaymentsRow])
  const repoWithAttempts: BulkpayReconcileRepository = {
    ...repo,
    findConfirmedBulkPayAttempts: () => Promise.resolve([attemptRow]),
  }
  const fetcher: ArcReceiptFetcher = {
    getTransactionReceipt(txHash) {
      if (txHash === '0xFromBulkPayments') return Promise.resolve({ ...realBulkPayReceipt(), transactionHash: '0xFromBulkPayments', logs: realBulkPayReceipt().logs.map(l => ({ ...l, transactionHash: '0xFromBulkPayments' })) })
      return Promise.resolve(realBulkPayReceipt())
    },
  }
  const results = await runBulkpayReconciliation(repoWithAttempts, fetcher, CHAIN_ID, NATIVE_LOG_CONTRACT, TOKENS, '2020-01-01T00:00:00Z')
  assertEquals(results.length, 2, 'both sources processed')
  assert(verifiedIds.includes('bp-x'))
  assert(verifiedIds.includes('attempt-y'))
  assertEquals(inserted.length, 4) // 2 events from each real transaction
})

Deno.test('deduplicates by tx_hash when both sources reference the SAME real transaction — processes it once, not twice', async () => {
  const bulkPaymentsRow: BulkPaymentWorklistRow = { id: 'bp-dup', tx_hash: REAL_TX_HASH, created_at: new Date().toISOString(), source: 'bulk_payments' }
  const attemptRow: BulkPaymentWorklistRow = { id: 'attempt-dup', tx_hash: REAL_TX_HASH, created_at: new Date().toISOString(), source: 'transaction_attempt' }
  const { repo, inserted, verifiedIds } = makeFakeRepo([bulkPaymentsRow])
  const repoWithAttempts: BulkpayReconcileRepository = {
    ...repo,
    findConfirmedBulkPayAttempts: () => Promise.resolve([attemptRow]),
  }
  const fetcher: ArcReceiptFetcher = { getTransactionReceipt: () => Promise.resolve(realBulkPayReceipt()) }
  const results = await runBulkpayReconciliation(repoWithAttempts, fetcher, CHAIN_ID, NATIVE_LOG_CONTRACT, TOKENS, '2020-01-01T00:00:00Z')
  assertEquals(results.length, 1, 'the same real tx_hash from both sources is processed exactly once')
  assert(verifiedIds.includes('bp-dup'), 'the bulk_payments-sourced row wins the dedup')
  assert(!verifiedIds.includes('attempt-dup'), 'the duplicate attempt-sourced row is never independently processed')
  assertEquals(inserted.length, 2) // not 4 -- processed once, not twice
})

// ── REAL BUG, found against a real production transaction, 2026-08-25 ────
// 0x517e432cb356e19b5e40f52b6f4c714966e07e4989c51f5d74aacfb01c364a39,
// a real 3-recipient BulkPay batch. Reconciliation against the REAL receipt
// produced 4 events, not 3 -- a spurious 4th leg at log_index 44 with
// wallet_address === Multicall3 itself (the payer's own deposit INTO
// Multicall3, before it forwards funds to the 3 real recipients). This is
// real receipt data (the native-transfer-log wrapper genuinely emits this
// log for every Multicall3 batch that funds itself via msg.value) --
// reconstructed here as a fixture using the real addresses/amounts/
// log_index values from this real transaction.
const REAL_TX_HASH_2 = '0x517e432cb356e19b5e40f52b6f4c714966e07e4989c51f5d74aacfb01c364a39'
const REAL_PAYER = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
const REAL_RECIPIENT_A2 = '0xebe52519a38e857a744e65d01f23137e22fb784b'
const REAL_RECIPIENT_B2 = '0x0634f842340bac0049b29db9955258252f2f406e'
const REAL_RECIPIENT_C2 = '0xfa2fd0dd67764dac6090f6f2506fc42c6c4be16e'

function realBulkPayReceiptWithMulticall3FundingLeg(): RawReceipt {
  return {
    transactionHash: REAL_TX_HASH_2,
    status: '0x1',
    to: MULTICALL3_ADDRESS,
    blockNumber: '0x37fe783', // 58755459, the real confirmed block number
    logs: [
      { // REAL -- the payer's own deposit INTO Multicall3 (log_index 44) -- must be excluded
        address: NATIVE_LOG_CONTRACT,
        topics: [TRANSFER_TOPIC0, pad32(REAL_PAYER), pad32(MULTICALL3_ADDRESS)],
        data: '0x' + (10_000_000_000_000_000_000n).toString(16),
        transactionHash: REAL_TX_HASH_2, blockNumber: '0x37fe783', logIndex: '0x2c', blockHash: '0xReal2', transactionIndex: '0x1',
      },
      { // REAL -- recipient A, 5 USDC, log_index 45
        address: NATIVE_LOG_CONTRACT,
        topics: [TRANSFER_TOPIC0, pad32(MULTICALL3_ADDRESS), pad32(REAL_RECIPIENT_A2)],
        data: '0x' + (5_000_000_000_000_000_000n).toString(16),
        transactionHash: REAL_TX_HASH_2, blockNumber: '0x37fe783', logIndex: '0x2d', blockHash: '0xReal2', transactionIndex: '0x1',
      },
      { // REAL -- recipient B, 2 USDC, log_index 46
        address: NATIVE_LOG_CONTRACT,
        topics: [TRANSFER_TOPIC0, pad32(MULTICALL3_ADDRESS), pad32(REAL_RECIPIENT_B2)],
        data: '0x' + (2_000_000_000_000_000_000n).toString(16),
        transactionHash: REAL_TX_HASH_2, blockNumber: '0x37fe783', logIndex: '0x2e', blockHash: '0xReal2', transactionIndex: '0x1',
      },
      { // REAL -- recipient C, 3 USDC, log_index 47
        address: NATIVE_LOG_CONTRACT,
        topics: [TRANSFER_TOPIC0, pad32(MULTICALL3_ADDRESS), pad32(REAL_RECIPIENT_C2)],
        data: '0x' + (3_000_000_000_000_000_000n).toString(16),
        transactionHash: REAL_TX_HASH_2, blockNumber: '0x37fe783', logIndex: '0x2f', blockHash: '0xReal2', transactionIndex: '0x1',
      },
    ],
  }
}

Deno.test('BUG FIX: the payer-into-Multicall3 funding leg (wallet === Multicall3) is excluded — only the 3 real recipient legs are decoded', () => {
  const worklistRow: BulkPaymentWorklistRow = { id: 'bp-real2', tx_hash: REAL_TX_HASH_2, created_at: new Date().toISOString(), source: 'bulk_payments' }
  const outcome = decodeBulkPayReceipt(worklistRow, realBulkPayReceiptWithMulticall3FundingLeg(), CHAIN_ID, NATIVE_LOG_CONTRACT, TOKENS)
  assertEquals(outcome.outcome, 'reconciled')
  if (outcome.outcome !== 'reconciled') return
  assertEquals(outcome.events.length, 3, 'exactly 3 real recipients, never the 4th Multicall3-funding leg')
  assert(!outcome.events.some(e => e.wallet_address === MULTICALL3_ADDRESS), 'Multicall3 must never appear as a chain_event wallet_address')
  const byWallet = Object.fromEntries(outcome.events.map(e => [e.wallet_address, (e.metadata as any).amount]))
  assertEquals(byWallet[REAL_RECIPIENT_A2], 5)
  assertEquals(byWallet[REAL_RECIPIENT_B2], 2)
  assertEquals(byWallet[REAL_RECIPIENT_C2], 3)
  const total = outcome.events.reduce((s, e) => s + (e.metadata as any).amount, 0)
  assertEquals(total, 10, 'total credited to real recipients matches the real 10 USDC batch')
})
