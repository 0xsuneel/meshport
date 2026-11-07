// wallet-frame/src/vault.ts
//
// Where wallet keys live: this frame's memory, plus this frame's origin
// storage. The app's origin can't read any of it.
//
//   open keys       memory only (Map), dropped on lock / reload
//   session copy    sessionStorage, sealed with this origin's non-extractable
//                   device key - a plain reload reopens without the passcode
//                   (signing still needs a passcode approval, main.ts)
//   passcode copy   localStorage, PBKDF2(600k)-AES-GCM, then sealed with the
//                   device key - a copy of this storage alone can't be
//                   brute-forced elsewhere
//   phrase copy     localStorage, same, for wallets that have a phrase
//
// Passcode guesses: one at a time per wallet (a queue), and each guess is
// counted BEFORE the slow check runs, so a burst of parallel guesses can't
// slip past the lockout. A lock / forget that lands while a check is still
// running wins: the finished check doesn't reopen the key (epoch).

import { privateKeyToAccount } from 'viem/accounts'
import {
  encryptPrivateKey, decryptPrivateKey, sealForDevice, openFromDevice,
} from '@/lib/security'
import type { Hex, WalletKind, WalletStatus } from '@/wallet/protocol'

const P = 'mpw_'
const SESSION = P + 'ss_'   // sessionStorage
const PASSCODE = P + 'pc_'
const PHRASE = P + 'pm_'
const WORDS = P + 'wc_'
const LOCKOUT = P + 'lockout_'
// Written by older versions, no longer used: only removed (forget).
const OLD_KEYS = [P + 'dv_', P + 'kind_', P + 'approvals']

const LOCKOUT_FREE_TRIES = 5
const LOCKOUT_BASE_MS = 30_000
const LOCKOUT_MAX_MS = 60 * 60_000

/** A passcode the frame accepts when one is set: 6 to 64 characters. */
export function validPasscode(passcode: unknown): passcode is string {
  return typeof passcode === 'string' && passcode.length >= 6 && passcode.length <= 64
}

export class VaultError extends Error {
  constructor(public code: 'locked' | 'not-found' | 'bad-passcode' | 'rate-limited' | 'mismatch' | 'invalid', message: string, public lockedForMs = 0) {
    super(message)
  }
}

const norm = (address: string) => address.toLowerCase()
const open = new Map<string, string>()          // address → private key (hex)
const openPhrase = new Map<string, string>()    // address → phrase, only right after create/import
// Bumped by lock / forget: a slow check that started before can't reopen the key.
let epoch = 0

function ls(): Storage | null { try { return localStorage } catch { return null } }
function ss(): Storage | null { try { return sessionStorage } catch { return null } }
const get = (s: Storage | null, k: string) => { try { return s?.getItem(k) ?? null } catch { return null } }
const put = (s: Storage | null, k: string, v: string) => { try { s?.setItem(k, v) } catch { /* storage blocked */ } }
const del = (s: Storage | null, k: string) => { try { s?.removeItem(k) } catch { /* storage blocked */ } }
/** A write that must land (the passcode copy): read back, else refuse. */
function putSure(k: string, v: string) {
  put(ls(), k, v)
  if (get(ls(), k) !== v) throw new VaultError('invalid', "This browser won't let the wallet save on this device")
}

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

/** Keep `privateKey` open and refresh this tab's session copy - unless a lock came in since `since`. */
async function keepOpen(address: string, privateKey: string, since: number) {
  const sealed = await sealForDevice(privateKey)
  if (since !== epoch) throw new VaultError('locked', 'Wallet was locked')
  open.set(norm(address), privateKey)
  // No device key (IndexedDB blocked): stay open in memory only - never
  // fall back to writing the key unsealed.
  if (sealed) put(ss(), SESSION + norm(address), sealed)
}

export interface StoreOptions {
  kind: WalletKind
  passcode?: string
  mnemonic?: string
}

/**
 * Store a key this frame now owns. Whoever calls this proved they hold the
 * key (or made it), so an older passcode copy for the same wallet is replaced:
 * with `passcode`, or dropped until set-passcode saves a new one.
 */
