import { describe, it, expect, vi, beforeEach } from 'vitest'

// Google / email wallet passcode kept only in the wallet frame
// (lib/circlePasscode.ts) - with the frame faked: one check per device.

let framePin: string | null = null
let frameUp = true
const err = (code: string) => Object.assign(new Error(code), { code })
vi.mock('@/wallet/frameClient', () => ({
  callWallet: async (method: string, p: any) => {
    if (!frameUp) throw err('timeout')
    if (method === 'circle-passcode:check') { if (!framePin) throw err('not-found'); if (p.passcode !== framePin) throw err('bad-passcode'); return { ok: true } }
    if (method === 'circle-passcode:set') { if (framePin && p.oldPasscode !== framePin) throw err('bad-passcode'); framePin = p.passcode; return { ok: true } }
    if (method === 'circle-passcode:forget') { framePin = null; return { ok: true } }
    throw new Error('unexpected ' + method)
  },
}))
const auth: any = {}
vi.mock('@/store', () => ({ useAuthStore: { getState: () => auth } }))
const hooks: Array<(p: string) => Promise<void>> = []
vi.mock('./security', () => ({ FRAME_PASSCODE: 'frame:v1', WALLET_UNAVAILABLE: 'wallet-unavailable', onPasscodeVerified: (f: any) => { hooks.push(f) } }))

const cp = await import('./circlePasscode')
const verified = async (p: string) => { for (const h of hooks) await h(p) }

describe('Google / email wallet passcode in the wallet frame', () => {
  beforeEach(() => {
    framePin = null; frameUp = true
    Object.assign(auth, { walletSource: 'circle', walletAddress: '0xabc', passcode: 'v3:hash', setPasscode: (c: string) => { auth.passcode = c }, logout: () => { auth.loggedOut = true }, loggedOut: false })
  })

  it('the first passcode the app verifies (against its old hash) moves to the frame, and the hash goes', async () => {
    await verified('123456')
    expect(framePin).toBe('123456')
    expect(auth.passcode).toBe('frame:v1')
  })

  it('a check left from an earlier passcode on this device is replaced (the app\'s hash is the authority until then)', async () => {
    framePin = '999999'
    await verified('123456')
    expect(framePin).toBe('123456')
    expect(auth.passcode).toBe('frame:v1')
  })

  it('frame unreachable: the hash stays, and it moves next time', async () => {
    frameUp = false
    await verified('123456')
    expect(auth.passcode).toBe('v3:hash')
  })

  it('not for other wallets, and never once the frame holds it', async () => {
    auth.walletSource = 'create'
    await verified('123456')
    expect(framePin).toBeNull()
    auth.walletSource = 'circle'; auth.passcode = 'frame:v1'; framePin = '111111'
    await verified('123456')
    expect(framePin).toBe('111111')
  })

  it('unlocking: checked in the frame; wrong is false; frame unreachable throws; a lost check signs out', async () => {
    framePin = '123456'; auth.passcode = 'frame:v1'
    expect(await cp.checkCirclePasscode('123456')).toBe(true)
    expect(await cp.checkCirclePasscode('000000')).toBe(false)
    frameUp = false
    await expect(cp.checkCirclePasscode('123456')).rejects.toThrow('wallet-unavailable')
    frameUp = true; framePin = null
    expect(await cp.checkCirclePasscode('123456')).toBe(false)
    expect(auth.passcode).toBe('')
    expect(auth.loggedOut).toBe(true) // signed out: never "no passcode" behind the lock screen
  })

  it('change passcode: the frame changes its check only with the current passcode, and a refusal changes nothing', async () => {
    framePin = '123456'; auth.passcode = 'frame:v1'
    await expect(cp.changeCirclePasscode('000000', '654321')).rejects.toThrow('Current passcode is incorrect')
    expect(framePin).toBe('123456')
    frameUp = false
    await expect(cp.changeCirclePasscode('123456', '654321')).rejects.toThrow("Couldn't reach your wallet")
    frameUp = true
    expect(await cp.changeCirclePasscode('123456', '654321')).toBe(true)
    expect(framePin).toBe('654321')
  })

  it('change passcode before it moved (still a hash): the new one goes straight to the frame', async () => {
    framePin = '999999'
    expect(await cp.changeCirclePasscode('123456', '654321')).toBe(true)
    expect(framePin).toBe('654321')
  })
})
