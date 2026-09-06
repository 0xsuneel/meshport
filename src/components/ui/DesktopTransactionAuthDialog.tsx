// DesktopTransactionAuthDialog.tsx
// Desktop-only PIN-entry dialog — deliberately NOT the same generic shell
// as DesktopDialogFrame (used everywhere else: token pickers, chain
// pickers, history details, confirmations). This one is reserved for the
// single moment across the app that actually authorizes money movement,
// so it gets its own visual weight: a lock badge, a standardized amount +
// destination summary above the keypad, and an accent-tinted border/glow.
// Every caller keeps its existing PinKeypad + error text completely
// unchanged — this is only the chrome around it, swapped in on the
// isDesktop branch exactly like DesktopDialogFrame was, mobile untouched.
import { motion } from 'framer-motion'
import { type ReactNode } from 'react'

export function DesktopTransactionAuthDialog({
  onClose, title, amountLabel, subLabel, accent = 'var(--brand)', maxWidth = 420, children,
}: {
  onClose: () => void
  title: string
  // Optional — not every "authorize" moment is a dollar figure (P2P has
  // plain confirmations like "Confirm Cancel"/"Confirm Changes" sharing
  // this same dialog). When omitted, the big tabular-number line is
  // skipped and subLabel alone carries the description.
  amountLabel?: string
  subLabel: ReactNode
  accent?: string
  maxWidth?: number
  children: ReactNode
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
          background: 'var(--surface)', border: `1px solid color-mix(in srgb, ${accent} 25%, var(--border))`, borderRadius: 22,
          boxShadow: `0 0 0 1px color-mix(in srgb, ${accent} 12%, transparent), var(--shadow-3)`,
        }}
      >
        <div style={{ padding: '28px 28px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          {/* Lock badge — spring-scales in just after the panel itself for a
              light staggered reveal rather than everything landing at once. */}
          <motion.div
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 420, damping: 22, delay: 0.05 }}
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

          {/* Standardized transaction summary — every caller now shows the
              same amount + destination presentation here, instead of each
              page inventing its own text sentence. */}
          {amountLabel && (
            <div style={{ fontSize: 30, fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', marginTop: 10 }}>
              {amountLabel}
            </div>
          )}
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: amountLabel ? 4 : 10, textAlign: 'center' }}>
            {subLabel}
          </div>

          <div style={{ width: '100%', height: 1, background: 'var(--border)', margin: '22px 0' }} />

          <div style={{ width: '100%' }}>
            {children}
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}
