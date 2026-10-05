// src/store/index.migrateAuthStore.test.ts
//
// Regression guard for the mnemonic-plaintext security fix's migration step
// (see security.mnemonicEncryption.test.ts for the encryption fix itself).
// Bumping useAuthStore's persist `version` (4 -> 5) and removing `mnemonic`
// from `partialize` only stops FUTURE writes from ever persisting the raw
// mnemonic again -- it does nothing about a plaintext copy an existing user
// already has sitting in their browser's localStorage from a build before
// this fix shipped. migrateAuthStore is the one-time cleanup Zustand's
// persist middleware runs for exactly that user, the first time they load a
// build carrying the version bump.

import { describe, it, expect } from 'vitest'
import { migrateAuthStore } from './index'

describe('migrateAuthStore', () => {
  it('scrubs a plaintext mnemonic left over from before the security fix', () => {
    const persisted = {
      walletAddress: '0x1111111111111111111111111111111111111111',
      mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      walletSource: 'create',
      username: 'alice',
    }
    const result = migrateAuthStore(persisted)
    expect(result.mnemonic).toBeUndefined()
    expect('mnemonic' in result).toBe(false)
  })

  it('leaves every other field untouched', () => {
    const persisted = {
      walletAddress: '0x1111111111111111111111111111111111111111',
      mnemonic: 'some seed phrase',
      walletSource: 'import-seed',
      username: 'bob',
      passcode: 'v2:abc:def',
      biometricEnabled: true,
    }
    const result = migrateAuthStore(persisted)
    expect(result.walletAddress).toBe(persisted.walletAddress)
    expect(result.walletSource).toBe('import-seed')
    expect(result.username).toBe('bob')
    expect(result.passcode).toBe('v2:abc:def')
    expect(result.biometricEnabled).toBe(true)
  })

  it('is a no-op (does not throw) when there was never a mnemonic to begin with', () => {
    // import-privkey wallets, or a fresh install with nothing persisted yet.
    const persisted = { walletAddress: '0x2222222222222222222222222222222222222222', walletSource: 'import-privkey' }
    expect(() => migrateAuthStore(persisted)).not.toThrow()
    expect('mnemonic' in migrateAuthStore(persisted)).toBe(false)
  })

  it('still clears the pre-existing avatar-cache fields (unchanged prior behavior)', () => {
    const persisted = { persistedAvatarUrl: 'https://example.com/a.png', persistedAvatars: { x: 1 }, mnemonic: 'x' }
    const result = migrateAuthStore(persisted)
    expect('persistedAvatarUrl' in result).toBe(false)
    expect('persistedAvatars' in result).toBe(false)
  })
})
