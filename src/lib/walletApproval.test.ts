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
// The frame's passcode:check: checks (or, with none on this device, takes) the passcode; approves nothing.
const checkFramePasscode = vi.fn(async (_a: string, pin: string) => {
  if (frameDown) throw Object.assign(new Error('The wallet took too long to answer'), { code: 'timeout' })
  if (!frameHasPasscode) return { set: true }
  if (pin !== '123456') throw Object.assign(new Error('Wrong passcode'), { code: 'bad-passcode' })
  return { set: false }
})
vi.mock('@/wallet', () => ({ checkFramePasscode: (a: string, p: string) => checkFramePasscode(a, p) }))
vi.mock('./errorReport', () => ({ reportClientError: vi.fn() }))
// The frame's signing calls: refused for want of a confirmation, until one comes.
const callWallet = vi.fn()
vi.mock('@/wallet/frameClient', async importOriginal => ({ ...(await importOriginal<object>()), callWallet: (m: string, p: unknown) => callWallet(m, p) }))

const security = await import('./security')
const approval = await import('./walletApproval')
const { approvedCall } = await import('@/wallet/account')
const { WalletFrameError } = await import('@/wallet/frameClient')

const refused = () => new WalletFrameError('approval-required' as never, 'Enter your passcode')

describe('wallet approval', () => {
  beforeEach(() => { checkFramePasscode.mockClear(); auth.walletSource = 'create'; frameHasPasscode = true; frameDown = false; security.forgetVerifiedPasscodes(); security.clearPasscodeLockout() })

  it('a passcode typed in the app is checked by the frame but approves nothing', async () => {
    const hash = await security.hashPasscode('123456')
    security.forgetVerifiedPasscodes()
    auth.walletAddress = '0x3333333333333333333333333333333333333333'
    expect(await security.verifyPasscode('123456', hash)).toBe(true)
    expect(checkFramePasscode).toHaveBeenCalledWith(auth.walletAddress, '123456')
    expect(approval.approvalFresh()).toBe(false)
    // Only the wallet's own confirm page opens the window.
    approval.noteWalletApproved(auth.walletAddress)
    expect(approval.approvalFresh()).toBe(true)
    auth.walletAddress = '0x1111111111111111111111111111111111111111'
  })

  it('a token from the wallet confirm page passes without asking the frame; a made-up one does not', async () => {
    const { issueWalletConfirmToken } = await import('./walletConfirmToken')
    expect(await approval.checkWalletPasscode(issueWalletConfirmToken('0x02'))).toEqual({ ok: true })
    expect(await approval.checkWalletPasscode('wallet-confirmed:0xmadeup')).toEqual({ ok: false, error: 'bad-passcode' })
    expect(checkFramePasscode).not.toHaveBeenCalled()
  })

  const params = { address: auth.walletAddress, typedData: { primaryType: 'Permit' } }

  it('a refused signature shows that exact request on the shared sheet, then signs with its confirmation', async () => {
    callWallet.mockReset()
    callWallet.mockImplementation(async (_m: string, p: { confirmation?: string }) => { if (!p.confirmation) throw refused(); return { signature: '0xsigned' } })
    const p = approvedCall('sign:typed-data', params)
    await vi.waitFor(() => expect(approval.useApprovalPrompt.getState().open).toBe(true))
    expect(approval.useApprovalPrompt.getState().request).toEqual({ method: 'sign:typed-data', params })
    approval.useApprovalPrompt.getState().resolve?.('0xticket')
    expect(await p).toEqual({ signature: '0xsigned' })
    expect(callWallet).toHaveBeenCalledTimes(2)
    expect(callWallet).toHaveBeenLastCalledWith('sign:typed-data', { ...params, confirmation: '0xticket' })
  })

  it('cancelling the sheet keeps it refused - nothing signs', async () => {
    callWallet.mockReset()
    callWallet.mockRejectedValue(refused())
    const p = approvedCall('sign:typed-data', params)
    await vi.waitFor(() => expect(approval.useApprovalPrompt.getState().open).toBe(true))
    approval.useApprovalPrompt.getState().resolve?.(null)
    await expect(p).rejects.toThrow('Enter your passcode')
    expect(callWallet).toHaveBeenCalledTimes(1)
  })

  it('two refused requests are asked one after the other, each with its own confirmation', async () => {
    callWallet.mockReset()
    callWallet.mockImplementation(async (_m: string, p: { confirmation?: string }) => { if (!p.confirmation) throw refused(); return { signature: p.confirmation } })
    const a = approvedCall('sign:typed-data', params)
    const b = approvedCall('sign:message', { address: auth.walletAddress, message: 'hi' })
    await vi.waitFor(() => expect(approval.useApprovalPrompt.getState().request?.method).toBe('sign:typed-data'))
    approval.useApprovalPrompt.getState().resolve?.('0xa')
    await vi.waitFor(() => expect(approval.useApprovalPrompt.getState().request?.method).toBe('sign:message'))
    approval.useApprovalPrompt.getState().resolve?.('0xb')
    expect(await a).toEqual({ signature: '0xa' })
    expect(await b).toEqual({ signature: '0xb' })
  })

  it('background work never opens the sheet', async () => {
    callWallet.mockReset()
    callWallet.mockRejectedValue(refused())
    await expect(approval.inBackground(() => approvedCall('sign:typed-data', params))).rejects.toThrow()
    expect(approval.useApprovalPrompt.getState().open).toBe(false)
  })

  it('a wrong passcode is not accepted by the frame', async () => {
    expect(await approval.checkWalletPasscode('000000')).toEqual({ ok: false, error: 'bad-passcode', lockedForMs: undefined })
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

  it('a wallet with no passcode on this device takes the one typed (it still approves nothing)', async () => {
    frameHasPasscode = false
    expect(await security.verifyPasscode('999999', security.FRAME_PASSCODE)).toBe(true)
  })

  it('the frame out of reach: an error, not a wrong passcode (no try counted)', async () => {
    frameDown = true
    await expect(security.verifyPasscode('123456', security.FRAME_PASSCODE)).rejects.toThrow(security.WALLET_UNAVAILABLE)
    expect(security.getPasscodeLockoutRemainingMs()).toBe(0)
  })

  it('older passcode formats are refused (sign in again to set a new one)', async () => {
    auth.walletSource = 'circle'
    expect(await security.verifyPasscode('123456', '123456')).toBe(false)
    expect(await security.verifyPasscode('123456', 'v2:AAAA:BBBB')).toBe(false)
  })

  it('a stored value that is not a passcode is never matched as plain text', async () => {
    auth.walletSource = 'circle'
    expect(await security.verifyPasscode('not-a-pin', 'not-a-pin')).toBe(false)
  })

  it('Google / email (Circle) wallets have nothing to approve here', async () => {
    auth.walletSource = 'circle'
    expect(await approval.checkWalletPasscode('000000')).toEqual({ ok: true })
    expect(checkFramePasscode).not.toHaveBeenCalled()
  })
})
