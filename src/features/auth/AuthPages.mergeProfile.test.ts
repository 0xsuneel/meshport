// src/features/auth/AuthPages.mergeProfile.test.ts
//
// Regression test for a re-imported wallet losing its profile photo and
// display name (2026-09-03). ClaimUsernamePage detects when an imported
// wallet already has a registered MeshPort profile and restores id/
// username/walletAddress from it — but used to stop there, silently
// dropping display_name and avatar_url even though both were already
// present in the same query result. A wallet re-imported on a fresh
// device or after a reinstall kept its correct username but reverted its
// profile picture and display name to blank/default.

import { describe, it, expect, vi } from 'vitest'

// AuthPages.tsx imports @/lib/supabase, which constructs a real client at
// module load and throws without env vars — same recurring issue as the
// other component test files in this repo.
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
  upsertUserProfile: async () => {},
  fetchUserProfile: async () => null,
  isUsernameTakenDb: async () => false,
  getUserByWalletAddress: async () => null,
  ensureAnonSession: async () => {},
  fetchUserByEmail: async () => null,
}))

import { mergeExistingWalletProfile } from './AuthPages'
import type { User } from '@/types'

const BASE_USER: User = {
  id: 'usr_temp_123',
  username: '',
  displayName: 'temp',
  email: '',
  avatar: null,
  walletAddress: '',
  country: 'IN',
  createdAt: '2026-09-03T00:00:00.000Z',
}

describe('mergeExistingWalletProfile', () => {
  it('restores display_name and avatar_url from the existing profile, not just id/username', () => {
    const result = mergeExistingWalletProfile(BASE_USER, '0xWALLET', {
      id: 'usr_real_456',
      username: 'sunil',
      display_name: 'Sunil R',
      avatar_url: 'https://example.com/avatar.jpg',
    })

    expect(result?.id).toBe('usr_real_456')
    expect(result?.username).toBe('sunil.arc')
    expect(result?.walletAddress).toBe('0xWALLET')
    expect(result?.displayName).toBe('Sunil R')
    expect(result?.avatar).toBe('https://example.com/avatar.jpg')
  })

  it('falls back to the current displayName/avatar when the existing profile has neither set', () => {
    const result = mergeExistingWalletProfile(BASE_USER, '0xWALLET', {
      id: 'usr_real_456',
      username: 'sunil',
      display_name: null,
      avatar_url: null,
    })

    expect(result?.displayName).toBe('temp') // kept the pre-merge value, not wiped to null
    expect(result?.avatar).toBe(null)
  })

  it('returns null unchanged when there is no current user to merge into', () => {
    const result = mergeExistingWalletProfile(null, '0xWALLET', {
      id: 'usr_real_456',
      username: 'sunil',
      display_name: 'Sunil R',
      avatar_url: 'https://example.com/avatar.jpg',
    })
    expect(result).toBe(null)
  })

  it('preserves every other existing User field untouched (email, country, createdAt)', () => {
    const userWithEmail: User = { ...BASE_USER, email: 'sunil@example.com', country: 'US' }
    const result = mergeExistingWalletProfile(userWithEmail, '0xWALLET', {
      id: 'usr_real_456',
      username: 'sunil',
      display_name: 'Sunil R',
      avatar_url: null,
    })
    expect(result?.email).toBe('sunil@example.com')
    expect(result?.country).toBe('US')
    expect(result?.createdAt).toBe(BASE_USER.createdAt)
  })
})
