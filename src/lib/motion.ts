// motion.ts — single source of truth for page/step transition timing.
//
// Before this existed, every route/wizard hand-rolled its own duration,
// easing, and travel-distance values (0.15s/0.2s/0.24s/0.3s/0.4s/0.5s all
// appeared across different files for what was visually the same kind of
// motion). That drift is what made the app feel like several things were
// animating at different speeds. Every page-level and step-level transition
// should import its numbers from here instead of hardcoding new ones.
//
// Three categories, matched to how the user is actually navigating:
//   - Desktop: fade + a few px of rise. Never horizontal movement — a slide
//     reads as out-of-place mobile motion language in a sidebar+header shell.
//   - Mobile, lateral (tab-to-tab): same fade+rise weight as desktop.
//   - Mobile, hierarchical (push/pop — drilling into a detail, or stepping
//     through a wizard): directional horizontal slide + fade. Back reverses
//     the direction.
import type { Transition } from 'framer-motion'

export type NavDirection = 'forward' | 'back'

const EASE_OUT = [0.4, 0, 0.2, 1] as const

export const DESKTOP_FADE_Y = 5
export const DESKTOP_FADE_TRANSITION: Transition = { duration: 0.2, ease: EASE_OUT }

export const MOBILE_TAB_FADE_Y = 6
export const MOBILE_TAB_FADE_TRANSITION: Transition = { duration: 0.2, ease: EASE_OUT }

export const MOBILE_SLIDE_X = 18
export const MOBILE_SLIDE_TRANSITION: Transition = { duration: 0.24, ease: EASE_OUT }

/**
 * Variants for a screen that's part of a browsable, back-able step sequence
 * (e.g. PaySend's search->amount->review, or a claim flow's chain-select->
 * amount). `direction` is which way the user is moving: 'forward' slides in
 * from the right / out to the left; 'back' reverses it.
 */
export function slideStepVariants(direction: NavDirection) {
  const enterX = direction === 'back' ? -MOBILE_SLIDE_X : MOBILE_SLIDE_X
  const exitX = direction === 'back' ? MOBILE_SLIDE_X : -MOBILE_SLIDE_X
  return {
    initial: { opacity: 0, x: enterX },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: exitX },
  }
}
