import { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { TOAST_MOTION } from '@/lib/motion'
import { useAuthStore } from '@/store'
import { startArcHealth, useArcSlow } from '@/lib/arcHealth'

// A small pill under the top edge while the Arc network itself is slow
// (blocks arriving seconds apart instead of twice a second): payments are
// sent at once but confirm when the next block arrives. Says so, so the wait
// is not blamed on the app. Only watches while signed in (lib/arcHealth).
export function ArcSlowBanner() {
  const signedIn = useAuthStore(s => s.isAuthenticated)
  const slow = useArcSlow()
  useEffect(() => (signedIn ? startArcHealth() : undefined), [signedIn])
  return (
    <AnimatePresence>
      {slow && (
        <motion.div key="arc-slow" role="status" aria-live="polite"
          {...TOAST_MOTION}
          style={{
            position: 'fixed', zIndex: 9999, left: '50%', translateX: '-50%',
            top: 'calc(env(safe-area-inset-top, 0px) + 54px)',
            display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 999,
            fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', pointerEvents: 'none',
            color: '#fff', background: '#2B3137', boxShadow: '0 6px 18px -6px rgba(0,0,0,0.4)',
          }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
          </svg>
          Arc network is slow right now
        </motion.div>
      )}
    </AnimatePresence>
  )
}
