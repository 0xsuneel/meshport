import { describe, it, expect, vi, beforeEach } from 'vitest'

// The one way a payment gets its signer: never an address taken for a
// signer, never another account's signer, never while the app is locked.

type Listener = (s: typeof auth) => void
const listeners = new Set<Listener>()
const auth = {
  walletAddress: null as string | null, walletSource: null as string | null,
  signer: null as { address: string } | null, isAuthenticated: true, isLocked: false,
}
function setAuth(p: Partial<typeof auth>) { Object.assign(auth, p); listeners.forEach(l => l(auth)) }
vi.mock('@/store', () => ({ useAuthStore: { getState: () => auth, subscribe: (l: Listener) => { listeners.add(l); return () => listeners.delete(l) } } }))
vi.mock('./errorReport', () => ({ reportPerf: () => {} }))

const restore = vi.hoisted(() => ({ impl: null as null | ((p?: string, o?: { silent?: boolean }) => Promise<boolean>) }))
const restorePrivateKey = vi.fn((p?: string, o?: { silent?: boolean }) => restore.impl!(p, o))
vi.mock('./restoreWallet', () => ({ restorePrivateKey: (p?: string, o?: { silent?: boolean }) => restorePrivateKey(p, o) }))

const privy = vi.hoisted(() => ({ connected: false, warm: [] as string[] }))
vi.mock('@/wallet/privy', () => ({
  privySignerConnected: () => privy.connected,
  warmPrivySigner: async (a: string) => { privy.warm.push(a); return true },
}))
vi.mock('./arcService', () => ({ warmArcRpc: vi.fn() }))
vi.mock('./payIntentService', () => ({ warmPayIntent: vi.fn(async () => {}) }))

import { getReadySigner, prepareSigner } from './paymentReadiness'

const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'
const flush = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => {
  setAuth({ walletAddress: A, walletSource: 'create', signer: null, isLocked: false })
  restorePrivateKey.mockClear()
  privy.connected = false; privy.warm = []
  // Default: the frame opens the wallet with the right passcode.
  restore.impl = async p => { if (p === '123456') { setAuth({ signer: { address: A } }); return true } return false }
})

describe('getReadySigner', () => {
  it('an open wallet is used as is - no restore', async () => {
    setAuth({ signer: { address: A } })
    expect(await getReadySigner()).toEqual({ address: A })
    expect(restorePrivateKey).not.toHaveBeenCalled()
  })

  it('a closed wallet is opened with the passcode just typed', async () => {
    expect(await getReadySigner('123456')).toEqual({ address: A })
    expect(restorePrivateKey).toHaveBeenCalledWith('123456', undefined)
  })

  it('an address alone is not a signer: no passcode, no open → null', async () => {
    expect(await getReadySigner()).toBeNull()
  })

  it('refuses while the app is locked', async () => {
    setAuth({ signer: { address: A }, isLocked: true })
    expect(await getReadySigner()).toBeNull()
  })

  it('another account signed in while the wallet was opening → null, never the old signer', async () => {
    restore.impl = async () => { setAuth({ signer: { address: A } }); setAuth({ walletAddress: B, signer: null }); return true }
    expect(await getReadySigner('123456')).toBeNull()
  })

  it("a signer that isn't the signed-in account's is refused", async () => {
    setAuth({ signer: { address: B } })
    expect(await getReadySigner()).toBeNull()
  })

  it('a Privy wallet that is open but not warm yet: returned at once, its warm-up started', async () => {
    setAuth({ walletSource: 'privy', signer: { address: A } })
    expect(await getReadySigner()).toEqual({ address: A })
    await flush(); await flush()
    expect(privy.warm).toEqual([A])
  })

  it('a failed open passes the silent option through and returns null without throwing', async () => {
    restore.impl = async () => { throw new Error('frame down') }
    expect(await getReadySigner('123456', { silent: true })).toBeNull()
  })
})

describe('prepareSigner', () => {
  it('starts opening the wallet silently with the passcode - a typo must not raise the recovery banner', async () => {
    prepareSigner('123456')
    await vi.waitFor(() => expect(restorePrivateKey).toHaveBeenCalledWith('123456', { silent: true }))
  })

  it('a later getReadySigner joins it (the shared open)', async () => {
    prepareSigner('123456')
    await vi.waitFor(() => expect(auth.signer).toEqual({ address: A }))
    expect(await getReadySigner()).toEqual({ address: A })
  })

  it('keeps preparing behind the lock screen (the app lock does not close the wallet)', async () => {
    setAuth({ isLocked: true })
    prepareSigner('123456')
    await vi.waitFor(() => expect(restorePrivateKey).toHaveBeenCalled())
  })

  it('an open wallet is not opened again; a Privy one is warmed', async () => {
    setAuth({ walletSource: 'privy', signer: { address: A } })
    prepareSigner()
    await flush(); await flush()
    expect(restorePrivateKey).not.toHaveBeenCalled()
    expect(privy.warm).toEqual([A])
  })
})
