// wallet-frame/src/fastPayGate.ts
//
// The passcode check for Google / email (Circle) wallets, inside the wallet
// frame - for unlocking the app AND for every Fast Pay payment.
//
// Circle wallets have no key in this frame, so their passcode used to be
// checked only in the app, against a hash in the app's own storage (which a
// script in the page could read and brute-force offline). Now this frame
// holds the only check, like it does for create / import wallets:
//
//   one     a single check for this device - the app has one passcode per
//           device (its store), whichever Google / email account signs in.
//           A fixed marker encrypted under the passcode (PBKDF2-SHA256 600k
//           → AES-GCM, the same format as wallet passcode copies), sealed to
//           this device. Never the passcode itself.
//   check   unlocking (security.ts verifyPasscode → lib/circlePasscode.ts).
//           The first check per frame load is the full one (~1 s on a
//           phone); after it, an HMAC under a key that exists only in this
//           frame's memory answers in microseconds.
//   approve every Fast Pay payment: the passcode just entered is checked
//           HERE; a right one allows ONE payment signature, for that wallet,
//           within APPROVAL_MS.
//   guess   5 free tries, then 30 s, 60 s, 2 min … up to an hour, kept in
//           this frame's storage (the app can't reset it).
//   change  needs the current passcode. forget removes the check AND every
//           Fast Pay session key - a script that forgets it to set its own
//           gets no session (a new one needs the Circle wallet's signature).

import { encryptPrivateKey, decryptPrivateKey, sealForDevice } from '@/lib/security'
import type { ApprovalIntent } from '@/wallet/protocol'

const PIN = 'mp.circle.passcode'
const LOCK = 'mp.circle.lockout'
const OLD_PIN = 'mp.fastpay.pin.' // + owner: the first, per-wallet Fast Pay check (removed on sight)
const MARKER = 'meshport-circle-passcode-v1'
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
function lockState(): { fails: number; until: number } {
  try { return JSON.parse(get(LOCK) ?? '') ?? { fails: 0, until: 0 } } catch { return { fails: 0, until: 0 } }
}
function lockedForMs(): number { return Math.max(0, lockState().until - Date.now()) }
function failed(): number {
  const fails = lockState().fails + 1
  const wait = fails < FREE_TRIES ? 0 : Math.min(BASE_WAIT_MS * 2 ** (fails - FREE_TRIES), MAX_WAIT_MS)
  put(LOCK, JSON.stringify({ fails, until: wait ? Date.now() + wait : 0 }))
  return wait
}

// ── Fast checks after the first full one (this frame load only) ──────────────
let verified: string | null = null // HMAC tag of the passcode
let tagKey: Promise<CryptoKey> | null = null
async function tag(passcode: string): Promise<string> {
  tagKey ??= crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await tagKey, new TextEncoder().encode(passcode)))
  return Array.from(mac, b => b.toString(16).padStart(2, '0')).join('')
}

export function hasPasscode(): boolean { return !!get(PIN) }

/** Throws unless `passcode` is this device's Google / email wallet passcode. True: the full (slow) check ran. */
export async function checkPasscode(passcode: string): Promise<boolean> {
  const stored = get(PIN)
  if (!stored) throw new GateError('not-found', 'No passcode is set in the wallet yet')
  const wait = lockedForMs()
  if (wait > 0) throw new GateError('rate-limited', 'Too many wrong passcodes - try again shortly', wait)
  if (typeof passcode !== 'string' || !passcode) throw new GateError('bad-passcode', 'Wrong passcode')
  const t = await tag(passcode)
  if (verified) {
    if (verified === t) { del(LOCK); return false }
    const next = failed()
    throw new GateError(next ? 'rate-limited' : 'bad-passcode', 'Wrong passcode', next)
  }
  const opened = await decryptPrivateKey(stored, passcode).catch(() => null)
  if (opened !== MARKER) {
    const next = failed()
    throw new GateError(next ? 'rate-limited' : 'bad-passcode', 'Wrong passcode', next)
  }
  del(LOCK)
  verified = t
  return true
}

/** First set, or a change. A check already here needs the current passcode. */
export async function setPasscode(passcode: string, oldPasscode?: string): Promise<void> {
  if (typeof passcode !== 'string' || !/^\d{6}$/.test(passcode)) throw new GateError('invalid', 'A 6-digit passcode is needed')
  if (hasPasscode()) await checkPasscode(oldPasscode ?? '')
  const enc = await encryptPrivateKey(MARKER, passcode)
  const value = (await sealForDevice(enc)) ?? enc
  put(PIN, value)
  if (get(PIN) !== value) throw new GateError('invalid', "This browser blocks the wallet's storage")
  verified = await tag(passcode)
  approvals.clear()
  dropOldChecks()
}

/** The check goes (the caller drops every session key too). */
export function forget(): void {
  del(PIN)
  verified = null
  approvals.clear()
  dropOldChecks()
}

function dropOldChecks(): void {
  try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k?.startsWith(OLD_PIN)) localStorage.removeItem(k) } } catch { /* storage blocked */ }
}

// ── One approval = one payment signature, for one wallet ─────────────────────
// owner → approved until (ms), and what it was for when it came from the
// frame's own keypad page (confirm.html). No intent: the passcode reached the
// frame through the app (an older app) - it covers no Express pull.
const approvals = new Map<string, { until: number; intent: ApprovalIntent | null }>()

/** One payment approved. `full`: the slow check ran (first one since the frame loaded). */
export async function approve(owner: string, passcode: string): Promise<{ validForMs: number; full: boolean }> {
  const full = await checkPasscode(passcode)
  approvals.set(norm(owner), { until: Date.now() + APPROVAL_MS, intent: null })
  return { validForMs: APPROVAL_MS, full }
}

/** An approval the frame's keypad page already checked, for this intent. */
export function grant(owner: string, intent: ApprovalIntent): void {
  approvals.set(norm(owner), { until: Date.now() + APPROVAL_MS, intent })
}

/** Use the approval for one payment signature, if there is a fresh one: what it was for (null intent: unbound), or null. */
export function takeApproval(owner: string): { intent: ApprovalIntent | null } | null {
  const a = norm(owner)
  const ap = approvals.get(a)
  approvals.delete(a)
  return ap && ap.until > Date.now() ? { intent: ap.intent } : null
}

/** Test hook. */
export function _resetGate(): void { verified = null; approvals.clear(); tagKey = null }
