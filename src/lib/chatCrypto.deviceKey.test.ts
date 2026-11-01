// Google / email (Circle) wallets: no chat seed can come from the wallet, so
// the device makes its own random key, publishes it with ONE wallet
// signature, and reuses it after that (no signature on later starts).
import { describe, it, expect, vi } from 'vitest'

// Browser storage stand-ins (the tests run in node).
function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() { return m.size },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, String(v)) },
    removeItem: (k: string) => { m.delete(k) },
    clear: () => m.clear(),
  }
}
vi.stubGlobal('sessionStorage', memoryStorage())
vi.stubGlobal('localStorage', memoryStorage())
import { privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount(('0x' + '33'.repeat(32)) as `0x${string}`)
const signMessage = vi.fn((a: { message: string }) => account.signMessage(a))
const row: { chat_public_key: string | null; chat_key_sig: string | null } = { chat_public_key: null, chat_key_sig: null }
const sealedStore = new Map<string, string>()

vi.mock('@/store', () => ({ useAuthStore: { getState: () => ({ signer: { address: account.address, signMessage } }) } }))
vi.mock('@/wallet', () => ({ chatSeed: async () => { throw new Error('No wallet-derived chat key for a Circle wallet') } }))
vi.mock('@/lib/security', () => ({
  sealForDevice: async (v: string) => { sealedStore.set('s', v); return 'sealed' },
  openFromDevice: async () => sealedStore.get('s') ?? null,
}))
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { ...row } }) }) }),
      update: (patch: any) => ({ eq: async () => { Object.assign(row, patch); return { error: null } } }),
    }),
  },
}))

import { ensureChatKeysReady, verifyChatKey, clearChatSessionSeeds } from './chatCrypto'

describe('per-device chat key (Circle wallets)', () => {
  it('publishes a verified random key once, then reuses it - also after logout', async () => {
    await ensureChatKeysReady(account.address, 'u1')
    expect(signMessage).toHaveBeenCalledTimes(1)
    expect(row.chat_public_key).toBeTruthy()
    expect(await verifyChatKey(account.address, row.chat_public_key, row.chat_key_sig)).toBe(true)
    const first = row.chat_public_key

    await ensureChatKeysReady(account.address, 'u1')
    expect(signMessage).toHaveBeenCalledTimes(1)

    // Logout keeps the device copy: chats on this phone stay readable.
    clearChatSessionSeeds()
    sessionStorage.clear()
    await ensureChatKeysReady(account.address, 'u1')
    expect(row.chat_public_key).toBe(first)
    expect(signMessage).toHaveBeenCalledTimes(1)
  })
})
