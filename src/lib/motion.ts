// motion.ts - the ONE motion system for the whole app.
//
// Every animated surface imports its values from here, so the same kind of
// thing always moves the same way:
//
//   Page open  (mobile) ... the new page slides in across the whole width
//                           from the RIGHT while the old one shifts left and
//                           dims; back reverses it (PUSH_*). One look for
//                           routes (PageTransition), in-page steps
//                           (ScreenPush), Business screens (PushLayer) and
//                           Hub pages (HubPage).
//   Tab switch (bottom nav) instant, like native apps.
//   Bottom sheets ......... slide up from the bottom on one curve, dimmed
//                           backdrop fades - ActionSheet (every sheet), the
//                           passcode sheet (PinSheet) and the amount keypad.
//   Centered popups ....... DesktopDialogFrame: the dim fades, the card grows
//                           in (dialogs, pickers, confirms, receipts).
//   Dropdown menus ........ MENU_MOTION (TokenMenu).
//   Toasts ................ drop in from the top, fade out.
//   Errors ................ fade in with a small drop (and wrap inside the
//                           screen - see .mp-alert in index.css).
//   Desktop pages ......... fade + a few px of rise (no sliding in a
//                           sidebar layout).
import type { Transition } from 'framer-motion'

export type NavDirection = 'forward' | 'back'

/** iOS-style deceleration - fast start, long soft landing. */
export const EASE_OUT: [number, number, number, number] = [0.32, 0.72, 0, 1]

// ── Pages & steps ───────────────────────────────────────────────────────────
/** A page / step move's length and curve (framer pushes use it; PUSH_* below
 *  are the same values for Web Animations). */
export const PAGE_TRANSITION: Transition = { duration: 0.3, ease: EASE_OUT }

/** Tab switches / state swaps inside a screen: a quick cross-fade. */
export const MOBILE_TAB_FADE_Y = 0
export const MOBILE_TAB_FADE_TRANSITION: Transition = { duration: 0.18, ease: EASE_OUT }

export const DESKTOP_FADE_Y = 4
export const DESKTOP_FADE_TRANSITION: Transition = { duration: 0.15, ease: EASE_OUT }

// ── Desktop (≥980px, same breakpoint as useMediaQuery callers / Tailwind lg) ─
// Desktop apps don't use phone motion: popups fade in with a tiny zoom
// (quick, no grow-and-rise), pages cross-fade in the content area only.
export const DESKTOP_QUERY = '(min-width: 980px)'
export function isDesktopNow(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.(DESKTOP_QUERY).matches
}
const DESKTOP_POPUP = {
  initial: { opacity: 0, scale: 0.96, y: 0 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.98, y: 0, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } },
  transition: { duration: 0.18, ease: EASE_OUT } as Transition,
} as const
/** Phone variant on phones, the desktop one on wide screens - read at render. */
function byScreen<T extends object>(phone: T, desktop: object): T {
  const out = {} as T
  for (const k of Object.keys(phone) as (keyof T)[]) {
    Object.defineProperty(out, k, {
      enumerable: true,
      get: () => (isDesktopNow() ? (desktop as any)[k] : phone[k]),
    })
  }
  return out
}

// ── Bottom sheets (incl. PIN sheets and the amount keypad) ─────────────────
// A tween, not a spring: the old spring (damping 32 / stiffness 300) was just
// under-damped, so every sheet overshot its resting place and settled back -
// a small rubber-band bounce. This lands once, iOS-style, and stays.
/**
 * framer-motion `transformTemplate` for anything that pops or slides in over
 * the page (popups, sheets, a success screen's rows): it stays on its own
 * GPU layer for its whole life. Without it, the moment an animation settles
 * framer writes `transform: none`, Chrome drops the layer and paints the
 * content again - on Android that repaint shows as a one-frame blink at the
 * end of opening (and again as closing starts). translateZ(0) changes nothing
 * on screen; it only keeps the layer.
 */
export const stableLayer = (_: unknown, generated: string): string =>
  generated && generated !== 'none' ? `${generated} translateZ(0)` : 'translateZ(0)'

export const SHEET_SPRING: Transition = { duration: 0.38, ease: EASE_OUT }
/** Sheets leave a little quicker than they arrive (ease-in, like the OS). */
export const SHEET_EXIT = { y: '100%', transition: { duration: 0.24, ease: [0.4, 0, 1, 1] } } as const
export const SHEET_PANEL = {
  initial: { y: '100%' },
  animate: { y: 0 },
  exit: SHEET_EXIT,
  transition: SHEET_SPRING,
  transformTemplate: stableLayer,
} as const
/** The dim behind every bottom sheet (Tailwind bg-black/70). */
export const SHEET_DIM = 'rgba(0,0,0,0.7)'
/** A light dim that keeps the page readable behind it: the amount keypad
 *  sheet and the desktop chat Pay drawer. */
