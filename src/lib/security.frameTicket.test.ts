// verifyPasscode with the wallet frame's keypad ticket (docs/SECURE-APPROVALS.md).
import { describe, it, expect, vi, beforeEach } from 'vitest'

let approved = true
const calls: Array<{ method: string; params: any }> = []
vi.mock('@/wallet/frameClient', () => ({
  callWallet: async (method: string, params: any) => { calls.push({ method, params }); return { approved } },
}))
const { verifyPasscode, onPasscodeVerified, FRAME_PASSCODE } = await import('./security')

describe('verifyPasscode with a frame ticket', () => {
  beforeEach(() => { calls.length = 0; approved = true })
  it('asks the frame; an approved ticket counts, and the hooks get the ticket (never digits)', async () => {
    const seen: string[] = []
    const off = onPasscodeVerified(async p => { seen.push(p) })
    expect(await verifyPasscode('frame-ticket:0x' + 'ab'.repeat(16), FRAME_PASSCODE)).toBe(true)
    off()
    expect(calls[0].method).toBe('confirm:status')
    expect(seen).toEqual(['frame-ticket:0x' + 'ab'.repeat(16)])
  })
  it('not approved, or the passcode does not live in the frame: refused', async () => {
    approved = false
    expect(await verifyPasscode('frame-ticket:0x' + 'cd'.repeat(16), FRAME_PASSCODE)).toBe(false)
    approved = true
    expect(await verifyPasscode('frame-ticket:0x' + 'cd'.repeat(16), 'v3:abc:def')).toBe(false)
  })
})
