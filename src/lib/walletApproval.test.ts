import { describe, it, expect, vi, beforeEach } from 'vitest'

const auth = { walletAddress: '0x1111111111111111111111111111111111111111', walletSource: 'create' as string }
vi.mock('@/store', () => ({ useAuthStore: { getState: () => auth } }))
const approveFrameWallet = vi.fn(async (_a: string, pin: string) => {
  if (pin !== '123456') throw Object.assign(new Error('Wrong passcode'), { code: 'bad-passcode' })
})
vi.mock('@/wallet', () => ({ approveFrameWallet: (a: string, p: string) => approveFrameWallet(a, p) }))
vi.mock('./errorReport', () => ({ reportClientError: vi.fn() }))

const security = await import('./security')
const approval = await import('./walletApproval')
const { withApproval } = await import('@/wallet/account')
const { WalletFrameError } = await import('@/wallet/frameClient')

const refused = () => new WalletFrameError('approval-required' as never, 'Enter your passcode')

describe('wallet approval', () => {
  beforeEach(() => { approveFrameWallet.mockClear(); auth.walletSource = 'create' })

  it('a passcode that passes in the app is handed to the wallet frame', async () => {
    const hash = await security.hashPasscode('123456')
    security.forgetVerifiedPasscodes()
    expect(await security.verifyPasscode('123456', hash)).toBe(true)
    expect(approveFrameWallet).toHaveBeenCalledWith(auth.walletAddress, '123456')
    expect(approval.approvalFresh()).toBe(true)
  })

  it('a refused signature asks once on the shared sheet, then signs', async () => {
    let calls = 0
    const sign = () => { calls++; return calls === 1 ? Promise.reject(refused()) : Promise.resolve('0xsigned') }
    const p = withApproval(sign)
    await vi.waitFor(() => expect(approval.useApprovalPrompt.getState().open).toBe(true))
    const r = await approval.approveWallet('123456')
    expect(r.ok).toBe(true)
    approval.useApprovalPrompt.getState().resolve?.(true)
    expect(await p).toBe('0xsigned')
    expect(calls).toBe(2)
  })

  it('cancelling the sheet keeps it refused - nothing signs', async () => {
    const p = withApproval(() => Promise.reject(refused()))
    await vi.waitFor(() => expect(approval.useApprovalPrompt.getState().open).toBe(true))
    approval.useApprovalPrompt.getState().resolve?.(false)
    await expect(p).rejects.toThrow('Enter your passcode')
  })

  it('background work never opens the sheet', async () => {
    await expect(approval.inBackground(() => withApproval(() => Promise.reject(refused())))).rejects.toThrow()
    expect(approval.useApprovalPrompt.getState().open).toBe(false)
  })

  it('a wrong passcode is not accepted by the frame', async () => {
    expect(await approval.approveWallet('000000')).toEqual({ ok: false, error: 'bad-passcode', lockedForMs: undefined })
  })

  it('Google / email (Privy) wallets have nothing to approve here', async () => {
    auth.walletSource = 'privy'
    expect(await approval.approveWallet('000000')).toEqual({ ok: true })
    expect(approveFrameWallet).not.toHaveBeenCalled()
  })
})
