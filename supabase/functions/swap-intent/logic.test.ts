// supabase/functions/swap-intent/logic.test.ts
import { createSwapIntent, markSwapAttemptSubmitted } from './logic.ts'
import type { IntentRepository, NonceFetcher, CreateSwapIntentRequest } from './logic.ts'

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed${msg ? `: ${msg}` : ''}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`)
  }
}

const WALLET = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
const EURC_CONTRACT = '0x89b50855aa3be2f677cd6303cec089b5f319d72a'

const REQ: CreateSwapIntentRequest = {
  walletAddress: WALLET,
  idempotencyKey: 'idem-swap-1',
  chainId: 'arc',
  amountInAtomic: '5000000',
  decimalsIn: 6,
  tokenInAddress: null,
  tokenInSymbol: 'USDC',
  isNativeIn: true,
  tokenOutAddress: EURC_CONTRACT,
  tokenOutSymbol: 'EURC',
  decimalsOut: 6,
  minAmountOutAtomic: '4500000',
  expectedAmountOutAtomic: '4600000',
  slippageBps: 500,
  routerAddress: '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b',
}

function makeFakeRepo() {
  const intents: Array<{ id: string; wallet_address: string; idempotency_key: string; status?: string; metadata?: Record<string, unknown> }> = []
  const attempts: Array<{ id: string; intent_id: string; chain_id: string; wallet_address: string; nonce: number | null; tx_hash?: string; status?: string; updatedAt: number }> = []
  let n = 1
  const repo: IntentRepository = {
    findIntentByIdempotencyKey(walletAddress, idempotencyKey) {
      const row = intents.find(i => i.wallet_address === walletAddress && i.idempotency_key === idempotencyKey)
      if (!row) return Promise.resolve(null)
      const attempt = attempts.find(a => a.intent_id === row.id)
      return Promise.resolve({ id: row.id, attemptId: attempt?.id ?? null })
    },
    insertIntent(row) {
      const exists = intents.some(i => i.wallet_address === row.wallet_address && i.idempotency_key === row.idempotency_key)
      if (exists) return Promise.resolve({ outcome: 'conflict' })
      const id = `intent-${n++}`
      intents.push({ id, wallet_address: row.wallet_address, idempotency_key: row.idempotency_key, metadata: row.metadata })
      return Promise.resolve({ outcome: 'inserted', id })
    },
    insertAttempt(row) {
      const exists = attempts.some(a => a.chain_id === row.chain_id && a.wallet_address === row.wallet_address && a.nonce === row.nonce)
      if (exists) return Promise.resolve({ outcome: 'nonce_conflict' })
      const id = `attempt-${n++}`
      attempts.push({ id, intent_id: row.intent_id, chain_id: row.chain_id, wallet_address: row.wallet_address, nonce: row.nonce, status: row.status, updatedAt: Date.now() })
      return Promise.resolve({ outcome: 'inserted', id })
    },
    markAttemptSubmitted(attemptId, txHash) {
      const a = attempts.find(x => x.id === attemptId)
      if (a) { a.tx_hash = txHash; a.status = 'SUBMITTED'; a.updatedAt = Date.now() }
      return Promise.resolve()
    },
    transitionIntentToSubmitted(intentId) {
      const i = intents.find(x => x.id === intentId)
      if (i) i.status = 'SUBMITTED'
      return Promise.resolve()
    },
    reclaimStaleAttempt(chainId, walletAddress, nonce, staleBeforeIso) {
      const staleBeforeMs = new Date(staleBeforeIso).getTime()
      const row = attempts.find(a =>
        a.chain_id === chainId && a.wallet_address === walletAddress && a.nonce === nonce &&
        a.status === 'CREATED' && !a.tx_hash && a.updatedAt < staleBeforeMs
      )
      if (!row) return Promise.resolve(false)
      row.nonce = null
      row.status = 'DROPPED'
      return Promise.resolve(true)
    },
  }
  return { repo, intents, attempts }
}

Deno.test('1. normal Swap: creates exactly one intent and one attempt', async () => {
  const { repo, intents, attempts } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(10) }
  const result = await createSwapIntent(repo, fetcher, REQ)
  assertEquals(result.outcome, 'created')
  assertEquals(intents.length, 1)
  assertEquals(attempts.length, 1)
  if (result.outcome === 'created') assertEquals(result.nonce, 10)
})

Deno.test('2. output token/amount/slippage/router go into metadata, never onto the canonical input columns', async () => {
  const { repo, intents } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(10) }
  await createSwapIntent(repo, fetcher, REQ)
  const meta = intents[0].metadata as Record<string, unknown>
  assertEquals(meta.tokenOutSymbol, 'EURC')
  assertEquals(meta.minAmountOutAtomic, '4500000')
  assertEquals(meta.expectedAmountOutAtomic, '4600000')
  assertEquals(meta.slippageBps, 500)
  assertEquals(meta.routerAddress, REQ.routerAddress)
})

Deno.test('the intent transitions AUTHORIZING -> SUBMITTED once its attempt is created', async () => {
  const { repo, intents } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(10) }
  await createSwapIntent(repo, fetcher, REQ)
  assertEquals(intents[0].status, 'SUBMITTED')
})

Deno.test('3. duplicate click: same (wallet, idempotencyKey) returns the existing intent, never creates a second', async () => {
  const { repo, intents, attempts } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(10) }
  const first = await createSwapIntent(repo, fetcher, REQ)
  const second = await createSwapIntent(repo, fetcher, REQ)
  assertEquals(second.outcome, 'idempotent_replay')
  if (first.outcome === 'created' && second.outcome === 'idempotent_replay') {
    assertEquals(second.intentId, first.intentId)
  }
  assertEquals(intents.length, 1)
  assertEquals(attempts.length, 1)
})

Deno.test('4. nonce collision: retries with a fresh nonce, bounded', async () => {
  const { repo, attempts } = makeFakeRepo()
  let call = 0
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(call++ === 0 ? 10 : 11) }
  await repo.insertAttempt({ intent_id: 'seed-intent', chain_id: 'arc', wallet_address: WALLET.toLowerCase(), nonce: 10, status: 'CREATED' })
  const result = await createSwapIntent(repo, fetcher, { ...REQ, idempotencyKey: 'idem-swap-collision' })
  assertEquals(result.outcome, 'created')
  if (result.outcome === 'created') assertEquals(result.nonce, 11)
  assertEquals(attempts.filter(a => a.nonce === 11).length, 1)
})

// ── reclaimStaleAttempt (regression guard for the live "could not reserve a
// unique nonce after 5 attempts" report, 2026-09-05 -- reported first on
// Swap) ──────────────────────────────────────────────────────────────────
Deno.test('stale nonce reclaim: an old, never-broadcast attempt at the same nonce is reclaimed and the SAME nonce succeeds', async () => {
  const { repo, attempts } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(10) }
  await repo.insertAttempt({ intent_id: 'seed-intent', chain_id: 'arc', wallet_address: WALLET.toLowerCase(), nonce: 10, status: 'CREATED' })
  attempts[0].updatedAt = Date.now() - 10 * 60 * 1000
  const result = await createSwapIntent(repo, fetcher, { ...REQ, idempotencyKey: 'idem-swap-reclaim' })
  assertEquals(result.outcome, 'created')
  if (result.outcome === 'created') assertEquals(result.nonce, 10)
  assertEquals(attempts[0].status, 'DROPPED')
})

Deno.test('stale nonce reclaim: a RECENT attempt at the same nonce is never reclaimed -- genuine concurrency still fails correctly', async () => {
  const { repo, attempts } = makeFakeRepo()
  let call = 0
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(call++ === 0 ? 10 : 11) }
  await repo.insertAttempt({ intent_id: 'seed-intent', chain_id: 'arc', wallet_address: WALLET.toLowerCase(), nonce: 10, status: 'CREATED' })
  const result = await createSwapIntent(repo, fetcher, { ...REQ, idempotencyKey: 'idem-swap-no-reclaim' })
  assertEquals(result.outcome, 'created')
  if (result.outcome === 'created') assertEquals(result.nonce, 11)
  assertEquals(attempts[0].status, 'CREATED')
  assertEquals(attempts[0].nonce, 10)
})

Deno.test('invalid: non-native input without a tokenInAddress is rejected', async () => {
  const { repo } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(1) }
  const result = await createSwapIntent(repo, fetcher, { ...REQ, isNativeIn: false, tokenInAddress: null })
  assertEquals(result.outcome, 'invalid_request')
})

Deno.test('invalid: tokenIn === tokenOut is rejected (not a real swap)', async () => {
  const { repo } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(1) }
  const result = await createSwapIntent(repo, fetcher, { ...REQ, tokenInSymbol: 'USDC', tokenOutSymbol: 'USDC' })
  assertEquals(result.outcome, 'invalid_request')
})

Deno.test('invalid: non-positive amount rejected', async () => {
  const { repo } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(1) }
  const result = await createSwapIntent(repo, fetcher, { ...REQ, amountInAtomic: '0' })
  assertEquals(result.outcome, 'invalid_request')
})

Deno.test('invalid: missing tokenOutSymbol rejected', async () => {
  const { repo } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(1) }
  const result = await createSwapIntent(repo, fetcher, { ...REQ, tokenOutSymbol: null })
  assertEquals(result.outcome, 'invalid_request')
})

Deno.test('5. tx_hash persistence: markSwapAttemptSubmitted transitions the attempt to SUBMITTED with the real hash', async () => {
  const { repo, attempts } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(10) }
  const created = await createSwapIntent(repo, fetcher, REQ)
  if (created.outcome !== 'created') throw new Error('expected created')
  const result = await markSwapAttemptSubmitted(repo, created.attemptId, '0xRealSwapTxHash')
  assertEquals(result.outcome, 'updated')
  const attempt = attempts.find(a => a.id === created.attemptId)
  assertEquals(attempt?.tx_hash, '0xrealswaptxhash')
  assertEquals(attempt?.status, 'SUBMITTED')
})

Deno.test('invalid: malformed txHash rejected before any write', async () => {
  const { repo } = makeFakeRepo()
  const result = await markSwapAttemptSubmitted(repo, 'attempt-1', 'not-a-hash')
  assertEquals(result.outcome, 'invalid_request')
})

Deno.test('ERC20-to-ERC20 swap (non-native input) is accepted when tokenInAddress is present', async () => {
  const { repo } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(1) }
  const result = await createSwapIntent(repo, fetcher, {
    ...REQ,
    idempotencyKey: 'idem-swap-erc20-in',
    isNativeIn: false,
    tokenInAddress: EURC_CONTRACT,
    tokenInSymbol: 'EURC',
    tokenOutSymbol: 'cirBTC',
  })
  assertEquals(result.outcome, 'created')
})
