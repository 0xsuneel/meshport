import { describe, it, expect } from 'vitest'
import { moveBreakdown, formatFee } from './moveFees'

describe('moveBreakdown', () => {
  it('CCTP bring: sent includes MeshPort fee, Circle fee is the burn-to-mint gap', () => {
    // Real Base bring: burned 9.937232, minted 9.911358 (Circle 0.025874), MeshPort 0.00078.
    const m = moveBreakdown('bring', { amount: 9.911358, arrivedAmount: 9.911358, claimedAmount: 9.937232, meshportFee: 0.00078 })!
    expect(m.sent).toBe(9.938012)
    expect(m.received).toBe(9.911358)
    expect(m.networkFee).toBe(0.025874)
    expect(m.meshportFee).toBe(0.00078)
    expect(m.fees).toBe(0.026654)
  })

  it('bring without a recorded MeshPort fee shows only the network fee', () => {
    const m = moveBreakdown('bring', { amount: 9.968593, claimedAmount: 9.99922 })!
    expect(m.sent).toBe(9.99922)
    expect(m.fees).toBe(0.030627)
    expect(m.meshportFee).toBe(0)
  })

  it('transfer: receiver got the arrived amount', () => {
    const m = moveBreakdown('transfer', { amount: 10, arrivedAmount: 9.99615 })!
    expect(m.received).toBe(9.99615)
    expect(m.fees).toBe(0.00385)
  })

  it('no arrived amount, still pending, or arrived above sent: nothing shown', () => {
    expect(moveBreakdown('transfer', { amount: 10 })).toBeNull()
    expect(moveBreakdown('transfer', { amount: 10, arrivedAmount: 9.9, status: 'pending' })).toBeNull()
    expect(moveBreakdown('transfer', { amount: 1, arrivedAmount: 2 })).toBeNull()
    expect(moveBreakdown('bring', { amount: 5, claimedAmount: 4 })).toBeNull()
  })
})

describe('formatFee', () => {
  it('keeps small fees readable', () => {
    expect(formatFee(0)).toBe('$0')
    expect(formatFee(0.00385)).toBe('$0.0039')
    expect(formatFee(0.025874)).toBe('$0.0259')
    expect(formatFee(0.5)).toBe('$0.5')
    expect(formatFee(1.0178)).toBe('$1.02')
  })
})
