import { useLocation } from 'react-router-dom'
import { PageTransition } from '@/components/ui/PageTransition'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DESKTOP_QUERY } from '@/lib/motion'

// AuthShell - wraps public, pre-login pages (login/register flow, the
// public payment link, legal pages) so they get the same phone-width
// treatment as the logged-in app's AppLayout mobile shell instead of
// stretching edge-to-edge on desktop. These pages render before
// AppLayout ever mounts (no session yet), so without this they had no
// width constraint at all - inputs, buttons, and the payment-receive
// link page all rendered full browser width on desktop.
//
// Pages change with the same push as the rest of the app (PageTransition):
// the next page slides in from the right over a picture of the old one, and
// back reverses it; a first load shows the page at once. (They used to
// remount from opacity 0, so every change started on an empty frame.)
// /legal, /terms and /privacy are one page whose tabs switch the URL, so
// they share one key and a tab tap doesn't count as opening a new page.
const LEGAL = new Set(['/legal', '/terms', '/privacy'])

export function AuthShell({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const pageKey = LEGAL.has(location.pathname) ? '/legal' : location.pathname
  // Desktop: a centred card on a soft background (like desktop sign-in
  // pages), not a phone-width strip stuck to the top of a wide screen.
  const isDesktop = useMediaQuery(DESKTOP_QUERY)

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: isDesktop ? 'color-mix(in srgb, var(--brand) 6%, var(--bg))' : 'var(--bg)',
      display: 'flex',
      alignItems: isDesktop ? 'center' : 'flex-start',
      justifyContent: 'center',
      padding: isDesktop ? 24 : 0,
    }}>
      <div data-page-shell="" style={{
        width: '100%',
        maxWidth: isDesktop ? '460px' : '430px',
        height: isDesktop ? 'min(860px, 100%)' : '100%',
        position: 'relative',
        overflow: 'hidden',
        ...(isDesktop ? {
          background: 'var(--bg)', borderRadius: 24,
          border: '1px solid var(--border)', boxShadow: 'var(--shadow-2, 0 24px 60px -24px rgba(0,0,0,0.35))',
        } : {}),
        // BUG FIX: this inner box was never a flex container, so any child
        // page using `flex-1` + `overflow-y-auto` for its own internal
        // scroll (e.g. TermsPrivacyPage) had `flex-1` do nothing - the
        // child just rendered at its natural content height instead of
        // being bounded to this box's real height. Once that content grew
        // taller than the box, it wasn't scrollable at all: this box's own
        // `overflow: hidden` (needed to keep the phone-width frame from
        // spilling on desktop) simply clipped the excess instead of a
        // scrollbar ever appearing. Reached via /terms, /privacy, /legal
        // (this AuthShell path, for the public/pre-login/Google-OAuth-
        // consent-screen links) but NOT via Profile → Support's nested
        // in-app route (a different parent, AppLayout's own outlet, which
        // already provides this correctly) - exactly the "behaves
        // differently" symptom. display:flex + column here is what makes
        // a child's `flex-1` actually resolve to this box's bounded
        // height, so its own `overflow-y-auto` can do its job.
        display: 'flex',
        flexDirection: 'column',
      }}>
        <PageTransition locationKey={pageKey}>
          {children}
        </PageTransition>
      </div>
    </div>
  )
}
