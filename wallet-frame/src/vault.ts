// wallet-frame/src/vault.ts
//
// Where wallet keys live: this frame's memory, plus this frame's origin
// storage. The app's origin can't read any of it.
//
//   open keys       memory only (Map), dropped on lock / reload
//   session copy    sessionStorage, sealed with this origin's non-extractable
//                   device key - a plain reload reopens without the passcode
//   device copy     localStorage, sealed the same way (Google / email wallets:
//                   the self-custodial "this device" copy; deleted on logout)
//   passcode copy   localStorage, PBKDF2(600k)-AES-GCM, then sealed with the
//                   device key (as the app did for backed-up wallets) - a copy
//                   of this storage alone can't be brute-forced elsewhere
//   phrase copy     localStorage, same, for wallets that have a phrase
//
// The formats are the app's existing ones (lib/security.ts), so keys moved
// here from the app (adopt) and keys made here look the same.

import { privateKeyToAccount } from 'viem/accounts'
import {
  encryptPrivateKey, decryptPrivateKey, sealForDevice, openFromDevice,
} from '@/lib/security'
import type { Hex, WalletKind, WalletStatus } from '@/wallet/protocol'

const P = 'mpw_'
const SESSION = P + 'ss_'   // sessionStorage
const DEVICE = P + 'dv_'
const PASSCODE = P + 'pc_'
const PHRASE = P + 'pm_'
const WORDS = P + 'wc_'
const KIND = P + 'kind_'
const LOCKOUT = P + 'lockout_'
const APPROVALS = P + 'approvals'    // this device's app sends passcode approvals (main.ts)

const LOCKOUT_FREE_TRIES = 5
const LOCKOUT_BASE_MS = 30_000
const LOCKOUT_MAX_MS = 60 * 60_000

export class VaultError extends Error {
  constructor(public code: 'locked' | 'not-found' | 'bad-passcode' | 'rate-limited' | 'mismatch' | 'invalid', message: string, public lockedForMs = 0) {
    super(message)
  }
}

const norm = (address: string) => address.toLowerCase()
const open = new Map<string, string>()          // address → private key (hex)
// Stored by create / import / adopt in this frame load: its passcode may be set
// without the old one for a while (re-importing a wallet this device knew).
const storedAt = new Map<string, number>()
const FRESH_MS = 15 * 60_000
const openPhrase = new Map<string, string>()    // address → phrase, only right after create/import

function ls(): Storage | null { try { return localStorage } catch { return null } }
function ss(): Storage | null { try { return sessionStorage } catch { return null } }
const get = (s: Storage | null, k: string) => { try { return s?.getItem(k) ?? null } catch { return null } }
const put = (s: Storage | null, k: string, v: string) => { try { s?.setItem(k, v) } catch { /* storage blocked */ } }
const del = (s: Storage | null, k: string) => { try { s?.removeItem(k) } catch { /* storage blocked */ } }

export function addressOf(privateKey: string): Hex {
  return privateKeyToAccount(privateKey as Hex).address
}

function assertKeyFor(privateKey: string, address: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new VaultError('invalid', 'Not a wallet key')
  if (norm(addressOf(privateKey)) !== norm(address)) throw new VaultError('mismatch', 'That key belongs to a different wallet')
}

/** The open key for `address`, or throws 'locked'. */
export function keyFor(address: string): string {
  const k = open.get(norm(address))
  if (!k) throw new VaultError('locked', 'Wallet is locked')
  return k
}

export function phraseInMemory(address: string): string | null { return openPhrase.get(norm(address)) ?? null }

/** Keep `privateKey` open and refresh this tab's session copy. */
async function keepOpen(address: string, privateKey: string) {
  open.set(norm(address), privateKey)
  const sealed = await sealForDevice(privateKey)
  // No device key (IndexedDB blocked): stay open in memory only - never
  // fall back to writing the key unsealed.
  if (sealed) put(ss(), SESSION + norm(address), sealed)
}

export interface StoreOptions {
  kind: WalletKind
  passcode?: string
  mnemonic?: string
}

/** Store a key this frame now owns, in every form its wallet kind uses. */
export async function store(address: string, privateKey: string, opts: StoreOptions): Promise<void> {
  assertKeyFor(privateKey, address)
  const a = norm(address)
  storedAt.set(a, Date.now())
  put(ls(), KIND + a, opts.kind)
  if (opts.kind === 'social-auto') {
    const sealed = await sealForDevice(privateKey)
    if (sealed) put(ls(), DEVICE + a, sealed)
  } else if (opts.passcode) {
    put(ls(), PASSCODE + a, await sealed(privateKey, opts.passcode))
    if (opts.mnemonic) put(ls(), PHRASE + a, await sealed(opts.mnemonic, opts.passcode))
  }
  if (opts.mnemonic) {
    put(ls(), WORDS + a, String(opts.mnemonic.trim().split(/\s+/).length))
    // Kept open until it's saved under a passcode (create shows it first).
    if (!opts.passcode) openPhrase.set(a, opts.mnemonic)
  }
  await keepOpen(address, privateKey)
}

