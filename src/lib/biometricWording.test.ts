import { describe, it, expect } from 'vitest'
import { biometricAction, biometricWaiting } from './biometricWording'
import { greetingTime, greetingText } from './greeting'

describe('biometric wording', () => {
  it('says the same thing on every flow, with the device\'s own method', () => {
    expect(biometricAction('Unlock', 'Fingerprint')).toBe('Unlock with fingerprint')
    expect(biometricAction('Pay', 'Fingerprint')).toBe('Pay with fingerprint')
    expect(biometricAction('Unlock', 'Face ID')).toBe('Unlock with Face ID')
    expect(biometricAction('Pay', 'Face ID')).toBe('Pay with Face ID')
    expect(biometricAction('Confirm', 'Touch ID')).toBe('Confirm with Touch ID')
    expect(biometricAction('Confirm', 'Biometric')).toBe('Confirm with biometrics')
    expect(biometricWaiting('Face ID')).toBe('Waiting for Face ID…')
    expect(biometricWaiting('Fingerprint')).toBe('Waiting for fingerprint…')
  })
})

describe('lock screen greeting', () => {
  const at = (h: number) => greetingTime(new Date(2026, 0, 1, h, 30))
  it('follows the time of day', () => {
    expect(at(5)).toBe('morning'); expect(at(11)).toBe('morning')
    expect(at(12)).toBe('afternoon'); expect(at(16)).toBe('afternoon')
    expect(at(17)).toBe('evening'); expect(at(20)).toBe('evening')
    expect(at(21)).toBe('night'); expect(at(2)).toBe('night')
    expect(greetingText('evening')).toBe('Good evening')
  })
})
