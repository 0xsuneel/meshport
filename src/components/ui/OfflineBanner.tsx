import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useOnline, useSlowNetwork } from '@/lib/connectivity'

// A small pill at the top of the screen: "No internet connection" while the
// device is offline, then "Back online" for a moment when it returns, as the
// screens reload their data by themselves (see lib/connectivity.ts).
const BACK_ONLINE_MS = 2000
// "Slow connection" shows for a moment when the network turns very slow.
const SLOW_NOTICE_MS = 4000

export function OfflineBanner() {
  const online = useOnline()
  const slow = useSlowNetwork()
  const [showBack, setShowBack] = useState(false)
  const [showSlow, setShowSlow] = useState(false)
  useEffect(() => {
    if (!slow) { setShowSlow(false); return }
    setShowSlow(true)
    const t = setTimeout(() => setShowSlow(false), SLOW_NOTICE_MS)
    return () => clearTimeout(t)
  }, [slow])
  const wasOffline = useRef(!online)

  useEffect(() => {
    if (!online) { wasOffline.current = true; setShowBack(false); return }
    if (!wasOffline.current) return
    wasOffline.current = false
    setShowBack(true)
    const t = setTimeout(() => setShowBack(false), BACK_ONLINE_MS)
    return () => clearTimeout(t)
  }, [online])

  const state = !online ? 'offline' : showBack ? 'back' : showSlow ? 'slow' : null
  return (
    <AnimatePresence>
      {state && (
        <motion.div key={state} role="status" aria-live="polite"
          initial={{ y: -16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -16, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
          style={{
            position: 'fixed', zIndex: 10000, left: '50%', translateX: '-50%',
            top: 'calc(env(safe-area-inset-top, 0px) + 10px)',
            display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 999,
            fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', pointerEvents: 'none',
            color: '#fff', background: state === 'offline' || state === 'slow' ? '#2B3137' : '#12665F',
            boxShadow: '0 6px 18px -6px rgba(0,0,0,0.4)',
          }}>
          {state === 'slow' ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M2 20h.01M7 20v-4M12 20v-8M17 20V8" />
            </svg>
          ) : state === 'offline' ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M2 2l20 20M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 5.2-2.7M19 12.9a10 10 0 0 0-2.3-1.6M2 8.8a15 15 0 0 1 4.2-2.7M22 8.8A15 15 0 0 0 11 5M12 20h.01" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          )}
          {state === 'offline' ? 'No internet connection' : state === 'slow' ? 'Slow connection · balance first' : 'Back online'}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
