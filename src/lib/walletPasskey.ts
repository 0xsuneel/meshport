// src/lib/walletPasskey.ts
//
// Passkeys that unlock a Google / email wallet (self-custodial).
//
// A passkey belongs to the MeshPort account (users.id), not to Google or the
// email login. When it's created, the authenticator is asked for a secret
// (the WebAuthn PRF extension) that only it can produce, after Face ID /
// fingerprint. The wallet key is locked with that secret (HKDF → AES-256-GCM)
// on the device; the server stores only the locked copy, the credential id
// and the PRF salt - none of which open the wallet. Passkeys sync through
// iCloud Keychain / Google Password Manager, so a new phone signed into the
// same Apple / Google account unlocks the same wallet.
//
// Nothing here derives the wallet key from the passkey, the credential id,
// the email or any login: the key is random (made on the device) and the
// passkey only locks and unlocks it.
//
// This is separate from biometric.ts, which unlocks the app passcode on one
// device.

import { supabase } from './supabase'

const RP_NAME = 'MeshPort'
const HKDF_INFO = new TextEncoder().encode('meshport-wallet-passkey-v1')

export interface WalletPasskey {
  id: string
  credentialId: string
  label: string | null
  createdAt: string
}

const toB64 = (b: Uint8Array) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s) }
const toB64Url = (b: Uint8Array) => toB64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const n = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(n + '='.repeat((4 - (n.length % 4)) % 4))
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(new ArrayBuffer(h.length / 2))
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}
const toHex = (b: Uint8Array) => '0x' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('')

/** True when this browser can make passkeys at all (PRF support is only known once one is used). */
export async function isPasskeySupported(): Promise<boolean> {
  try {
    if (typeof window === 'undefined' || !window.PublicKeyCredential || !navigator.credentials) return false
    const pkc = window.PublicKeyCredential as any
    if (typeof pkc.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
      return await pkc.isUserVerifyingPlatformAuthenticatorAvailable()
    }
    return true
  } catch { return false }
}

function prfOutput(cred: PublicKeyCredential | null): Uint8Array | null {
  const r = (cred as any)?.getClientExtensionResults?.()?.prf?.results?.first
  return r ? new Uint8Array(r) : null
}

async function lockKey(prf: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', prf as BufferSource, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: HKDF_INFO }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

async function addressOf(privateKey: string): Promise<string> {
  const { privateKeyToAccount } = await import('viem/accounts')
  return privateKeyToAccount(privateKey as `0x${string}`).address
}

export class PasskeyError extends Error {
  constructor(public code: 'unsupported' | 'cancelled' | 'no-prf' | 'none' | 'mismatch' | 'failed', message: string) { super(message) }
}

/**
 * Create a passkey for this account and store the wallet key locked with it.
 * Must run from a tap (browsers require a user gesture).
 */
export async function registerWalletPasskey(opts: {
  userId: string; username: string; walletAddress: string; privateKey: string
}): Promise<void> {
  if (!(await isPasskeySupported())) throw new PasskeyError('unsupported', "This device can't create passkeys")
  if ((await addressOf(opts.privateKey)).toLowerCase() !== opts.walletAddress.toLowerCase()) {
    throw new PasskeyError('mismatch', 'Wallet key does not match this account')
  }
  const prfSalt = crypto.getRandomValues(new Uint8Array(32))
  const label = opts.username ? `${opts.username}.arc` : 'MeshPort wallet'
  let cred: PublicKeyCredential | null
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: RP_NAME },
        // The account id (not the email or a login id) - one account, many passkeys.
        user: { id: new TextEncoder().encode(opts.userId), name: label, displayName: label },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        attestation: 'none',
        timeout: 60_000,
        extensions: { prf: { eval: { first: prfSalt } } } as any,
      },
    }) as PublicKeyCredential | null
  } catch (e) {
    throw new PasskeyError('cancelled', e instanceof Error && e.name === 'NotAllowedError' ? 'Passkey setup was cancelled' : "Couldn't create a passkey")
  }
  if (!cred) throw new PasskeyError('cancelled', 'Passkey setup was cancelled')
  const credentialId = toB64Url(new Uint8Array(cred.rawId))

  // Some browsers only return the PRF secret on sign-in, not on creation.
  let prf = prfOutput(cred)
  if (!prf) prf = await evalPrf([{ credentialId, salt: prfSalt }]).then(r => r?.prf ?? null).catch(() => null)
  if (!prf) {
    throw new PasskeyError('no-prf', "This device's passkeys can't secure a wallet. Use a Recovery QR instead, or another device.")
  }

  const key = await lockKey(prf, prfSalt)
  prf.fill(0)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const pk = hexToBytes(opts.privateKey)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pk))
  pk.fill(0)

  const { error } = await supabase.from('wallet_passkeys').insert({
    user_id: opts.userId,
    credential_id: credentialId,
    prf_salt: toB64(prfSalt),
    encrypted_wallet: toB64(ct),
    iv: toB64(iv),
    wallet_address: opts.walletAddress.toLowerCase(),
    label: deviceLabel(),
  })
  if (error) throw new PasskeyError('failed', "Couldn't save the passkey - try again")
}

