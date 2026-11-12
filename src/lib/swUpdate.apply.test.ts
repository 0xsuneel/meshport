import { describe, it, expect } from 'vitest'
import { decideApply, isBeforeWallet, QUIET_SWITCH_AFTER_HIDDEN_MS } from './swUpdate'

const base = { visible: true, hiddenForMs: 0, resting: true, onLock: false, lockTouched: false }

describe('when a new version is applied - never while the app is being used', () => {
  it('in use on screen: only the optional "Update ready" pill', () => {
    expect(decideApply(base)).toBe('pill')
    expect(decideApply({ ...base, resting: false })).toBe('pill')
  })
  it('lock screen, nothing typed yet: now (the unlock opens the new version)', () => {
    expect(decideApply({ ...base, onLock: true })).toBe('now')
  })
  it('lock screen with a passcode being typed: never under their fingers', () => {
    expect(decideApply({ ...base, onLock: true, lockTouched: true })).toBe('pill')
  })
  it('in the background about a minute on a resting screen: quietly', () => {
    expect(QUIET_SWITCH_AFTER_HIDDEN_MS).toBe(60_000)
    expect(decideApply({ ...base, visible: false, hiddenForMs: 60_000 })).toBe('quiet')
    expect(decideApply({ ...base, visible: false, hiddenForMs: 30_000 })).toBe('wait')
  })
  it('in the background on a screen where money can be moving: wait', () => {
    expect(decideApply({ ...base, visible: false, hiddenForMs: 10 * 60_000, resting: false })).toBe('wait')
  })
})

describe('before there is a wallet (landing, sign-in / sign-up, wallet choice)', () => {
  it('a new user is switched to the newest version at once - taps or not', () => {
    expect(decideApply({ ...base, beforeWallet: true })).toBe('now')
    expect(decideApply({ ...base, beforeWallet: true, visible: false })).toBe('now')
  })
  it('but never while something is being typed', () => {
    expect(decideApply({ ...base, beforeWallet: true, typing: true })).toBe('wait')
  })
})

describe('isBeforeWallet', () => {
  it('landing, sign-in / sign-up and the wallet choice, with no wallet', () => {
    for (const p of ['/', '/auth', '/auth/', '/auth/wallet-setup']) expect(isBeforeWallet(p, false)).toBe(true)
  })
  it('not once a wallet is being made or exists', () => {
    for (const p of ['/auth/create-wallet', '/auth/import-wallet', '/auth/passcode', '/auth/claim-username', '/pay']) expect(isBeforeWallet(p, false)).toBe(false)
    expect(isBeforeWallet('/', true)).toBe(false)
    expect(isBeforeWallet('/auth', true)).toBe(false)
  })
})
