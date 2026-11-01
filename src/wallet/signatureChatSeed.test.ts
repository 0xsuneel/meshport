import { describe, it, expect, vi, beforeEach } from 'vitest'
import { signatureChatSeed } from './signatureChatSeed'

const store = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
vi.mock('@/lib/errorReport', () => ({ reportClientError: () => {} }))

const account = (addr: string, sigs: string[]) => {
  const signMessage = vi.fn(async () => sigs.shift()!)
  return { address: addr, signMessage } as any
}

describe('chat key from a wallet signature', () => {
  beforeEach(() => store.clear())

  it('a deterministic wallet: one seed from two equal signatures', async () => {
    const a = account('0x1111111111111111111111111111111111111111', ['0x' + 'ab'.repeat(65), '0x' + 'ab'.repeat(65)])
    expect((await signatureChatSeed(a)).length).toBe(32)
    expect(a.signMessage).toHaveBeenCalledTimes(2)
  })

  it('signatures differ (Circle): refused, remembered, and never signed for again on this device', async () => {
    const a = account('0x2222222222222222222222222222222222222222', ['0x' + '01'.repeat(65), '0x' + '02'.repeat(65)])
    await expect(signatureChatSeed(a)).rejects.toThrow(/stable chat key/)
    expect(a.signMessage).toHaveBeenCalledTimes(2)
    await expect(signatureChatSeed(a)).rejects.toThrow(/stable chat key/)
    expect(a.signMessage).toHaveBeenCalledTimes(2) // no new signatures
  })
})
