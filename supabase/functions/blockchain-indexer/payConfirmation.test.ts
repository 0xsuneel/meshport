// supabase/functions/blockchain-indexer/payConfirmation.test.ts
import { verifyAttemptConfirmation, sweepSubmittedAttempts } from './payConfirmation.ts'
import type { TransactionVerifier, ConfirmableAttempt, ConfirmationUpdateRepository, RawTransaction, RawTxReceipt } from './payConfirmation.ts'

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed${msg ? `: ${msg}` : ''}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`)
  }
}

const SENDER = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
const RECIPIENT = '0xebe52519a38e857a744e65d01f23137e22fb784b'
const EURC_CONTRACT = '0x89b50855aa3be2f677cd6303cec089b5f319d72a'
const REAL_TX = '0xaabbccdd0000000000000000000000000000000000000000000000000000'

function nativeAttempt(overrides: Partial<ConfirmableAttempt> = {}): ConfirmableAttempt {
  return { id: 'attempt-1', intentId: 'intent-1', chainId: 'arc', walletAddress: SENDER, nonce: 12, txHash: REAL_TX, expectedTo: RECIPIENT, ...overrides }
}
function erc20Attempt(overrides: Partial<ConfirmableAttempt> = {}): ConfirmableAttempt {
  return { id: 'attempt-2', intentId: 'intent-2', chainId: 'arc', walletAddress: SENDER, nonce: 13, txHash: REAL_TX, expectedTo: EURC_CONTRACT, ...overrides }
}

function makeVerifier(tx: RawTransaction | null, receipt: RawTxReceipt | null): TransactionVerifier {
  return { getTransaction: () => Promise.resolve(tx), getReceipt: () => Promise.resolve(receipt) }
}
function makeUpdateRepo() {
  const confirmed: Array<{ id: string; blockNumber: number }> = []
  const reverted: string[] = []
  const cleared: string[] = []
  const intentTransitions: Array<{ intentId: string; to: string }> = []
  const repo: ConfirmationUpdateRepository = {
    markConfirmed: (id, blockNumber) => { confirmed.push({ id, blockNumber }); return Promise.resolve() },
    markReverted: (id) => { reverted.push(id); return Promise.resolve() },
    clearForRecovery: (id) => { cleared.push(id); return Promise.resolve() },
    transitionIntent: (intentId, to) => { intentTransitions.push({ intentId, to }); return Promise.resolve() },
  }
  return { repo, confirmed, reverted, cleared, intentTransitions }
}

// ── Native Pay: expectedTo === recipient's own wallet ──────────────────────
Deno.test('native Pay: transaction.to === recipient wallet -> confirmed', async () => {
  const verifier = makeVerifier(
    { hash: REAL_TX, from: SENDER, to: RECIPIENT, nonce: '0xc' },
    { status: '0x1', blockNumber: '0x100' },
  )
  const result = await verifyAttemptConfirmation(verifier, nativeAttempt())
  assertEquals(result.outcome, 'confirmed')
})

Deno.test('native Pay: transaction.to === Multicall3 is REJECTED (not this attempt\'s expected `to`) -- proves Pay confirmation is not accidentally reusing BulkPay semantics', async () => {
  const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
  const verifier = makeVerifier(
    { hash: REAL_TX, from: SENDER, to: MULTICALL3, nonce: '0xc' },
    { status: '0x1', blockNumber: '0x100' },
  )
  const result = await verifyAttemptConfirmation(verifier, nativeAttempt())
  assertEquals(result.outcome, 'mismatch')
})

// ── ERC20 Pay: expectedTo === token contract, not the recipient ────────────
Deno.test('ERC20 Pay: transaction.to === token contract (not the recipient wallet) -> confirmed', async () => {
  const verifier = makeVerifier(
    { hash: REAL_TX, from: SENDER, to: EURC_CONTRACT, nonce: '0xd' },
    { status: '0x1', blockNumber: '0x100' },
  )
  const result = await verifyAttemptConfirmation(verifier, erc20Attempt())
  assertEquals(result.outcome, 'confirmed')
})

Deno.test('ERC20 Pay: transaction.to === the recipient wallet directly is REJECTED (the real destination for an ERC20 transfer is the token contract, not the recipient)', async () => {
  const verifier = makeVerifier(
    { hash: REAL_TX, from: SENDER, to: RECIPIENT, nonce: '0xd' },
    { status: '0x1', blockNumber: '0x100' },
  )
  const result = await verifyAttemptConfirmation(verifier, erc20Attempt())
  assertEquals(result.outcome, 'mismatch')
})

// ── Shared confirmation matrix (same guarantees as BulkPay's own, re-proven for Pay) ──
Deno.test('reverted receipt -> reverted', async () => {
  const verifier = makeVerifier({ hash: REAL_TX, from: SENDER, to: RECIPIENT, nonce: '0xc' }, { status: '0x0', blockNumber: '0x100' })
  const result = await verifyAttemptConfirmation(verifier, nativeAttempt())
  assertEquals(result.outcome, 'reverted')
})

Deno.test('missing transaction -> missing, NOT reverted, remains recoverable', async () => {
  const verifier = makeVerifier(null, null)
  const result = await verifyAttemptConfirmation(verifier, nativeAttempt())
  assertEquals(result.outcome, 'missing')
})

Deno.test('wrong sender -> mismatch', async () => {
  const verifier = makeVerifier({ hash: REAL_TX, from: '0xSomeoneElse', to: RECIPIENT, nonce: '0xc' }, { status: '0x1', blockNumber: '0x100' })
  const result = await verifyAttemptConfirmation(verifier, nativeAttempt())
  assertEquals(result.outcome, 'mismatch')
})

Deno.test('wrong nonce -> mismatch', async () => {
  const verifier = makeVerifier({ hash: REAL_TX, from: SENDER, to: RECIPIENT, nonce: '0xff' }, { status: '0x1', blockNumber: '0x100' })
  const result = await verifyAttemptConfirmation(verifier, nativeAttempt())
  assertEquals(result.outcome, 'mismatch')
})

Deno.test('receipt not yet available -> pending, no write', async () => {
  const verifier = makeVerifier({ hash: REAL_TX, from: SENDER, to: RECIPIENT, nonce: '0xc' }, null)
  const updateRepo = makeUpdateRepo()
  const results = await sweepSubmittedAttempts([nativeAttempt()], verifier, updateRepo.repo)
  assertEquals(results[0].outcome, 'pending')
  assertEquals(updateRepo.confirmed.length, 0)
})

Deno.test('confirming an attempt also transitions its parent intent SUBMITTED -> CONFIRMED', async () => {
  const verifier = makeVerifier({ hash: REAL_TX, from: SENDER, to: RECIPIENT, nonce: '0xc' }, { status: '0x1', blockNumber: '0x37daf32' })
  const updateRepo = makeUpdateRepo()
  await sweepSubmittedAttempts([nativeAttempt({ intentId: 'intent-xyz' })], verifier, updateRepo.repo)
  assertEquals(updateRepo.intentTransitions, [{ intentId: 'intent-xyz', to: 'CONFIRMED' }])
  assertEquals(updateRepo.confirmed, [{ id: 'attempt-1', blockNumber: 58568498 }])
})

Deno.test('reverting also transitions the parent intent SUBMITTED -> FAILED', async () => {
  const verifier = makeVerifier({ hash: REAL_TX, from: SENDER, to: RECIPIENT, nonce: '0xc' }, { status: '0x0', blockNumber: '0x100' })
  const updateRepo = makeUpdateRepo()
  await sweepSubmittedAttempts([nativeAttempt({ intentId: 'intent-xyz' })], verifier, updateRepo.repo)
  assertEquals(updateRepo.intentTransitions, [{ intentId: 'intent-xyz', to: 'FAILED' }])
  assertEquals(updateRepo.reverted, ['attempt-1'])
})

Deno.test('a mismatch clears the attempt for the EXISTING nonce-recovery mechanism to resolve — does not transition the intent', async () => {
  const verifier = makeVerifier({ hash: REAL_TX, from: SENDER, to: '0xADifferentDestination', nonce: '0xc' }, { status: '0x1', blockNumber: '0x100' })
  const updateRepo = makeUpdateRepo()
  await sweepSubmittedAttempts([nativeAttempt()], verifier, updateRepo.repo)
  assertEquals(updateRepo.cleared, ['attempt-1'])
  assertEquals(updateRepo.intentTransitions.length, 0)
})

Deno.test('idempotent: re-confirming an already-confirmed attempt produces the same outcome both times', async () => {
  const verifier = makeVerifier({ hash: REAL_TX, from: SENDER, to: RECIPIENT, nonce: '0xc' }, { status: '0x1', blockNumber: '0x100' })
  const updateRepo = makeUpdateRepo()
  const first = await sweepSubmittedAttempts([nativeAttempt()], verifier, updateRepo.repo)
  const second = await sweepSubmittedAttempts([nativeAttempt()], verifier, updateRepo.repo)
  assertEquals(first[0].outcome, 'confirmed')
  assertEquals(second[0].outcome, 'confirmed')
})

Deno.test('one attempt failing does not stop the rest of the batch', async () => {
  const failingVerifier: TransactionVerifier = {
    getTransaction: (chainId) => chainId === 'bad' ? Promise.reject(new Error('boom')) : Promise.resolve({ hash: REAL_TX, from: SENDER, to: RECIPIENT, nonce: '0xc' }),
    getReceipt: () => Promise.resolve({ status: '0x1', blockNumber: '0x100' }),
  }
  const updateRepo = makeUpdateRepo()
  const results = await sweepSubmittedAttempts(
    [nativeAttempt({ id: 'a', chainId: 'bad' }), nativeAttempt({ id: 'b' })],
    failingVerifier,
    updateRepo.repo,
  )
  assertEquals(results.find(r => r.attemptId === 'a')?.outcome, 'missing')
  assertEquals(results.find(r => r.attemptId === 'b')?.outcome, 'confirmed')
})
