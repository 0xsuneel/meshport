// supabase/functions/blockchain-indexer/swapConfirmation.test.ts
import { verifySwapAttemptConfirmation, sweepSubmittedSwapAttempts } from './swapConfirmation.ts'
import type { TransactionVerifier, ConfirmableSwapAttempt, SwapConfirmationUpdateRepository, RawTransaction, RawTxReceipt } from './swapConfirmation.ts'

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed${msg ? `: ${msg}` : ''}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`)
  }
}

const SENDER = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
const KIT_ADAPTER = '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b'
const REAL_TX = '0xaabbccdd0000000000000000000000000000000000000000000000000000'

function swapAttempt(overrides: Partial<ConfirmableSwapAttempt> = {}): ConfirmableSwapAttempt {
  return { id: 'attempt-1', intentId: 'intent-1', chainId: 'arc', walletAddress: SENDER, nonce: 12, txHash: REAL_TX, expectedTo: KIT_ADAPTER, ...overrides }
}

function makeVerifier(tx: RawTransaction | null, receipt: RawTxReceipt | null): TransactionVerifier {
  return { getTransaction: () => Promise.resolve(tx), getReceipt: () => Promise.resolve(receipt) }
}
function makeUpdateRepo() {
  const confirmed: Array<{ id: string; blockNumber: number }> = []
  const reverted: string[] = []
  const cleared: string[] = []
  const intentTransitions: Array<{ intentId: string; to: string }> = []
  const repo: SwapConfirmationUpdateRepository = {
    markConfirmed: (id, blockNumber) => { confirmed.push({ id, blockNumber }); return Promise.resolve() },
    markReverted: (id) => { reverted.push(id); return Promise.resolve() },
    clearForRecovery: (id) => { cleared.push(id); return Promise.resolve() },
    transitionIntent: (intentId, to) => { intentTransitions.push({ intentId, to }); return Promise.resolve() },
  }
  return { repo, confirmed, reverted, cleared, intentTransitions }
}

Deno.test('Swap: transaction.to === Kit Adapter Contract -> confirmed', async () => {
  const verifier = makeVerifier(
    { hash: REAL_TX, from: SENDER, to: KIT_ADAPTER, nonce: '0xc' },
    { status: '0x1', blockNumber: '0x100' },
  )
  const result = await verifySwapAttemptConfirmation(verifier, swapAttempt())
  assertEquals(result.outcome, 'confirmed')
})

Deno.test('Swap: transaction.to !== Kit Adapter Contract is REJECTED (this attempt did not actually broadcast to the router it claims to have)', async () => {
  const verifier = makeVerifier(
    { hash: REAL_TX, from: SENDER, to: '0x0000000000000000000000000000000000dead', nonce: '0xc' },
    { status: '0x1', blockNumber: '0x100' },
  )
  const result = await verifySwapAttemptConfirmation(verifier, swapAttempt())
  assertEquals(result.outcome, 'mismatch')
})

Deno.test('reverted receipt -> reverted', async () => {
  const verifier = makeVerifier({ hash: REAL_TX, from: SENDER, to: KIT_ADAPTER, nonce: '0xc' }, { status: '0x0', blockNumber: '0x100' })
  const result = await verifySwapAttemptConfirmation(verifier, swapAttempt())
  assertEquals(result.outcome, 'reverted')
})

Deno.test('missing transaction -> missing, NOT reverted, remains recoverable', async () => {
  const verifier = makeVerifier(null, null)
  const result = await verifySwapAttemptConfirmation(verifier, swapAttempt())
  assertEquals(result.outcome, 'missing')
})

Deno.test('wrong sender -> mismatch', async () => {
  const verifier = makeVerifier({ hash: REAL_TX, from: '0xSomeoneElse', to: KIT_ADAPTER, nonce: '0xc' }, { status: '0x1', blockNumber: '0x100' })
  const result = await verifySwapAttemptConfirmation(verifier, swapAttempt())
  assertEquals(result.outcome, 'mismatch')
})

Deno.test('CRITICAL REGRESSION: a real transaction nonce that differs from attempt.nonce is NOT treated as a mismatch -- Swap\'s stored nonce is informational only, unlike Pay/BulkPay (see this file\'s header). This is not a hypothetical: in production, swap-broadcast-recovery correctly found and independently verified (sender==wallet, to==Kit Adapter) the real transaction for attempt b3eb0389.../intent ff52946c..., attached its tx_hash, and this exact check then incorrectly bounced it right back to CREATED because the real broadcast nonce (chosen internally by Circle Kit SDK) did not match the informational nonce reserved at intent-creation time. Sender+to are still checked below and are the real proof.', async () => {
  const verifier = makeVerifier({ hash: REAL_TX, from: SENDER, to: KIT_ADAPTER, nonce: '0xff' }, { status: '0x1', blockNumber: '0x100' })
  const result = await verifySwapAttemptConfirmation(verifier, swapAttempt())
  assertEquals(result.outcome, 'confirmed')
})

Deno.test('receipt not yet available -> pending, no write', async () => {
  const verifier = makeVerifier({ hash: REAL_TX, from: SENDER, to: KIT_ADAPTER, nonce: '0xc' }, null)
  const updateRepo = makeUpdateRepo()
  const results = await sweepSubmittedSwapAttempts([swapAttempt()], verifier, updateRepo.repo)
  assertEquals(results[0].outcome, 'pending')
  assertEquals(updateRepo.confirmed.length, 0)
})

Deno.test('confirming an attempt also transitions its parent intent SUBMITTED -> CONFIRMED (this is what makes classifySwapDebit applicable)', async () => {
  const verifier = makeVerifier({ hash: REAL_TX, from: SENDER, to: KIT_ADAPTER, nonce: '0xc' }, { status: '0x1', blockNumber: '0x37daf32' })
  const updateRepo = makeUpdateRepo()
  await sweepSubmittedSwapAttempts([swapAttempt({ intentId: 'intent-xyz' })], verifier, updateRepo.repo)
  assertEquals(updateRepo.intentTransitions, [{ intentId: 'intent-xyz', to: 'CONFIRMED' }])
  assertEquals(updateRepo.confirmed, [{ id: 'attempt-1', blockNumber: 58568498 }])
})

Deno.test('reverting also transitions the parent intent SUBMITTED -> FAILED', async () => {
  const verifier = makeVerifier({ hash: REAL_TX, from: SENDER, to: KIT_ADAPTER, nonce: '0xc' }, { status: '0x0', blockNumber: '0x100' })
  const updateRepo = makeUpdateRepo()
  await sweepSubmittedSwapAttempts([swapAttempt({ intentId: 'intent-xyz' })], verifier, updateRepo.repo)
  assertEquals(updateRepo.intentTransitions, [{ intentId: 'intent-xyz', to: 'FAILED' }])
  assertEquals(updateRepo.reverted, ['attempt-1'])
})

Deno.test('a mismatch clears the attempt for the EXISTING nonce-recovery mechanism to resolve -- does not transition the intent', async () => {
  const verifier = makeVerifier({ hash: REAL_TX, from: SENDER, to: '0xADifferentDestination', nonce: '0xc' }, { status: '0x1', blockNumber: '0x100' })
  const updateRepo = makeUpdateRepo()
  await sweepSubmittedSwapAttempts([swapAttempt()], verifier, updateRepo.repo)
  assertEquals(updateRepo.cleared, ['attempt-1'])
  assertEquals(updateRepo.intentTransitions.length, 0)
})

Deno.test('idempotent: re-confirming an already-confirmed attempt produces the same outcome both times', async () => {
  const verifier = makeVerifier({ hash: REAL_TX, from: SENDER, to: KIT_ADAPTER, nonce: '0xc' }, { status: '0x1', blockNumber: '0x100' })
  const updateRepo = makeUpdateRepo()
  const first = await sweepSubmittedSwapAttempts([swapAttempt()], verifier, updateRepo.repo)
  const second = await sweepSubmittedSwapAttempts([swapAttempt()], verifier, updateRepo.repo)
  assertEquals(first[0].outcome, 'confirmed')
  assertEquals(second[0].outcome, 'confirmed')
})

Deno.test('one attempt failing does not stop the rest of the batch', async () => {
  const failingVerifier: TransactionVerifier = {
    getTransaction: (chainId) => chainId === 'bad' ? Promise.reject(new Error('boom')) : Promise.resolve({ hash: REAL_TX, from: SENDER, to: KIT_ADAPTER, nonce: '0xc' }),
    getReceipt: () => Promise.resolve({ status: '0x1', blockNumber: '0x100' }),
  }
  const updateRepo = makeUpdateRepo()
  const results = await sweepSubmittedSwapAttempts(
    [swapAttempt({ id: 'a', chainId: 'bad' }), swapAttempt({ id: 'b' })],
    failingVerifier,
    updateRepo.repo,
  )
  assertEquals(results.find(r => r.attemptId === 'a')?.outcome, 'missing')
  assertEquals(results.find(r => r.attemptId === 'b')?.outcome, 'confirmed')
})