/** Ask the authenticator for the PRF secret of one of these credentials. */
async function evalPrf(creds: Array<{ credentialId: string; salt: Uint8Array }>): Promise<{ credentialId: string; prf: Uint8Array } | null> {
  const evalByCredential: Record<string, { first: Uint8Array }> = {}
  for (const c of creds) evalByCredential[c.credentialId] = { first: c.salt }
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: creds.map(c => ({ type: 'public-key' as const, id: fromB64(c.credentialId) })),
      userVerification: 'required',
      timeout: 60_000,
      extensions: { prf: { evalByCredential } } as any,
    },
  }) as PublicKeyCredential | null
  if (!cred) return null
  const prf = prfOutput(cred)
  return prf ? { credentialId: toB64Url(new Uint8Array(cred.rawId)), prf } : null
}

/** This account's passkeys (public details only). */
export async function listWalletPasskeys(userId: string): Promise<WalletPasskey[]> {
  const { data, error } = await supabase.from('wallet_passkeys')
    .select('id, credential_id, label, created_at').eq('user_id', userId).order('created_at', { ascending: true })
  if (error || !data) return []
  return data.map(r => ({ id: r.id, credentialId: r.credential_id, label: r.label, createdAt: r.created_at }))
}

/**
 * Unlock the wallet with any of this account's passkeys (Face ID /
 * fingerprint). Must run from a tap. Returns the key only after checking it
 * is `walletAddress`'s.
 */
export async function unlockWithPasskey(userId: string, walletAddress: string): Promise<string> {
  const { data, error } = await supabase.from('wallet_passkeys')
    .select('credential_id, prf_salt, encrypted_wallet, iv, wallet_address').eq('user_id', userId)
  if (error) throw new PasskeyError('failed', "Couldn't reach MeshPort - check your connection")
  const rows = (data ?? []).filter(r => r.wallet_address?.toLowerCase() === walletAddress.toLowerCase())
  if (rows.length === 0) throw new PasskeyError('none', 'No passkey is set up for this wallet')
  let got: { credentialId: string; prf: Uint8Array } | null
  try {
    got = await evalPrf(rows.map(r => ({ credentialId: r.credential_id, salt: fromB64(r.prf_salt) })))
  } catch (e) {
    throw new PasskeyError('cancelled', e instanceof Error && e.name === 'NotAllowedError'
      ? 'Passkey not available on this device, or cancelled' : "Couldn't use the passkey")
  }
  if (!got) throw new PasskeyError('no-prf', "This device's passkeys can't unlock a wallet - use your Recovery QR")
  const row = rows.find(r => r.credential_id === got!.credentialId)
  if (!row) { got.prf.fill(0); throw new PasskeyError('none', 'That passkey is not set up for this wallet') }
  const key = await lockKey(got.prf, fromB64(row.prf_salt))
  got.prf.fill(0)
  let pk: Uint8Array
  try {
    pk = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(row.iv) }, key, fromB64(row.encrypted_wallet)))
  } catch {
    throw new PasskeyError('failed', "This passkey couldn't unlock the wallet")
  }
  const privateKey = toHex(pk)
  pk.fill(0)
  if ((await addressOf(privateKey)).toLowerCase() !== walletAddress.toLowerCase()) {
    throw new PasskeyError('mismatch', 'This passkey belongs to a different wallet')
  }
  return privateKey
}

/** Remove one of this account's passkeys. */
export async function removeWalletPasskey(id: string): Promise<boolean> {
  const { error } = await supabase.from('wallet_passkeys').delete().eq('id', id)
  return !error
}

function deviceLabel(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const os = /iPhone|iPad/.test(ua) ? 'iPhone / iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device'
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : ''
  return browser ? `${os} · ${browser}` : os
}
