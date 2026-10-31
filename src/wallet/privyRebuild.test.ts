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

  it('a Privy that is up but signed out (sync failed after re-tries) is rebuilt, and a wallet needed then asks for it', async () => {
    const base = { ready: true, authenticated: false, wallets: [], linked: [] } as any
    privy.setPrivyBridge({ ...base, syncFailed: false })
    expect(privy.privyNeedsRebuild()).toBe(false)
    privy.setPrivyBridge({ ...base, syncFailed: true })
    expect(privy.privyNeedsRebuild()).toBe(true)
    const heard = vi.fn()
    window.addEventListener(privy.PRIVY_NEEDED_EVENT, heard)
    await privy.restorePrivyAccount('0xa', 10, 10)
    expect(heard).toHaveBeenCalledTimes(1)
    window.removeEventListener(privy.PRIVY_NEEDED_EVENT, heard)
    privy.setPrivyBridge(null)
  })
})

describe('the wallet stays warm while the app is open', () => {
  const ADDR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const bridgeWith = (signMessage: (m: unknown, a: string) => Promise<`0x${string}`>) => ({
    ready: true, authenticated: true, wallets: [ADDR], linked: [ADDR],
    signMessage, signTransaction: signMessage, signTypedData: signMessage,
    createWallet: async () => ADDR, solanaWallets: [], solanaReady: true,
    createSolanaWallet: async () => 'x', signSolanaTransaction: async (t: Uint8Array) => t,
  }) as any

  it('a wallet that still answers is left alone; a dead one is replaced in the background', async () => {
    const signs: unknown[] = []
    privy.setPrivyBridge(bridgeWith(async m => { signs.push(m); return '0xsig' }))
    await new Promise(r => setTimeout(r, 0))
    signs.length = 0
    // Signed just now (the warm-up): nothing to prove.
    expect(await privy.checkPrivyAlive()).toBe(true)
    expect(signs).toHaveLength(0)
    // Nothing signed "for a while" (freshMs 0): one silent statement signature.
    expect(await privy.checkPrivyAlive(0)).toBe(true)
    expect(signs).toEqual([privy.PRIVY_WARM_MESSAGE])

    // Privy's iframe aborts it: replaced at once, before any payment needs it.
    const dead = vi.fn()
    window.addEventListener(privy.PRIVY_DEAD_EVENT, dead)
    privy.setPrivyBridge(bridgeWith(async () => { const e = new Error('signal is aborted without reason'); e.name = 'AbortError'; throw e }))
    expect(await privy.checkPrivyAlive(0)).toBe(false)
    expect(dead).toHaveBeenCalledTimes(1)
    expect(privy.privyNeedsRebuild()).toBe(true)
    privy.setPrivyBridge(null) // PrivyRoot replaced it
    expect(privy.privyNeedsRebuild()).toBe(true) // (not loaded yet)
    window.removeEventListener(privy.PRIVY_DEAD_EVENT, dead)
  })

  it('a signature aborted by a dead iframe: Privy is replaced and it signs again', async () => {
    let n = 0
    const first = bridgeWith(async () => { n++; const e = new Error('signal is aborted without reason'); e.name = 'AbortError'; throw e })
    privy.setPrivyBridge(first)
    const onDead = () => setTimeout(() => {
      privy.setPrivyBridge(null)
      privy.setPrivyBridge(bridgeWith(async () => '0xfresh'))
    }, 0)
    window.addEventListener(privy.PRIVY_DEAD_EVENT, onDead)
    const sig = await privy.privyAccount(ADDR).signTypedData({ domain: {}, types: { T: [{ name: 'a', type: 'uint256' }] }, primaryType: 'T', message: { a: 1n } } as any)
    expect(sig).toBe('0xfresh')
    expect(n).toBeGreaterThanOrEqual(1) // the dead one was asked (warm-up included)
    window.removeEventListener(privy.PRIVY_DEAD_EVENT, onDead)
    privy.setPrivyBridge(null)
  })
})
