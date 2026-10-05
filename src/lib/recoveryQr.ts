// src/lib/recoveryQr.ts
//
// Encrypted Recovery QR for Google / email wallets (self-custodial).
//
// The QR never holds the private key, the password or the encryption key.
// It holds only what's needed to decrypt WITH the user's recovery password:
//
//   "meshport-recovery:" + base64url(
//     magic "MPR" | version | alg | argon2 m (KiB, u32) | t | p |
//     salt(16) | nonce(12) | wallet address(20) | AES-256-GCM ciphertext+tag(48)
//   )
//
//   recovery password ─Argon2id(salt, m, t, p)─▶ 256-bit key
//   key ─AES-256-GCM(nonce, AAD = every byte before the ciphertext)─▶ private key
//
// Every header byte is authenticated (AAD), so changing any byte of the QR —
// parameters, salt, address or ciphertext — makes decryption fail and the
// recovery is rejected. After decrypting, the key's own address must match
// the address in the QR AND the account's wallet, or it's rejected too.
//
// Runs entirely on the device: the password and the decrypted key are never
// sent anywhere, stored or logged. Primitives come from @noble/hashes
// (Argon2id) and WebCrypto (AES-GCM) — nothing hand-rolled.

import { argon2idAsync } from '@noble/hashes/argon2'

export const RECOVERY_QR_PREFIX = 'meshport-recovery:'

const MAGIC = [0x4d, 0x50, 0x52] // "MPR"
const VERSION = 1
const ALG_ARGON2ID_AES256GCM = 1
// Above OWASP's Argon2id minimum (19 MiB, t=2). Stored in the QR, so later
// QRs can use stronger settings without breaking older ones.
const DEFAULT_KDF = { m: 32 * 1024, t: 2, p: 1 }
// Bounds for parameters read from a QR — a crafted QR must not make the
// phone allocate gigabytes or spin for minutes.
const KDF_LIMITS = { mMin: 8 * 1024, mMax: 256 * 1024, tMin: 1, tMax: 10, pMin: 1, pMax: 4 }

const HEADER_LEN = 3 + 1 + 1 + 4 + 1 + 1 + 16 + 12 + 20 // 59
const CT_LEN = 32 + 16
const TOTAL_LEN = HEADER_LEN + CT_LEN

export type RecoveryErrorCode =
  | 'format'     // not a MeshPort recovery QR / damaged beyond reading
  | 'unsupported'// a newer QR version this app doesn't know
  | 'decrypt'    // wrong password, or the QR was changed
  | 'mismatch'   // decrypted, but it isn't this account's wallet

export class RecoveryError extends Error {
  constructor(public code: RecoveryErrorCode, message: string) { super(message) }
}

/** Why a recovery password isn't strong enough, or null if it's fine. */
export function checkRecoveryPassword(pw: string): string | null {
  if (pw.length < 12) return 'Use at least 12 characters'
  if (/^\d+$/.test(pw)) return "Don't use only numbers — add letters or words"
  if (new Set(pw).size < 6) return 'Too repetitive — use more different characters'
  return null
}

const enc = new TextEncoder()
function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function fromB64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new RecoveryError('format', 'Not a MeshPort Recovery QR')
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2) throw new Error('bad hex')
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}
const toHex = (b: Uint8Array) => '0x' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('')

async function addressOf(privateKey: string): Promise<string> {
  const { privateKeyToAccount } = await import('viem/accounts')
  return privateKeyToAccount(privateKey as `0x${string}`).address
}

async function deriveKey(password: string, salt: Uint8Array, kdf: { m: number; t: number; p: number }): Promise<CryptoKey> {
  const raw = await argon2idAsync(enc.encode(password.normalize('NFKC')), salt, { m: kdf.m, t: kdf.t, p: kdf.p, dkLen: 32 })
  try {
    return await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  } finally {
    raw.fill(0)
  }
}

/**
 * Build the Recovery QR text for this wallet. The password must pass
 * checkRecoveryPassword. Nothing leaves the device.
 */
