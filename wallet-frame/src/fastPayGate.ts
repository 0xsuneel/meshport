// wallet-frame/src/fastPayGate.ts
//
// The passcode check for Fast Pay payments, inside the wallet frame.
//
// Google / email (Circle) wallets have no passcode copy in this frame - the
// app checks their passcode. For Fast Pay that left the frame signing a
// payment for anything that asked (a script running in the app included),
// up to the session's on-chain limit. Now the frame holds its own check:
//
//   set     turning Fast Pay on, the person confirms their passcode; the frame
//           keeps a check value - a fixed marker encrypted under the passcode
//           (PBKDF2-SHA256 600k → AES-GCM, the same format as wallet passcode
//           copies), sealed to this device. Never the passcode itself.
//   approve every Fast Pay payment: the passcode the person just entered is
//           checked HERE; a right one allows ONE payment signature within
//           APPROVAL_MS. The first check per frame load is the full one
//           (~1 s on a phone - normally done at unlock, which sends it too);
//           after it, an HMAC under a key that exists only in this frame's
//           memory answers in microseconds.
//   guess   5 free tries, then 30 s, 60 s, 2 min … up to an hour, kept in
//           this frame's storage (the app can't reset it).
//   change  needs the current passcode; forget (Fast Pay off) removes the
//           check value AND every session key of that wallet - a script that
//           forgets it to set its own gets no session (a new one needs the
//           person's Circle signature).

import { encryptPrivateKey, decryptPrivateKey, sealForDevice } from '@/lib/security'

const PIN = 'mp.fastpay.pin.'
const LOCK = 'mp.fastpay.lockout.'
const MARKER = 'meshport-fastpay-passcode-v1'
export const APPROVAL_MS = 60_000
const FREE_TRIES = 5
const BASE_WAIT_MS = 30_000
const MAX_WAIT_MS = 60 * 60_000

export class GateError extends Error {
  constructor(public code: 'not-found' | 'bad-passcode' | 'rate-limited' | 'invalid', message: string, public lockedForMs = 0) { super(message) }
}

const norm = (a: string) => String(a).toLowerCase()
const ls = (): Storage | null => { try { return localStorage } catch { return null } }
const get = (k: string) => { try { return ls()?.getItem(k) ?? null } catch { return null } }
const put = (k: string, v: string) => { try { ls()?.setItem(k, v) } catch { /* storage blocked */ } }
const del = (k: string) => { try { ls()?.removeItem(k) } catch { /* storage blocked */ } }

// ── Lockout ───────────────────────────────────────────────────────────────────
function lockState(a: string): { fails: number; until: number } {
  try { return JSON.parse(get(LOCK + a) ?? '') ?? { fails: 0, until: 0 } } catch { return { fails: 0, until: 0 } }
}
function lockedForMs(a: string): number { return Math.max(0, lockState(a).until - Date.now()) }
function failed(a: string): number {
  const fails = lockState(a).fails + 1
  const wait = fails < FREE_TRIES ? 0 : Math.min(BASE_WAIT_MS * 2 ** (fails - FREE_TRIES), MAX_WAIT_MS)
  put(LOCK + a, JSON.stringify({ fails, until: wait ? Date.now() + wait : 0 }))
  return wait
}

// ── Fast checks after the first full one (this frame load only) ──────────────
const verified = new Map<string, string>() // owner → HMAC tag of its passcode
let tagKey: Promise<CryptoKey> | null = null
async function tag(passcode: string): Promise<string> {
  tagKey ??= crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await tagKey, new TextEncoder().encode(passcode)))
  return Array.from(mac, b => b.toString(16).padStart(2, '0')).join('')
}

export function hasPasscode(owner: string): boolean { return !!get(PIN + norm(owner)) }

/** Throws unless `passcode` is this wallet's Fast Pay passcode. */
export async function checkPasscode(owner: string, passcode: string): Promise<void> {
  const a = norm(owner)
  const stored = get(PIN + a)
  if (!stored) throw new GateError('not-found', 'Turn Fast Pay on again to confirm your passcode')
  const wait = lockedForMs(a)
  if (wait > 0) throw new GateError('rate-limited', 'Too many wrong passcodes - try again shortly', wait)
  if (typeof passcode !== 'string' || !passcode) throw new GateError('bad-passcode', 'Wrong passcode')
  const t = await tag(passcode)
  const known = verified.get(a)
  if (known) {
    if (known === t) { del(LOCK + a); return }
    const next = failed(a)
    throw new GateError(next ? 'rate-limited' : 'bad-passcode', 'Wrong passcode', next)
  }
  const opened = await decryptPrivateKey(stored, passcode).catch(() => null)
  if (opened !== MARKER) {
    const next = failed(a)
    throw new GateError(next ? 'rate-limited' : 'bad-passcode', 'Wrong passcode', next)
  }
  del(LOCK + a)
  verified.set(a, t)
}

/** Turning Fast Pay on / changing the passcode. A check value already here needs the current passcode. */
export async function setPasscode(owner: string, passcode: string, oldPasscode?: string): Promise<void> {
  const a = norm(owner)
  if (typeof passcode !== 'string' || !/^\d{6}$/.test(passcode)) throw new GateError('invalid', 'A 6-digit passcode is needed')
  if (hasPasscode(a)) await checkPasscode(a, oldPasscode ?? '')
  const enc = await encryptPrivateKey(MARKER, passcode)
  put(PIN + a, (await sealForDevice(enc)) ?? enc)
  verified.set(a, await tag(passcode))
}

/** Fast Pay off: the check value goes (the caller drops the wallet's session keys too). */
export function forget(owner: string): void {
  const a = norm(owner)
  del(PIN + a)
  verified.delete(a)
  approvals.delete(a)
}

// ── One approval = one payment signature ──────────────────────────────────────
const approvals = new Map<string, number>() // owner → approved until (ms)

export async function approve(owner: string, passcode: string): Promise<number> {
  await checkPasscode(owner, passcode)
  approvals.set(norm(owner), Date.now() + APPROVAL_MS)
  return APPROVAL_MS
}

/** Use the approval for one payment signature (true), if there is a fresh one. */
export function takeApproval(owner: string): boolean {
  const a = norm(owner)
  const until = approvals.get(a) ?? 0
  approvals.delete(a)
  return until > Date.now()
}

/** Test hook. */
export function _resetGate(): void { verified.clear(); approvals.clear(); tagKey = null }
