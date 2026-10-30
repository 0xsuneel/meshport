import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Registration, PRF evaluation, failure recovery and unlock against a fake
// platform authenticator. The fake computes a real PRF (HMAC-SHA-256 of the
// salt under a per-credential secret), so every test runs the actual
// seal → store → assert → unseal cycle - nothing about the crypto is mocked.

const security = vi.hoisted(() => ({
  markPasscodeVerified: vi.fn(async () => {}),
  isPasscodeVerifiedThisSession: vi.fn(async () => false),
}))
vi.mock('./security', () => security)

const store = vi.hoisted(() => {
  const auth = { biometricEnabled: true, setBiometricEnabled: vi.fn((v: boolean) => { auth.biometricEnabled = v }) }
  const ui = { showToastMessage: vi.fn() }
  return { auth, ui, useAuthStore: { getState: () => auth }, useUIStore: { getState: () => ui } }
})
vi.mock('@/store', () => ({ useAuthStore: store.useAuthStore, useUIStore: store.useUIStore }))

type Lib = typeof import('./biometric')
const WALLET = '0xAbC0000000000000000000000000000000000001'
const PASSCODE = '482913'

// ─── Fake environment ────────────────────────────────────────────────────

class MemoryStorage {
  map = new Map<string, string>()
  failSetFor: ((key: string) => boolean) | null = null
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null }
  setItem(k: string, v: string) {
    if (this.failSetFor?.(k)) throw new DOMException('quota', 'QuotaExceededError')
    this.map.set(k, String(v))
  }
  removeItem(k: string) { this.map.delete(k) }
}

type CreateMode = 'results' | 'enabled-only' | 'disabled' | 'no-ext' | 'wrong-results'
type Authenticator = ReturnType<typeof makeAuthenticator>

function b64url(bytes: Uint8Array) {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
async function hmac(secret: Uint8Array, salt: BufferSource): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', key, salt)
}

function makeAuthenticator() {
  const creds = new Map<string, Uint8Array>() // credential id (b64url) → PRF secret
  const a = {
    creds,
    createMode: 'enabled-only' as CreateMode,
    getPrf: true,
    createError: null as DOMException | Error | null,
    getErrors: [] as (DOMException | Error)[],
    hangGet: false,
    createCalls: [] as CredentialCreationOptions[],
    getCalls: [] as CredentialRequestOptions[],
    async create(opts: CredentialCreationOptions) {
      a.createCalls.push(opts)
      if (a.createError) throw a.createError
      const id = crypto.getRandomValues(new Uint8Array(16))
      const secret = crypto.getRandomValues(new Uint8Array(32))
      creds.set(b64url(id), secret)
      const salt = (opts.publicKey!.extensions as any).prf.eval.first as Uint8Array
      const first = a.createMode === 'results' ? await hmac(secret, salt as BufferSource)
        : a.createMode === 'wrong-results' ? crypto.getRandomValues(new Uint8Array(32)).buffer
        : undefined
      const prf = a.createMode === 'no-ext' ? undefined
        : a.createMode === 'disabled' ? { enabled: false }
        : first ? { enabled: true, results: { first } } : { enabled: true }
      return { rawId: id.buffer, getClientExtensionResults: () => (prf ? { prf } : {}) }
    },
    async get(opts: CredentialRequestOptions) {
      a.getCalls.push(opts)
      const signal = opts.signal
      if (a.hangGet) {
        await new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      }
      const err = a.getErrors.shift()
      if (err) throw err
      const id = new Uint8Array(opts.publicKey!.allowCredentials![0].id as ArrayBuffer | Uint8Array as any)
      const secret = creds.get(b64url(id))
      if (!secret) throw new DOMException('no credential', 'NotAllowedError')
      const salt = (opts.publicKey!.extensions as any).prf.eval.first as Uint8Array
      const prf = a.getPrf ? { enabled: true, results: { first: new Uint8Array(await hmac(secret, salt as BufferSource)) } } : {}
      return { rawId: id.buffer.slice(id.byteOffset, id.byteOffset + id.byteLength), getClientExtensionResults: () => ({ prf }) }
    },
  }
  return a
}

let storage: MemoryStorage
let auth: Authenticator
let PKC: {
  isUserVerifyingPlatformAuthenticatorAvailable: ReturnType<typeof vi.fn>
  getClientCapabilities?: ReturnType<typeof vi.fn>
  signalUnknownCredential: ReturnType<typeof vi.fn>
}