export const LIGHT_DIM = 'rgba(0,0,0,0.16)'
/** The dim behind every centred popup (PopupDim). */
export const POPUP_DIM = 'rgba(6,10,14,0.62)'
export const SHEET_BACKDROP = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.22, ease: EASE_OUT },
} as const

// ── Centered popups / dialogs ──────────────────────────────────────────────
/** Popups move on plain tweens: springs overshoot (a rubber-band bounce),
 *  and on a spring the opacity overshoots and dips back, which reads as a blink. */
// The card starts 85% solid and is fully solid within ~5 frames, so the page
// behind barely shows through it (a full fade from 0 left the page's text
// visible inside the white card - a flicker on light pages), and it grows
// into place on a longer, soft ease-out, so it opens as a smooth pop rather
// than appearing at once. Only the dim fades behind it (PopupDim).
const POPUP_FADE: Transition = { duration: 0.08, ease: 'linear' }
const POPUP_GROW = [0.16, 1, 0.3, 1] as const
export const DIALOG_CARD = byScreen({
  initial: { opacity: 0.85, scale: 0.94, y: 10 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.97, y: 4 },
  transition: { duration: 0.32, ease: POPUP_GROW, opacity: POPUP_FADE } as Transition, // no overshoot
} as const, DESKTOP_POPUP)
/** Centred popups (DesktopDialogFrame / Sheet): a slightly livelier pop-in
 *  than DIALOG_CARD, which the success receipt keeps. */
export const POPUP_CARD = byScreen({
  initial: { opacity: 0.85, scale: 0.9, y: 22 },
  animate: { opacity: 1, scale: 1, y: 0 },
  // Closing: the card goes first and fast (most of it in the first frames),
  // while the dim behind it lifts gently (DIALOG_BACKDROP). The other way
  // round - a card that lingers while the dim lifts at once - the page jumped
  // to full brightness and showed through the half-faded card, its text
  // floating over the page: the screen read as flashing.
  exit: { opacity: 0, scale: 0.97, y: 6, transition: { duration: 0.12, ease: EASE_OUT } },
  transition: { duration: 0.36, ease: POPUP_GROW, opacity: POPUP_FADE } as Transition, // no overshoot
} as const, DESKTOP_POPUP)
export const DIALOG_BACKDROP = byScreen({
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  // Lifts slowly at first (the card is leaving over it), then eases off.
  exit: { opacity: 0, transition: { duration: 0.24, ease: [0.45, 0, 0.25, 1] } },
  transition: { duration: 0.18, ease: EASE_OUT },
} as const, {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0, transition: { duration: 0.12, ease: EASE_OUT } },
  transition: { duration: 0.15, ease: EASE_OUT },
})

// ── Controls (press / hover, the bottom-nav pill, badges) ────────────────
export const CONTROL_MOTION: Transition = { duration: 0.22, ease: EASE_OUT }

// ── Dropdown menus (TokenMenu and every menu like it) ─────────────────────
export const MENU_MOTION = {
  initial: { opacity: 0, y: -6, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -4, scale: 0.98 },
  transition: { duration: 0.16, ease: EASE_OUT },
} as const

// ── Push pages ─────────────────────────────────────────────────────────────
// Every page that opens over another - a route (PageTransition), a step in a
// flow (ScreenPush), a Business screen (PushLayer), a Hub page (HubPage) -
// moves the same way: the new page slides in across the whole width while
// the old one shifts left by PUSH_PARALLAX and dims; back reverses it. Both
// pages stay fully opaque (no cross-fade). On desktop a page only fades in
// with a few px of rise (DESKTOP_FADE_*).
export const PUSH_OPEN_MS = 300
export const PUSH_BACK_MS = 250
/** EASE_OUT as a CSS easing (Web Animations). */
export const PUSH_EASE_CSS = 'cubic-bezier(0.32, 0.72, 0, 1)'
export const PUSH_PARALLAX = '-28%'
/** How dark the page underneath gets while a page is pushed over it. */
export const PUSH_DIM = 0.22
export const DESKTOP_FADE_MS = 150
/** The first page of a new frame (landing → sign-in, sign-up → Home) has
 *  no old page to slide over: it glides this far and fades up instead. */
export const FRAME_ENTRY_PX = 32
export const FRAME_ENTRY_MS = 240
/** Desktop page / screen entrance as Web Animations keyframes. */
export const DESKTOP_FADE_KEYFRAMES: Keyframe[] = [{ opacity: 0, transform: `translateY(${4}px)` }, { opacity: 1, transform: 'none' }]

// ── Toasts / banners ───────────────────────────────────────────────────────
// Slides down from above the screen fully opaque (like a phone
// notification): fading in over the page header showed both texts at once.
export const TOAST_MOTION = {
  initial: { opacity: 1, y: '-160%' },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 1, y: '-160%' },
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
