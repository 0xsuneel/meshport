import { describe, it, expect } from 'vitest'
import { depositOutcomeUnknownTx } from './ubDepositOutcome'

const HASH = '0x' + 'ab'.repeat(32)

describe('depositOutcomeUnknownTx (App Kit 1.23 "Deposit outcome unknown")', () => {
  it('returns the broadcast deposit hash from the kit error', () => {
    const e = Object.assign(new Error('Deposit outcome unknown: timeout. The Gateway allowance was not revoked because the deposit may still execute on-chain. Check its status before retrying.'),
      { cause: { trace: { txHash: HASH } } })
    expect(depositOutcomeUnknownTx(e)).toBe(HASH)
  })
  it('ignores other errors, and unknown outcomes without a usable hash', () => {
    expect(depositOutcomeUnknownTx(new Error('User rejected'))).toBeNull()
    expect(depositOutcomeUnknownTx(Object.assign(new Error('Deposit outcome unknown: x'), { cause: { trace: { challengeId: 'c1' } } }))).toBeNull()
    expect(depositOutcomeUnknownTx(Object.assign(new Error('Deposit outcome unknown: x'), { cause: { trace: { txHash: '0x12' } } }))).toBeNull()
    expect(depositOutcomeUnknownTx(null)).toBeNull()
  })
})
