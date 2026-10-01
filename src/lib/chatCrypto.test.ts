// src/lib/chatCrypto.test.ts
//
// These tests exercise the actual Web Crypto API (available natively in
// Node's test runner — verified: globalThis.crypto.subtle exists), not
// mocks. That matters here specifically: a crypto module is exactly the
// kind of code where "the function returned without throwing" tells you
// almost nothing — the thing that actually needs verifying is that
// encrypt→decrypt round-trips to the original bytes, that a payload
// encrypted under one key can't be read with another, and that every
// fallback path (no key yet, legacy unencrypted content) behaves exactly
// as chatCrypto.ts's own comments promise it does.
//
// getConversationKey/ensureChatKeysReady themselves aren't tested here —
// they need a real localStorage + Supabase client, which is what
// getConversationKey internally uses to derive the AES key this file
// tests directly (generated with crypto.subtle.generateKey, bypassing that
// machinery). The AES-GCM behavior under test is identical either way;
// only the "how do two people agree on this key" step is skipped.

import { describe, it, expect } from 'vitest'
import { encryptText, decryptText, encryptBlob, decryptBlob, isEncryptedPayload, deriveMyChatIdentity } from './chatCrypto'
import { x25519 } from '@noble/curves/ed25519'

async function makeAesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

describe('isEncryptedPayload', () => {
  it('recognizes the e2e:v1: prefix', () => {
    expect(isEncryptedPayload('e2e:v1:abc:def')).toBe(true)
  })
  it('treats every message sent before this feature existed as NOT encrypted', () => {
    expect(isEncryptedPayload('hey, are you free tonight?')).toBe(false)
    expect(isEncryptedPayload('')).toBe(false)
    expect(isEncryptedPayload('[IMAGE](https://example.com/x.jpg)')).toBe(false)
  })
})

describe('deriveMyChatIdentity — the multi-device fix', () => {
  const walletKeyA = '0x' + '11'.repeat(32)
  const walletKeyB = '0x' + '22'.repeat(32)

  it('derives the exact same key pair from the same wallet key every time — the core "any device" property', () => {
    // Simulates the SAME wallet being re-imported on a second device: this
    // is called completely independently twice, with no shared state
    // between the calls (no localStorage, no cache) — exactly what happens
    // across two real devices. If this ever produced different output, the
    // whole multi-device fix would be broken.
    const identity1 = deriveMyChatIdentity(walletKeyA)
    const identity2 = deriveMyChatIdentity(walletKeyA)
    expect(Array.from(identity1.publicKey)).toEqual(Array.from(identity2.publicKey))
    expect(Array.from(identity1.privateKey)).toEqual(Array.from(identity2.privateKey))
  })

  it('derives a DIFFERENT identity for a different wallet — not the same key for everyone', () => {
    const identityA = deriveMyChatIdentity(walletKeyA)
    const identityB = deriveMyChatIdentity(walletKeyB)
    expect(Array.from(identityA.publicKey)).not.toEqual(Array.from(identityB.publicKey))
  })

  it('handles a private key with or without the 0x prefix identically', () => {
    const withPrefix = deriveMyChatIdentity('0x' + 'ab'.repeat(32))
    const withoutPrefix = deriveMyChatIdentity('ab'.repeat(32))
    expect(Array.from(withPrefix.publicKey)).toEqual(Array.from(withoutPrefix.publicKey))
  })

  it('two independently-derived identities can still agree on a shared secret via X25519 — proves getConversationKey\'s actual DH step works with this derivation', () => {
    // This is the actual end-to-end property that matters: two different
    // "people" (wallets), each independently deriving their own identity,
    // must still be able to agree on the same shared secret from each
    // other's public key — exactly what getConversationKey relies on.
    const alice = deriveMyChatIdentity(walletKeyA)
    const bob   = deriveMyChatIdentity(walletKeyB)
    const sharedByAlice = x25519.getSharedSecret(alice.privateKey, bob.publicKey)
    const sharedByBob   = x25519.getSharedSecret(bob.privateKey, alice.publicKey)
    expect(Array.from(sharedByAlice)).toEqual(Array.from(sharedByBob))
  })

  it('simulates a real device change: re-deriving on a fresh "device" still decrypts a message encrypted on the old one', async () => {
    // Alice sends a message from "device 1". Bob's public key is whatever
    // Bob most recently derived (also deterministic, so this doesn't need
    // to simulate Bob separately for both sides of this specific check).
    const bob = deriveMyChatIdentity(walletKeyB)

    // "Device 1": Alice derives her identity and encrypts a message to Bob.
    const aliceDevice1 = deriveMyChatIdentity(walletKeyA)
    const sharedSecret1 = x25519.getSharedSecret(aliceDevice1.privateKey, bob.publicKey)
    const hkdfKey1 = await crypto.subtle.importKey('raw', new Uint8Array(sharedSecret1), 'HKDF', false, ['deriveKey'])
    const aesKey1 = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('meshport-chat-e2e-v1') },
      hkdfKey1, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    )
    const encrypted = await encryptText('see you at the same time tomorrow?', aesKey1)

    // "Device 2": Alice reinstalls / switches phones, re-imports the SAME
    // wallet (same private key), and opens the same conversation with Bob.
    // No localStorage, no prior state carried over — this is the whole
    // point of the fix.
    const aliceDevice2 = deriveMyChatIdentity(walletKeyA)
    const sharedSecret2 = x25519.getSharedSecret(aliceDevice2.privateKey, bob.publicKey)
    const hkdfKey2 = await crypto.subtle.importKey('raw', new Uint8Array(sharedSecret2), 'HKDF', false, ['deriveKey'])
    const aesKey2 = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('meshport-chat-e2e-v1') },
      hkdfKey2, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    )
    const decrypted = await decryptText(encrypted, aesKey2)

    expect(decrypted).toBe('see you at the same time tomorrow?')
  })
})