/** PBKDF2 passcode encryption, then the device seal (dv1:). decryptPrivateKey opens both layers. */
async function sealed(secret: string, passcode: string): Promise<string> {
  const enc = await encryptPrivateKey(secret, passcode)
  return (await sealForDevice(enc)) ?? enc
}

export async function status(address: string): Promise<WalletStatus> {
  const a = norm(address)
  const words = Number(get(ls(), WORDS + a) ?? 0) || (openPhrase.get(a)?.split(/\s+/).length ?? 0)
  const pc = get(ls(), PASSCODE + a)
  return {
    unlocked: open.has(a),
    device: !!get(ls(), DEVICE + a),
    passcode: !!pc,
    mnemonic: !!get(ls(), PHRASE + a) || openPhrase.has(a),
    wordCount: words,
    lockedForMs: lockedForMs(a),
    bindingLost: !!pc && pc.startsWith('dv1:') && (await openFromDevice(pc)) == null,
  }
}

// ── Passcode attempts ───────────────────────────────────────────────────────
// Kept here, not in the app: a script in the app could call `unlock` over and
// over, so the frame itself must slow guessing down. 5 free tries, then
// 30s, 60s, 2m … up to an hour between tries. Survives reloads.
function lockoutState(a: string): { fails: number; until: number } {
  try { return JSON.parse(get(ls(), LOCKOUT + a) ?? '') ?? { fails: 0, until: 0 } } catch { return { fails: 0, until: 0 } }
}
function lockedForMs(a: string): number { return Math.max(0, lockoutState(a).until - Date.now()) }
function noteFailure(a: string): number {
  const s = lockoutState(a)
  const fails = s.fails + 1
  const wait = fails < LOCKOUT_FREE_TRIES ? 0 : Math.min(LOCKOUT_BASE_MS * 2 ** (fails - LOCKOUT_FREE_TRIES), LOCKOUT_MAX_MS)
  put(ls(), LOCKOUT + a, JSON.stringify({ fails, until: wait ? Date.now() + wait : 0 }))
  return wait
}
function noteSuccess(a: string) { del(ls(), LOCKOUT + a) }

// ── The passcode, checked here (approving a signature - main.ts) ────────────
// The full check decrypts the passcode copy (PBKDF2 600k, ~1 s on a phone).
// After one success this frame load remembers an HMAC of the passcode under a
// key that exists only in this frame's memory: later checks take microseconds
// and nothing reusable is kept. Wrong tries count against the same lockout.
const verified = new Map<string, string>()   // address → HMAC tag of its passcode
let tagKey: Promise<CryptoKey> | null = null
async function passcodeTag(passcode: string): Promise<string> {
  tagKey ??= crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await tagKey, new TextEncoder().encode(passcode)))
  return Array.from(mac, b => b.toString(16).padStart(2, '0')).join('')
}

/** The app on this device sends passcode approvals - from then on, always required (main.ts). */
export function noteApprovalsUsed(): void { put(ls(), APPROVALS, '1') }
export function approvalsUsed(): boolean { return get(ls(), APPROVALS) === '1' }

/** Whether this wallet has a passcode on this device (Google / email device wallets don't). */
export function hasPasscode(address: string): boolean { return !!get(ls(), PASSCODE + norm(address)) }

/** Stored here in the last FRESH_MS (create / import / adopt). */
export function storedRecently(address: string): boolean {
  const at = storedAt.get(norm(address))
  return at != null && Date.now() - at < FRESH_MS
}

/** Throws unless `passcode` is this wallet's passcode. Opens the key too when the full check ran. */
export async function checkPasscode(address: string, passcode: string): Promise<void> {
  const a = norm(address)
  const wait = lockedForMs(a)
  if (wait > 0) throw new VaultError('rate-limited', 'Too many wrong passcodes - try again shortly', wait)
  const tag = await passcodeTag(passcode)
  const known = verified.get(a)
  if (known) {
    if (known === tag) { noteSuccess(a); return }
    const next = noteFailure(a)
    throw new VaultError(next ? 'rate-limited' : 'bad-passcode', 'Wrong passcode', next)
  }
  const enc = get(ls(), PASSCODE + a)
  if (!enc) throw new VaultError('not-found', 'This wallet has no passcode on this device')
  const k = await decryptPrivateKey(enc, passcode)
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k) || norm(addressOf(k)) !== a) {
    const next = noteFailure(a)
    throw new VaultError(next ? 'rate-limited' : 'bad-passcode', 'Wrong passcode', next)
  }
  noteSuccess(a)
  verified.set(a, tag)
  if (!open.has(a)) await keepOpen(address, k)
}

