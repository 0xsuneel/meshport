// Pure lock rule (no app imports) - see lib/accountLock.ts.

import type { MerchantStatus } from './merchant'

export const ACCOUNT_LOCKED_MESSAGE = 'Available after your business is approved'

export type AccountLockReason = Exclude<MerchantStatus, 'approved'> | null

export type AccountLock = {
  /** Show the locked state. */
  locked: boolean
  /** The account's real status has loaded from the server. */
  loaded: boolean
  /** True while it is not yet known whether the account is locked (not
   *  loaded and no hint on this device). Money actions wait while this is
   *  true; read-only screens just render. */
  unknown: boolean
  /** The application status behind the lock (null when not locked). */
  reason: AccountLockReason
}

type Input = {
  loaded: boolean
  accountType: 'personal' | 'business'
  status: MerchantStatus
}
type Hint = { approved: boolean; business: boolean | null } | null

/**
 * The lock rule. Loaded: business && status !== 'approved'. Before the load
 * the last known status on this device decides (so an approved business
 * never flashes locked and a locked one never flashes unlocked); with no
 * usable hint the answer is "unknown" - not locked for display, but money
 * actions wait.
 */
export function computeAccountLock(s: Input, hint: Hint): AccountLock {
  if (s.loaded) {
    const locked = s.accountType === 'business' && s.status !== 'approved'
    return { locked, loaded: true, unknown: false, reason: locked ? (s.status as AccountLockReason) : null }
  }
  if (hint && hint.approved) return { locked: false, loaded: false, unknown: false, reason: null }
  if (hint && hint.business === true) return { locked: true, loaded: false, unknown: false, reason: 'none' }
  if (hint && hint.business === false) return { locked: false, loaded: false, unknown: false, reason: null }
  return { locked: false, loaded: false, unknown: true, reason: null }
}

// Non-React check used by the core money functions. Kept in this
// dependency-free module (the money services must not pull in the Supabase
// client or the stores); lib/accountLock.ts registers the real probe when the
// app loads.
let lockProbe: () => boolean = () => false
export function registerAccountLockProbe(fn: () => boolean): void { lockProbe = fn }

/** True when this account can't use features right now (business not
 *  approved). Before the status loads, the last known status decides. */
export function isAccountLockedNow(): boolean {
  try { return lockProbe() } catch { return false }
}

/** Throws Error('Available after your business is approved') when locked. */
export function assertAccountUnlocked(): void {
  if (isAccountLockedNow()) throw new Error(ACCOUNT_LOCKED_MESSAGE)
}

// Routes a locked account can't open (prefix match). Everything else - Home,
// Activity, notifications, profile/settings/security, help and legal, the
// Business tab and the merchant application - stays open.
const LOCKED_PREFIXES = [
  '/pay', '/pay-send', '/paylink', '/scanner', '/receive', '/swap', '/multichain', '/multichain-recovery',
  '/multichain-transfer', '/multichain-claim', '/bulk-payout', '/p2p', '/chat', '/rewards', '/insights',
  '/recent-paid', '/asset', '/news',
]
export function isLockedPath(path: string): boolean {
  const p = (path.split(/[?#]/)[0] || '/').replace(/\/+$/, '') || '/'
  return LOCKED_PREFIXES.some(x => p === x || p.startsWith(x + '/'))
}
