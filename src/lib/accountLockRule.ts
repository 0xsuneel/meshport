// Pure lock rule (no app imports) - see lib/accountLock.ts.

import type { MerchantStatus } from './merchant'

export const ACCOUNT_LOCKED_MESSAGE = 'Taking payments turns on once your business is approved'

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
 * The lock rule: a business that isn't approved (none / pending / rejected /
 * revoked) can't TAKE payments yet - the Receive and Splits screens are
 * locked (isLockedPath) and the server refuses its requests, Shop QR and
 * bills. It can always send, swap, claim and withdraw its own money (as
 * Venmo and PayPal: verification gates business payments, never the
 * balance). Loaded: business && status !== 'approved'. Before the load
 * the last known status on this device decides (so an approved business
 * never flashes locked and a locked one never flashes unlocked); with no
 * usable hint the answer is "unknown" - the locked screens wait for it.
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

// Routes a business that isn't approved can't open: the ones that take
// payments. Everything else - sending, swaps, cross-chain, P2P, chat, Home,
// Activity, settings, the Business tab and the application - stays open.
const LOCKED_PREFIXES = ['/receive', '/splits', '/biz/collect']
export function isLockedPath(path: string): boolean {
  const p = (path.split(/[?#]/)[0] || '/').replace(/\/+$/, '') || '/'
  return LOCKED_PREFIXES.some(x => p === x || p.startsWith(x + '/'))
}
