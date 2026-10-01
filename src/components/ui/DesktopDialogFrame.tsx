// DesktopDialogFrame.tsx
// The app's centred popup. Started as the desktop stand-in for mobile bottom
// sheets; now every popup opens this way on phones too (pickers, menus,
// profiles, confirmations). Only the amount keypad and the passcode keypad
// sheets still slide up from the bottom.
//
// Rendered into document.body so a transformed ancestor (page transitions)
// can't become its containing block, and it always centres on the screen.
// React still delivers a portal's events to its React ancestors, so clicks
// and touches are stopped here. A plain dim (no backdrop blur): Android
// Chrome re-blurs every frame while content underneath animates, which
// flickers.
import { motion } from 'framer-motion'
import { createPortal } from 'react-dom'
import { POPUP_CARD, DIALOG_BACKDROP } from '@/lib/motion'
import { type ReactNode } from 'react'

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()

export function DesktopDialogFrame({ onClose, children, maxWidth = 440, zIndex = 200 }: {
  onClose: () => void
  children: ReactNode
  maxWidth?: number
  zIndex?: number
}) {
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={DIALOG_BACKDROP.transition}
      onClick={e => { e.stopPropagation(); onClose() }}
      onMouseDown={stop} onMouseUp={stop} onTouchStart={stop} onTouchMove={stop} onTouchEnd={stop} onTouchCancel={stop}
      style={{
        position: 'fixed', inset: 0, zIndex,
        background: 'rgba(6,10,14,0.62)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom))',
      }}
    >
      <motion.div
        onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true"
        className="mp-popup"
        initial={POPUP_CARD.initial}
        animate={POPUP_CARD.animate}
        exit={POPUP_CARD.exit}
        transition={POPUP_CARD.transition}
        style={{ width: '100%', maxWidth, maxHeight: '100%', overflowY: 'auto', overscrollBehavior: 'contain' }}
      >
        {children}
      </motion.div>
    </motion.div>,
    document.body,
  )
}
