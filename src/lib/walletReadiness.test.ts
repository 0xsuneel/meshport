import { describe, it, expect, vi, beforeEach } from 'vitest'

type Listener = (s: typeof auth) => void
const listeners = new Set<Listener>()
const auth = {
  walletAddress: null as string | null, walletSource: null as string | null, signer: null as unknown,
  isAuthenticated: false, isLocked: false,
}
function setAuth(p: Partial<typeof auth>) { Object.assign(auth, p); listeners.forEach(l => l(auth)) }
vi.mock('@/store', () => ({ useAuthStore: { getState: () => auth, subscribe: (l: Listener) => { listeners.add(l); return () => listeners.delete(l) } } }))
const reports: string[] = []
vi.mock('./errorReport', () => ({ reportPerf: (l: string) => reports.push(l) }))

import { useWalletReadiness, startWalletReadiness, noteRestoring, setPrivyConnectedProbe, walletGeneration, noteNetworkReady, recompute } from './walletReadiness'

const W = '0x4cb2ff6492d51edfb54f0cff3b517d7f207d80a1'
const phase = () => useWalletReadiness.getState().phase

describe('wallet readiness', () => {
  beforeEach(() => { startWalletReadiness(); setAuth({ walletAddress: null, walletSource: null, signer: null, isAuthenticated: false, isLocked: false }) })

  it('signed out → signed in → wallet opening → signer ready', () => {
    expect(phase()).toBe('idle')
    setAuth({ isAuthenticated: true })
    expect(phase()).toBe('authenticated')
    setAuth({ walletAddress: W, walletSource: 'create' })
    expect(phase()).toBe('locked') // an address alone is not a signer
    noteRestoring(true)
    expect(phase()).toBe('initializing')
    setAuth({ signer: {} }); noteRestoring(false)
    expect(phase()).toBe('signer_ready')
  })

  it('a failed open is an error with its reason - and can be tried again', () => {
    setAuth({ isAuthenticated: true, walletAddress: W, walletSource: 'create' })
    noteRestoring(true); noteRestoring(false, 'wallet frame unavailable')
    expect(useWalletReadiness.getState()).toMatchObject({ phase: 'error', error: 'wallet frame unavailable' })
    noteRestoring(true)
    expect(phase()).toBe('initializing')
  })

  it('Privy: listed but not connected is "discovered", not ready to sign', () => {
    let connected = false
    setPrivyConnectedProbe(() => connected)
    setAuth({ isAuthenticated: true, walletAddress: W, walletSource: 'privy', signer: {} })
    expect(phase()).toBe('wallet_discovered')
    connected = true; recompute()
    expect(phase()).toBe('signer_ready')
  })

  it('the app lock and the network are separate from the wallet', () => {
    setAuth({ isAuthenticated: true, walletAddress: W, walletSource: 'create', signer: {}, isLocked: true })
    expect(useWalletReadiness.getState()).toMatchObject({ phase: 'signer_ready', appLocked: true })
    noteNetworkReady()
    expect(useWalletReadiness.getState().networkReady).toBe(true)
  })

  it('logout / another account starts a new generation (late results are dropped)', () => {
    setAuth({ walletAddress: W })
    const g = walletGeneration()
    setAuth({ walletAddress: null })
    expect(walletGeneration()).toBe(g + 1)
    setAuth({ walletAddress: '0x2222222222222222222222222222222222222222' })
    expect(walletGeneration()).toBe(g + 2)
  })
})
