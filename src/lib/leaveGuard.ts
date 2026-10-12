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

// ── Back button ───────────────────────────────────────────────────────────
// React Router can't hold a Back press onto a history entry it didn't create
// (the bottom nav, the Hub and some flows push their own entries), and a
// Back that stays on the same path never reaches its blocker at all. So while
// a guard is on, LeaveGuardHost catches every popstate itself, before the
// router and the pages see it. When the person chooses Leave, the next Back
// is let through untouched - and the router's blocker lets it through too.

let passPending = false
let passing = false

/** Let the next Back (popstate) through the guard: the person chose Leave. */
export function letNextBackThrough() { passPending = true }

/** In LeaveGuardHost's popstate handler: true once, for the Back that was let through. */
export function takePassThrough(): boolean {
  if (!passPending) return false
  passPending = false
  passing = true
  // The router and the pages handle this same event synchronously after us.
  setTimeout(() => { passing = false }, 0)
  return true
}

/** True while the let-through Back is being handled. */
export const isPassingThrough = () => passing

// The app itself also steps back through history (a flow dropping its own
// entry as it moves on, navigate(-1)). Those calls go through history.back()
// / history.go(-n); a person's Back button never does. They're tallied here
// (from the moment the app loads, since such a call can come in the very
// render that turns a guard on) so the guard only catches real Back presses.
const appPops: number[] = []
const APP_POP_WINDOW_MS = 1500

if (typeof window !== 'undefined' && window.history) {
  const h = window.history
  const back = h.back.bind(h)
  const go = h.go.bind(h)
  h.back = () => { appPops.push(Date.now()); back() }
  h.go = (delta?: number) => { if (delta && delta < 0) appPops.push(Date.now()); go(delta) }
  // The Back press itself. Listeners on window run in the order they were
  // added (capture or not), so this one - added when this module first loads,
  // which main.tsx makes happen before the router is created - sees every
  // Back before React Router and every page's own popstate handler. While a
  // guard is on, a real Back is undone (history.go(1): the screen and
  // history stay exactly as they were) and the person is asked Stay / Leave.
  let undoing = false
  window.addEventListener('popstate', e => {
    // Every Back is paired with its cause, guard on or not, so a step back the
    // app made just before a guard switched on can't be taken for the next one.
    const byApp = takeAppPop()
    if (undoing) { undoing = false; e.stopImmediatePropagation(); return }
    if (takePassThrough() || byApp || !isLeaveGuarded()) return
    e.stopImmediatePropagation()
    undoing = true
    go(1)
    const close = () => useLeaveGuardStore.setState({ ask: null })
    useLeaveGuardStore.setState({ ask: { stay: close, leave: () => { close(); letNextBackThrough(); window.history.back() } } })
  })
}

/** In LeaveGuardHost's popstate handler: true once per back step the app made itself. */
export function takeAppPop(now = Date.now()): boolean {
  while (appPops.length && now - appPops[0] > APP_POP_WINDOW_MS) appPops.shift()
  if (!appPops.length) return false
  appPops.shift()
  return true
}
