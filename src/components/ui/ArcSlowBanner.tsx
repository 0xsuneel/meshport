import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { TOAST_MOTION } from '@/lib/motion'
import { useAuthStore } from '@/store'
import { startArcHealth, useArcSlow } from '@/lib/arcHealth'

// A small pill under the top edge while the Arc network itself is slow
// (blocks arriving seconds apart instead of twice a second): payments are
// sent at once but confirm when the next block arrives. Says so, so the wait
// is not blamed on the app. Only watches while signed in (lib/arcHealth).
//
// Tap × to hide it: it stays hidden while this slow spell lasts and comes
// back only if Arc slows down again later.
export function ArcSlowBanner() {
  const signedIn = useAuthStore(s => s.isAuthenticated)
  const slow = useArcSlow()
  const [hidden, setHidden] = useState(false)
  useEffect(() => (signedIn ? startArcHealth() : undefined), [signedIn])
  // Arc healthy again: the next slow spell shows it again.
  useEffect(() => { if (!slow) setHidden(false) }, [slow])

  return (
    // Full-width row that centres the pill.
    <div style={{ position: 'fixed', zIndex: 9999, left: 0, right: 0, top: 'calc(env(safe-area-inset-top, 0px) + 54px)', display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
      <AnimatePresence>
        {slow && !hidden && (
          <motion.div key="arc-slow" role="status" aria-live="polite"
            {...TOAST_MOTION}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 6px 6px 14px', borderRadius: 999,
              fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', pointerEvents: 'auto',
              color: '#fff', background: '#2B3137', boxShadow: '0 6px 18px -6px rgba(0,0,0,0.4)',
            }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
            </svg>
            Arc network is slow right now
            <button type="button" aria-label="Hide" onClick={() => setHidden(true)}
              style={{ display: 'grid', placeItems: 'center', width: 24, height: 24, borderRadius: 999, border: 0, padding: 0, background: 'rgba(255,255,255,0.12)', color: 'inherit', cursor: 'pointer' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
