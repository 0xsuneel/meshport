// "Your activity just changed" - a payment, swap, transfer, claim, P2P step
// made on this device. The screen that did it knows at once; the lists that
// show it (Activity, Home's recent people, Recent paid, the chat list) reload
// on this signal instead of waiting for a live database update, which a phone
// often misses after being in the background or changing networks (17 Nov:
// "payments not updating instantly in Recent paid, chats, Activity").
//
// Fired at once and again after a few seconds: some rows are written by the
// server a moment after the transaction (the receiver's row, a swap's
// reconcile, a P2P release), and a reload that ran too early would miss them.
// Each fire also clears the 15 s recent-contacts cache.
import { useEffect, useState } from 'react'

export const ACTIVITY_CHANGED_EVENT = 'meshport:activity-changed'
const AGAIN_MS = [2500, 7000]
let timers: ReturnType<typeof setTimeout>[] = []

function fire() {
  void import('@/lib/recentContacts').then(m => m.invalidateRecentContactsCache()).catch(() => {})
  try { window.dispatchEvent(new CustomEvent(ACTIVITY_CHANGED_EVENT)) } catch { /* no window */ }
}

/** Call after any transaction this device made. Safe to call often (re-arms). */
export function notifyActivityChanged(): void {
  if (typeof window === 'undefined') return
  for (const t of timers) clearTimeout(t)
  fire()
  timers = AGAIN_MS.map(ms => setTimeout(fire, ms))
}

/** A number that goes up on each change - put it in an effect's deps to reload. */
export function useActivityChangedCount(): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    const on = () => setN(x => x + 1)
    window.addEventListener(ACTIVITY_CHANGED_EVENT, on)
    return () => window.removeEventListener(ACTIVITY_CHANGED_EVENT, on)
  }, [])
  return n
}
