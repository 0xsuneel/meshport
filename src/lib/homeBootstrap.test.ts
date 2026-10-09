import { describe, it, expect, vi, beforeEach } from 'vitest'

const rpc = vi.fn()
const auth = { user: { id: 'u1' }, walletAddress: '0xABC' } as any
vi.mock('./supabase', () => ({
  supabase: {
    auth: { getSession: () => Promise.resolve({ data: { session: null } }) },
    rpc: (...a: any[]) => ({ abortSignal: () => rpc(...a) }),
  },
}))
vi.mock('@/store', () => ({ useAuthStore: { getState: () => auth } }))

import { bootPart, __resetHomeBootstrapForTest } from './homeBootstrap'

const boot = (o: any = {}) => ({ data: { at: Date.now(), linked: true, settings: [{ feature: 'a' }], trades: [{ id: 't' }], cleared_at: null, unread_chats: 3, ...o }, error: null })

describe('homeBootstrap', () => {
  beforeEach(() => { __resetHomeBootstrapForTest(); rpc.mockReset(); auth.user = { id: 'u1' }; auth.walletAddress = '0xABC' })

  it('one request serves every reader, once each', async () => {
    rpc.mockResolvedValue(boot())
    const [s, t, u] = await Promise.all([bootPart('settings', 'a'), bootPart('trades', 'b', { userId: 'u1' }), bootPart('unread_chats', 'c')])
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('home_bootstrap', { p_user_id: 'u1', p_wallet: '0xabc' })
    expect(s).toEqual([{ feature: 'a' }]); expect(t).toEqual([{ id: 't' }]); expect(u).toBe(3)
    expect(await bootPart('trades', 'b', { userId: 'u1' })).toBeUndefined() // a refresh queries normally
  })

  it('null cleared_at is a real answer', async () => {
    rpc.mockResolvedValue(boot())
    expect(await bootPart('cleared_at', 'x')).toBeNull()
  })

  it('session not linked: user parts fall back, public parts still used', async () => {
    rpc.mockResolvedValue(boot({ linked: false }))
    expect(await bootPart('trades', 'b')).toBeUndefined()
    expect(await bootPart('settings', 'a')).toEqual([{ feature: 'a' }])
  })

  it('failed call or another user: fall back', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'x' } })
    expect(await bootPart('settings', 'a')).toBeUndefined()
    __resetHomeBootstrapForTest()
    rpc.mockResolvedValue(boot())
    expect(await bootPart('trades', 'b', { userId: 'someone-else' })).toBeUndefined()
  })

  it('signed out: no call at all', async () => {
    auth.user = null
    expect(await bootPart('settings', 'a')).toBeUndefined()
    expect(rpc).not.toHaveBeenCalled()
  })
})
