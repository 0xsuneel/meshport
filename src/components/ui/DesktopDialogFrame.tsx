// DesktopDialogFrame.tsx
// Desktop-only replacement chrome for mobile bottom sheets. Every sheet
// across the app keeps its existing mobile backdrop+rounded-top-panel JSX
// completely untouched — this component is swapped in ONLY on the desktop
// branch (isDesktop === true), wrapping the exact same inner content, so a
// PIN entry / picker / confirmation opens as a centered dialog instead of
// sliding up from the bottom of a 1920px-wide screen like a phone.
import { motion } from 'framer-motion'
import { type ReactNode } from 'react'

export function DesktopDialogFrame({ onClose, children, maxWidth = 440 }: {
  onClose: () => void
  children: ReactNode
  maxWidth?: number
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <motion.div
        onClick={e => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97 }}
        transition={{ type: 'spring', stiffness: 380, damping: 28 }}
        style={{
          width: '100%', maxWidth, maxHeight: '85vh', overflowY: 'auto',
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 20,
          boxShadow: 'var(--shadow-3)',
        }}
      >
        {children}
      </motion.div>
    </motion.div>
  )
}
