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

describe('a warm wallet whose signature just hangs', () => {
  const ADDR = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  const bridgeWith = (sign: () => Promise<`0x${string}`>) => ({
    ready: true, authenticated: true, wallets: [ADDR], linked: [ADDR],
    signMessage: sign, signTransaction: sign, signTypedData: sign,
    createWallet: async () => ADDR, solanaWallets: [], solanaReady: true,
    createSolanaWallet: async () => 'x', signSolanaTransaction: async (t: Uint8Array) => t,
  }) as any

  it('is replaced after 12 s and signs on the fresh Privy', async () => {
    // A fresh privy module: earlier tests here leave Privy retries running.
    vi.resetModules()
    const privy = await import('./privy')
    vi.useFakeTimers()
    try {
      let calls = 0
      // Warm-up answers (the wallet is warm), then every signature hangs.
      privy.setPrivyBridge(bridgeWith(() => (++calls === 1 ? Promise.resolve('0xwarm') : new Promise(() => {}))))
      await vi.advanceTimersByTimeAsync(0)
      const onDead = () => setTimeout(() => { privy.setPrivyBridge(null); privy.setPrivyBridge(bridgeWith(async () => '0xfresh')) }, 0)
      window.addEventListener(privy.PRIVY_DEAD_EVENT, onDead)
      const sig = privy.privyAccount(ADDR).signMessage({ message: 'pay' })
      const out = sig.then(v => v, (e: Error) => e.message)
      for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(privy.PRIVY_HUNG_WARM_MS / 4)
      expect(await out).toBe('0xfresh')
      window.removeEventListener(privy.PRIVY_DEAD_EVENT, onDead)
      privy.setPrivyBridge(null)
    } finally { vi.useRealTimers() }
  })
})

describe("Privy's signing key lasts 60 minutes (TEE): the slow re-authentication after it is not a dead frame", () => {
  const ADDR = '0xcccccccccccccccccccccccccccccccccccccccc'
  const bridgeWith = (sign: () => Promise<`0x${string}`>) => ({
    ready: true, authenticated: true, wallets: [ADDR], linked: [ADDR],
    signMessage: sign, signTransaction: sign, signTypedData: sign,
    createWallet: async () => ADDR, solanaWallets: [], solanaReady: true,
    createSolanaWallet: async () => 'x', signSolanaTransaction: async (t: Uint8Array) => t,
  }) as any

  it('fresh for 59 minutes; after that a 20 s signature completes - Privy is not replaced', async () => {
    vi.resetModules()
    const privy = await import('./privy')
    vi.useFakeTimers()
    try {
      let n = 0
      // Warm-up quick; after the key expires the next signature takes 20 s (re-authentication).
      privy.setPrivyBridge(bridgeWith(() => (++n === 1
        ? Promise.resolve('0xwarm')
        : new Promise(r => setTimeout(() => r('0xreauth'), 20_000)))))
      await vi.advanceTimersByTimeAsync(0)
      expect(privy.privySigningKeyFresh()).toBe(true)
      await vi.advanceTimersByTimeAsync(privy.PRIVY_SIGNING_KEY_MS) // the hour is up
      expect(privy.privySigningKeyFresh()).toBe(false)
      const dead = vi.fn()
      window.addEventListener(privy.PRIVY_DEAD_EVENT, dead)
      const sig = privy.privyAccount(ADDR).signMessage({ message: 'pay' })
      await vi.advanceTimersByTimeAsync(21_000)
      expect(await sig).toBe('0xreauth')
      expect(dead).not.toHaveBeenCalled()
      expect(privy.privySigningKeyFresh()).toBe(true) // renewed
      window.removeEventListener(privy.PRIVY_DEAD_EVENT, dead)
      privy.setPrivyBridge(null)
    } finally { vi.useRealTimers() }
  })
})

// Field 1 Nov 05:38: Privy rebuilt after 37 min away while a signature waited
// on the old one. It hung, then called the new Privy "dead" and rebuilt it too.
describe('Privy replaced while a signature waits on it', () => {
  const ADDR = '0xdddddddddddddddddddddddddddddddddddddddd'
  const bridgeWith = (sign: () => Promise<`0x${string}`>) => ({
    ready: true, authenticated: true, wallets: [ADDR], linked: [ADDR],
    signMessage: sign, signTransaction: sign, signTypedData: sign,
    createWallet: async () => ADDR, solanaWallets: [], solanaReady: true,
    createSolanaWallet: async () => 'x', signSolanaTransaction: async (t: Uint8Array) => t,
  }) as any

  it('signs again on the new Privy at once - no hang, no second rebuild', async () => {
    vi.resetModules()
    const privy = await import('./privy')
    vi.useFakeTimers()
    try {
      let calls = 0
      privy.setPrivyBridge(bridgeWith(() => (++calls === 1 ? Promise.resolve('0xwarm') : new Promise(() => {}))))
      await vi.advanceTimersByTimeAsync(0)
      const dead = vi.fn()
      window.addEventListener(privy.PRIVY_DEAD_EVENT, dead)
      const sig = privy.privyAccount(ADDR).signMessage({ message: 'pay' })
      await vi.advanceTimersByTimeAsync(1_000) // hanging on the old Privy
      // PrivyRoot rebuilds it (e.g. the re-check after the background).
      privy.setPrivyBridge(null)
      privy.setPrivyBridge(bridgeWith(async () => '0xnew'))
      await vi.advanceTimersByTimeAsync(100)
      expect(await sig).toBe('0xnew')
      expect(dead).not.toHaveBeenCalled() // the new Privy is not thrown away
      window.removeEventListener(privy.PRIVY_DEAD_EVENT, dead)
      privy.setPrivyBridge(null)
    } finally { vi.useRealTimers() }
  })

  it('a Privy replaced while waiting for it (before signing) does not cancel the signature on the new one', async () => {
    vi.resetModules()
    const privy = await import('./privy')
    privy.setPrivyBridge(null)
    const sig = privy.privyAccount(ADDR).signMessage({ message: 'pay' })
    privy.setPrivyBridge(null) // a rebuild while nothing is up yet
    privy.setPrivyBridge(bridgeWith(async () => '0xok'))
    expect(await sig).toBe('0xok')
    privy.setPrivyBridge(null)
  })
})
