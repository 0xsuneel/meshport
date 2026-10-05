import { describe, it, expect } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import {
  createRecoveryPayload, openRecoveryPayload, checkRecoveryPassword, recoveryPayloadAddress,
  RecoveryError, RECOVERY_QR_PREFIX,
} from './recoveryQr'

// Smallest allowed cost so the suite stays fast; the app uses the default.
const FAST = { m: 8 * 1024, t: 1, p: 1 }
const PASSWORD = 'river-lamp-coffee-42'
const pk = generatePrivateKey()
const address = privateKeyToAccount(pk).address

const code = async (p: Promise<unknown>) => {
  try { await p; return 'ok' } catch (e) { return e instanceof RecoveryError ? e.code : 'other:' + (e as Error).message }
}
function flipByte(text: string, index: number): string {
  const b64 = text.slice(RECOVERY_QR_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0))
  bytes[index] ^= 0x01
  const out = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return RECOVERY_QR_PREFIX + out
}

describe('Recovery QR', () => {
  it('round-trips with the right password and wallet', async () => {
    const qr = await createRecoveryPayload(pk, address, PASSWORD, FAST)
    expect(qr.startsWith(RECOVERY_QR_PREFIX)).toBe(true)
    const out = await openRecoveryPayload(qr, PASSWORD, address)
    expect(out.privateKey).toBe(pk)
    expect(out.address).toBe(address)
  })

  it('never contains the private key, the password or anything readable from them', async () => {
    const qr = await createRecoveryPayload(pk, address, PASSWORD, FAST)
    expect(qr.toLowerCase()).not.toContain(pk.slice(2).toLowerCase())
    expect(qr).not.toContain(PASSWORD)
    const raw = atob(qr.slice(RECOVERY_QR_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice(0, (4 - (qr.length - RECOVERY_QR_PREFIX.length) % 4) % 4))
    const hex = Array.from(raw, c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    expect(hex).not.toContain(pk.slice(2).toLowerCase())
    // Same inputs → different QR (fresh salt and nonce every time).
    expect(await createRecoveryPayload(pk, address, PASSWORD, FAST)).not.toBe(qr)
  })

  it('rejects a wrong password', async () => {
    const qr = await createRecoveryPayload(pk, address, PASSWORD, FAST)
    expect(await code(openRecoveryPayload(qr, PASSWORD + 'x', address))).toBe('decrypt')
  })

  it('rejects the QR if any single byte is changed', async () => {
    const qr = await createRecoveryPayload(pk, address, PASSWORD, FAST)
    const total = 107
    for (let i = 3; i < total; i++) {
      const result = await code(openRecoveryPayload(flipByte(qr, i), PASSWORD, address))
      expect(result, `byte ${i}`).not.toBe('ok')
    }
  }, 120_000)

  it('rejects a truncated or foreign QR', async () => {
    const qr = await createRecoveryPayload(pk, address, PASSWORD, FAST)
    expect(await code(openRecoveryPayload(qr.slice(0, -4), PASSWORD, address))).toBe('format')
    expect(await code(openRecoveryPayload('https://example.com', PASSWORD, address))).toBe('format')
    expect(await code(openRecoveryPayload(pk, PASSWORD, address))).toBe('format')
  })

  it("rejects a valid QR for a different account's wallet", async () => {
    const other = privateKeyToAccount(generatePrivateKey()).address
    const qr = await createRecoveryPayload(pk, address, PASSWORD, FAST)
    expect(await code(openRecoveryPayload(qr, PASSWORD, other))).toBe('mismatch')
  })

  it('refuses to build a QR for a key that is not this wallet', async () => {
    const other = privateKeyToAccount(generatePrivateKey()).address
    expect(await code(createRecoveryPayload(pk, other, PASSWORD, FAST))).toMatch(/^other:/)
  })

  it('exposes the wallet address without the password (to say which wallet it is)', async () => {
    const qr = await createRecoveryPayload(pk, address, PASSWORD, FAST)
    expect(recoveryPayloadAddress(qr)?.toLowerCase()).toBe(address.toLowerCase())
    expect(recoveryPayloadAddress('nope')).toBeNull()
  })

  it('requires a strong recovery password', () => {
    expect(checkRecoveryPassword('123456')).not.toBeNull()
    expect(checkRecoveryPassword('123456789012')).not.toBeNull()
    expect(checkRecoveryPassword('aaaaaaaaaaaaaa')).not.toBeNull()
    expect(checkRecoveryPassword(PASSWORD)).toBeNull()
  })
})
