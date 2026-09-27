import { useEffect, type Ref, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { FlashAuthIcon } from './FlashAuthIcon'
import { EASE_OUT } from '@/lib/motion'
import { successFeedback } from '@/lib/feedback'

// The one payment-success moment used by every payment screen (Send, Chat
// pay, Swap, Transfer, Claim, Contacts, Bulk Pay):
//   1. brand colour fills the screen from the centre outward
//   2. the white circle springs in and the tick draws itself
//   3. soft "ding" + a short buzz
//   4. the title rises in
// Sizes of the white circle and the icon are fixed — the screens' traveling
// checkmark measures this circle (checkRef) to fly into the receipt.
export const SUCCESS_CIRCLE = 82.08
export const SUCCESS_ICON = 37.62

interface SuccessFlashProps {
  title: string
  checkRef?: Ref<HTMLDivElement>
  viaBiometric?: boolean
  /** Biometric icon waits for the circle to land before swapping to the tick. */
  circleReady?: boolean
  onCircleReady?: () => void
  /** Portal to <body> and cover the viewport (default), or fill the parent. */
  portal?: boolean
  /** Desktop: pin to this rect instead of the whole viewport. */
  rect?: DOMRect | null
  radius?: number | string
}

export function SuccessFlash({ title, checkRef, viaBiometric, circleReady = true, onCircleReady, portal = true, rect, radius = 20 }: SuccessFlashProps) {
  useEffect(() => { successFeedback() }, [])

  const box: CSSProperties = portal
    ? { position: 'fixed', ...(rect ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height, borderRadius: radius } : { inset: 0 }) }
    : { position: 'absolute', inset: 0, borderRadius: 'inherit' }

  const body = (
    <motion.div
      role="status"
      aria-live="polite"
      initial={{ clipPath: 'circle(0% at 50% 50%)' }}
      animate={{ clipPath: 'circle(75% at 50% 50%)' }}
      transition={{ duration: 0.45, ease: EASE_OUT }}
      style={{ ...box, zIndex: 999, background: 'var(--brand)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
    >
      <div style={{ position: 'relative', width: SUCCESS_CIRCLE, height: SUCCESS_CIRCLE, marginBottom: 20 }}>
        {/* One soft ring pulsing out from the circle */}
        <motion.span aria-hidden
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: [0.6, 1.9], opacity: [0, 0.45, 0] }}
          transition={{ delay: 0.3, duration: 0.9, ease: 'easeOut', times: [0, 0.2, 1] }}
          style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '2px solid #fff' }} />
        <motion.div ref={checkRef}
          initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
          transition={{ delay: 0.14, type: 'spring', stiffness: 260, damping: 17 }}
          onAnimationComplete={onCircleReady}
          style={{ width: SUCCESS_CIRCLE, height: SUCCESS_CIRCLE, borderRadius: '50%', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {viaBiometric ? (
            <FlashAuthIcon viaBiometric start={circleReady} size={SUCCESS_ICON} color="var(--brand)" />
          ) : (
            <motion.svg width={SUCCESS_ICON} height={SUCCESS_ICON} viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
              <motion.polyline points="20 6 9 17 4 12" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.4, delay: 0.32, ease: EASE_OUT }} />
            </motion.svg>
          )}
        </motion.div>
      </div>
      <motion.p
        initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.36, duration: 0.36, ease: EASE_OUT }}
        style={{ fontSize: 22, fontWeight: 700, color: '#fff', margin: 0, textAlign: 'center', padding: '0 24px' }}>
        {title}
      </motion.p>
    </motion.div>
  )

  return portal ? createPortal(body, document.body) : body
}