/**
 * Open the key: already open → session copy → device copy → passcode copy.
 * Returns false when nothing here opens it without more input.
 */
export async function unlock(address: string, passcode?: string): Promise<boolean> {
  const a = norm(address)
  if (open.has(a)) return true
  for (const sealed of [get(ss(), SESSION + a), get(ls(), DEVICE + a)]) {
    if (!sealed) continue
    const k = await openFromDevice(sealed)
    if (k && norm(addressOf(k)) === a) { await keepOpen(address, k); return true }
  }
  if (!passcode) return false
  const enc = get(ls(), PASSCODE + a)
  if (!enc) return false
  const wait = lockedForMs(a)
  if (wait > 0) throw new VaultError('rate-limited', 'Too many wrong passcodes - try again shortly', wait)
  const k = await decryptPrivateKey(enc, passcode)
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k) || norm(addressOf(k)) !== a) {
    const next = noteFailure(a)
    throw new VaultError(next ? 'rate-limited' : 'bad-passcode', 'Wrong passcode', next)
  }
  noteSuccess(a)
  verified.set(a, await passcodeTag(passcode))
  await keepOpen(address, k)
  return true
}

/** Open a key that came from a passkey / Recovery QR; also keeps a device copy for Google / email wallets. */
export async function openRecovered(address: string, privateKey: string): Promise<void> {
  assertKeyFor(privateKey, address)
  const a = norm(address)
  const kind = (get(ls(), KIND + a) as WalletKind | null) ?? 'social-auto'
  put(ls(), KIND + a, kind)
  if (kind === 'social-auto') {
    const sealed = await sealForDevice(privateKey)
    if (sealed) put(ls(), DEVICE + a, sealed)
  }
  await keepOpen(address, privateKey)
}

export async function setPasscode(address: string, passcode: string, oldPasscode?: string): Promise<void> {
  const a = norm(address)
  const k = keyFor(address)
  const phrase = openPhrase.get(a) ?? await readPhrase(address, oldPasscode ?? passcode).catch(() => null)
  put(ls(), PASSCODE + a, await sealed(k, passcode))
  verified.set(a, await passcodeTag(passcode))
  if (phrase) {
    put(ls(), PHRASE + a, await sealed(phrase, passcode))
    put(ls(), WORDS + a, String(phrase.split(/\s+/).length))
  }
  openPhrase.delete(a)
}

/** The recovery phrase: in memory right after create/import, else passcode-decrypted. */
export async function readPhrase(address: string, passcode?: string): Promise<string | null> {
  const a = norm(address)
  const mem = openPhrase.get(a)
  if (mem) return mem
  const enc = get(ls(), PHRASE + a)
  if (!enc || !passcode) return null
  const wait = lockedForMs(a)
  if (wait > 0) throw new VaultError('rate-limited', 'Too many wrong passcodes - try again shortly', wait)
  const phrase = await decryptPrivateKey(enc, passcode)
  if (!phrase) {
    const next = noteFailure(a)
    throw new VaultError(next ? 'rate-limited' : 'bad-passcode', 'Wrong passcode', next)
  }
  noteSuccess(a)
  return phrase
}

export function lock(address?: string) {
  const targets = address ? [norm(address)] : [...open.keys()]
  for (const a of targets) {
    open.delete(a); openPhrase.delete(a); verified.delete(a)
    del(ss(), SESSION + a)
  }
  if (!address) {
    verified.clear()
    const s = ss()
    try { for (let i = (s?.length ?? 0) - 1; i >= 0; i--) { const k = s!.key(i); if (k?.startsWith(SESSION)) s!.removeItem(k) } } catch { /* */ }
  }
}

/** Logout. `everything` also drops passcode copies and phrases (a full reset). */
export function forget(address?: string, everything = false) {
  lock(address)
  const s = ls()
  const drop = everything ? [DEVICE, PASSCODE, PHRASE, WORDS, KIND, LOCKOUT] : [DEVICE]
  try {
    for (let i = (s?.length ?? 0) - 1; i >= 0; i--) {
      const k = s!.key(i)
      if (!k) continue
      const prefix = drop.find(p => k.startsWith(p))
      if (prefix && (!address || k === prefix + norm(address))) s!.removeItem(k)
    }
  } catch { /* storage blocked */ }
}
