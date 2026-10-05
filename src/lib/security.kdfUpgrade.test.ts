// New records use 600k-iteration PBKDF2 ("v3"/"v3enc"); records written by
// older versions ("v2"/"v2enc", 100k) must still open, and an unlock upgrades
// them in place.
import { describe, it, expect, beforeEach, vi } from 'vitest'

function installLocalStorage() {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  })
}
import {
  hashPasscode, verifyPasscode, encryptPrivateKey, decryptPrivateKey,
  storeEncryptedKey, getEncryptedKey, upgradeLegacyEncryption, clearPasscodeLockout,
} from './security'

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))

async function legacyKey(pin: string, salt: Uint8Array, usage: KeyUsage[]) {
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), { name: 'PBKDF2' }, false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as Uint8Array<ArrayBuffer>, iterations: 100000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, usage)
}
async function legacyHash(pin: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, await legacyKey(pin, salt, ['encrypt']), new TextEncoder().encode('meshport-passcode-verify-v2'))
  return `v2:${b64(salt)}:${b64(new Uint8Array(ct))}`
}
async function legacyEnc(secret: string, pin: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await legacyKey(pin, salt, ['encrypt']), new TextEncoder().encode(secret)))
  const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12)
  return `v2enc:${b64(salt)}:${b64(all)}`
}

describe('passcode KDF upgrade', () => {
  beforeEach(() => { installLocalStorage(); clearPasscodeLockout() })

  it('writes v3 records that round-trip', async () => {
    const h = await hashPasscode('123456')
    expect(h.startsWith('v3:')).toBe(true)
    expect(await verifyPasscode('123456', h)).toBe(true)
    expect(await verifyPasscode('654321', h)).toBe(false)
    const e = await encryptPrivateKey('0xsecret', '123456')
    expect(e.startsWith('v3enc:')).toBe(true)
    expect(await decryptPrivateKey(e, '123456')).toBe('0xsecret')
    expect(await decryptPrivateKey(e, '000000')).toBeNull()
  })

  it('still opens legacy v2 records and upgrades them on unlock', async () => {
    const addr = '0x' + '1'.repeat(40)
    const h = await legacyHash('123456')
    expect(await verifyPasscode('123456', h)).toBe(true)
    storeEncryptedKey(addr, await legacyEnc('0xkey', '123456'))
    expect(await decryptPrivateKey(getEncryptedKey(addr)!, '123456')).toBe('0xkey')

    const newHash = await upgradeLegacyEncryption(addr, '123456', h)
    expect(newHash?.startsWith('v3:')).toBe(true)
    expect(await verifyPasscode('123456', newHash!)).toBe(true)
    expect(getEncryptedKey(addr)!.startsWith('v3enc:')).toBe(true)
    expect(await decryptPrivateKey(getEncryptedKey(addr)!, '123456')).toBe('0xkey')
    // Nothing left to upgrade the second time.
    expect(await upgradeLegacyEncryption(addr, '123456', newHash)).toBeNull()
  })
})
