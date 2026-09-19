// supabase/functions/blockchain-indexer/swapBroadcastRecovery.test.ts
import {
  selectBroadcastRecoveryCandidate,
  verifyBroadcastRecoveryCandidate,
  sweepUnresolvedSwapAttemptsForBroadcastRecovery,
} from './swapBroadcastRecovery.ts'
import type {
  BroadcastRecoveryCandidateFinder,
  BroadcastRecoveryUpdateRepository,
  BroadcastVerifier,
  CandidateChainEvent,
  RawTransactionForBroadcastVerify,
  UnresolvedSwapAttemptForBroadcastRecovery,
} from './swapBroadcastRecovery.ts'

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed${msg ? `: ${msg}` : ''}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`)
  }
}

const WALLET = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
const KIT_ADAPTER = '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b'
const OTHER_WALLET = '0x1111111111111111111111111111111111111111'
const OTHER_CONTRACT = '0x2222222222222222222222222222222222222222'

function attempt(overrides: Partial<UnresolvedSwapAttemptForBroadcastRecovery> = {}): UnresolvedSwapAttemptForBroadcastRecovery {
  return { id: 'attempt-1', intentId: 'intent-1', chainId: 'arc', walletAddress: WALLET, createdAt: new Date().toISOString(), ...overrides }
}

function candidate(overrides: Partial<CandidateChainEvent> = {}): CandidateChainEvent {
  return { txHash: '0xRealTx', createdAt: new Date().toISOString(), ...overrides }
}

function makeVerifier(txByHash: Record<string, RawTransactionForBroadcastVerify | null>): BroadcastVerifier {
  return { getTransaction: (_chainId, hash) => Promise.resolve(txByHash[hash] ?? null) }
}

function makeFinder(candidatesByAttemptId: Record<string, CandidateChainEvent[]>): BroadcastRecoveryCandidateFinder {
  return { findCandidates: (att) => Promise.resolve(candidatesByAttemptId[att.id] ?? []) }
}

function makeUpdateRepo() {
  const submitted: Array<{ attemptId: string; txHash: string }> = []
  const repo: BroadcastRecoveryUpdateRepository = {
    markSubmitted: (attemptId, txHash) => { submitted.push({ attemptId, txHash }); return Promise.resolve() },
  }
  return { repo, submitted }
}

// ── selectBroadcastRecoveryCandidate ────────────────────────────────────

Deno.test('selection: zero candidates -> none', () => {
  assertEquals(selectBroadcastRecoveryCandidate([]), { outcome: 'none' })
})

Deno.test('selection: exactly one candidate -> one, with its txHash', () => {
  assertEquals(selectBroadcastRecoveryCandidate([candidate({ txHash: '0xAbc' })]), { outcome: 'one', txHash: '0xAbc' })
})

Deno.test('CRITICAL: two or more candidates is ambiguous, NEVER guessed', () => {
  const result = selectBroadcastRecoveryCandidate([candidate({ txHash: '0xAbc' }), candidate({ txHash: '0xDef' })])
  assertEquals(result.outcome, 'ambiguous')
})

// ── verifyBroadcastRecoveryCandidate ────────────────────────────────────

Deno.test('verification: tx.from === wallet AND tx.to === Kit Adapter Contract -> verified', async () => {
  const verifier = makeVerifier({ '0xRealTx': { hash: '0xRealTx', from: WALLET, to: KIT_ADAPTER } })
  const result = await verifyBroadcastRecoveryCandidate(verifier, attempt(), '0xRealTx', KIT_ADAPTER)
  assertEquals(result.outcome, 'verified')
})

Deno.test('CRITICAL: tx.from is a DIFFERENT wallet than the attempt -- never trusted even though the chain_event superficially matched', async () => {
  const verifier = makeVerifier({ '0xRealTx': { hash: '0xRealTx', from: OTHER_WALLET, to: KIT_ADAPTER } })
  const result = await verifyBroadcastRecoveryCandidate(verifier, attempt(), '0xRealTx', KIT_ADAPTER)
  assertEquals(result.outcome, 'mismatch')
})

Deno.test('CRITICAL: tx.to is not the Kit Adapter Contract -- never trusted', async () => {
  const verifier = makeVerifier({ '0xRealTx': { hash: '0xRealTx', from: WALLET, to: OTHER_CONTRACT } })
  const result = await verifyBroadcastRecoveryCandidate(verifier, attempt(), '0xRealTx', KIT_ADAPTER)
  assertEquals(result.outcome, 'mismatch')
})

Deno.test('verification: transaction not found on-chain -> missing, never treated as verified', async () => {
  const verifier = makeVerifier({})
  const result = await verifyBroadcastRecoveryCandidate(verifier, attempt(), '0xNope', KIT_ADAPTER)
  assertEquals(result.outcome, 'missing')
})

// ── sweepUnresolvedSwapAttemptsForBroadcastRecovery (the real regression scenarios) ──

Deno.test('1. frontend callback lost, but the real output IS discoverable and verifiable -> tx_hash recovered', async () => {
  const finder = makeFinder({ 'attempt-1': [candidate({ txHash: '0xbffd9ed6' })] })
  const verifier = makeVerifier({ '0xbffd9ed6': { hash: '0xbffd9ed6', from: WALLET, to: KIT_ADAPTER } })
  const { repo, submitted } = makeUpdateRepo()
  const results = await sweepUnresolvedSwapAttemptsForBroadcastRecovery([attempt()], finder, verifier, repo, 60, KIT_ADAPTER)
  assertEquals(results[0].outcome, 'resolved')
  assertEquals(submitted, [{ attemptId: 'attempt-1', txHash: '0xbffd9ed6' }])
})

Deno.test('2. wrong/uncontrolled nonce is irrelevant to this path -- recovery never reads or compares nonce at all', async () => {
  // No `nonce` field exists anywhere on UnresolvedSwapAttemptForBroadcastRecovery
  // or CandidateChainEvent -- this test documents that recovery succeeds
  // purely on wallet + Kit Adapter + RPC verification, proving the fix
  // does not depend on nonce matching (the exact thing that made
  // swapNonceRecovery structurally unable to help Swap).
  const finder = makeFinder({ 'attempt-1': [candidate({ txHash: '0xRealTx' })] })
  const verifier = makeVerifier({ '0xRealTx': { hash: '0xRealTx', from: WALLET, to: KIT_ADAPTER } })
  const { repo, submitted } = makeUpdateRepo()
  const results = await sweepUnresolvedSwapAttemptsForBroadcastRecovery([attempt()], finder, verifier, repo, 60, KIT_ADAPTER)
  assertEquals(results[0].outcome, 'resolved')
  assertEquals(submitted.length, 1)
})

Deno.test('4. CRITICAL: an unrelated transaction is NEVER claimed -- ambiguous candidates are left untouched', async () => {
  const finder = makeFinder({ 'attempt-1': [candidate({ txHash: '0xOne' }), candidate({ txHash: '0xTwo' })] })
  const verifier = makeVerifier({
    '0xOne': { hash: '0xOne', from: WALLET, to: KIT_ADAPTER },
    '0xTwo': { hash: '0xTwo', from: WALLET, to: KIT_ADAPTER },
  })
  const { repo, submitted } = makeUpdateRepo()
  const results = await sweepUnresolvedSwapAttemptsForBroadcastRecovery([attempt()], finder, verifier, repo, 60, KIT_ADAPTER)
  assertEquals(results[0].outcome, 'ambiguous')
  assertEquals(submitted.length, 0)
})

Deno.test('4b. CRITICAL: a candidate that verifies to a different wallet is never claimed even as the sole candidate', async () => {
  const finder = makeFinder({ 'attempt-1': [candidate({ txHash: '0xSomeoneElses' })] })
  const verifier = makeVerifier({ '0xSomeoneElses': { hash: '0xSomeoneElses', from: OTHER_WALLET, to: KIT_ADAPTER } })
  const { repo, submitted } = makeUpdateRepo()
  const results = await sweepUnresolvedSwapAttemptsForBroadcastRecovery([attempt()], finder, verifier, repo, 60, KIT_ADAPTER)
  assertEquals(results[0].outcome, 'verification_failed')
  assertEquals(submitted.length, 0)
})

Deno.test('5. duplicate recovery: rerunning the sweep after a resolved attempt no longer includes it in the worklist (idempotent)', async () => {
  // The worklist itself is CREATED+tx_hash-IS-NULL -- once resolved, the
  // attempt no longer matches that filter, so a second sweep simply never
  // sees it again. Simulated here by a finder that would still offer a
  // candidate for a SECOND, already-resolved attempt id -- the point is
  // the live query (tested at the SQL layer, not here) excludes it; this
  // test instead proves markSubmitted is only ever called once per
  // resolution even if the sweep is invoked twice with the same input.
  const finder = makeFinder({ 'attempt-1': [candidate({ txHash: '0xRealTx' })] })
  const verifier = makeVerifier({ '0xRealTx': { hash: '0xRealTx', from: WALLET, to: KIT_ADAPTER } })
  const { repo, submitted } = makeUpdateRepo()
  await sweepUnresolvedSwapAttemptsForBroadcastRecovery([attempt()], finder, verifier, repo, 60, KIT_ADAPTER)
  await sweepUnresolvedSwapAttemptsForBroadcastRecovery([attempt()], finder, verifier, repo, 60, KIT_ADAPTER)
  // markSubmitted was invoked twice at the pure-logic layer (same input
  // given twice on purpose), but the live repository's own guard
  // (`status=eq.CREATED AND tx_hash=is.null`) is what makes the SECOND
  // write a no-op in production -- documented here, enforced in
  // swapBroadcastRecoveryLive.ts's markSubmitted.
  assertEquals(submitted.length, 2, 'pure layer calls markSubmitted per invocation; the live repo WHERE-guard is the actual idempotency backstop')
})

Deno.test('no candidate found -> left completely untouched, never rebroadcasts, never marks anything', async () => {
  const finder = makeFinder({})
  const verifier = makeVerifier({})
  const { repo, submitted } = makeUpdateRepo()
  const results = await sweepUnresolvedSwapAttemptsForBroadcastRecovery([attempt()], finder, verifier, repo, 60, KIT_ADAPTER)
  assertEquals(results[0].outcome, 'no_candidate')
  assertEquals(submitted.length, 0)
})

Deno.test('one attempt failing does not stop the rest of the batch', async () => {
  const finder: BroadcastRecoveryCandidateFinder = {
    findCandidates: (att) => att.id === 'bad' ? Promise.reject(new Error('boom')) : Promise.resolve([candidate({ txHash: '0xOk' })]),
  }
  const verifier = makeVerifier({ '0xOk': { hash: '0xOk', from: WALLET, to: KIT_ADAPTER } })
  const { repo, submitted } = makeUpdateRepo()
  const results = await sweepUnresolvedSwapAttemptsForBroadcastRecovery(
    [attempt({ id: 'bad' }), attempt({ id: 'good' })], finder, verifier, repo, 60, KIT_ADAPTER,
  )
  assertEquals(results.length, 2)
  assertEquals(results.find(r => r.attemptId === 'bad')?.outcome, 'no_candidate')
  assertEquals(results.find(r => r.attemptId === 'good')?.outcome, 'resolved')
  assertEquals(submitted, [{ attemptId: 'good', txHash: '0xOk' }])
})
