import { describe, it, expect, afterEach } from 'vitest'
import {
  computeAccountLock, isLockedPath, isAccountLockedNow, assertAccountUnlocked, registerAccountLockProbe, ACCOUNT_LOCKED_MESSAGE,
} from './accountLockRule'
import { filterServices } from './searchServices'

const loaded = (accountType: 'personal' | 'business', status: any) => ({ loaded: true, accountType, status })
const notLoaded = { loaded: false, accountType: 'personal' as const, status: 'none' as const }

describe('computeAccountLock - loaded', () => {
  it('locks business accounts until approved', () => {
    for (const status of ['none', 'pending', 'rejected', 'revoked'] as const) {
      expect(computeAccountLock(loaded('business', status), null)).toEqual({ locked: true, loaded: true, unknown: false, reason: status })
    }
  })
  it('leaves approved businesses unlocked', () => {
    expect(computeAccountLock(loaded('business', 'approved'), null).locked).toBe(false)
  })
  it('never locks personal accounts (incl. staff and older merchants who applied as personal)', () => {
    for (const status of ['none', 'pending', 'approved', 'rejected', 'revoked'] as const) {
      expect(computeAccountLock(loaded('personal', status), null).locked).toBe(false)
    }
  })
  it('the loaded state wins over a stale hint', () => {
    expect(computeAccountLock(loaded('business', 'pending'), { approved: true, business: true }).locked).toBe(true)
    expect(computeAccountLock(loaded('business', 'approved'), { approved: false, business: true }).locked).toBe(false)
  })
})

describe('computeAccountLock - before the status loads', () => {
  it('approved hint: no flash-lock', () => {
    expect(computeAccountLock(notLoaded, { approved: true, business: true })).toMatchObject({ locked: false, unknown: false, loaded: false })
    expect(computeAccountLock(notLoaded, { approved: true, business: null })).toMatchObject({ locked: false, unknown: false })
  })
  it('unapproved business hint: locked straight away', () => {
    expect(computeAccountLock(notLoaded, { approved: false, business: true })).toMatchObject({ locked: true, unknown: false, loaded: false })
  })
  it('personal hint: unlocked', () => {
    expect(computeAccountLock(notLoaded, { approved: false, business: false })).toMatchObject({ locked: false, unknown: false })
  })
  it('no hint (or an old hint without the account type): unknown - money actions wait', () => {
    expect(computeAccountLock(notLoaded, null)).toMatchObject({ locked: false, unknown: true })
    expect(computeAccountLock(notLoaded, { approved: false, business: null })).toMatchObject({ locked: false, unknown: true })
  })
})

describe('isLockedPath', () => {
  it('locks the money and feature routes', () => {
    for (const p of ['/pay', '/pay?to=bob', '/pay-send', '/paylink/bob', '/paylink/r/abc', '/scanner', '/receive', '/receive/requests',
      '/swap', '/multichain', '/multichain-recovery', '/bulk-payout', '/p2p', '/p2p/trade/1', '/chat', '/chat/123', '/rewards',
      '/insights', '/recent-paid', '/asset/USDC', '/news', '/news/1']) {
      expect(isLockedPath(p), p).toBe(true)
    }
  })
  it('keeps the allowed routes open', () => {
    for (const p of ['/', '/activity', '/activity/abc', '/notifications', '/profile', '/edit-profile', '/security', '/security/change-passcode',
      '/backup', '/appearance', '/help-support', '/feature-guide', '/about', '/terms-privacy', '/legal', '/terms', '/privacy',
      '/business', '/business?apply=1', '/merchant', '/auth/lock', '/payments', '/payouts']) {
      expect(isLockedPath(p), p).toBe(false)
    }
  })
})

describe('isAccountLockedNow / assertAccountUnlocked', () => {
  afterEach(() => registerAccountLockProbe(() => false))
  it('defaults to unlocked', () => {
    expect(isAccountLockedNow()).toBe(false)
    expect(() => assertAccountUnlocked()).not.toThrow()
  })
  it('throws the approval message when locked', () => {
    registerAccountLockProbe(() => true)
    expect(isAccountLockedNow()).toBe(true)
    expect(() => assertAccountUnlocked()).toThrow(ACCOUNT_LOCKED_MESSAGE)
  })
  it('a failing probe never locks', () => {
    registerAccountLockProbe(() => { throw new Error('x') })
    expect(isAccountLockedNow()).toBe(false)
  })
})

describe('filterServices while locked', () => {
  it('leaves out locked services', () => {
    expect(filterServices('pay', false, false).map(s => s.path)).toContain('/pay')
    expect(filterServices('pay', false, true)).toEqual([])
    expect(filterServices('activity', false, true).map(s => s.path)).toEqual(['/activity'])
  })
})
