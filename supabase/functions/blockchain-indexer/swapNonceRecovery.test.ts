// supabase/functions/blockchain-indexer/swapNonceRecovery.test.ts
import { recoverSwapAttemptByNonce, sweepUnresolvedSwapAttempts } from './swapNonceRecovery.ts'
import type { BlockFetcher, RawBlockWithTransactions, UnresolvedSwapAttempt, SwapAttemptUpdateRepository } from './swapNonceRecovery.ts'

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed${msg ? `: ${msg}` : ''}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`)
  }
}

const SENDER = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
const KIT_ADAPTER = '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b'

function attempt(overrides: Partial<UnresolvedSwapAttempt> = {}): UnresolvedSwapAttempt {
  return { id: 'attempt-1', intentId: 'intent-1', chainId: 'arc', walletAddress: SENDER, nonce: 42, createdAt: new Date().toISOString(), expectedTo: KIT_ADAPTER, ...overrides }
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
  const repo: SwapAttemptUpdateRepository = {
    markSubmitted: (attemptId, txHash) => { submitted.push({ attemptId, txHash }); return Promise.resolve() },
    markReplaced: (attemptId, txHash) => { replaced.push({ attemptId, txHash }); return Promise.resolve() },
    transitionIntentToFailed: (intentId) => { intentsFailed.push(intentId); return Promise.resolve() },
  }
  return { repo, submitted, replaced, intentsFailed }
}

Deno.test('a real transaction matching (wallet, nonce, Kit Adapter Contract) is discovered and confirmed', async () => {
  const fetcher = makeFetcher({
    100: { number: '0x64', transactions: [{ hash: '0xRealSwapTx', from: SENDER, to: KIT_ADAPTER, nonce: '0x2a' }] },
  })
  const result = await recoverSwapAttemptByNonce(fetcher, attempt(), 100, 100)
  assertEquals(result.outcome, 'confirmed')
})

Deno.test('CRITICAL: a matching (wallet, nonce) transaction to a DIFFERENT destination (not the Kit Adapter) is REPLACED, never falsely confirmed', async () => {
  const fetcher = makeFetcher({
    100: { number: '0x64', transactions: [{ hash: '0xUnrelatedTx', from: SENDER, to: '0xSomeOtherContract', nonce: '0x2a' }] },
  })
  const result = await recoverSwapAttemptByNonce(fetcher, attempt(), 100, 100)
  assertEquals(result.outcome, 'replaced')
})

Deno.test('no matching transaction anywhere in the window -> not_found, remains recoverable (UNKNOWN) -- never a rebroadcast trigger', async () => {
  const fetcher = makeFetcher({ 100: { number: '0x64', transactions: [] }, 99: null })
  const result = await recoverSwapAttemptByNonce(fetcher, attempt(), 99, 100)
  assertEquals(result.outcome, 'not_found')
})

Deno.test('sweep: a replaced candidate marks REPLACED and transitions the intent to FAILED', async () => {
  const fetcher = makeFetcher({
    100: { number: '0x64', transactions: [{ hash: '0xUnrelatedTx', from: SENDER, to: '0xSomeOtherContract', nonce: '0x2a' }] },
  })
  const { repo, submitted, replaced, intentsFailed } = makeUpdateRepo()
  const results = await sweepUnresolvedSwapAttempts([attempt({ intentId: 'intent-xyz' })], fetcher, repo, 5)
  assertEquals(results[0].outcome, 'replaced')
  assertEquals(submitted.length, 0)
  assertEquals(replaced.length, 1)
  assertEquals(intentsFailed, ['intent-xyz'])
})

Deno.test('sweep: not_found leaves the attempt completely untouched -- structurally cannot rebroadcast', async () => {
  const fetcher = makeFetcher({ 100: { number: '0x64', transactions: [] } })
  const { repo, submitted, replaced, intentsFailed } = makeUpdateRepo()
  const results = await sweepUnresolvedSwapAttempts([attempt()], fetcher, repo, 5)
  assertEquals(results[0].outcome, 'not_found')
  assertEquals(submitted.length, 0)
  assertEquals(replaced.length, 0)
  assertEquals(intentsFailed.length, 0)
})

Deno.test('DROPPED-equivalent: repeated not_found across multiple sweeps stays inert, never escalates to a rebroadcast', async () => {
  const fetcher = makeFetcher({ 100: { number: '0x64', transactions: [] } })
  const { repo, submitted, replaced } = makeUpdateRepo()
  await sweepUnresolvedSwapAttempts([attempt()], fetcher, repo, 5)
  await sweepUnresolvedSwapAttempts([attempt()], fetcher, repo, 5)
  await sweepUnresolvedSwapAttempts([attempt()], fetcher, repo, 5)
  assertEquals(submitted.length, 0)
  assertEquals(replaced.length, 0)
})

Deno.test('a same-nonce transaction to a recipient-style address (not the router) is REPLACED, not confused with a Pay-shaped confirmation', async () => {
  const RECIPIENT_LOOKING_ADDRESS = '0xebe52519a38e857a744e65d01f23137e22fb784b'
  const fetcher = makeFetcher({
    100: { number: '0x64', transactions: [{ hash: '0xNotASwap', from: SENDER, to: RECIPIENT_LOOKING_ADDRESS, nonce: '0x2a' }] },
  })
  const result = await recoverSwapAttemptByNonce(fetcher, attempt(), 100, 100)
  assertEquals(result.outcome, 'replaced')
})

Deno.test('one attempt failing does not stop the rest of the batch', async () => {
  const fetcher: BlockFetcher = {
    getBlockWithTransactions: (chainId) => chainId === 'bad' ? Promise.reject(new Error('boom')) : Promise.resolve({ number: '0x64', transactions: [{ hash: '0xTx', from: SENDER, to: KIT_ADAPTER, nonce: '0x2a' }] }),
    getCurrentBlockNumber: (chainId) => chainId === 'bad' ? Promise.reject(new Error('boom')) : Promise.resolve(100),
  }
  const { repo } = makeUpdateRepo()
  const results = await sweepUnresolvedSwapAttempts([attempt({ id: 'a', chainId: 'bad' }), attempt({ id: 'b' })], fetcher, repo, 5)
  assertEquals(results.length, 2)
  assertEquals(results.find(r => r.attemptId === 'a')?.outcome, 'not_found')
  assertEquals(results.find(r => r.attemptId === 'b')?.outcome, 'confirmed')
})
