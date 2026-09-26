// components/ui/GlassPopCard.tsx
//
// A richer, top-anchored frosted-glass confirmation — a checkmark/error
// badge, bold title, message, and an optional action button — for
// confirmations that deserve more than Toast.tsx's plain single-line bar
// but don't need ProcessingFlipCard's full processing→flip→result modal
// (no async action to wait on here; the thing being confirmed already
// happened). Same portal-to-<body> + fixed-centering approach as
// Toast.tsx, for the same reason: a `position: sticky` ancestor further up
// the tree establishes a containing block that would otherwise throw off
// "centered on screen" math on viewports wider than that ancestor.

import { createPortal } from 'react-dom'
import { TOAST_MOTION } from '@/lib/motion'
import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useState } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'

export interface GlassPopState {
  open: boolean
  kind: 'success' | 'error'
  title: string
  message: string
  actionLabel?: string
  onAction?: () => void
}

const INITIAL_STATE: GlassPopState = { open: false, kind: 'success', title: '', message: '' }
const AUTO_DISMISS_MS = 5000

export function useGlassPop() {
  const [glassPop, setGlassPop] = useState<GlassPopState>(INITIAL_STATE)

  const showGlassPop = useCallback((
    title: string, message: string,
    opts?: { kind?: 'success' | 'error'; actionLabel?: string; onAction?: () => void },
  ) => {
    setGlassPop({ open: true, kind: opts?.kind ?? 'success', title, message, actionLabel: opts?.actionLabel, onAction: opts?.onAction })
    setTimeout(() => setGlassPop(s => (s.title === title && s.message === message ? { ...s, open: false } : s)), AUTO_DISMISS_MS)
  }, [])

  const dismissGlassPop = useCallback(() => setGlassPop(s => ({ ...s, open: false })), [])

  return { glassPop, showGlassPop, dismissGlassPop }
}

export function GlassPopCard({ open, kind, title, message, actionLabel, onAction, onDismiss }: GlassPopState & { onDismiss: () => void }) {
  const color = kind === 'success' ? 'var(--success)' : 'var(--danger)'

  return createPortal(
    <div style={{ position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 9999 }} className="max-w-sm w-full px-4">
      <AnimatePresence>
        {open && (
          <motion.div
            {...TOAST_MOTION}
            style={{
              background: 'color-mix(in srgb, var(--surface) 65%, transparent)',
              border: '1px solid color-mix(in srgb, var(--text-primary) 10%, transparent)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              borderRadius: 20,
              padding: 18,
              boxShadow: '0 20px 50px rgba(0,0,0,0.35)',
            }}
          >
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <div style={{
                width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                background: kind === 'success' ? 'color-mix(in srgb, var(--success) 18%, transparent)' : 'color-mix(in srgb, var(--danger) 18%, transparent)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {kind === 'success' ? <CheckCircle2 size={20} color={color} /> : <XCircle size={20} color={color} />}
              </div>
              <div style={{ flex: 1, paddingTop: 2 }}>
                <p style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 3px' }}>{title}</p>
                <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.4 }}>{message}</p>
              </div>
            </div>
            {actionLabel && (
              <button
                onClick={() => { onAction?.(); onDismiss() }}
                style={{
                  width: '100%', marginTop: 14, padding: '10px 0', borderRadius: 12,
                  border: '1px solid color-mix(in srgb, var(--text-primary) 12%, transparent)',
                  background: 'color-mix(in srgb, var(--text-primary) 8%, transparent)',
                  color: 'var(--text-primary)', fontWeight: 700, fontSize: 13, cursor: 'pointer',
                }}
              >
                {actionLabel}
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>,
    document.body
  )
}
