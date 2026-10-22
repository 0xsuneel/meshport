import { describe, it, expect } from 'vitest'
import { classifyFailure, classifyPreBroadcastFailure, cleanErrorText, needsRecovery, revertReason, FAILURE_MESSAGES } from './failure'

const c = (msg: string, extra: Record<string, unknown> = {}) => classifyFailure(Object.assign(new Error(msg), extra))

describe('classifyFailure', () => {
  it('reverted on-chain is definite, with the contract reason when there is one', () => {
    expect(classifyFailure(null, { reverted: true })).toEqual({ code: 'reverted', definite: true, message: FAILURE_MESSAGES.reverted })
    const f = c('The contract function "release" reverted with the following reason:\ninvalid trade amount\n\nContract Call:\n  address: 0xabc')
    expect(f).toMatchObject({ code: 'reverted', definite: true })
    expect(f.message).toBe('Rejected on-chain: Invalid trade amount - nothing was sent.')
    expect(c('release: transaction 0x12 was mined but reverted on-chain (status: reverted)').code).toBe('reverted')
  })
  it('money / gas / nonce / wallet reasons', () => {
    expect(c('insufficient funds for gas * price + value').code).toBe('insufficient_gas')
    expect(c('Insufficient USDC balance').code).toBe('insufficient_funds')
    expect(c('Exceeds available balance').code).toBe('insufficient_funds')
    expect(c('nonce too low').code).toBe('nonce')
    expect(c("Couldn't access your wallet on this device to release funds.").code).toBe('wallet_unavailable')
    expect(c('P2P escrow is currently paused by an admin.').code).toBe('paused')
    expect(c('Transaction rejected').code).toBe('rejected')
  })
  it('swap reasons', () => {
    expect(c('Too little received').code).toBe('slippage')
    expect(c('Quote expired, please refresh').code).toBe('quote_expired')
  })
  it('uncertain outcomes are never definite (Architecture rule 5)', () => {
    for (const m of ['Not confirmed yet - it may still complete. Check Activity before retrying.', 'Timed out while waiting for transaction', 'Failed to fetch', '502 Bad Gateway']) {
      expect(c(m).definite).toBe(false)
    }
    expect(classifyFailure(Object.assign(new Error('x'), { isUncertain: true })).definite).toBe(false)
  })
  it('a cancelled wallet prompt is not a failure', () => {
    expect(c('User rejected the request.')).toMatchObject({ code: 'cancelled', definite: false })
  })
  it('unknown errors keep their own words, on one line', () => {
    const f = c('Something odd happened\nDetails: blah\nVersion: viem@2')
    expect(f).toMatchObject({ code: 'unknown', definite: true, message: 'Something odd happened - nothing was sent.' })
  })
  it('before broadcast, a lost connection is a definite "nothing was sent"', () => {
    expect(classifyPreBroadcastFailure(new Error('Failed to fetch'))).toMatchObject({ code: 'service_unavailable', definite: true })
  })
})

describe('helpers', () => {
  it('cleanErrorText drops the request dump and shortens addresses', () => {
    expect(cleanErrorText('Bad thing for 0x1234567890abcdef1234567890abcdef12345678\nRequest Arguments:\n from: 0x')).toBe('Bad thing for 0x1234…5678')
  })
  it('revertReason ignores raw hex data', () => {
    expect(revertReason('execution reverted: 0x08c379a0')).toBeNull()
    expect(revertReason("reverted with reason string 'Not seller'")).toBe('Not seller')
  })
  it('needsRecovery: only Transfer / Bring rows whose money already moved', () => {
    expect(needsRecovery({ activityType: 'bridge', status: 'failed', metadata: {} })).toBe(true)
    expect(needsRecovery({ activityType: 'claim', status: 'failed', metadata: { nothing_moved: true } })).toBe(false)
    expect(needsRecovery({ activityType: 'send', status: 'failed', metadata: {} })).toBe(false)
    expect(needsRecovery({ activityType: 'bridge', status: 'pending', metadata: {} })).toBe(false)
    expect(needsRecovery({ activityType: 'withdraw', status: 'pending', metadata: { ub_stuck_transfer: true } })).toBe(true)
    expect(needsRecovery({ activityType: 'withdraw', status: 'completed', metadata: { ub_stuck_transfer: false } })).toBe(false)
  })
})
