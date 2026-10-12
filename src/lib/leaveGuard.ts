// lib/leaveGuard.ts
//
// "Don't walk away mid-payment." A flow that is moving money (Transfer,
// Bring, Pay, Chat pay, Bulk Pay, Swap, P2P escrow, ...) turns the guard on
// for exactly the steps after the passcode, until the step completes:
//
//   useLeaveGuard(step === 'broadcasting', 'Transfer')
//
// While any guard is on, LeaveGuardHost (components/layout) holds every
// in-app route change - sidebar, bottom nav, header, links and the browser /
// phone Back - makes the flow's panel border blink, and asks Stay / Leave.
// Closing or refreshing the tab gets the browser's own "Leave site?" prompt.
// Leaving never cancels anything: the transaction is already on its way.
//
// The blinking panel is the nearest element marked `data-leave-guard`, else
// the open Hub right-hand panel (`data-hub-page`), else the whole screen.
//
// Screens that handle Back themselves without a route change (a Hub panel
// that closes on popstate) ask through `isLeaveGuarded()` / `requestLeave()`.

import { useEffect } from 'react'
import { create } from 'zustand'

export interface LeaveAsk {
  /** Close the ask and stay on the screen. */
  stay: () => void
  /** Close the ask and carry on with the navigation that was held. */
  leave: () => void
}

interface LeaveGuardState {
  /** Active guards: id → what is in progress ("Transfer", "Payment", ...). */
  guards: Record<number, string>
  /** An ask raised by a screen's own Back handling (see requestLeave). */
  ask: LeaveAsk | null
}

export const useLeaveGuardStore = create<LeaveGuardState>(() => ({ guards: {}, ask: null }))

let nextId = 0

/** Guard the current screen while `active` (the money-moving step) is true. */
export function useLeaveGuard(active: boolean, label: string) {
  useEffect(() => {
    if (!active) return
    const id = ++nextId
    useLeaveGuardStore.setState(s => ({ guards: { ...s.guards, [id]: label } }))
    return () => {
      useLeaveGuardStore.setState(s => {
        const guards = { ...s.guards }
        delete guards[id]
        // The step finished while an in-page ask was open: nothing left to ask.
        return Object.keys(guards).length ? { guards } : { guards, ask: null }
      })
    }
  }, [active, label])
}

export const isLeaveGuarded = () => Object.keys(useLeaveGuardStore.getState().guards).length > 0

/** The label of the most recent active guard, or null. */
export function leaveGuardLabel(guards: Record<number, string>): string | null {
  const ids = Object.keys(guards).map(Number)
  return ids.length ? guards[Math.max(...ids)] : null
}

/**
 * For a screen's own popstate handling: show the Stay / Leave ask and run
 * `onLeave` only if the person chooses Leave.
 */
export function requestLeave(onLeave: () => void) {
  const close = () => useLeaveGuardStore.setState({ ask: null })
  useLeaveGuardStore.setState({ ask: { stay: close, leave: () => { close(); onLeave() } } })
}

/**
 * Whether a route change should be held. Sign-in, lock and sign-out screens
 * (/auth/*) are never held: the app lock must always be able to come up.
 */
export function shouldHoldNavigation(guarded: boolean, fromPath: string, toPath: string): boolean {
  if (!guarded) return false
  if (fromPath === toPath) return false
  if (toPath === '/auth' || toPath.startsWith('/auth/')) return false
  return true
}