describe('encryptText / decryptText — round trip', () => {
  it('decrypts back to the exact original plaintext', async () => {
    const key = await makeAesKey()
    const original = 'Hey — can you send me the invoice for last month?'
    const encrypted = await encryptText(original, key)
    expect(isEncryptedPayload(encrypted)).toBe(true)
    expect(encrypted).not.toContain(original) // never leaks plaintext into the ciphertext string
    const decrypted = await decryptText(encrypted, key)
    expect(decrypted).toBe(original)
  })

  it('round-trips unicode, emoji, and newlines correctly', async () => {
    const key = await makeAesKey()
    const original = '¡Hola! 🔒💸\nLine two — 日本語のテスト'
    const encrypted = await encryptText(original, key)
    const decrypted = await decryptText(encrypted, key)
    expect(decrypted).toBe(original)
  })

  it('produces a DIFFERENT ciphertext each time for the same plaintext (random IV per message)', async () => {
    const key = await makeAesKey()
    const a = await encryptText('same message', key)
    const b = await encryptText('same message', key)
    expect(a).not.toBe(b)
  })

  it('cannot be decrypted with a different key', async () => {
    const keyA = await makeAesKey()
    const keyB = await makeAesKey()
    const encrypted = await encryptText('secret', keyA)
    const result = await decryptText(encrypted, keyB)
    // Fails soft — returns a placeholder, never throws, never silently
    // returns garbage that looks like it might be real content.
    expect(result).toContain('🔒')
    expect(result).not.toBe('secret')
  })

  it('encryptText passes plaintext through unchanged when key is null (recipient has no key yet)', async () => {
    const original = 'plain until they update'
    const result = await encryptText(original, null)
    expect(result).toBe(original)
    expect(isEncryptedPayload(result)).toBe(false)
  })

  it('decryptText returns legacy plaintext completely unchanged, even with a real key available', async () => {
    const key = await makeAesKey()
    const legacyMessage = 'this was sent before E2E encryption existed'
    const result = await decryptText(legacyMessage, key)
    expect(result).toBe(legacyMessage)
  })

  it('decryptText returns a clear fallback for encrypted content when no key is available', async () => {
    const key = await makeAesKey()
    const encrypted = await encryptText('you need my key to read this', key)
    const result = await decryptText(encrypted, null)
    expect(result).toContain('🔒')
  })
})

describe('encryptBlob / decryptBlob — round trip', () => {
  it('decrypts back to the exact original bytes', async () => {
    const key = await makeAesKey()
    const originalBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3, 255, 254, 253])
    const originalBlob = new Blob([originalBytes])

    const { blob: encryptedBlob, ivBase64, encrypted } = await encryptBlob(originalBlob, key)
    expect(encrypted).toBe(true)
    expect(ivBase64).toBeTruthy()

    const encryptedBytes = await encryptedBlob.arrayBuffer()
    // Ciphertext must not equal the plaintext bytes verbatim
    expect(new Uint8Array(encryptedBytes)).not.toEqual(originalBytes)

    const decryptedBlob = await decryptBlob(encryptedBytes, ivBase64, key)
    const decryptedBytes = new Uint8Array(await decryptedBlob.arrayBuffer())
    expect(Array.from(decryptedBytes)).toEqual(Array.from(originalBytes))
  })

  it('encryptBlob passes the file through unchanged when key is null', async () => {
    const originalBytes = new Uint8Array([1, 2, 3, 4, 5])
    const originalBlob = new Blob([originalBytes])
    const { blob, ivBase64, encrypted } = await encryptBlob(originalBlob, null)
    expect(encrypted).toBe(false)
    expect(ivBase64).toBe(null)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect(Array.from(bytes)).toEqual(Array.from(originalBytes))
  })

  it('decryptBlob passes bytes through unchanged when ivBase64 is null (never-encrypted file)', async () => {
    const key = await makeAesKey()
    const originalBytes = new Uint8Array([9, 8, 7])
    const result = await decryptBlob(originalBytes.buffer, null, key)
    const bytes = new Uint8Array(await result.arrayBuffer())
    expect(Array.from(bytes)).toEqual(Array.from(originalBytes))
  })

  it('throws on a genuinely corrupted/wrong-key payload rather than silently returning garbage', async () => {
    const keyA = await makeAesKey()
    const keyB = await makeAesKey()
    const originalBlob = new Blob([new Uint8Array([1, 2, 3])])
    const { blob: encryptedBlob, ivBase64 } = await encryptBlob(originalBlob, keyA)
    const encryptedBytes = await encryptedBlob.arrayBuffer()
    await expect(decryptBlob(encryptedBytes, ivBase64, keyB)).rejects.toBeTruthy()
  })
})
