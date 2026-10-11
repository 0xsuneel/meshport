import { describe, it, expect, vi, afterEach } from 'vitest'
import { biometricLabel, isApplePasskeyDevice } from './biometric'

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  ipados: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
}
const on = (userAgent: string, maxTouchPoints = 0) => vi.stubGlobal('navigator', { userAgent, maxTouchPoints })
afterEach(() => vi.unstubAllGlobals())

describe('biometric device detection', () => {
  it('names the biometric each device actually uses', () => {
    on(UA.iphone, 5); expect(biometricLabel()).toBe('Face ID')
    on(UA.ipados, 5); expect(biometricLabel()).toBe('Face ID')   // iPadOS reports itself as a Mac
    on(UA.mac, 0); expect(biometricLabel()).toBe('Touch ID')
    on(UA.android, 5); expect(biometricLabel()).toBe('Fingerprint')
    on(UA.windows, 0); expect(biometricLabel()).toBe('Windows Hello')
    on(UA.linux, 0); expect(biometricLabel()).toBe('Biometric')
  })
  it('Apple devices get the "Save a passkey" explanation; others do not', () => {
    on(UA.iphone, 5); expect(isApplePasskeyDevice()).toBe(true)
    on(UA.ipados, 5); expect(isApplePasskeyDevice()).toBe(true)
    on(UA.mac, 0); expect(isApplePasskeyDevice()).toBe(true)
    on(UA.android, 5); expect(isApplePasskeyDevice()).toBe(false)
    on(UA.windows, 0); expect(isApplePasskeyDevice()).toBe(false)
  })
})
