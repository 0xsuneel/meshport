// supabase/functions/pay-intent/logic.test.ts
import { createPayIntent, markPayAttemptSubmitted } from './logic.ts'
import type { IntentRepository, NonceFetcher, CreatePayIntentRequest } from './logic.ts'

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed${msg ? `: ${msg}` : ''}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`)
  }
}

const SENDER = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
const RECIPIENT = '0xebe52519a38e857a744e65d01f23137e22fb784b'

const REQ: CreatePayIntentRequest = {
  walletAddress: SENDER,
  idempotencyKey: 'idem-pay-1',
  chainId: 'arc',
  amountAtomic: '5000000000000000000',
  decimals: 18,
  isNative: true,
  tokenAddress: null,
  tokenSymbol: 'USDC',
  recipientAddress: RECIPIENT,
  recipientUsername: 'suvarna',
}

function makeFakeRepo() {
  const intents: Array<{ id: string; wallet_address: string; idempotency_key: string; status?: string; recipient_address?: string }> = []
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
      intents.push({ id, wallet_address: row.wallet_address, idempotency_key: row.idempotency_key, recipient_address: row.recipient_address })
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

Deno.test('1. normal Pay: creates exactly one intent and one attempt', async () => {
  const { repo, intents, attempts } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(10) }
  const result = await createPayIntent(repo, fetcher, REQ)
  assertEquals(result.outcome, 'created')
  assertEquals(intents.length, 1)
  assertEquals(attempts.length, 1)
  if (result.outcome === 'created') assertEquals(result.nonce, 10)
})

Deno.test('2. server nonce: the fetcher-supplied nonce is what gets returned, not recomputed', async () => {
  const { repo } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(42) }
  const result = await createPayIntent(repo, fetcher, REQ)
  if (result.outcome === 'created') assertEquals(result.nonce, 42)
})

Deno.test('the intent transitions AUTHORIZING -> SUBMITTED once its attempt is created', async () => {
  const { repo, intents } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(10) }
  await createPayIntent(repo, fetcher, REQ)
  assertEquals(intents[0].status, 'SUBMITTED')
})

Deno.test('recipient_address is stored on the intent, needed for confirmation to compute expected `to`', async () => {
  const { repo, intents } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(10) }
  await createPayIntent(repo, fetcher, REQ)
  assertEquals(intents[0].recipient_address, RECIPIENT)
})

Deno.test('5. duplicate click: same (wallet, idempotencyKey) returns the existing intent, never creates a second', async () => {
  const { repo, intents, attempts } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(10) }
  const first = await createPayIntent(repo, fetcher, REQ)
  const second = await createPayIntent(repo, fetcher, REQ)
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
  await repo.insertAttempt({ intent_id: 'seed-intent', chain_id: 'arc', wallet_address: SENDER.toLowerCase(), nonce: 10, status: 'CREATED' })
  const result = await createPayIntent(repo, fetcher, { ...REQ, idempotencyKey: 'idem-pay-collision' })
  assertEquals(result.outcome, 'created')
  if (result.outcome === 'created') assertEquals(result.nonce, 11)
  assertEquals(attempts.filter(a => a.nonce === 11).length, 1)
})

// ── reclaimStaleAttempt (regression guard for the live "could not reserve a
// unique nonce after 5 attempts" report, 2026-09-05) ────────────────────────
Deno.test('stale nonce reclaim: an old, never-broadcast attempt at the same nonce is reclaimed and the SAME nonce succeeds', async () => {
  const { repo, attempts } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(10) } // the chain never advances -- nothing was ever broadcast
  await repo.insertAttempt({ intent_id: 'seed-intent', chain_id: 'arc', wallet_address: SENDER.toLowerCase(), nonce: 10, status: 'CREATED' })
  // Backdate it well past the grace period -- simulates a genuinely
  // abandoned attempt (passcode failed, signing threw, tab closed) rather
  // than one still legitimately in flight.
  attempts[0].updatedAt = Date.now() - 10 * 60 * 1000 // 10 minutes ago
  const result = await createPayIntent(repo, fetcher, { ...REQ, idempotencyKey: 'idem-pay-reclaim' })
  assertEquals(result.outcome, 'created')
  if (result.outcome === 'created') assertEquals(result.nonce, 10) // reclaimed the SAME nonce, not a fresh one
  assertEquals(attempts[0].status, 'DROPPED') // the stale row is marked, not silently deleted
})

Deno.test('stale nonce reclaim: a RECENT attempt at the same nonce is never reclaimed -- genuine concurrency still fails correctly', async () => {
  const { repo, attempts } = makeFakeRepo()
  // The chain reports a DIFFERENT nonce on the second call, simulating a
  // real second in-flight sender -- proves reclaim isn't why this succeeds.
  let call = 0
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(call++ === 0 ? 10 : 11) }
  await repo.insertAttempt({ intent_id: 'seed-intent', chain_id: 'arc', wallet_address: SENDER.toLowerCase(), nonce: 10, status: 'CREATED' })
  // updatedAt stays at "just now" (insertAttempt's default) -- well within
  // the grace period, so this must NOT be treated as abandoned.
  const result = await createPayIntent(repo, fetcher, { ...REQ, idempotencyKey: 'idem-pay-no-reclaim' })
  assertEquals(result.outcome, 'created')
  if (result.outcome === 'created') assertEquals(result.nonce, 11) // moved past the still-fresh row, did not touch it
  assertEquals(attempts[0].status, 'CREATED') // untouched
  assertEquals(attempts[0].nonce, 10) // untouched
})

Deno.test('stale nonce reclaim: an old attempt that DID get a tx_hash is never reclaimed (it broadcast -- reclaiming it would risk a double-spend)', async () => {
  const { repo, attempts } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(10) }
  await repo.insertAttempt({ intent_id: 'seed-intent', chain_id: 'arc', wallet_address: SENDER.toLowerCase(), nonce: 10, status: 'CREATED' })
  attempts[0].tx_hash = '0xrealbroadcasthash'
  attempts[0].status = 'SUBMITTED'
  attempts[0].updatedAt = Date.now() - 10 * 60 * 1000 // old, but it DID broadcast
  const result = await createPayIntent(repo, fetcher, { ...REQ, idempotencyKey: 'idem-pay-no-reclaim-broadcast' })
  // Still fails after 5 attempts -- reclaim correctly refuses a row with a
  // real tx_hash, so this nonce genuinely cannot be freed by this path.
  assertEquals(result.outcome, 'invalid_request')
})

Deno.test('self-transfer is now permitted (previously rejected here)', async () => {
  const { repo } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(1) }
  const result = await createPayIntent(repo, fetcher, { ...REQ, recipientAddress: SENDER })
  assertEquals(result.outcome, 'created')
})

Deno.test('invalid: non-native Pay without a tokenAddress is rejected', async () => {
  const { repo } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(1) }
  const result = await createPayIntent(repo, fetcher, { ...REQ, isNative: false, tokenAddress: null })
  assertEquals(result.outcome, 'invalid_request')
})

Deno.test('invalid: non-positive amount rejected', async () => {
  const { repo } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(1) }
  const result = await createPayIntent(repo, fetcher, { ...REQ, amountAtomic: '0' })
  assertEquals(result.outcome, 'invalid_request')
})

Deno.test('7. tx_hash persistence: markPayAttemptSubmitted transitions the attempt to SUBMITTED with the real hash', async () => {
  const { repo, attempts } = makeFakeRepo()
  const fetcher: NonceFetcher = { getPendingNonce: () => Promise.resolve(10) }
  const created = await createPayIntent(repo, fetcher, REQ)
  if (created.outcome !== 'created') throw new Error('expected created')
  const result = await markPayAttemptSubmitted(repo, created.attemptId, '0xRealTxHash')
  assertEquals(result.outcome, 'updated')
  const attempt = attempts.find(a => a.id === created.attemptId)
  assertEquals(attempt?.tx_hash, '0xrealtxhash')
  assertEquals(attempt?.status, 'SUBMITTED')
})

Deno.test('invalid: malformed txHash rejected before any write', async () => {
  const { repo } = makeFakeRepo()
  const result = await markPayAttemptSubmitted(repo, 'attempt-1', 'not-a-hash')
  assertEquals(result.outcome, 'invalid_request')
})
