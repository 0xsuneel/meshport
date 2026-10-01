// supabase/functions/blockchain-indexer/payNonceRecovery.test.ts
import { recoverAttemptByNonce, sweepUnresolvedAttempts } from './payNonceRecovery.ts'
import type { BlockFetcher, RawBlockWithTransactions, UnresolvedAttempt, AttemptUpdateRepository } from './payNonceRecovery.ts'

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed${msg ? `: ${msg}` : ''}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`)
  }
}

const SENDER = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
const RECIPIENT = '0xebe52519a38e857a744e65d01f23137e22fb784b'

function attempt(overrides: Partial<UnresolvedAttempt> = {}): UnresolvedAttempt {
  return { id: 'attempt-1', intentId: 'intent-1', chainId: 'arc', walletAddress: SENDER, nonce: 42, createdAt: new Date().toISOString(), expectedTo: RECIPIENT, ...overrides }
}

function makeFetcher(blocksByNumber: Record<number, RawBlockWithTransactions | null>): BlockFetcher {
  return {
    getBlockWithTransactions: (_chainId, bn) => Promise.resolve(blocksByNumber[bn] ?? null),
    getCurrentBlockNumber: () => Promise.resolve(Math.max(...Object.keys(blocksByNumber).map(Number))),
  }
}
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

Deno.test('a real transaction matching (wallet, nonce, expectedTo) is discovered and confirmed', async () => {
  const fetcher = makeFetcher({
    100: { number: '0x64', transactions: [{ hash: '0xRealTx', from: SENDER, to: RECIPIENT, nonce: '0x2a' }] },
  })
  const result = await recoverAttemptByNonce(fetcher, attempt(), 100, 100)
  assertEquals(result.outcome, 'confirmed')
})

Deno.test('CRITICAL: a matching (wallet, nonce) transaction to a DIFFERENT destination is REPLACED, never falsely confirmed', async () => {
  const fetcher = makeFetcher({
    100: { number: '0x64', transactions: [{ hash: '0xDifferentPayment', from: SENDER, to: '0xSomeOtherRecipient', nonce: '0x2a' }] },
  })
  const result = await recoverAttemptByNonce(fetcher, attempt(), 100, 100)
  assertEquals(result.outcome, 'replaced')
})

Deno.test('no matching transaction anywhere in the window -> not_found, remains recoverable (UNKNOWN)', async () => {
  const fetcher = makeFetcher({ 100: { number: '0x64', transactions: [] }, 99: null })
  const result = await recoverAttemptByNonce(fetcher, attempt(), 99, 100)
  assertEquals(result.outcome, 'not_found')
})

Deno.test('sweep: a replaced candidate marks REPLACED and transitions the intent to FAILED', async () => {
  const fetcher = makeFetcher({
    100: { number: '0x64', transactions: [{ hash: '0xDifferentPayment', from: SENDER, to: '0xSomeOtherRecipient', nonce: '0x2a' }] },
  })
  const { repo, submitted, replaced, intentsFailed } = makeUpdateRepo()
  const results = await sweepUnresolvedAttempts([attempt({ intentId: 'intent-xyz' })], fetcher, repo, 5)
  assertEquals(results[0].outcome, 'replaced')
  assertEquals(submitted.length, 0)
  assertEquals(replaced.length, 1)
  assertEquals(intentsFailed, ['intent-xyz'])
})

Deno.test('sweep: not_found leaves the attempt completely untouched — structurally cannot rebroadcast', async () => {
  const fetcher = makeFetcher({ 100: { number: '0x64', transactions: [] } })
  const { repo, submitted, replaced, intentsFailed } = makeUpdateRepo()
  const results = await sweepUnresolvedAttempts([attempt()], fetcher, repo, 5)
  assertEquals(results[0].outcome, 'not_found')
  assertEquals(submitted.length, 0)
  assertEquals(replaced.length, 0)
  assertEquals(intentsFailed.length, 0)
})

Deno.test('DROPPED-equivalent: repeated not_found across multiple sweeps stays inert, never escalates to a rebroadcast', async () => {
  const fetcher = makeFetcher({ 100: { number: '0x64', transactions: [] } })
  const { repo, submitted, replaced } = makeUpdateRepo()
  await sweepUnresolvedAttempts([attempt()], fetcher, repo, 5)
  await sweepUnresolvedAttempts([attempt()], fetcher, repo, 5)
  await sweepUnresolvedAttempts([attempt()], fetcher, repo, 5)
  assertEquals(submitted.length, 0)
  assertEquals(replaced.length, 0)
})

Deno.test('ERC20 Pay: expectedTo is the token contract, not the recipient — a tx to the recipient directly is REPLACED', async () => {
  const EURC_CONTRACT = '0x89b50855aa3be2f677cd6303cec089b5f319d72a'
  const fetcher = makeFetcher({
    100: { number: '0x64', transactions: [{ hash: '0xNativeLookingTx', from: SENDER, to: RECIPIENT, nonce: '0x2a' }] },
  })
  const result = await recoverAttemptByNonce(fetcher, attempt({ expectedTo: EURC_CONTRACT }), 100, 100)
  assertEquals(result.outcome, 'replaced')
})

Deno.test('one attempt failing does not stop the rest of the batch', async () => {
  const fetcher: BlockFetcher = {
    getBlockWithTransactions: (chainId) => chainId === 'bad' ? Promise.reject(new Error('boom')) : Promise.resolve({ number: '0x64', transactions: [{ hash: '0xTx', from: SENDER, to: RECIPIENT, nonce: '0x2a' }] }),
    getCurrentBlockNumber: (chainId) => chainId === 'bad' ? Promise.reject(new Error('boom')) : Promise.resolve(100),
  }
  const { repo } = makeUpdateRepo()
  const results = await sweepUnresolvedAttempts([attempt({ id: 'a', chainId: 'bad' }), attempt({ id: 'b' })], fetcher, repo, 5)
  assertEquals(results.length, 2)
  assertEquals(results.find(r => r.attemptId === 'a')?.outcome, 'not_found')
  assertEquals(results.find(r => r.attemptId === 'b')?.outcome, 'confirmed')
})
