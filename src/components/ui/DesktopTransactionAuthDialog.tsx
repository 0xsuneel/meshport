// DesktopTransactionAuthDialog.tsx
// Desktop-only PIN-entry dialog - deliberately NOT the same generic shell
// as DesktopDialogFrame (used everywhere else: token pickers, chain
// pickers, history details, confirmations). This one is reserved for the
// single moment across the app that actually authorizes money movement,
// so it gets its own visual weight: a lock badge, a standardized amount +
// destination summary above the keypad, and an accent-tinted border/glow.
// Every caller keeps its existing PinKeypad + error text completely
// unchanged - this is only the chrome around it, swapped in on the
// isDesktop branch exactly like DesktopDialogFrame was, mobile untouched.
//
// Rendered into document.body (like DesktopDialogFrame) so a transformed
// ancestor - e.g. the Multichain Hub's embedded flows - can't become its
// containing block: it always centres on the screen.
import { motion } from 'framer-motion'
import { PopupDim } from './PopupDim'
import { createPortal } from 'react-dom'
import { DIALOG_CARD } from '@/lib/motion'
import { usePopupOpen } from '@/hooks/usePopupOpen'
import { type ReactNode, useEffect, useRef } from 'react'
import { useBackLayer } from '@/lib/backLayers'
import { HUB_PANEL_WIDTH } from '@/components/multichain/HubPage'

export function DesktopTransactionAuthDialog({
  onClose, title, amountLabel, subLabel, accent = 'var(--brand)', maxWidth = 420, placement = 'center', panelWidth = HUB_PANEL_WIDTH, anchor, instantExit = false, backClose = true, zIndex = 100, children,
}: {
  onClose: () => void
  title: string
  // Optional - not every "authorize" moment is a dollar figure (P2P has
  // plain confirmations like "Confirm Cancel"/"Confirm Changes" sharing
  // this same dialog). When omitted, the big tabular-number line is
  // skipped and subLabel alone carries the description.
  amountLabel?: string
  subLabel: ReactNode
  accent?: string
  maxWidth?: number
  /** 'panel': centred in the right-hand panel (Multichain Hub's Transfer / Bring
   *  flows, see HubPage), so every step of those flows stays in that column. */
  placement?: 'center' | 'panel'
  /** Width of that right-hand panel (default: the Hub's). */
  panelWidth?: string
  /** Centre over this element instead (e.g. the page's flow column beside
   *  its Recent History panel), so the dialog sits over what it authorizes. */
  anchor?: HTMLElement | null
  /** Card leaves at once (only the dim fades) - for a dialog over a panel
   *  whose own content would otherwise show through the fading card. */
  instantExit?: boolean
  /** Phone / browser Back closes it (default). */
  backClose?: boolean
  /** Stacking order (default 100); raise it over a popup that stays open. */
  zIndex?: number
  children: ReactNode
}) {
  usePopupOpen()
  useBackLayer(backClose, onClose)
  // Esc closes it, like every other dialog.
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const box = anchor?.getBoundingClientRect()
  return createPortal(
    <div
      // A portal still delivers events to its React ancestors: stop them so
      // a click here can't also trigger the page's own handlers.
      onClick={e => { e.stopPropagation(); onClose() }}
      style={{ position: 'fixed', inset: 0, zIndex }}
    >
      {/* A plain dim, no backdrop blur - see usePopupOpen. Only the dim fades (PopupDim). */}
      <PopupDim background="rgba(0,0,0,0.6)" />
      <div style={{
        position: 'absolute',
        ...(box ? { top: box.top, left: box.left, width: box.width, height: box.height }
          : { top: 0, bottom: 0, right: 0, ...(placement === 'panel' ? { width: panelWidth } : { left: 0 }) }),
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: placement === 'panel' ? 20 : 24, pointerEvents: 'none',
      }}>
      <motion.div
        onClick={e => e.stopPropagation()}
        initial={DIALOG_CARD.initial}
        animate={DIALOG_CARD.animate}
        exit={instantExit ? { opacity: 0, transition: { duration: 0 } } : DIALOG_CARD.exit}
        transition={DIALOG_CARD.transition}
        style={{
          position: 'relative', width: '100%', maxWidth, maxHeight: '85vh', overflowY: 'auto', pointerEvents: 'auto',
          background: 'var(--surface)', border: `1px solid color-mix(in srgb, ${accent} 25%, var(--border))`, borderRadius: 22,
          boxShadow: `0 0 0 1px color-mix(in srgb, ${accent} 12%, transparent), var(--shadow-3)`,
        }}
      >
        <div style={{ padding: '28px 28px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          {/* Lock badge - spring-scales in just after the panel itself for a
              light staggered reveal rather than everything landing at once. */}
          <motion.div
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1], delay: 0.05 }}
            style={{
              width: 52, height: 52, borderRadius: '50%', flexShrink: 0,
              background: `color-mix(in srgb, ${accent} 14%, transparent)`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              marginBottom: 16,
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <rect x="5" y="11" width="14" height="9" rx="2.5" stroke={accent} strokeWidth="1.8"/>
              <path d="M8 11V8a4 4 0 118 0v3" stroke={accent} strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
          </motion.div>

          <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>{title}</h2>

          {/* Standardized transaction summary - every caller now shows the
              same amount + destination presentation here, instead of each
              page inventing its own text sentence. */}
          {amountLabel && (
            <div style={{ fontSize: 30, fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', marginTop: 10 }}>
              {amountLabel}
            </div>
          )}
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: amountLabel ? 4 : 10, textAlign: 'center', overflowWrap: 'anywhere' }}>
            {subLabel}
          </div>

          <div style={{ width: '100%', height: 1, background: 'var(--border)', margin: '22px 0' }} />

          <div style={{ width: '100%' }}>
            {children}
          </div>
        </div>
      </motion.div>
      </div>
    </div>,
    document.body,
  )
}
