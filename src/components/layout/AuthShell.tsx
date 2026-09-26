import { motion, useReducedMotion } from 'framer-motion'
import { useLocation } from 'react-router-dom'
import { DESKTOP_FADE_Y, DESKTOP_FADE_TRANSITION, PAGE_TRANSITION, pageSlide } from '@/lib/motion'
import { useNavDirection } from '@/hooks/useNavDirection'

// AuthShell — wraps public, pre-login pages (login/register flow, the
// public payment link, legal pages) so they get the same phone-width
// treatment as the logged-in app's AppLayout mobile shell instead of
// stretching edge-to-edge on desktop. These pages render before
// AppLayout ever mounts (no session yet), so without this they had no
// width constraint at all — inputs, buttons, and the payment-receive
// link page all rendered full browser width on desktop.
//
// Onboarding (/auth/*) is a linear, back-able wizard, so its steps get the
// same directional slide as any other hierarchical step flow — direction
// comes from useNavigationType() ('POP' = the user went back), so it
// reverses automatically without each auth page tracking its own state.
// Everything else routed through this shell (/pay/:username, /legal,
// /terms, /privacy) is a standalone deep-linked page with no "previous
// step" to slide from, so it only fades.
export function AuthShell({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const nav = useNavDirection()
  const reduceMotion = useReducedMotion()
  const isOnboardingStep = location.pathname.startsWith('/auth')
  // Same page animation as the rest of the app (lib/motion.ts).
  const slide = pageSlide(nav === 'back' ? 'back' : 'forward')
  const initial = isOnboardingStep && nav !== 'none' ? slide.initial : { opacity: 0, y: DESKTOP_FADE_Y }
  const animate = isOnboardingStep && nav !== 'none' ? slide.animate : { opacity: 1, y: 0 }
  const transition = isOnboardingStep && nav !== 'none' ? PAGE_TRANSITION : DESKTOP_FADE_TRANSITION

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'var(--bg)',
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'center',
    }}>
      <div style={{
        width: '100%',
        maxWidth: '430px',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
        // BUG FIX: this inner box was never a flex container, so any child
        // page using `flex-1` + `overflow-y-auto` for its own internal
        // scroll (e.g. TermsPrivacyPage) had `flex-1` do nothing — the
        // child just rendered at its natural content height instead of
        // being bounded to this box's real height. Once that content grew
        // taller than the box, it wasn't scrollable at all: this box's own
        // `overflow: hidden` (needed to keep the phone-width frame from
        // spilling on desktop) simply clipped the excess instead of a
        // scrollbar ever appearing. Reached via /terms, /privacy, /legal
        // (this AuthShell path, for the public/pre-login/Google-OAuth-
        // consent-screen links) but NOT via Profile → Support's nested
        // in-app route (a different parent, AppLayout's own outlet, which
        // already provides this correctly) — exactly the "behaves
        // differently" symptom. display:flex + column here is what makes
        // a child's `flex-1` actually resolve to this box's bounded
        // height, so its own `overflow-y-auto` can do its job.
        display: 'flex',
        flexDirection: 'column',
      }}>
        <motion.div
          key={location.pathname}
          initial={reduceMotion ? false : initial}
          animate={animate}
          transition={transition}
          style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
        >
          {children}
        </motion.div>
      </div>
    </div>
  )
}
