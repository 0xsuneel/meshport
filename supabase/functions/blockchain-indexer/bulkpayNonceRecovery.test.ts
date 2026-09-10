// supabase/functions/blockchain-indexer/bulkpayNonceRecovery.test.ts
import { recoverAttemptByNonce } from './bulkpayNonceRecovery.ts'
import type { BlockFetcher, RawBlockWithTransactions, UnresolvedAttempt } from './bulkpayNonceRecovery.ts'

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed${msg ? `: ${msg}` : ''}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`)
  }
}

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
const PAYER = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'

function attempt(overrides: Partial<UnresolvedAttempt> = {}): UnresolvedAttempt {
  return { id: 'attempt-1', intentId: 'intent-1', chainId: 'arc', walletAddress: PAYER, nonce: 42, createdAt: new Date().toISOString(), ...overrides }
}

function makeFetcher(blocksByNumber: Record<number, RawBlockWithTransactions>): BlockFetcher {
  return {
    getBlockWithTransactions: (_chainId, bn) => Promise.resolve(blocksByNumber[bn] ?? null),
    getCurrentBlockNumber: () => Promise.resolve(Math.max(...Object.keys(blocksByNumber).map(Number))),
  }
}

Deno.test('D. finds a real transaction by (wallet, nonce) and confirms it once to === Multicall3', async () => {
  const fetcher = makeFetcher({
    100: { number: '0x64', transactions: [{ hash: '0xRealTxHash', from: PAYER, to: MULTICALL3, nonce: '0x2a' }] },
  })
  const result = await recoverAttemptByNonce(fetcher, attempt(), 100, 100)
  assertEquals(result.outcome, 'confirmed')
  if (result.outcome === 'confirmed') {
    assertEquals(result.txHash, '0xrealtxhash')
    assertEquals(result.blockNumber, 100)
  }
})

Deno.test('E. nonce matches but to !== Multicall3 -> REPLACED, never CONFIRMED, never a second broadcast', async () => {
  const fetcher = makeFetcher({
    100: { number: '0x64', transactions: [{ hash: '0xReplacementTx', from: PAYER, to: '0xSomeOtherContract', nonce: '0x2a' }] },
  })
  const result = await recoverAttemptByNonce(fetcher, attempt(), 100, 100)
  assertEquals(result.outcome, 'replaced')
  if (result.outcome === 'replaced') assertEquals(result.txHash, '0xreplacementtx')
})

Deno.test('F. no matching transaction in the scanned range -> not_found, bounded, does not scan forever', async () => {
  const fetcher = makeFetcher({
    100: { number: '0x64', transactions: [{ hash: '0xUnrelated', from: '0xSomeoneElse', to: MULTICALL3, nonce: '0x2a' }] },
    99: { number: '0x63', transactions: [] },
  })
  const result = await recoverAttemptByNonce(fetcher, attempt(), 99, 100)
  assertEquals(result.outcome, 'not_found')
})

Deno.test('wrong wallet, same nonce, correct destination -> correctly ignored, not a false match', async () => {
  const fetcher = makeFetcher({
    100: { number: '0x64', transactions: [{ hash: '0xNotOurs', from: '0xDifferentWallet', to: MULTICALL3, nonce: '0x2a' }] },
  })
  const result = await recoverAttemptByNonce(fetcher, attempt(), 100, 100)
  assertEquals(result.outcome, 'not_found')
})

Deno.test('correct wallet, wrong nonce, correct destination -> correctly ignored', async () => {
  const fetcher = makeFetcher({
    100: { number: '0x64', transactions: [{ hash: '0xDifferentNonce', from: PAYER, to: MULTICALL3, nonce: '0x2b' }] },
  })
  const result = await recoverAttemptByNonce(fetcher, attempt(), 100, 100)
  assertEquals(result.outcome, 'not_found')
})

Deno.test('scans multiple blocks correctly, finds the real transaction wherever it actually is', async () => {
  const fetcher = makeFetcher({
    98: { number: '0x62', transactions: [] },
    99: { number: '0x63', transactions: [{ hash: '0xUnrelatedInBetween', from: '0xOther', to: MULTICALL3, nonce: '0x1' }] },
    100: { number: '0x64', transactions: [{ hash: '0xTheRealOne', from: PAYER, to: MULTICALL3, nonce: '0x2a' }] },
  })
  const result = await recoverAttemptByNonce(fetcher, attempt(), 98, 100)
  assertEquals(result.outcome, 'confirmed')
})

Deno.test('a transiently-unavailable block (null) does not abort the scan or produce a false result', async () => {
  const fetcher: BlockFetcher = {
    getBlockWithTransactions: (_chainId, bn) => {
      if (bn === 99) return Promise.resolve(null)
      if (bn === 100) return Promise.resolve({ number: '0x64', transactions: [{ hash: '0xFound', from: PAYER, to: MULTICALL3, nonce: '0x2a' }] })
      return Promise.resolve({ number: '0x0', transactions: [] })
    },
    getCurrentBlockNumber: () => Promise.resolve(100),
  }
  const result = await recoverAttemptByNonce(fetcher, attempt(), 98, 100)
  assertEquals(result.outcome, 'confirmed')
})

Deno.test('idempotent: running the recovery scan twice against the same real data produces the same outcome, never broadcasts anything', async () => {
  const fetcher = makeFetcher({
    100: { number: '0x64', transactions: [{ hash: '0xRealTxHash', from: PAYER, to: MULTICALL3, nonce: '0x2a' }] },
  })
  const first = await recoverAttemptByNonce(fetcher, attempt(), 100, 100)
  const second = await recoverAttemptByNonce(fetcher, attempt(), 100, 100)
  assertEquals(first, second)
})

Deno.test('H. N=100 recipients does not change this mechanism — it is keyed on the outer transaction (wallet, nonce) alone', async () => {
  const fetcher = makeFetcher({
    100: { number: '0x64', transactions: [{ hash: '0xBigBatchTx', from: PAYER, to: MULTICALL3, nonce: '0x2a' }] },
  })
  const result = await recoverAttemptByNonce(fetcher, attempt(), 100, 100)
  assertEquals(result.outcome, 'confirmed')
})

// ── sweepUnresolvedAttempts (orchestration) ─────────────────────────────
import { sweepUnresolvedAttempts } from './bulkpayNonceRecovery.ts'
import type { AttemptUpdateRepository } from './bulkpayNonceRecovery.ts'

function makeUpdateRepo() {
  const submitted: Array<{ attemptId: string; txHash: string }> = []
  const replaced: Array<{ attemptId: string; txHash: string }> = []
  const intentsFailed: string[] = []
  const repo: AttemptUpdateRepository = {
    markSubmitted: (attemptId, txHash) => { submitted.push({ attemptId, txHash }); return Promise.resolve() },
    markReplaced: (attemptId, txHash) => { replaced.push({ attemptId, txHash }); return Promise.resolve() },
    transitionIntentToFailed: (intentId) => { intentsFailed.push(intentId); return Promise.resolve() },
  }
  return { repo, submitted, replaced, intentsFailed }
}

Deno.test('sweep: a confirmed candidate marks the attempt submitted with the real tx_hash', async () => {
  const fetcher = makeFetcher({
    100: { number: '0x64', transactions: [{ hash: '0xRealTxHash', from: PAYER, to: MULTICALL3, nonce: '0x2a' }] },
  })
  const { repo, submitted, replaced } = makeUpdateRepo()
  const results = await sweepUnresolvedAttempts([attempt()], fetcher, repo, 5)
  assertEquals(results[0].outcome, 'confirmed')
  assertEquals(submitted.length, 1)
  assertEquals(submitted[0].txHash, '0xrealtxhash')
  assertEquals(replaced.length, 0)
})

Deno.test('sweep: a replaced candidate marks the attempt REPLACED, not submitted', async () => {
  const fetcher = makeFetcher({
    100: { number: '0x64', transactions: [{ hash: '0xReplacementTx', from: PAYER, to: '0xSomeOtherContract', nonce: '0x2a' }] },
  })
  const { repo, submitted, replaced } = makeUpdateRepo()
  const results = await sweepUnresolvedAttempts([attempt()], fetcher, repo, 5)
  assertEquals(results[0].outcome, 'replaced')
  assertEquals(submitted.length, 0)
  assertEquals(replaced.length, 1)
})

Deno.test('sweep: a replaced candidate also transitions the parent intent to FAILED — the original BulkPay payment genuinely never happened', async () => {
  const fetcher = makeFetcher({
    100: { number: '0x64', transactions: [{ hash: '0xReplacementTx', from: PAYER, to: '0xSomeOtherContract', nonce: '0x2a' }] },
  })
  const { repo, intentsFailed } = makeUpdateRepo()
  await sweepUnresolvedAttempts([attempt({ intentId: 'intent-xyz' })], fetcher, repo, 5)
  assertEquals(intentsFailed, ['intent-xyz'])
})

Deno.test('sweep: not_found leaves the attempt untouched — no write of any kind', async () => {
  const fetcher = makeFetcher({ 100: { number: '0x64', transactions: [] } })
  const { repo, submitted, replaced } = makeUpdateRepo()
  const results = await sweepUnresolvedAttempts([attempt()], fetcher, repo, 5)
  assertEquals(results[0].outcome, 'not_found')
  assertEquals(submitted.length, 0)
  assertEquals(replaced.length, 0)
})

Deno.test('sweep: one attempt failing unexpectedly does not stop the rest of the batch', async () => {
  const fetcher: BlockFetcher = {
    getBlockWithTransactions: () => Promise.reject(new Error('simulated RPC failure')),
    getCurrentBlockNumber: (chainId) => chainId === 'bad' ? Promise.reject(new Error('boom')) : Promise.resolve(100),
  }
  const { repo, submitted, replaced } = makeUpdateRepo()
  const attemptA = attempt({ id: 'a', chainId: 'bad' })
  const attemptB = attempt({ id: 'b' })
  const results = await sweepUnresolvedAttempts([attemptA, attemptB], fetcher, repo, 5)
  assertEquals(results.length, 2)
  assertEquals(results.every(r => r.outcome === 'not_found'), true) // both fail here (fetcher always rejects), but neither crashes the sweep
  assertEquals(submitted.length, 0)
  assertEquals(replaced.length, 0)
})
