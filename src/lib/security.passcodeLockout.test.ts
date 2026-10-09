// src/lib/security.passcodeLockout.test.ts
//
// Regression guard for a /cso audit finding: verifyPasscode() had no
// brute-force protection at all. Each PBKDF2-100k check is single-digit
// milliseconds in WebCrypto, so a script with localStorage/devtools access
// could exhaust all 10^6 six-digit codes well under an hour with nothing to
// stop it. Fix: a persisted (per-device) failed-attempt counter that locks
// further attempts out with exponential backoff after 5 wrong guesses,
// reset on any correct guess.

import { describe, it, expect, vi, beforeEach } from 'vitest'

/** In-memory localStorage - same stub pattern as security.mnemonicEncryption.test.ts. */
function installLocalStorage() {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
  return store
}

import { hashPasscode, verifyPasscode, getPasscodeLockoutRemainingMs, clearPasscodeLockout } from './security'

describe('passcode brute-force lockout', () => {
  beforeEach(() => { installLocalStorage() })

  it('the attack: 6 wrong guesses in a row get progressively locked out, blocking further guesses even the CORRECT passcode', async () => {
    const hash = await hashPasscode('654321')

    // 4 wrong guesses allowed before the 5th trips the lockout.
    for (let i = 0; i < 4; i++) {
      expect(await verifyPasscode('000000', hash)).toBe(false)
    }
    expect(getPasscodeLockoutRemainingMs()).toBe(0)

    // The 5th wrong guess trips the lockout.
    expect(await verifyPasscode('000000', hash)).toBe(false)
    expect(getPasscodeLockoutRemainingMs()).toBeGreaterThan(0)

    // Proof the attack is actually closed: even the CORRECT passcode is
    // rejected while locked out - a brute-force script gets no signal
    // distinguishing "wrong" from "right but locked", and can't just keep
    // guessing through the lockout.
    expect(await verifyPasscode('654321', hash)).toBe(false)
  })

  it('legit unlock: the correct passcode on the first try is never throttled and clears any prior fail count', async () => {
    const hash = await hashPasscode('111222')
    expect(await verifyPasscode('111222', hash)).toBe(true)
    expect(getPasscodeLockoutRemainingMs()).toBe(0)

    // A couple of wrong guesses, then the correct one - should still work
    // (below the 5-attempt threshold) and reset the counter.
    expect(await verifyPasscode('000000', hash)).toBe(false)
    expect(await verifyPasscode('999999', hash)).toBe(false)
    expect(await verifyPasscode('111222', hash)).toBe(true)
    expect(getPasscodeLockoutRemainingMs()).toBe(0)
  })

  it('lockout duration grows on repeated lockouts (exponential backoff), not a flat one-time delay', async () => {
    const hash = await hashPasscode('000001')
    // Trip the first lockout (5 wrong + 1 more).
    for (let i = 0; i < 6; i++) await verifyPasscode('999999', hash)
    const firstLockoutMs = getPasscodeLockoutRemainingMs()
    expect(firstLockoutMs).toBeGreaterThan(0)

    // Simulate the lockout having expired, then trip a SECOND lockout -
    // its duration must be longer than the first, not the same fixed value.
    ;(localStorage as any).setItem('meshport_passcode_lockout', JSON.stringify({ failCount: 6, lockedUntil: 0 }))
    await verifyPasscode('999999', hash) // 7th failure - past the threshold again
    const secondLockoutMs = getPasscodeLockoutRemainingMs()
    expect(secondLockoutMs).toBeGreaterThan(firstLockoutMs)
  })

  it('biometric-unlock regression: clearPasscodeLockout() lifts an active lockout so a hardware-verified unlock is never blocked by prior manual-guess failures', async () => {
    const hash = await hashPasscode('654321')
    for (let i = 0; i < 5; i++) await verifyPasscode('000000', hash)
    expect(getPasscodeLockoutRemainingMs()).toBeGreaterThan(0)

    // This is what PasscodeSetup.tsx's tryBiometric() now does right after
    // a successful Face ID/fingerprint assertion, before feeding the
    // recovered (guaranteed-correct) passcode through verifyPasscode.
    clearPasscodeLockout()
    expect(getPasscodeLockoutRemainingMs()).toBe(0)
    expect(await verifyPasscode('654321', hash)).toBe(true)
  })
})
