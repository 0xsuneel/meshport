import { describe, it, expect, vi } from 'vitest'

vi.stubEnv('VITE_PRIVY_APP_ID', 'test-app-id')
// A browser window (events) for this file only.
vi.stubGlobal('window', new EventTarget())
vi.mock('@/lib/errorReport', () => ({ reportClientError: vi.fn() }))
const { rebuildGapMs } = await import('./privyActivity')
const privy = await import('./privy')

describe('Privy restarts on a weak connection', () => {
  it('two at once, then 20 s, 40 s, and every 60 s - never given up', () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(rebuildGapMs)).toEqual([0, 0, 20_000, 40_000, 60_000, 60_000, 60_000])
  })

  it('needs a restart: not loaded, not ready, or the account wallet never connected', () => {
    privy.setPrivyBridge(null)
    expect(privy.privyNeedsRebuild()).toBe(true)
    const base = { ready: true, authenticated: true, wallets: ['0xa'], linked: ['0xa'] } as any
    privy.setPrivyBridge({ ...base, ready: false })
    expect(privy.privyNeedsRebuild()).toBe(true)
    privy.setPrivyBridge({ ...base, wallets: [] })
    expect(privy.privyNeedsRebuild()).toBe(true)
    privy.setPrivyBridge(base)
    expect(privy.privyNeedsRebuild()).toBe(false)
    privy.setPrivyBridge(null)
  })

  it('a wallet needed while Privy is not up asks for a restart', async () => {
    privy.setPrivyBridge(null)
    const heard = vi.fn()
    window.addEventListener(privy.PRIVY_NEEDED_EVENT, heard)
    expect(await privy.restorePrivyAccount('0xa', 10, 10)).toBeNull()
    expect(heard).toHaveBeenCalledTimes(1)
    window.removeEventListener(privy.PRIVY_NEEDED_EVENT, heard)
  })
})
