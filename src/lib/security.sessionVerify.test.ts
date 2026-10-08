// Passcodes already verified in this session are answered from memory, so a
// payment approval doesn't redo the 600k-round PBKDF2 check every time.
import { describe, it, expect, vi, beforeEach } from 'vitest'

function installLocalStorage() {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
}

import { hashPasscode, verifyPasscode, markPasscodeVerified, isPasscodeVerifiedThisSession, forgetVerifiedPasscodes } from './security'

describe('session passcode verification', () => {
  beforeEach(() => { installLocalStorage(); forgetVerifiedPasscodes() })

  it('a second check of the same passcode is instant', async () => {
    const hash = await hashPasscode('123456')
    let t = performance.now()
    expect(await verifyPasscode('123456', hash)).toBe(true)
    const full = performance.now() - t
    t = performance.now()
    expect(await verifyPasscode('123456', hash)).toBe(true)
    const cached = performance.now() - t
    expect(cached).toBeLessThan(full / 5)
  })

  it('never remembers a wrong passcode, and is tied to the stored hash', async () => {
    const hash = await hashPasscode('123456')
    expect(await verifyPasscode('000000', hash)).toBe(false)
    expect(await isPasscodeVerifiedThisSession('000000', hash)).toBe(false)
    await verifyPasscode('123456', hash)
    const other = await hashPasscode('123456') // same passcode, new hash (e.g. after a change)
    expect(await isPasscodeVerifiedThisSession('123456', other)).toBe(false)
  })

  it('lock / sign-out forgets everything', async () => {
    const hash = await hashPasscode('123456')
    await verifyPasscode('123456', hash)
    expect(await isPasscodeVerifiedThisSession('123456', hash)).toBe(true)
    forgetVerifiedPasscodes()
    expect(await isPasscodeVerifiedThisSession('123456', hash)).toBe(false)
  })

  it('a biometric-confirmed passcode counts as verified without the full check', async () => {
    const hash = await hashPasscode('123456')
    await markPasscodeVerified('123456', hash)
    const t = performance.now()
    expect(await verifyPasscode('123456', hash)).toBe(true)
    expect(performance.now() - t).toBeLessThan(50)
  })
})
