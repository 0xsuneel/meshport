// supabase/functions/bulkpay-intent/logic.test.ts
import { createBulkPayIntent, markBulkPayAttemptSubmitted } from './logic.ts'
import type { IntentRepository, NonceFetcher, CreateBulkPayIntentRequest } from './logic.ts'

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed${msg ? `: ${msg}` : ''}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`)
  }
}

const REQ: CreateBulkPayIntentRequest = {
  walletAddress: '0x05d00ab75bcbe15450143f810cd5e5164ee126e0',
  idempotencyKey: 'idem-key-1',
  chainId: 'arc',
  amountAtomic: '24000000000000000000',
  decimals: 18,
  isNative: true,
  tokenAddress: null,
  tokenSymbol: 'USDC',
  recipientCount: 2,
  purpose: 'Payroll',
}

function makeFakeRepo() {
  const intents: Array<{ id: string; wallet_address: string; idempotency_key: string; status?: string }> = []
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
      intents.push({ id, wallet_address: row.wallet_address, idempotency_key: row.idempotency_key })
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

Deno.test('creates exactly one intent and one attempt for a normal request', async () => {
  const { repo, intents, attempts } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(42) }
  const result = await createBulkPayIntent(repo, fetcher, REQ)
  assertEquals(result.outcome, 'created')
  assertEquals(intents.length, 1)
  assertEquals(attempts.length, 1)
  if (result.outcome === 'created') assertEquals(result.nonce, 42)
})

Deno.test('the intent transitions AUTHORIZING -> SUBMITTED once its attempt is created — prevents deriveDisplayState from showing "AUTHORIZING" forever', async () => {
  const { repo, intents } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(42) }
  await createBulkPayIntent(repo, fetcher, REQ)
  assertEquals(intents[0].status, 'SUBMITTED')
})

Deno.test('B. duplicate idempotency key (same wallet) -> idempotent replay, no second intent/attempt', async () => {
  const { repo, intents, attempts } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(42) }
  const first = await createBulkPayIntent(repo, fetcher, REQ)
  const second = await createBulkPayIntent(repo, fetcher, REQ)
  assertEquals(first.outcome, 'created')
  assertEquals(second.outcome, 'idempotent_replay')
  assertEquals(intents.length, 1, 'exactly one intent, never two')
  assertEquals(attempts.length, 1, 'exactly one attempt, never two')
  if (first.outcome === 'created' && second.outcome === 'idempotent_replay') {
    assertEquals(first.intentId, second.intentId)
  }
})

Deno.test('a different idempotency key for the same wallet creates a genuinely separate intent', async () => {
  const { repo, intents } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(42) }
  await createBulkPayIntent(repo, fetcher, REQ)
  const secondReq = { ...REQ, idempotencyKey: 'idem-key-2' }
  const fetcher2: NonceFetcher = { getPendingNonce: () => Promise.resolve(43) }
  const result = await createBulkPayIntent(repo, fetcher2, secondReq)
  assertEquals(result.outcome, 'created')
  assertEquals(intents.length, 2)
})

Deno.test('Q. nonce_conflict on first attempt (concurrent collision) retries and succeeds with the next nonce', async () => {
  const { repo, attempts } = makeFakeRepo()
  let callCount = 0
  const fetcher: NonceFetcher = {
    getPendingNonce: () => {
      callCount++
      return Promise.resolve(callCount === 1 ? 42 : 43)
    },
  }
  await repo.insertAttempt({ intent_id: 'other-intent', chain_id: 'arc', wallet_address: REQ.walletAddress.toLowerCase(), nonce: 42, status: 'CREATED' })
  const result = await createBulkPayIntent(repo, fetcher, REQ)
  assertEquals(result.outcome, 'created')
  if (result.outcome === 'created') assertEquals(result.nonce, 43, 'must retry to the next available nonce, never reuse the colliding one')
  assertEquals(attempts.length, 2)
})

// ── reclaimStaleAttempt (regression guard for the live "could not reserve a
// unique nonce after 5 attempts" report, 2026-09-05 -- same gap, same shared
// architecture as pay-intent/swap-intent) ──────────────────────────────────
Deno.test('stale nonce reclaim: an old, never-broadcast attempt at the same nonce is reclaimed and the SAME nonce succeeds', async () => {
  const { repo, attempts } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(42) }
  await repo.insertAttempt({ intent_id: 'seed-intent', chain_id: 'arc', wallet_address: REQ.walletAddress.toLowerCase(), nonce: 42, status: 'CREATED' })
  attempts[0].updatedAt = Date.now() - 10 * 60 * 1000
  const result = await createBulkPayIntent(repo, fetcher, { ...REQ, idempotencyKey: 'idem-bulkpay-reclaim' })
  assertEquals(result.outcome, 'created')
  if (result.outcome === 'created') assertEquals(result.nonce, 42)
  assertEquals(attempts[0].status, 'DROPPED')
})

Deno.test('invalid request: missing walletAddress rejected before any DB/RPC call', async () => {
  const { repo, intents } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(1) }
  const result = await createBulkPayIntent(repo, fetcher, { ...REQ, walletAddress: '' })
  assertEquals(result.outcome, 'invalid_request')
  assertEquals(intents.length, 0)
})

Deno.test('invalid request: non-positive amount rejected', async () => {
  const { repo } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(1) }
  const result = await createBulkPayIntent(repo, fetcher, { ...REQ, amountAtomic: '0' })
  assertEquals(result.outcome, 'invalid_request')
})

Deno.test('recipient metadata carries only non-authoritative context — never a canonical recipient list', async () => {
  const { repo } = makeFakeRepo()
  const capturedMetadata: Record<string, unknown>[] = []
  const capturingRepo: IntentRepository = {
    ...repo,
    insertIntent: (row) => {
      capturedMetadata.push(row.metadata)
      return repo.insertIntent(row)
    },
  }
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(1) }
  await createBulkPayIntent(capturingRepo, fetcher, REQ)
  assertEquals(Object.keys(capturedMetadata[0]).sort(), ['purpose', 'recipient_count'])
})

// ── markBulkPayAttemptSubmitted (Phase 3 frontend integration) ──────────
Deno.test('7. persists a real tx_hash immediately, transitioning the attempt to SUBMITTED', async () => {
  const { repo, attempts } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(42) }
  const created = await createBulkPayIntent(repo, fetcher, REQ)
  assertEquals(created.outcome, 'created')
  if (created.outcome !== 'created') return
  const result = await markBulkPayAttemptSubmitted(repo, created.attemptId, '0xRealTxHash')
  assertEquals(result.outcome, 'updated')
  const attempt = attempts.find(a => a.id === created.attemptId)
  assertEquals(attempt?.tx_hash, '0xrealtxhash')
  assertEquals(attempt?.status, 'SUBMITTED')
})

Deno.test('invalid: empty attemptId rejected before any write', async () => {
  const { repo, attempts } = makeFakeRepo()
  const result = await markBulkPayAttemptSubmitted(repo, '', '0xRealTxHash')
  assertEquals(result.outcome, 'invalid_request')
  assertEquals(attempts.length, 0)
})

Deno.test('invalid: malformed txHash (no 0x prefix) rejected', async () => {
  const { repo } = makeFakeRepo()
  const result = await markBulkPayAttemptSubmitted(repo, 'attempt-1', 'not-a-hash')
  assertEquals(result.outcome, 'invalid_request')
})
