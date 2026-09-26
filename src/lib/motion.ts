// motion.ts — the ONE motion system for the whole app.
//
// Every animated surface imports its values from here, so the same kind of
// thing always moves the same way:
//
//   Page open  (mobile) ... slides in from the RIGHT; going back slides in
//                           from the LEFT (PageTransition decides direction).
//   Tab switch (bottom nav) quick cross-fade, no sliding (like native apps).
//   In-page steps ......... same slide as pages (forward → from right,
//                           back → from left), e.g. Pay's amount → review.
//   Bottom sheets ......... slide up from the bottom on one spring, dimmed
//                           backdrop fades — every sheet, PIN sheet and the
//                           amount keypad.
//   Centered popups ....... fade + gentle scale-in (dialogs, confirms).
//   Toasts ................ drop in from the top, fade out.
//   Errors ................ fade in with a small drop (and wrap inside the
//                           screen — see .mp-alert in index.css).
//   Desktop pages ......... fade + a few px of rise (no sliding in a
//                           sidebar layout).
import type { Transition } from 'framer-motion'

export type NavDirection = 'forward' | 'back'

/** iOS-style deceleration — fast start, long soft landing. */
export const EASE_OUT: [number, number, number, number] = [0.32, 0.72, 0, 1]

// ── Pages & steps ───────────────────────────────────────────────────────────
/** How far a page / step travels while fading in (share of its width). */
export const PAGE_SLIDE_X = '28%'
export const PAGE_TRANSITION: Transition = { duration: 0.34, ease: EASE_OUT }

/** Page / step entrance for a direction ('back' comes from the left). */
export function pageSlide(direction: NavDirection) {
  const from = direction === 'back' ? `-${PAGE_SLIDE_X}` : PAGE_SLIDE_X
  return { initial: { opacity: 0, x: from }, animate: { opacity: 1, x: 0 } }
}

/**
 * Variants for a screen that's part of a browsable, back-able step sequence
 * (Pay's search → amount → review, a claim flow's chain → amount, …) —
 * identical to a page opening, plus an exit for AnimatePresence.
 */
export function slideStepVariants(direction: NavDirection) {
  const from = direction === 'back' ? `-${PAGE_SLIDE_X}` : PAGE_SLIDE_X
  const to = direction === 'back' ? PAGE_SLIDE_X : `-${PAGE_SLIDE_X}`
  return {
    initial: { opacity: 0, x: from },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: to },
  }
}

// Kept names (older call sites) — now the same system.
export const MOBILE_SLIDE_X = 96
export const MOBILE_SLIDE_TRANSITION: Transition = PAGE_TRANSITION

/** Tab switches / state swaps inside a screen: a quick cross-fade. */
export const MOBILE_TAB_FADE_Y = 0
export const MOBILE_TAB_FADE_TRANSITION: Transition = { duration: 0.18, ease: EASE_OUT }

export const DESKTOP_FADE_Y = 5
export const DESKTOP_FADE_TRANSITION: Transition = { duration: 0.2, ease: EASE_OUT }

// ── Bottom sheets (incl. PIN sheets and the amount keypad) ─────────────────
export const SHEET_SPRING: Transition = { type: 'spring', damping: 32, stiffness: 300 }
export const SHEET_PANEL = {
  initial: { y: '100%' },
  animate: { y: 0 },
  exit: { y: '100%' },
  transition: SHEET_SPRING,
} as const
export const SHEET_BACKDROP = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.22, ease: EASE_OUT },
} as const

// ── Centered popups / dialogs ──────────────────────────────────────────────
export const DIALOG_CARD = {
  initial: { opacity: 0, scale: 0.96, y: 8 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.97, y: 4 },
  transition: { type: 'spring', stiffness: 380, damping: 30 } as Transition,
} as const
export const DIALOG_BACKDROP = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.18, ease: EASE_OUT },
} as const

// ── Toasts / banners ───────────────────────────────────────────────────────
export const TOAST_MOTION = {
  initial: { opacity: 0, y: -16, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -12, scale: 0.98 },
  transition: { duration: 0.24, ease: EASE_OUT },
} as const
/** Bottom snackbars (e.g. "Deleted · UNDO"): same, rising from below. */
export const SNACKBAR_MOTION = {
  initial: { opacity: 0, y: 16, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 12, scale: 0.98 },
  transition: { duration: 0.24, ease: EASE_OUT },
} as const

// ── Errors ─────────────────────────────────────────────────────────────────
export const ERROR_MOTION = {
  initial: { opacity: 0, y: -4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0 },
  transition: { duration: 0.2, ease: EASE_OUT },
} as const
