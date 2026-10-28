import { describe, it, expect, vi, beforeEach } from 'vitest'

// A create / import wallet: the frame opens it only with the passcode.
const auth = {
  walletAddress: '0x1111111111111111111111111111111111111111' as string | null,
  signer: null as unknown,
  walletSource: 'create' as string | null,
  setWallet: vi.fn((_a: string, s: unknown) => { auth.signer = s }),
}
const ui = { setWalletRecoveryNeeded: vi.fn() }
vi.mock('@/store', () => ({
  useAuthStore: { getState: () => auth },
  useUIStore: { getState: () => ui },
}))

let releaseFrame: () => void = () => {}
const unlockWallet = vi.fn(async (_address: string, passcode?: string) => {
  // The frame answers slowly (it is still loading) - long enough for the
  // lock screen's call to arrive while the mount-time one is running.
  await new Promise<void>(r => { releaseFrame = r })
  return passcode === '123456' ? { address: auth.walletAddress } : null
})
vi.mock('@/wallet', () => ({
  unlockWallet: (a: string, p?: string) => unlockWallet(a, p),
  migrateLegacyKey: async () => null,
  WalletFrameError: class extends Error { code = '' },
}))

import { restorePrivateKey } from './restoreWallet'

const flush = () => new Promise(r => setTimeout(r, 0))

describe('restorePrivateKey', () => {
  beforeEach(() => { auth.signer = null; unlockWallet.mockClear(); auth.setWallet.mockClear() })

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
})
