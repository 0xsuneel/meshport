import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
vi.mock('@/store', () => ({ useAuthStore: () => false }))
vi.mock('./privy', () => ({ privyConfigured: () => true }))
const { startSessionReads } = await import('./PrivyGate')

describe('PrivyGate session read', () => {
  it('a rejected read is read again (it used to stop: Privy never loaded)', async () => {
    vi.useFakeTimers()
    try {
      const session = { user: { id: 'u' } } as any
      const getSession = vi.fn()
        .mockRejectedValueOnce(new Error('Acquiring an exclusive Navigator LockManager lock timed out'))
        .mockResolvedValue({ data: { session }, error: null })
      const applied: any[] = []
      startSessionReads(getSession, (_e, s) => applied.push(s))
      await vi.advanceTimersByTimeAsync(0)
      expect(applied).toEqual([null])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(getSession).toHaveBeenCalledTimes(2)
      expect(applied[applied.length - 1]).toBe(session)
    } finally { vi.useRealTimers() }
  })

  it('a failed read (error, no session) is read again too', async () => {
    vi.useFakeTimers()
    try {
      const getSession = vi.fn()
        .mockResolvedValueOnce({ data: { session: null }, error: new Error('refresh failed') })
        .mockResolvedValue({ data: { session: { user: { id: 'u' } } }, error: null })
      startSessionReads(getSession as any, () => {})
      await vi.advanceTimersByTimeAsync(1_000)
      expect(getSession).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })
})