export async function store(address: string, privateKey: string, opts: StoreOptions): Promise<void> {
  assertKeyFor(privateKey, address)
  if (opts.passcode != null && !validPasscode(opts.passcode)) throw new VaultError('invalid', 'Passcode must be at least 6 characters')
  const a = norm(address)
  const since = epoch
  verified.delete(a)
  if (opts.passcode) {
    putSure(PASSCODE + a, await sealed(privateKey, opts.passcode))
    if (opts.mnemonic) putSure(PHRASE + a, await sealed(opts.mnemonic, opts.passcode))
    else del(ls(), PHRASE + a)
  } else {
    del(ls(), PASSCODE + a); del(ls(), PHRASE + a)
  }
  if (opts.mnemonic) {
    put(ls(), WORDS + a, String(opts.mnemonic.trim().split(/\s+/).length))
    // Kept open until it's saved under a passcode (create shows it first).
    if (!opts.passcode) openPhrase.set(a, opts.mnemonic)
  } else del(ls(), WORDS + a)
  await keepOpen(address, privateKey, since)
}

/** PBKDF2 passcode encryption, then the device seal (dv1:). decryptPrivateKey opens both layers. */
async function sealed(secret: string, passcode: string): Promise<string> {
  const enc = await encryptPrivateKey(secret, passcode)
  return (await sealForDevice(enc)) ?? enc
}

/** The device key that sealed `enc` is gone (site data partly cleared). */
async function bindingLost(enc: string): Promise<boolean> {
  return enc.startsWith('dv1:') && (await openFromDevice(enc)) == null
}