function install() {
  storage = new MemoryStorage()
  auth = makeAuthenticator()
  PKC = {
    isUserVerifyingPlatformAuthenticatorAvailable: vi.fn(async () => true),
    getClientCapabilities: vi.fn(async () => ({ 'extension:prf': true })),
    signalUnknownCredential: vi.fn(async () => {}),
  }
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('PublicKeyCredential', PKC)
  vi.stubGlobal('window', { PublicKeyCredential: PKC })
  vi.stubGlobal('location', { hostname: 'meshport.xyz' })
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
    maxTouchPoints: 5,
    credentials: { create: (o: CredentialCreationOptions) => auth.create(o), get: (o: CredentialRequestOptions) => auth.get(o) },
  })
}

/** A fresh copy of the module - what a page refresh / PWA restart starts with. */
async function load(): Promise<Lib> {
  vi.resetModules()
  return import('./biometric')
}

const credKey = `meshport_biometric_cred_${WALLET.toLowerCase()}`
const secretKey = `meshport_biometric_secret_${WALLET.toLowerCase()}`
const saltOf = (o: { publicKey?: { extensions?: unknown } }) => b64url((o.publicKey!.extensions as any).prf.eval.first)

beforeEach(() => {
  install()
  store.auth.biometricEnabled = true
  store.auth.setBiometricEnabled.mockClear()
  store.ui.showToastMessage.mockClear()
  security.markPasscodeVerified.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

// ─── Registration ────────────────────────────────────────────────────────

describe('registerBiometric - PRF registration sequence', () => {
  it('create() reporting enabled without results → a separate get() with the same credential and salt obtains the PRF output', async () => {
    const lib = await load()
    auth.createMode = 'enabled-only'
    const r = await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')
    expect(r).toEqual({ status: 'ok' })
    expect(auth.createCalls).toHaveLength(1)
    expect(auth.getCalls).toHaveLength(1)
    // Same credential, same salt.
    const getOpts = auth.getCalls[0].publicKey!
    expect(b64url(new Uint8Array(getOpts.allowCredentials![0].id as Uint8Array))).toBe(storage.getItem(credKey))
    expect(saltOf(auth.getCalls[0])).toBe(saltOf(auth.createCalls[0]))
    expect(getOpts.userVerification).toBe('required')
    expect(lib.hasBiometricRegistered(WALLET)).toBe(true)
  })

  it('create() returning the PRF output still runs a verification get(), whose output must match', async () => {
    const lib = await load()
    auth.createMode = 'results'
    expect(await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')).toEqual({ status: 'ok' })
    expect(auth.getCalls).toHaveLength(1)
  })

  it('never stores the passcode readable, and uses a platform, UV-required credential with no rp.id override', async () => {
    const lib = await load()
    await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')
    const raw = storage.getItem(secretKey)!
    expect(raw).not.toContain(PASSCODE)
    expect(JSON.parse(raw)).toMatchObject({ v: 3 })
    const pk = auth.createCalls[0].publicKey!
    expect(pk.authenticatorSelection).toMatchObject({ authenticatorAttachment: 'platform', userVerification: 'required' })
    expect((pk.rp as { id?: string }).id).toBeUndefined() // the current host (meshport.xyz / preview host)
  })

  it('uses the same user handle for the same wallet, so re-enabling replaces the passkey', async () => {
    const lib = await load()
    await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')
    await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')
    const ids = auth.createCalls.map(c => b64url(new Uint8Array(c.publicKey!.user.id as Uint8Array)))
    expect(ids[0]).toBe(ids[1])
  })

  it('prf.enabled false → unsupported: no assertion, nothing stored, credential discarded', async () => {
    const lib = await load()
    auth.createMode = 'disabled'
    expect(await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')).toEqual({ status: 'failed', reason: 'unsupported' })
    expect(auth.getCalls).toHaveLength(0)
    expect(lib.hasBiometricRegistered(WALLET)).toBe(false)
    expect(storage.map.size).toBe(0)
    expect(PKC.signalUnknownCredential).toHaveBeenCalledWith(expect.objectContaining({ rpId: 'meshport.xyz' }))
  })

  it('assertion without PRF results → unsupported, nothing stored (no weaker fallback)', async () => {
    const lib = await load()
    auth.getPrf = false
    expect(await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')).toEqual({ status: 'failed', reason: 'unsupported' })
    expect(storage.map.size).toBe(0)
    expect(PKC.signalUnknownCredential).toHaveBeenCalled()
  })

  it('create() and get() PRF outputs disagreeing → mismatch, nothing stored', async () => {
    const lib = await load()
    auth.createMode = 'wrong-results'
    expect(await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')).toEqual({ status: 'failed', reason: 'mismatch' })
    expect(storage.map.size).toBe(0)
  })

  it('reports what actually went wrong instead of calling everything "cancelled"', async () => {
    const lib = await load()
    const cases: [Error, string][] = [
      [new DOMException('x', 'NotAllowedError'), 'cancelled'],
      [new DOMException('x', 'AbortError'), 'cancelled'],
      [new DOMException('x', 'SecurityError'), 'security'],
      [new DOMException('x', 'InvalidStateError'), 'exists'],
      [new DOMException('x', 'NotSupportedError'), 'unsupported'],
      [new DOMException('x', 'ConstraintError'), 'no-screen-lock'],
      [new TypeError('bad options'), 'error'],
    ]
    for (const [err, reason] of cases) {
      auth.createError = err
      expect(await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')).toEqual({ status: 'failed', reason })
      expect(storage.map.size).toBe(0)
      expect(lib.biometricFailureMessage(reason as never, 'Fingerprint')).toMatch(/\w/)
    }
  })

  it('isBiometricSupported is false once the browser says it has no PRF, even with a platform authenticator', async () => {
    const lib = await load()
    PKC.getClientCapabilities!.mockResolvedValue({ 'extension:prf': false })
    expect(await lib.isBiometricSupported()).toBe(false)
    expect(await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')).toEqual({ status: 'failed', reason: 'unsupported' })
    expect(auth.createCalls).toHaveLength(0)
  })

  it('isBiometricSupported still tries when the browser cannot report capabilities', async () => {
    const lib = await load()
    delete PKC.getClientCapabilities
    expect(await lib.isBiometricSupported()).toBe(true)
  })
})

describe('registerBiometric - failure recovery', () => {
  it('a verification prompt refused without a fresh tap → needs-confirm; confirming finishes it', async () => {
    const lib = await load()
    auth.getErrors = [new DOMException('needs a gesture', 'NotAllowedError')]
    const r = await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')
    expect(r.status).toBe('needs-confirm')
    expect(lib.hasBiometricRegistered(WALLET)).toBe(false) // nothing saved yet
    if (r.status !== 'needs-confirm') return
    expect(await lib.confirmBiometricRegistration(r.pending)).toEqual({ status: 'ok' })
    expect((await lib.unlockWithBiometric(WALLET)).passcode).toBe(PASSCODE)
  })

  it('needs-confirm then Skip → credential discarded, nothing stored', async () => {
    const lib = await load()
    auth.getErrors = [new DOMException('x', 'NotAllowedError')]
    const r = await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')
    if (r.status !== 'needs-confirm') throw new Error('expected needs-confirm')
    lib.abandonBiometricRegistration(r.pending)
    expect(PKC.signalUnknownCredential).toHaveBeenCalledWith({ rpId: 'meshport.xyz', credentialId: r.pending.credId })
    expect(storage.map.size).toBe(0)
  })

  it('cancelling the confirmation too → cancelled, credential discarded', async () => {
    const lib = await load()
    auth.getErrors = [new DOMException('x', 'NotAllowedError'), new DOMException('x', 'NotAllowedError')]
    const r = await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')
    if (r.status !== 'needs-confirm') throw new Error('expected needs-confirm')
    expect(await lib.confirmBiometricRegistration(r.pending)).toEqual({ status: 'failed', reason: 'cancelled' })
    expect(PKC.signalUnknownCredential).toHaveBeenCalled()
    expect(storage.map.size).toBe(0)
  })

  it('storage failing half-way → both keys removed, credential discarded', async () => {
    const lib = await load()
    storage.failSetFor = k => k === credKey // the second of the two writes
    expect(await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')).toEqual({ status: 'failed', reason: 'storage' })
    expect(storage.getItem(secretKey)).toBeNull()
    expect(storage.getItem(credKey)).toBeNull()
    expect(PKC.signalUnknownCredential).toHaveBeenCalled()
  })

  it('a failed registration leaves no record, so passcode login is untouched', async () => {
    const lib = await load()
    auth.createError = new DOMException('x', 'NotAllowedError')
    await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')
    expect(lib.hasBiometricRegistered(WALLET)).toBe(false)
    expect(await lib.unlockWithBiometric(WALLET)).toEqual({ ok: false, reason: 'not-registered' })
    expect(auth.getCalls).toHaveLength(0) // no prompt is even attempted
  })
})

// ─── Unlock ──────────────────────────────────────────────────────────────

describe('unlockWithBiometric', () => {
  it('decrypts the passcode after a page refresh / PWA restart (fresh module, same storage + authenticator)', async () => {
    const first = await load()
    expect(await first.registerBiometric(WALLET, PASSCODE, 'Sunil')).toEqual({ status: 'ok' })
    const afterRestart = await load()
    expect(afterRestart.hasBiometricRegistered(WALLET)).toBe(true)
    expect(await afterRestart.unlockWithBiometric(WALLET)).toEqual({ ok: true, passcode: PASSCODE })
    expect(await afterRestart.verifyBiometricAndGetPasscode(WALLET)).toBe(PASSCODE)
  })

  it('a record confirmed for the current hash counts as verified at once', async () => {
    const lib = await load()
    await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')
    storage.setItem(secretKey, JSON.stringify({ ...JSON.parse(storage.getItem(secretKey)!), forHash: 'HASH' }))
    await lib.unlockWithBiometric(WALLET, 'HASH')
    expect(security.markPasscodeVerified).toHaveBeenCalledWith(PASSCODE, 'HASH')
  })

  it('cancelled prompt → cancelled, record kept; repeated cancels stop the automatic prompt, a success resets it', async () => {
    const lib = await load()
    await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')
    for (let i = 0; i < 3; i++) {
      auth.getErrors = [new DOMException('x', 'NotAllowedError')]
      expect(await lib.unlockWithBiometric(WALLET)).toEqual({ ok: false, reason: 'cancelled' })
    }
    expect(lib.hasBiometricRegistered(WALLET)).toBe(true)
    expect(lib.shouldAutoPromptBiometric(WALLET)).toBe(false)
    expect((await lib.unlockWithBiometric(WALLET)).ok).toBe(true)
    expect(lib.shouldAutoPromptBiometric(WALLET)).toBe(true)
  })

  it('"Use passcode" aborts an open prompt immediately, without counting as a failure', async () => {
    const lib = await load()
    await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')
    auth.hangGet = true
    const ctrl = new AbortController()
    const p = lib.unlockWithBiometric(WALLET, undefined, ctrl.signal)
    ctrl.abort()
    expect(await p).toEqual({ ok: false, reason: 'cancelled' })
    expect(lib.shouldAutoPromptBiometric(WALLET)).toBe(true)
  })

  it('a record that no longer decrypts is removed and the setting turned off - later payments go straight to the passcode', async () => {
    const lib = await load()
    await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')
    const rec = JSON.parse(storage.getItem(secretKey)!)
    storage.setItem(secretKey, JSON.stringify({ ...rec, ciphertext: btoa('tampered-ciphertext-bytes') }))
    expect(await lib.unlockWithBiometric(WALLET)).toEqual({ ok: false, reason: 'invalidated' })
    expect(lib.hasBiometricRegistered(WALLET)).toBe(false)
    await vi.waitFor(() => expect(store.auth.setBiometricEnabled).toHaveBeenCalledWith(false))
    const prompts = auth.getCalls.length
    expect(await lib.unlockWithBiometric(WALLET)).toEqual({ ok: false, reason: 'not-registered' })
    expect(auth.getCalls).toHaveLength(prompts)
  })

  it('an assertion that stops returning PRF output invalidates the record', async () => {
    const lib = await load()
    await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')
    auth.getPrf = false
    expect(await lib.unlockWithBiometric(WALLET)).toEqual({ ok: false, reason: 'invalidated' })
    expect(lib.hasBiometricRegistered(WALLET)).toBe(false)
  })

  it('a passkey deleted from the device fails as a normal cancel (passcode still works)', async () => {
    const lib = await load()
    await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')
    auth.creds.clear()
    expect(await lib.unlockWithBiometric(WALLET)).toEqual({ ok: false, reason: 'cancelled' })
  })

  it('a legacy (v2) record is dropped, never used', async () => {
    const lib = await load()
    storage.setItem(credKey, 'abc')
    storage.setItem(secretKey, JSON.stringify({ v: 2, iv: 'x', ciphertext: 'y' }))
    expect(lib.hasBiometricRegistered(WALLET)).toBe(false)
    expect(await lib.unlockWithBiometric(WALLET)).toEqual({ ok: false, reason: 'invalidated' })
    expect(storage.getItem(secretKey)).toBeNull()
    expect(auth.getCalls).toHaveLength(0)
  })
})

// ─── Lifecycle ───────────────────────────────────────────────────────────

describe('disable / re-enable / passcode change / logout', () => {
  it('disabling (or logout) removes the record and signals the authenticator; re-enabling works', async () => {
    const lib = await load()
    await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')
    const credId = storage.getItem(credKey)!
    lib.removeBiometric(WALLET)
    expect(lib.hasBiometricRegistered(WALLET)).toBe(false)
    expect(PKC.signalUnknownCredential).toHaveBeenCalledWith({ rpId: 'meshport.xyz', credentialId: credId })
    expect(await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')).toEqual({ status: 'ok' })
    expect((await lib.unlockWithBiometric(WALLET)).passcode).toBe(PASSCODE)
  })

  it('a passcode change re-seals under a fresh salt with the same credential', async () => {
    const lib = await load()
    await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')
    const credId = storage.getItem(credKey)
    const oldSalt = JSON.parse(storage.getItem(secretKey)!).salt
    expect(await lib.updateBiometricPasscode(WALLET, '111222')).toEqual({ status: 'ok' })
    expect(storage.getItem(credKey)).toBe(credId)
    expect(JSON.parse(storage.getItem(secretKey)!).salt).not.toBe(oldSalt)
    expect(auth.createCalls).toHaveLength(1) // no new enrollment
    expect((await lib.unlockWithBiometric(WALLET)).passcode).toBe('111222')
  })

  it('a passcode change whose scan is refused (Safari: no fresh tap) drops the old passcode at once and finishes from one tap', async () => {
    const lib = await load()
    await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')
    auth.getErrors = [new DOMException('x', 'NotAllowedError')]
    const r = await lib.updateBiometricPasscode(WALLET, '111222')
    if (r.status !== 'needs-confirm') throw new Error('expected needs-confirm')
    expect(r.pending.reseal).toBe(true)
    expect(lib.hasBiometricRegistered(WALLET)).toBe(false) // the old passcode is never recoverable again
    expect(PKC.signalUnknownCredential).not.toHaveBeenCalled() // the credential is kept for the confirm
    expect(await lib.confirmBiometricRegistration(r.pending)).toEqual({ status: 'ok' })
    expect(auth.createCalls).toHaveLength(1) // still no new enrollment
    expect((await lib.unlockWithBiometric(WALLET)).passcode).toBe('111222')
  })

  it('a refused passcode re-seal that is then skipped discards the credential', async () => {
    const lib = await load()
    await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')
    auth.getErrors = [new DOMException('x', 'NotAllowedError')]
    const r = await lib.updateBiometricPasscode(WALLET, '111222')
    if (r.status !== 'needs-confirm') throw new Error('expected needs-confirm')
    lib.abandonBiometricRegistration(r.pending)
    expect(PKC.signalUnknownCredential).toHaveBeenCalledWith({ rpId: 'meshport.xyz', credentialId: r.pending.credId })
    expect(storage.map.size).toBe(0)
  })

  it('a passcode re-seal without PRF turns biometric unlock off', async () => {
    const lib = await load()
    await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')
    auth.getPrf = false
    expect(await lib.updateBiometricPasscode(WALLET, '111222')).toEqual({ status: 'failed', reason: 'unsupported' })
    expect(lib.hasBiometricRegistered(WALLET)).toBe(false)
  })

  it('asks the browser to keep storage after a successful registration', async () => {
    const lib = await load()
    const persist = vi.fn(async () => true)
    ;(navigator as unknown as { storage: unknown }).storage = { persisted: vi.fn(async () => false), persist }
    await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')
    await vi.waitFor(() => expect(persist).toHaveBeenCalled())
  })

  it('records are per wallet', async () => {
    const lib = await load()
    await lib.registerBiometric(WALLET, PASSCODE, 'Sunil')
    expect(lib.hasBiometricRegistered('0x0000000000000000000000000000000000000002')).toBe(false)
  })
})
