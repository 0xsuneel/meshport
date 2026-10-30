import { describe, it, expect, vi, beforeEach } from 'vitest'

// A create / import wallet: the frame opens it only with the passcode.
type Listener = (s: typeof auth) => void
const listeners = new Set<Listener>()
const auth = {
  walletAddress: '0x1111111111111111111111111111111111111111' as string | null,
  signer: null as unknown,
  walletSource: 'create' as string | null,
  isAuthenticated: true,
  isLocked: false,
  setWallet: vi.fn((a: string, s: unknown) => { setAuth({ walletAddress: a, signer: s }) }),
}
function setAuth(patch: Partial<typeof auth>) { Object.assign(auth, patch); listeners.forEach(l => l(auth)) }
const ui = { setWalletRecoveryNeeded: vi.fn() }
vi.mock('@/store', () => ({
  useAuthStore: { getState: () => auth, subscribe: (l: Listener) => { listeners.add(l); return () => listeners.delete(l) } },
  useUIStore: { getState: () => ui },
}))

class FrameError extends Error { constructor(public code: string) { super(code) } }
const waiting: (() => void)[] = []
const releaseFrame = () => { waiting.splice(0).forEach(r => r()) }
// Default frame: answers slowly (still loading) - long enough for a second
// caller to arrive while the first is running. Tests can swap it.
const slowFrame = async (_address: string, passcode?: string) => {
  await new Promise<void>(r => { waiting.push(r) })
  return passcode === '123456' ? { address: auth.walletAddress } : null
}
let frame: (a: string, p?: string) => Promise<unknown> = slowFrame
const unlockWallet = vi.fn((a: string, p?: string) => frame(a, p))
vi.mock('@/wallet', () => ({
  unlockWallet: (a: string, p?: string) => unlockWallet(a, p),
  migrateLegacyKey: async () => null,
  WalletFrameError: FrameError,
}))

// Privy doesn't list this wallet (an old device-kept Google / email one).
const privyWarm = { connected: false, warmPrivySigner: vi.fn(async (_a: string) => true) }
vi.mock('@/wallet/privy', () => ({
  restorePrivyAccount: async () => null, privyState: () => '',
  privySignerConnected: () => privyWarm.connected,
  warmPrivySigner: (a: string) => privyWarm.warmPrivySigner(a),
}))

import { restorePrivateKey } from './restoreWallet'
import { useWalletReadiness } from './walletReadiness'

const flush = () => new Promise(r => setTimeout(r, 0))