export async function status(address: string): Promise<WalletStatus> {
  const a = norm(address)
  const words = Number(get(ls(), WORDS + a) ?? 0) || (openPhrase.get(a)?.split(/\s+/).length ?? 0)
  const pc = get(ls(), PASSCODE + a)
  return {
    unlocked: open.has(a),
    passcode: !!pc,
    mnemonic: !!get(ls(), PHRASE + a) || openPhrase.has(a),
    wordCount: words,
    lockedForMs: lockedForMs(a),
    bindingLost: !!pc && (await bindingLost(pc)),
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
/** Counts one more wrong try; returns the wait it now costs. */
function noteFailure(a: string): number {
  const fails = lockoutState(a).fails + 1
  const wait = fails <= LOCKOUT_FREE_TRIES ? 0 : Math.min(LOCKOUT_BASE_MS * 2 ** (fails - LOCKOUT_FREE_TRIES - 1), LOCKOUT_MAX_MS)
  put(ls(), LOCKOUT + a, JSON.stringify({ fails, until: wait ? Date.now() + wait : 0 }))
  return wait
}
function noteSuccess(a: string) { del(ls(), LOCKOUT + a) }

// One passcode check at a time per wallet.
const queues = new Map<string, Promise<unknown>>()
function serial<T>(a: string, run: () => Promise<T>): Promise<T> {
  const prev = queues.get(a) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(run)
  queues.set(a, next)
  void next.catch(() => {}).finally(() => { if (queues.get(a) === next) queues.delete(a) })
  return next
}

/**
 * One passcode guess: waits its turn, counts as wrong up front, and is only
 * cleared when `check` returns a value. `check` returns null for a wrong passcode.
 */
function guess<T>(a: string, check: () => Promise<T | null>): Promise<T> {
  return serial(a, async () => {
    const wait = lockedForMs(a)
    if (wait > 0) throw new VaultError('rate-limited', 'Too many wrong passcodes - try again shortly', wait)
    const enc = get(ls(), PASSCODE + a)
    if (enc && await bindingLost(enc)) {
      throw new VaultError('not-found', "This device's wallet storage was partly cleared - restore with your recovery phrase or private key")
    }
    const next = noteFailure(a)
    const out = await check()
    if (out == null) throw new VaultError(next ? 'rate-limited' : 'bad-passcode', 'Wrong passcode', next)
    noteSuccess(a)
    return out
  })
}

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

/** Whether this wallet has a passcode copy on this device. */
export function hasPasscode(address: string): boolean { return !!get(ls(), PASSCODE + norm(address)) }

/** Throws unless `passcode` is this wallet's passcode. Opens the key too when the full check ran. */
export async function checkPasscode(address: string, passcode: string): Promise<void> {
  const a = norm(address)
  if (typeof passcode !== 'string' || !passcode) throw new VaultError('bad-passcode', 'Enter your passcode')
  const since = epoch
  const tag = await passcodeTag(passcode)
  const k = await guess(a, async () => {
    const known = verified.get(a)
    if (known) return known === tag ? '' : null
    const enc = get(ls(), PASSCODE + a)
    if (!enc) throw new VaultError('not-found', 'This wallet has no passcode on this device')
    const key = await decryptPrivateKey(enc, passcode)
    return key && /^0x[0-9a-fA-F]{64}$/.test(key) && norm(addressOf(key)) === a ? key : null
  })
  verified.set(a, tag)
  if (k && !open.has(a)) await keepOpen(address, k, since)
}

/**
 * Open the key: already open → session copy → passcode copy.
 * Returns false when nothing here opens it without more input.
 */
export async function unlock(address: string, passcode?: string): Promise<boolean> {
  const a = norm(address)
  if (open.has(a)) return true
  const since = epoch
  const session = get(ss(), SESSION + a)
  if (session) {
    const k = await openFromDevice(session)
    if (k && norm(addressOf(k)) === a) { await keepOpen(address, k, since); return true }
  }
  if (!passcode) return false
  if (!get(ls(), PASSCODE + a)) return false
  await checkPasscode(address, passcode)
  if (since !== epoch) throw new VaultError('locked', 'Wallet was locked')
  return open.has(a)
}

export async function setPasscode(address: string, passcode: string, oldPasscode?: string): Promise<void> {
  if (!validPasscode(passcode)) throw new VaultError('invalid', 'Passcode must be at least 6 characters')
  const a = norm(address)
  const k = keyFor(address)
  const phrase = openPhrase.get(a) ?? (oldPasscode ? await readPhrase(address, oldPasscode).catch(() => null) : null)
  putSure(PASSCODE + a, await sealed(k, passcode))
  verified.set(a, await passcodeTag(passcode))
  if (phrase) {
    putSure(PHRASE + a, await sealed(phrase, passcode))
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
  return guess(a, () => decryptPrivateKey(enc, passcode))
}

export function lock(address?: string) {
  epoch++
  const targets = address ? [norm(address)] : [...open.keys()]
  for (const a of targets) {
    open.delete(a); openPhrase.delete(a); verified.delete(a)
    del(ss(), SESSION + a)
  }
  if (!address) {
    openPhrase.clear()
    verified.clear()
    const s = ss()
    try { for (let i = (s?.length ?? 0) - 1; i >= 0; i--) { const k = s!.key(i); if (k?.startsWith(SESSION)) s!.removeItem(k) } } catch { /* */ }
  }
}

/**
 * Logout. `everything` also drops this wallet's passcode copy and phrase
 * (main.ts asks for the passcode first). The lockout record is kept.
 */
export function forget(address?: string, everything = false) {
  lock(address)
  const s = ls()
  const drop = everything ? [...OLD_KEYS, PASSCODE, PHRASE, WORDS] : OLD_KEYS
  try {
    for (let i = (s?.length ?? 0) - 1; i >= 0; i--) {
      const k = s!.key(i)
      if (!k) continue
      const prefix = drop.find(p => k.startsWith(p))
      if (prefix && (!address || k === prefix || k === prefix + norm(address))) s!.removeItem(k)
    }
  } catch { /* storage blocked */ }
}

// Another tab changed this wallet's passcode: this frame's remembered check is stale.
try {
  addEventListener('storage', (e: StorageEvent) => {
    if (e.key?.startsWith(PASSCODE)) verified.delete(e.key.slice(PASSCODE.length))
    else if (e.key == null) verified.clear()
  })
} catch { /* no window (tests) */ }

/** Tests only: forget the lockout record too. */
export function resetForTests() { forget(undefined, true); try { const s = ls(); for (let i = (s?.length ?? 0) - 1; i >= 0; i--) { const k = s!.key(i); if (k?.startsWith(LOCKOUT)) s!.removeItem(k) } } catch { /* */ } }
