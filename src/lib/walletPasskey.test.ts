import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

// ── In-memory wallet_passkeys table behind a tiny supabase-js look-alike ──
const rows: any[] = []
vi.mock('./supabase', () => {
  const from = (_table: string) => {
    const filters: Array<[string, unknown]> = []
    const q: any = {
      select: () => q,
      eq: (c: string, v: unknown) => { filters.push([c, v]); return q },
      order: () => q,
      insert: async (r: any) => { rows.push({ id: String(rows.length + 1), created_at: new Date().toISOString(), ...r }); return { error: null } },
      delete: () => ({ eq: async (c: string, v: unknown) => { const i = rows.findIndex(r => r[c] === v); if (i >= 0) rows.splice(i, 1); return { error: null } } }),
      then: (res: any) => res({ data: rows.filter(r => filters.every(([c, v]) => r[c] === v)), error: null }),
    }
    return q
  }
  return { supabase: { from } }
})

// ── Fake platform authenticator with the PRF extension ────────────────────
// PRF output = SHA-256(device secret ‖ credential id ‖ salt), like a real
// authenticator: same credential + same salt → same secret, nothing else.
const deviceSecret = crypto.getRandomValues(new Uint8Array(32))
const creds = new Map<string, Uint8Array>() // credential id (b64url) → raw id
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
async function prf(rawId: Uint8Array, salt: Uint8Array) {
  const buf = new Uint8Array([...deviceSecret, ...rawId, ...salt])
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf))
}
let prfOnCreate = true
let prfSupported = true
const credentials = {
  create: vi.fn(async ({ publicKey }: any) => {
    const rawId = crypto.getRandomValues(new Uint8Array(16))
    creds.set(b64url(rawId), rawId)
    const salt = publicKey.extensions.prf.eval.first
    const results = prfSupported && prfOnCreate ? { first: (await prf(rawId, salt)).buffer } : undefined
    return { rawId: rawId.buffer, getClientExtensionResults: () => ({ prf: results ? { results } : {} }) }
  }),
  get: vi.fn(async ({ publicKey }: any) => {
    const allowed = publicKey.allowCredentials.map((c: any) => b64url(new Uint8Array(c.id)))
    const id = allowed.find((a: string) => creds.has(a))
    if (!id) throw Object.assign(new Error('not allowed'), { name: 'NotAllowedError' })
    const rawId = creds.get(id)!
    const salt = publicKey.extensions.prf.evalByCredential[id].first
    const results = prfSupported ? { first: (await prf(rawId, salt)).buffer } : undefined
    return { rawId: rawId.buffer, getClientExtensionResults: () => ({ prf: results ? { results } : {} }) }
  }),
}
vi.stubGlobal('window', { PublicKeyCredential: { isUserVerifyingPlatformAuthenticatorAvailable: async () => true } })
vi.stubGlobal('navigator', { credentials, userAgent: 'test' })

const { registerWalletPasskey, unlockWithPasskey, listWalletPasskeys, PasskeyError } = await import('./walletPasskey')

const pk = generatePrivateKey()
const address = privateKeyToAccount(pk).address
const userId = '11111111-1111-1111-1111-111111111111'

describe('wallet passkeys', () => {
  beforeEach(() => { rows.length = 0; creds.clear(); prfOnCreate = true; prfSupported = true })

  it('locks the wallet to the passkey and unlocks it again', async () => {
    await registerWalletPasskey({ userId, username: 'sunil', walletAddress: address, privateKey: pk })
    expect(rows).toHaveLength(1)
    // The server row never holds the key in readable form.
    expect(JSON.stringify(rows[0]).toLowerCase()).not.toContain(pk.slice(2).toLowerCase())
    expect(await unlockWithPasskey(userId, address)).toBe(pk)
    expect((await listWalletPasskeys(userId))).toHaveLength(1)
  })

  it('works when the browser only gives the PRF secret on sign-in', async () => {
    prfOnCreate = false
    await registerWalletPasskey({ userId, username: 'sunil', walletAddress: address, privateKey: pk })
    expect(await unlockWithPasskey(userId, address)).toBe(pk)
  })

  it('refuses devices whose passkeys have no PRF (would not be able to unlock later)', async () => {
    prfSupported = false
    await expect(registerWalletPasskey({ userId, username: 'sunil', walletAddress: address, privateKey: pk }))
      .rejects.toMatchObject({ code: 'no-prf' })
    expect(rows).toHaveLength(0)
  })

  it('a passkey from another device (different authenticator secret) cannot open it', async () => {
    await registerWalletPasskey({ userId, username: 'sunil', walletAddress: address, privateKey: pk })
    deviceSecret.set(crypto.getRandomValues(new Uint8Array(32)))
    await expect(unlockWithPasskey(userId, address)).rejects.toBeInstanceOf(PasskeyError)
  })

  it("won't lock a key that isn't this account's wallet, or unlock for another wallet", async () => {
    const other = privateKeyToAccount(generatePrivateKey()).address
    await expect(registerWalletPasskey({ userId, username: 'x', walletAddress: other, privateKey: pk }))
      .rejects.toMatchObject({ code: 'mismatch' })
    await registerWalletPasskey({ userId, username: 'x', walletAddress: address, privateKey: pk })
    await expect(unlockWithPasskey(userId, other)).rejects.toMatchObject({ code: 'none' })
  })
})
