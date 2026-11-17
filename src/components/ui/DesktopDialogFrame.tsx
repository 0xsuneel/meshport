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
import { POPUP_CARD, isDesktopNow, stableLayer, staggerSheetContents } from '@/lib/motion'
import { PopupDim } from './PopupDim'
import { usePopupOpen } from '@/hooks/usePopupOpen'
import { useBackLayer } from '@/lib/backLayers'
import { type ReactNode, useEffect, useRef } from 'react'

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()

// Once per opening (the card mounts with the popup); desktop popups keep the
// desktop motion (a quick fade), no stagger.
const staggerOnPhone = (el: HTMLDivElement | null) => {
  if (el && !isDesktopNow()) requestAnimationFrame(() => staggerSheetContents(el))
}

export function DesktopDialogFrame({ onClose, children, maxWidth = 440, zIndex = 200, backClose = true, bare = false, stagger = false }: {
  onClose: () => void
  children: ReactNode
  maxWidth?: number
  zIndex?: number
  /** Phone / browser Back closes it (default). Off where the page already
   *  handles Back for this popup itself. */
  backClose?: boolean
  /** No card chrome (.mp-popup): the child draws its own card (receipts). */
  bare?: boolean
  /** Phone: its contents arrive one by one as it opens (lib/motion
   *  staggerSheetContents) - for a list or a grid, not a confirmation. */
  stagger?: boolean
}) {
  usePopupOpen()
  useBackLayer(backClose, onClose)
  // Esc closes it, like any desktop dialog (keyboards on phones too).
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return createPortal(
    <div
      onClick={e => { e.stopPropagation(); onClose() }}
      onMouseDown={stop} onMouseUp={stop} onTouchStart={stop} onTouchMove={stop} onTouchEnd={stop} onTouchCancel={stop}
      style={{
        position: 'fixed', inset: 0, zIndex,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        // keyboard-inset-height: Android draws the keyboard over the app
        // (lib/keyboardOverlay) - the card stays centred above it. 0px elsewhere.
        padding: 'max(16px, var(--safe-top)) 16px calc(max(16px, var(--safe-bottom)) + env(keyboard-inset-height, 0px))',
      }}
    >
      {/* Only the dim fades; the card is solid from its first frame (PopupDim). */}
      <PopupDim />
      <motion.div
        onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true"
        className={bare ? undefined : 'mp-popup'}
        initial={POPUP_CARD.initial}
        animate={POPUP_CARD.animate}
        exit={POPUP_CARD.exit}
        transition={POPUP_CARD.transition}
        transformTemplate={stableLayer}
        ref={stagger ? staggerOnPhone : undefined}
        // Its own compositor layer, so the grow animation never re-rasterizes the list inside.
        style={{ position: 'relative', width: '100%', maxWidth, maxHeight: '100%', overflowY: 'auto', overflowX: 'hidden', overscrollBehavior: 'contain', willChange: 'transform, opacity', backfaceVisibility: 'hidden' }}
      >
        {children}
      </motion.div>
    </div>,
    document.body,
  )
}
