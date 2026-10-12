import { describe, it, expect, beforeEach } from 'vitest'
import { shouldHoldNavigation, leaveGuardLabel, requestLeave, useLeaveGuardStore, isLeaveGuarded } from './leaveGuard'

describe('shouldHoldNavigation', () => {
  it('lets everything through when no flow is busy', () => {
    expect(shouldHoldNavigation(false, '/multichain', '/')).toBe(false)
  })
  it('holds a change of page while busy', () => {
    expect(shouldHoldNavigation(true, '/multichain', '/')).toBe(true)
    expect(shouldHoldNavigation(true, '/chat/abc', '/chat/def')).toBe(true)
  })
  it('ignores same-page history steps (in-page sheets and query changes)', () => {
    expect(shouldHoldNavigation(true, '/multichain', '/multichain')).toBe(false)
  })
  it('never holds the lock or sign-in screens', () => {
    expect(shouldHoldNavigation(true, '/pay', '/auth/lock')).toBe(false)
    expect(shouldHoldNavigation(true, '/pay', '/auth')).toBe(false)
    expect(shouldHoldNavigation(true, '/pay', '/authors')).toBe(true)
  })
})

describe('leaveGuardLabel', () => {
  it('returns the most recent guard', () => {
    expect(leaveGuardLabel({})).toBeNull()
    expect(leaveGuardLabel({ 3: 'Transfer', 7: 'Swap' })).toBe('Swap')
  })
})

describe('requestLeave', () => {
  beforeEach(() => useLeaveGuardStore.setState({ guards: {}, ask: null }))

  it('runs onLeave only when Leave is chosen', () => {
    let left = 0
    requestLeave(() => { left++ })
    useLeaveGuardStore.getState().ask!.stay()
    expect(left).toBe(0)
    expect(useLeaveGuardStore.getState().ask).toBeNull()

    requestLeave(() => { left++ })
    useLeaveGuardStore.getState().ask!.leave()
    expect(left).toBe(1)
    expect(useLeaveGuardStore.getState().ask).toBeNull()
  })

  it('reports guarded state from the store', () => {
    expect(isLeaveGuarded()).toBe(false)
    useLeaveGuardStore.setState({ guards: { 1: 'Payment' } })
    expect(isLeaveGuarded()).toBe(true)
  })
})

describe('Back button pass-through', () => {
  it('lets exactly one chosen Back through', async () => {
    const { letNextBackThrough, takePassThrough } = await import('./leaveGuard')
    expect(takePassThrough()).toBe(false)
    letNextBackThrough()
    expect(takePassThrough()).toBe(true)
    expect(takePassThrough()).toBe(false)
  })
  it('only counts recent back steps the app made itself', async () => {
    const { takeAppPop } = await import('./leaveGuard')
    expect(takeAppPop()).toBe(false)
  })
})