export async function createRecoveryPayload(privateKey: string, walletAddress: string, password: string, kdf = DEFAULT_KDF): Promise<string> {
  const weak = checkRecoveryPassword(password)
  if (weak) throw new Error(weak)
  const actual = await addressOf(privateKey)
  if (actual.toLowerCase() !== walletAddress.toLowerCase()) throw new Error('This key does not belong to this wallet')

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const header = new Uint8Array(HEADER_LEN)
  const view = new DataView(header.buffer)
  header.set(MAGIC, 0)
  header[3] = VERSION
  header[4] = ALG_ARGON2ID_AES256GCM
  view.setUint32(5, kdf.m)
  header[9] = kdf.t
  header[10] = kdf.p
  header.set(salt, 11)
  header.set(nonce, 27)
  header.set(hexToBytes(actual), 39)

  const key = await deriveKey(password, salt, kdf)
  const pk = hexToBytes(privateKey)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: header, tagLength: 128 }, key, pk as BufferSource))
  pk.fill(0)

  const out = new Uint8Array(TOTAL_LEN)
  out.set(header, 0)
  out.set(ct, HEADER_LEN)
  return RECOVERY_QR_PREFIX + b64url(out)
}

/** The wallet address a Recovery QR is for (readable without the password), or null if it isn't one. */
export function recoveryPayloadAddress(text: string): string | null {
  try { return parse(text).address } catch { return null }
}

function parse(text: string) {
  const t = text.trim()
  if (!t.startsWith(RECOVERY_QR_PREFIX)) throw new RecoveryError('format', 'Not a MeshPort Recovery QR')
  const bytes = fromB64url(t.slice(RECOVERY_QR_PREFIX.length))
  if (bytes.length < 5 || bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1] || bytes[2] !== MAGIC[2]) {
    throw new RecoveryError('format', 'Not a MeshPort Recovery QR')
  }
  if (bytes[3] !== VERSION || bytes[4] !== ALG_ARGON2ID_AES256GCM) {
    throw new RecoveryError('unsupported', 'This Recovery QR was made by a newer MeshPort — update the app')
  }
  if (bytes.length !== TOTAL_LEN) throw new RecoveryError('format', 'This Recovery QR is incomplete or damaged')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const kdf = { m: view.getUint32(5), t: bytes[9], p: bytes[10] }
  if (kdf.m < KDF_LIMITS.mMin || kdf.m > KDF_LIMITS.mMax || kdf.t < KDF_LIMITS.tMin || kdf.t > KDF_LIMITS.tMax
    || kdf.p < KDF_LIMITS.pMin || kdf.p > KDF_LIMITS.pMax) {
    throw new RecoveryError('format', 'This Recovery QR is damaged')
  }
  return {
    header: bytes.slice(0, HEADER_LEN),
    kdf,
    salt: bytes.slice(11, 27),
    nonce: bytes.slice(27, 39),
    address: toHex(bytes.slice(39, 59)),
    ct: bytes.slice(HEADER_LEN),
  }
}

/**
 * Decrypt a Recovery QR on this device. Throws RecoveryError:
 *   'decrypt'  — wrong password or the QR was changed (indistinguishable, by design)
 *   'mismatch' — it isn't `expectedAddress`'s wallet
 * Returns the private key only after its address has been checked.
 */
export async function openRecoveryPayload(text: string, password: string, expectedAddress: string): Promise<{ privateKey: string; address: string }> {
  const p = parse(text)
  if (p.address.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new RecoveryError('mismatch', "This Recovery QR is for a different wallet than this account's")
  }
  const key = await deriveKey(password, p.salt, p.kdf)
  let pk: Uint8Array
  try {
    pk = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: p.nonce as BufferSource, additionalData: p.header as BufferSource, tagLength: 128 }, key, p.ct as BufferSource))
  } catch {
    throw new RecoveryError('decrypt', 'Wrong recovery password, or this QR has been changed')
  }
  if (pk.length !== 32) { pk.fill(0); throw new RecoveryError('decrypt', 'Wrong recovery password, or this QR has been changed') }
  const privateKey = toHex(pk)
  pk.fill(0)
  const address = await addressOf(privateKey)
  if (address.toLowerCase() !== p.address.toLowerCase() || address.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new RecoveryError('mismatch', "This Recovery QR is for a different wallet than this account's")
  }
  return { privateKey, address }
}
