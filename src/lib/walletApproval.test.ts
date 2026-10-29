import { describe, it, expect, vi, beforeEach } from 'vitest'

const auth = {
  walletAddress: '0x1111111111111111111111111111111111111111', walletSource: 'create' as string,
  passcode: '' as string, setPasscode: (p: string) => { auth.passcode = p },
}
vi.mock('@/store', () => ({ useAuthStore: { getState: () => auth } }))
// Page storage (node has none): lockout state and the oldest passcode formats read it.
const mem = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  removeItem: (k: string) => { mem.delete(k) }, clear: () => mem.clear(),
})
let frameHasPasscode = true
let frameDown = false
const approveFrameWallet = vi.fn(async (_a: string, pin: string) => {
  if (frameDown) throw Object.assign(new Error('The wallet took too long to answer'), { code: 'timeout' })
  if (!frameHasPasscode) return { required: false }
  if (pin !== '123456') throw Object.assign(new Error('Wrong passcode'), { code: 'bad-passcode' })
  return { required: true }
})
vi.mock('@/wallet', () => ({ approveFrameWallet: (a: string, p: string) => approveFrameWallet(a, p) }))
vi.mock('./errorReport', () => ({ reportClientError: vi.fn() }))

const security = await import('./security')
const approval = await import('./walletApproval')
const { withApproval } = await import('@/wallet/account')
const { WalletFrameError } = await import('@/wallet/frameClient')

const refused = () => new WalletFrameError('approval-required' as never, 'Enter your passcode')

describe('wallet approval', () => {
  beforeEach(() => { approveFrameWallet.mockClear(); auth.walletSource = 'create'; frameHasPasscode = true; frameDown = false; security.forgetVerifiedPasscodes(); security.clearPasscodeLockout() })

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

  it('once the frame has checked the passcode, the app keeps no hash of it - only the marker', async () => {
    auth.passcode = await security.hashPasscode('123456')
    expect(await security.verifyPasscode('123456', auth.passcode)).toBe(true)
    expect(auth.passcode).toBe(security.FRAME_PASSCODE)
  })

  it('with the marker the frame checks the passcode: right / wrong', async () => {
    expect(await security.verifyPasscode('123456', security.FRAME_PASSCODE)).toBe(true)
    security.forgetVerifiedPasscodes()
    expect(await security.verifyPasscode('000000', security.FRAME_PASSCODE)).toBe(false)
  })

  it('a frame with no passcode for this wallet never counts as a match', async () => {
    frameHasPasscode = false
    expect(await security.verifyPasscode('999999', security.FRAME_PASSCODE)).toBe(false)
  })

  it('the frame out of reach: an error, not a wrong passcode (no try counted)', async () => {
    frameDown = true
    await expect(security.verifyPasscode('123456', security.FRAME_PASSCODE)).rejects.toThrow(security.WALLET_UNAVAILABLE)
    expect(security.getPasscodeLockoutRemainingMs()).toBe(0)
  })

  it('older passcode formats are refused (sign in again to set a new one)', async () => {
    auth.walletSource = 'privy'
    expect(await security.verifyPasscode('123456', '123456')).toBe(false)
    expect(await security.verifyPasscode('123456', 'v2:AAAA:BBBB')).toBe(false)
  })

  it('a stored value that is not a passcode is never matched as plain text', async () => {
    auth.walletSource = 'privy'
    expect(await security.verifyPasscode('not-a-pin', 'not-a-pin')).toBe(false)
  })

  it('Google / email (Privy) wallets have nothing to approve here', async () => {
    auth.walletSource = 'privy'
    expect(await approval.approveWallet('000000')).toEqual({ ok: true })
    expect(approveFrameWallet).not.toHaveBeenCalled()
  })
})
