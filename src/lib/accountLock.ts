// src/lib/accountLock.ts
//
// Business accounts that MeshPort hasn't approved yet (or whose access was
// removed) can't TAKE payments: the Receive and Splits screens are locked
// here, and the server refuses their payment requests, Shop QR and bills.
// They can always send, swap, claim and withdraw their own money.
// Personal accounts, staff, admins and approved businesses are unaffected.

import { useSyncExternalStore } from 'react'
import { getMerchantState, readMerchantHint, subscribeMerchant } from './merchant'
import { computeAccountLock, type AccountLock } from './accountLockRule'
import { useAuthStore } from '@/store'

export { ACCOUNT_LOCKED_MESSAGE, computeAccountLock, isLockedPath, type AccountLock, type AccountLockReason } from './accountLockRule'

function signedIn(): boolean {
  try { return !!useAuthStore.getState().walletAddress } catch { return false }
}

function current(): AccountLock {
  // Signed out (e.g. a visitor on a public payment link): nothing to lock.
  if (!signedIn()) return { locked: false, loaded: true, unknown: false, reason: null }
  return computeAccountLock(getMerchantState(), readMerchantHint())
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
