// src/lib/security.mnemonicEncryption.test.ts
//
// Regression guard for a CRITICAL security finding from /investigate
// (2026-09-05): the wallet's BIP-39 recovery phrase (mnemonic) used to be
// persisted in PLAIN TEXT via useAuthStore's Zustand `persist` middleware
// (store/index.ts's old `partialize` included the raw `mnemonic` field, and
// Zustand's default persist just JSON.stringifies state into localStorage --
// no encryption step). Contrast: the private key for the same wallet types
// WAS already properly AES-GCM encrypted (encryptPrivateKey/storeEncryptedKey,
// this same file) before ever touching storage. The seed phrase -- which can
// regenerate that private key and every other key/address for this wallet,
// forever, independent of MeshPort -- sat unprotected right next to it. Any
// XSS, malicious extension with storage access, or physical access to an
// unlocked browser profile could read it directly with
// `localStorage.getItem('meshport-auth-v4')`, no brute-forcing needed.
//
// Fix: encryptMnemonic/decryptMnemonic (thin wrappers around the SAME
// encryptPrivateKey/decryptPrivateKey crypto -- same PBKDF2-derived AES-GCM
// scheme, same deriveKey()) plus storeEncryptedMnemonic/getEncryptedMnemonic,
// storing under their own localStorage key, completely separate from the
// Zustand-persisted state.

import { describe, it, expect, vi, beforeEach } from 'vitest'

/** In-memory localStorage — node has none, and this module depends on it. */
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

import {
  encryptMnemonic, decryptMnemonic, storeEncryptedMnemonic, getEncryptedMnemonic,
  encryptPrivateKey, decryptPrivateKey,
} from './security'

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const TEST_ADDRESS = '0x1111111111111111111111111111111111111111'

describe('mnemonic encryption (encryptMnemonic/decryptMnemonic)', () => {
  beforeEach(() => { installLocalStorage() })

  it('round-trips a mnemonic through encrypt -> decrypt with the correct passcode', async () => {
    const encrypted = await encryptMnemonic(TEST_MNEMONIC, '123456')
    const decrypted = await decryptMnemonic(encrypted, '123456')
    expect(decrypted).toBe(TEST_MNEMONIC)
  })

  it('never stores the mnemonic in plaintext -- the encrypted blob does not contain any word from it', async () => {
    const encrypted = await encryptMnemonic(TEST_MNEMONIC, '123456')
    for (const word of TEST_MNEMONIC.split(' ')) {
      expect(encrypted).not.toContain(word)
    }
    // Sanity: the encrypted form is genuinely different text, not a no-op passthrough.
    expect(encrypted).not.toBe(TEST_MNEMONIC)
  })

  it('fails closed (returns null, never throws) when decrypted with the wrong passcode', async () => {
    const encrypted = await encryptMnemonic(TEST_MNEMONIC, '123456')
    const decrypted = await decryptMnemonic(encrypted, '999999')
    expect(decrypted).toBeNull()
  })

  it('uses the exact same crypto as the private key path (encryptMnemonic === encryptPrivateKey)', () => {
    // Deliberate design choice, not an implementation detail worth hiding:
    // the mnemonic is exactly as sensitive as the private key (arguably more
    // so — it regenerates the key), so it gets the exact same, already-
    // reviewed encryption, not a parallel implementation that could drift.
    expect(encryptMnemonic).toBe(encryptPrivateKey)
    expect(decryptMnemonic).toBe(decryptPrivateKey)
  })
})

describe('storeEncryptedMnemonic / getEncryptedMnemonic', () => {
  let store: Map<string, string>
  beforeEach(() => { store = installLocalStorage() })

  it('round-trips through localStorage under its own key, separate from the private key', async () => {
    const encryptedMnemonic = await encryptMnemonic(TEST_MNEMONIC, '123456')
    storeEncryptedMnemonic(TEST_ADDRESS, encryptedMnemonic)

    expect(getEncryptedMnemonic(TEST_ADDRESS)).toBe(encryptedMnemonic)
    // Full round trip: read back out of "localStorage" and decrypt.
    const readBack = getEncryptedMnemonic(TEST_ADDRESS)!
    expect(await decryptMnemonic(readBack, '123456')).toBe(TEST_MNEMONIC)
  })

  it('stores under a DIFFERENT localStorage key than the private key -- confirms they never collide', async () => {
    const encryptedMnemonic = await encryptMnemonic(TEST_MNEMONIC, '123456')
    storeEncryptedMnemonic(TEST_ADDRESS, encryptedMnemonic)

    const keys = Array.from(store.keys())
    expect(keys).toContain('meshport_encrypted_mnemonic_' + TEST_ADDRESS.toLowerCase())
    expect(keys).not.toContain('meshport_encrypted_' + TEST_ADDRESS.toLowerCase()) // never written by this test
  })

  it('returns null when nothing has been stored for this address', () => {
    expect(getEncryptedMnemonic('0x9999999999999999999999999999999999999999')).toBeNull()
  })

  it('is case-insensitive on the wallet address, matching storeEncryptedKey\'s existing convention', async () => {
    const encryptedMnemonic = await encryptMnemonic(TEST_MNEMONIC, '123456')
    storeEncryptedMnemonic(TEST_ADDRESS.toUpperCase(), encryptedMnemonic)
    expect(getEncryptedMnemonic(TEST_ADDRESS.toLowerCase())).toBe(encryptedMnemonic)
  })
})
