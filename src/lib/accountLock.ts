// src/lib/accountLock.ts
//
// Business accounts that MeshPort hasn't approved yet can't use the app's
// features. They can see their balance and activity, manage their profile,
// security and settings, read help/legal pages and complete the business
// application - nothing that moves money (or asks for it) works until the
// application is approved. Personal accounts, staff (personal accounts
// invited by a business), admins and approved businesses are unaffected.
//
// The server enforces the same rule (public.account_can_spend) on every path
// MeshPort's own servers use to move funds; this module is the app side:
// the route guard, the entry points and the core money functions.

import { useSyncExternalStore } from 'react'
import { getMerchantState, readMerchantHint, refreshMerchant, subscribeMerchant } from './merchant'
import { ACCOUNT_LOCKED_MESSAGE, computeAccountLock, registerAccountLockProbe, type AccountLock } from './accountLockRule'
import { useAuthStore } from '@/store'

export { ACCOUNT_LOCKED_MESSAGE, computeAccountLock, isLockedPath, isAccountLockedNow, assertAccountUnlocked, type AccountLock, type AccountLockReason } from './accountLockRule'

function signedIn(): boolean {
  try { return !!useAuthStore.getState().walletAddress } catch { return false }
}

function current(): AccountLock {
  // Signed out (e.g. a visitor on a public payment link): nothing to lock.
  if (!signedIn()) return { locked: false, loaded: true, unknown: false, reason: null }
  return computeAccountLock(getMerchantState(), readMerchantHint())
}

registerAccountLockProbe(() => current().locked)

/**
 * For money functions: throws Error(ACCOUNT_LOCKED_MESSAGE) when this
 * account can't spend. When the status hasn't loaded and isn't known on this
 * device, waits (up to a few seconds) for it to load first. The server
 * checks the same rule, so a failed load never lets a locked account spend.
 */
export async function assertAccountCanSpend(): Promise<void> {
  let c = current()
  if (c.unknown) {
    await Promise.race([refreshMerchant().catch(() => {}), new Promise(r => setTimeout(r, 8000))])
    c = current()
  }
  if (c.locked) throw new Error(ACCOUNT_LOCKED_MESSAGE)
}

// Stable snapshot for useSyncExternalStore: only a new object when it changes.
let snap: AccountLock = { locked: false, loaded: false, unknown: true, reason: null }
function getSnapshot(): AccountLock {
  const c = current()
  if (c.locked !== snap.locked || c.loaded !== snap.loaded || c.unknown !== snap.unknown || c.reason !== snap.reason) snap = c
  return snap
}
function subscribe(cb: () => void) {
  const off = subscribeMerchant(cb)
  const offAuth = useAuthStore.subscribe(cb)
  return () => { off(); offAuth() }
}

/** The account lock for this signed-in user. */
export function useAccountLock(): AccountLock {
  return useSyncExternalStore(subscribe, getSnapshot)
}