describe('restorePrivateKey', () => {
  beforeEach(() => {
    vi.useRealTimers()
    frame = slowFrame
    setAuth({ walletAddress: '0x1111111111111111111111111111111111111111', signer: null, walletSource: 'create', isLocked: false })
    unlockWallet.mockClear(); auth.setWallet.mockClear(); ui.setWalletRecoveryNeeded.mockClear()
  })

  it('a passcode call that joins a passcode-less attempt still opens the wallet', async () => {
    const mountRestore = restorePrivateKey(undefined, { silent: true })
    await flush()
    const lockScreen = restorePrivateKey('123456')
    // Let every frame call answer as it comes.
    for (let i = 0; i < 10 && !auth.signer; i++) { releaseFrame(); await flush() }
    expect(await mountRestore).toBe(false)
    expect(await lockScreen).toBe(true)
    expect(auth.signer).toBeTruthy()
    expect(unlockWallet).toHaveBeenCalledWith(auth.walletAddress, '123456')
  })

  it('callers without a passcode share one attempt', async () => {
    const a = restorePrivateKey()
    const b = restorePrivateKey()
    await flush()
    for (let i = 0; i < 5; i++) { releaseFrame(); await flush() }
    expect(await a).toBe(false)
    expect(await b).toBe(false)
    // one frame call without a passcode (step 2); nothing tried twice
    expect(unlockWallet).toHaveBeenCalledTimes(1)
  })
  it('a caller that joins a silent attempt still shows the banner when it fails', async () => {
    const silent = restorePrivateKey(undefined, { silent: true })
    const loud = restorePrivateKey()
    await flush()
    for (let i = 0; i < 5; i++) { releaseFrame(); await flush() }
    expect(await silent).toBe(false)
    expect(await loud).toBe(false)
    expect(ui.setWalletRecoveryNeeded).toHaveBeenCalledWith(true)
  })
  it('a caller with no passcode that joins a wrong-passcode attempt shows no banner', async () => {
    const typo = restorePrivateKey('000000', { silent: true })
    const mount = restorePrivateKey()
    await flush()
    for (let i = 0; i < 5; i++) { releaseFrame(); await flush() }
    expect(await typo).toBe(false)
    expect(await mount).toBe(false)
    expect(ui.setWalletRecoveryNeeded).not.toHaveBeenCalled()
  })

  it('a Google / email wallet is not opened twice for a passcode it does not use', async () => {
    auth.walletSource = 'social-auto'
    try {
      const mount = restorePrivateKey(undefined, { silent: true })
      const unlock = restorePrivateKey('123456')
      await flush()
      for (let i = 0; i < 5; i++) { releaseFrame(); await flush() }
      expect(await mount).toBe(false)
      expect(await unlock).toBe(false)
      expect(unlockWallet).toHaveBeenCalledTimes(1)
    } finally { auth.walletSource = 'create' }
  })

  it('a logout while the wallet is opening: the old wallet is not brought back', async () => {
    const restore = restorePrivateKey('123456')
    await flush()
    setAuth({ walletAddress: null, signer: null }) // logged out meanwhile
    for (let i = 0; i < 5; i++) { releaseFrame(); await flush() }
    expect(await restore).toBe(false)
    expect(auth.setWallet).not.toHaveBeenCalled()
    expect(auth.walletAddress).toBeNull()
  })

  it('another account signed in meanwhile: the late result is dropped, a new call opens the new one', async () => {
    const old = restorePrivateKey('123456')
    await flush()
    setAuth({ walletAddress: '0x2222222222222222222222222222222222222222', signer: null })
    const fresh = restorePrivateKey('123456') // not joined to the old account's attempt
    for (let i = 0; i < 10; i++) { releaseFrame(); await flush() }
    expect(await old).toBe(false)
    expect(await fresh).toBe(true)
    expect(auth.setWallet).toHaveBeenCalledTimes(1)
    expect(auth.setWallet.mock.calls[0][0]).toBe('0x2222222222222222222222222222222222222222')
  })

  it('a wallet frame that timed out is tried again, and the wallet opens', async () => {
    vi.useFakeTimers()
    let calls = 0
    frame = async () => { if (++calls === 1) throw new FrameError('timeout'); return { address: auth.walletAddress } }
    const restore = restorePrivateKey()
    await vi.advanceTimersByTimeAsync(1_500)
    expect(await restore).toBe(true)
    expect(calls).toBe(2)
    expect(useWalletReadiness.getState().phase).toBe('signer_ready')
  })

  it('a frame that never answers: a few bounded tries, then an error phase (retryable)', async () => {
    vi.useFakeTimers()
    frame = async () => { throw new FrameError('unavailable') }
    const restore = restorePrivateKey()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await restore).toBe(false)
    expect(unlockWallet).toHaveBeenCalledTimes(3)
    expect(useWalletReadiness.getState().phase).toBe('error')
    // ...and a later call can still open it (no rejected promise kept).
    frame = async () => ({ address: auth.walletAddress })
    expect(await restorePrivateKey()).toBe(true)
  })

  it('a "wrong passcode" answer is not retried as if the frame were down', async () => {
    frame = async () => { throw new FrameError('bad-passcode') }
    expect(await restorePrivateKey()).toBe(false)
    expect(unlockWallet).toHaveBeenCalledTimes(1)
  })

  it('no passcode yet: the wallet is locked, not an error - an address alone is never "ready"', async () => {
    frame = async () => null
    expect(await restorePrivateKey()).toBe(false)
    expect(auth.walletAddress).toBeTruthy()
    expect(useWalletReadiness.getState().phase).toBe('locked')
  })

  it('an existing Privy signer that is not authenticated yet: restore starts its warm-up instead of just saying OK', async () => {
    privyWarm.connected = false; privyWarm.warmPrivySigner.mockClear()
    setAuth({ walletSource: 'privy', signer: {} })
    expect(await restorePrivateKey()).toBe(true)
    await vi.waitFor(() => expect(privyWarm.warmPrivySigner).toHaveBeenCalledWith('0x1111111111111111111111111111111111111111'))
  })

  it('an already-warm Privy signer is left alone', async () => {
    privyWarm.connected = true; privyWarm.warmPrivySigner.mockClear()
    setAuth({ walletSource: 'privy', signer: {} })
    expect(await restorePrivateKey()).toBe(true)
    await flush(); await flush()
    expect(privyWarm.warmPrivySigner).not.toHaveBeenCalled()
  })
})
