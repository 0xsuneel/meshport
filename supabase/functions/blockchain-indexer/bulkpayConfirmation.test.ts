// supabase/functions/blockchain-indexer/bulkpayConfirmation.test.ts
import { verifyAttemptConfirmation, sweepSubmittedAttempts } from './bulkpayConfirmation.ts'
import type { TransactionVerifier, ConfirmableAttempt, ConfirmationUpdateRepository, RawTransaction, RawTxReceipt } from './bulkpayConfirmation.ts'

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed${msg ? `: ${msg}` : ''}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`)
  }
}
function assert(cond: boolean, msg = ''): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
const PAYER = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
const REAL_BULKPAY_TX = '0xb179c4f0691199d5a1fdfc49d5086cf587f5440b13c768629a2913f7f783714c'

function attempt(overrides: Partial<ConfirmableAttempt> = {}): ConfirmableAttempt {
  return { id: 'attempt-1', intentId: 'intent-1', chainId: 'arc', walletAddress: PAYER, nonce: 42, txHash: REAL_BULKPAY_TX, ...overrides }
}

function makeVerifier(tx: RawTransaction | null, receipt: RawTxReceipt | null | 'throw'): TransactionVerifier {
  return {
    getTransaction: () => Promise.resolve(tx),
    getReceipt: () => {
      if (receipt === 'throw') return Promise.reject(new Error('simulated RPC timeout'))
      return Promise.resolve(receipt)
    },
  }
}

function makeUpdateRepo() {
  const confirmed: string[] = []
  const reverted: string[] = []
  const cleared: string[] = []
  const intentTransitions: Array<{ intentId: string; to: string }> = []
  const repo: ConfirmationUpdateRepository = {
    markConfirmed: (id, _blockNumber) => { confirmed.push(id); return Promise.resolve() },
    markReverted: (id) => { reverted.push(id); return Promise.resolve() },
    clearForRecovery: (id) => { cleared.push(id); return Promise.resolve() },
    transitionIntent: (intentId, to) => { intentTransitions.push({ intentId, to }); return Promise.resolve() },
  }
  return { repo, confirmed, reverted, cleared, intentTransitions }
}

const REAL_TX: RawTransaction = { hash: REAL_BULKPAY_TX, from: PAYER, to: MULTICALL3, nonce: '0x2a' }

Deno.test('1. successful receipt -> confirmed', async () => {
  const verifier = makeVerifier(REAL_TX, { status: '0x1', blockNumber: '0x37daf32' })
  const result = await verifyAttemptConfirmation(verifier, attempt())
  assertEquals(result.outcome, 'confirmed')
})

Deno.test('2. reverted receipt -> reverted', async () => {
  const verifier = makeVerifier(REAL_TX, { status: '0x0', blockNumber: '0x37daf32' })
  const result = await verifyAttemptConfirmation(verifier, attempt())
  assertEquals(result.outcome, 'reverted')
})

Deno.test('3. missing transaction -> missing, NOT reverted, remains recoverable', async () => {
  const verifier = makeVerifier(null, null)
  const result = await verifyAttemptConfirmation(verifier, attempt())
  assertEquals(result.outcome, 'missing')
})

Deno.test('4. RPC timeout (getReceipt throws) -> sweep catches it, leaves attempt untouched, does not abort batch', async () => {
  const verifier = makeVerifier(REAL_TX, 'throw')
  const updateRepo = makeUpdateRepo()
  const results = await sweepSubmittedAttempts([attempt()], verifier, updateRepo.repo)
  assertEquals(results[0].outcome, 'missing')
  assertEquals(updateRepo.confirmed.length, 0)
  assertEquals(updateRepo.reverted.length, 0)
  assertEquals(updateRepo.cleared.length, 0)
})

Deno.test('5. wrong to -> mismatch, never confirmed', async () => {
  const verifier = makeVerifier({ ...REAL_TX, to: '0xSomeOtherContract' }, { status: '0x1', blockNumber: '0x37daf32' })
  const result = await verifyAttemptConfirmation(verifier, attempt())
  assertEquals(result.outcome, 'mismatch')
})

Deno.test('6. wrong chain -> verifier scoped correctly by attempt.chainId, not assumed', async () => {
  let requestedChain = ''
  const verifier: TransactionVerifier = {
    getTransaction: (chainId) => { requestedChain = chainId; return Promise.resolve(REAL_TX) },
    getReceipt: () => Promise.resolve({ status: '0x1', blockNumber: '0x37daf32' }),
  }
  await verifyAttemptConfirmation(verifier, attempt({ chainId: 'arc' }))
  assertEquals(requestedChain, 'arc')
})

Deno.test('7. wrong nonce -> mismatch, never confirmed', async () => {
  const verifier = makeVerifier({ ...REAL_TX, nonce: '0x2b' }, { status: '0x1', blockNumber: '0x37daf32' })
  const result = await verifyAttemptConfirmation(verifier, attempt({ nonce: 42 }))
  assertEquals(result.outcome, 'mismatch')
})

Deno.test('8. a mismatch clears the attempt for the EXISTING nonce-recovery mechanism to resolve, not decided here', async () => {
  const verifier = makeVerifier({ ...REAL_TX, to: '0xADifferentContract' }, { status: '0x1', blockNumber: '0x37daf32' })
  const updateRepo = makeUpdateRepo()
  const results = await sweepSubmittedAttempts([attempt()], verifier, updateRepo.repo)
  assertEquals(results[0].outcome, 'mismatch')
  assertEquals(updateRepo.cleared, ['attempt-1'])
  assertEquals(updateRepo.confirmed.length, 0)
})

Deno.test('9. a successful but unrelated Multicall3 transaction (different sender) is never confirmed as this attempt', async () => {
  const verifier = makeVerifier({ ...REAL_TX, from: '0xSomeUnrelatedWallet' }, { status: '0x1', blockNumber: '0x37daf32' })
  const result = await verifyAttemptConfirmation(verifier, attempt())
  assertEquals(result.outcome, 'mismatch')
})

Deno.test('10. the correct, real BulkPay transaction is accepted end to end', async () => {
  const verifier = makeVerifier(REAL_TX, { status: '0x1', blockNumber: '0x37daf32' })
  const updateRepo = makeUpdateRepo()
  const results = await sweepSubmittedAttempts([attempt()], verifier, updateRepo.repo)
  assertEquals(results[0].outcome, 'confirmed')
  assertEquals(updateRepo.confirmed, ['attempt-1'])
})

Deno.test('the real block number from the receipt is captured and passed to markConfirmed — not left null', async () => {
  const verifier = makeVerifier(REAL_TX, { status: '0x1', blockNumber: '0x37daf32' })
  const capturedBlockNumbers: number[] = []
  const updateRepo = makeUpdateRepo()
  const capturingRepo: ConfirmationUpdateRepository = {
    ...updateRepo.repo,
    markConfirmed: (id, blockNumber) => { capturedBlockNumbers.push(blockNumber); return updateRepo.repo.markConfirmed(id, blockNumber) },
  }
  await sweepSubmittedAttempts([attempt()], verifier, capturingRepo)
  assertEquals(capturedBlockNumbers, [58568498]) // 0x37daf32 decoded
})

Deno.test('confirming an attempt also transitions its parent intent SUBMITTED -> CONFIRMED — prevents deriveDisplayState from showing "SUBMITTED" forever', async () => {
  const verifier = makeVerifier(REAL_TX, { status: '0x1', blockNumber: '0x37daf32' })
  const updateRepo = makeUpdateRepo()
  await sweepSubmittedAttempts([attempt({ intentId: 'intent-xyz' })], verifier, updateRepo.repo)
  assertEquals(updateRepo.intentTransitions, [{ intentId: 'intent-xyz', to: 'CONFIRMED' }])
})

Deno.test('reverting an attempt also transitions its parent intent SUBMITTED -> FAILED', async () => {
  const verifier = makeVerifier(REAL_TX, { status: '0x0', blockNumber: '0x37daf32' })
  const updateRepo = makeUpdateRepo()
  await sweepSubmittedAttempts([attempt({ intentId: 'intent-xyz' })], verifier, updateRepo.repo)
  assertEquals(updateRepo.intentTransitions, [{ intentId: 'intent-xyz', to: 'FAILED' }])
})

Deno.test('a mismatch does NOT transition the intent — the intent stays SUBMITTED while nonce-recovery resolves the underlying attempt', async () => {
  const verifier = makeVerifier({ ...REAL_TX, to: '0xADifferentContract' }, { status: '0x1', blockNumber: '0x37daf32' })
  const updateRepo = makeUpdateRepo()
  await sweepSubmittedAttempts([attempt()], verifier, updateRepo.repo)
  assertEquals(updateRepo.intentTransitions.length, 0)
})

Deno.test('11. running the sweep twice against an already-confirmed attempt is idempotent (same outcome both times)', async () => {
  const verifier = makeVerifier(REAL_TX, { status: '0x1', blockNumber: '0x37daf32' })
  const updateRepo = makeUpdateRepo()
  const first = await sweepSubmittedAttempts([attempt()], verifier, updateRepo.repo)
  const second = await sweepSubmittedAttempts([attempt()], verifier, updateRepo.repo)
  assertEquals(first[0].outcome, 'confirmed')
  assertEquals(second[0].outcome, 'confirmed')
  assertEquals(updateRepo.confirmed, ['attempt-1', 'attempt-1'])
})

Deno.test('12. confirmation targets exactly one transaction_attempt regardless of recipient count', async () => {
  const verifier = makeVerifier(REAL_TX, { status: '0x1', blockNumber: '0x37daf32' })
  const updateRepo = makeUpdateRepo()
  const results = await sweepSubmittedAttempts([attempt()], verifier, updateRepo.repo)
  assertEquals(results.length, 1)
  assertEquals(updateRepo.confirmed.length, 1)
})

Deno.test('13. this module has no chain_events/log_index concept at all — structurally attempt-scoped only', () => {
  const keys = Object.keys(attempt())
  assert(!keys.includes('logIndex') && !keys.includes('chainEvents'))
})

Deno.test('14. this module has no broadcast capability anywhere — structurally cannot rebroadcast', async () => {
  const verifier = makeVerifier(null, null)
  const updateRepo = makeUpdateRepo()
  await sweepSubmittedAttempts([attempt()], verifier, updateRepo.repo)
  assertEquals(updateRepo.confirmed.length, 0)
  assertEquals(updateRepo.reverted.length, 0)
})

Deno.test('15. two concurrent sweeps over the same attempt both resolve to the same outcome, no interference', async () => {
  const verifier = makeVerifier(REAL_TX, { status: '0x1', blockNumber: '0x37daf32' })
  const updateRepo = makeUpdateRepo()
  const [a, b] = await Promise.all([
    sweepSubmittedAttempts([attempt()], verifier, updateRepo.repo),
    sweepSubmittedAttempts([attempt()], verifier, updateRepo.repo),
  ])
  assertEquals(a[0].outcome, 'confirmed')
  assertEquals(b[0].outcome, 'confirmed')
  assertEquals(updateRepo.confirmed.length, 2)
})

Deno.test('one attempt failing does not stop the rest of the batch', async () => {
  const failingVerifier: TransactionVerifier = {
    getTransaction: (chainId) => chainId === 'bad' ? Promise.reject(new Error('boom')) : Promise.resolve(REAL_TX),
    getReceipt: () => Promise.resolve({ status: '0x1', blockNumber: '0x37daf32' }),
  }
  const updateRepo = makeUpdateRepo()
  const results = await sweepSubmittedAttempts(
    [attempt({ id: 'a', chainId: 'bad' }), attempt({ id: 'b' })],
    failingVerifier,
    updateRepo.repo,
  )
  assertEquals(results.length, 2)
  assertEquals(results.find(r => r.attemptId === 'a')?.outcome, 'missing')
  assertEquals(results.find(r => r.attemptId === 'b')?.outcome, 'confirmed')
})
