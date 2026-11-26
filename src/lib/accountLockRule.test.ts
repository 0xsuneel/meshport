import { describe, it, expect } from 'vitest'
import {
  computeAccountLock, isLockedPath,
} from './accountLockRule'
import { filterServices } from './searchServices'

const loaded = (accountType: 'personal' | 'business', status: any) => ({ loaded: true, accountType, status })
const notLoaded = { loaded: false, accountType: 'personal' as const, status: 'none' as const }

describe('computeAccountLock - loaded', () => {
  it('a business takes payments only once approved', () => {
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
  it('locks only the screens that take payments', () => {
    for (const p of ['/receive', '/receive/requests', '/splits', '/splits/abc']) expect(isLockedPath(p), p).toBe(true)
  })
  it('never locks sending, swapping, cross-chain, P2P or anything else - a business always controls its money', () => {
    for (const p of ['/', '/pay', '/pay?to=bob', '/pay-send', '/paylink/bob', '/scanner', '/swap', '/multichain', '/multichain-transfer',
      '/bulk-payout', '/p2p', '/p2p/trade/1', '/chat', '/chat/123', '/activity', '/notifications', '/profile', '/security',
      '/business', '/business?apply=1', '/merchant', '/payments', '/payouts', '/receiver']) {
      expect(isLockedPath(p), p).toBe(false)
    }
  })
})


describe('filterServices while locked', () => {
  it('leaves out only the services that take payments', () => {
    expect(filterServices('pay', false, true).map(s => s.path)).toContain('/pay')
    expect(filterServices('receive', false, false).map(s => s.path)).toContain('/receive')
    expect(filterServices('receive', false, true).map(s => s.path)).not.toContain('/receive')
    expect(filterServices('activity', false, true).map(s => s.path)).toEqual(['/activity'])
  })
})
