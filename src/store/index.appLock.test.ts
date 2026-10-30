import { describe, it, expect, vi } from 'vitest'

// The auto-lock is an app lock only: the lock screen covers the app, the
// open wallet stays open behind it (so Pay signs at once after unlocking).

const security = vi.hoisted(() => ({ clearSessionPrivateKey: vi.fn(), forgetVerifiedPasscodes: vi.fn() }))
vi.mock('@/lib/security', () => security)
const wallet = vi.hoisted(() => ({ lockWallet: vi.fn() }))
vi.mock('@/wallet', () => wallet)

const { useAuthStore } = await import('./index')

describe('lock()', () => {
  it('shows the lock screen without closing the wallet', async () => {
    const signer = { address: '0x1111111111111111111111111111111111111111' } as never
    useAuthStore.setState({ isAuthenticated: true, walletAddress: '0x1111111111111111111111111111111111111111', walletSource: 'create', signer, isLocked: false })
    useAuthStore.getState().lock()
    expect(useAuthStore.getState().isLocked).toBe(true)
    expect(useAuthStore.getState().signer).toBe(signer)
    await vi.waitFor(() => expect(security.forgetVerifiedPasscodes).toHaveBeenCalled())
    expect(wallet.lockWallet).not.toHaveBeenCalled()
    useAuthStore.getState().unlock()
    expect(useAuthStore.getState().isLocked).toBe(false)
    expect(useAuthStore.getState().signer).toBe(signer)
  })
})
