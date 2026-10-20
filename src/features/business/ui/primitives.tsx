/**
 * Shared micro-components used across the business UI kit.
 * Pure presentational — no state, no fetching.
 */
import React from 'react'
import { motion } from 'framer-motion'

// ─── Skeleton shimmer ────────────────────────────────────────────────────────

export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-xl bg-border/40 ${className}`}
    />
  )
}

// ─── Chain logo with letter-circle fallback ──────────────────────────────────

interface ChainLogoProps {
  src: string
  label: string
  size?: number   // px, default 24
  className?: string
}

export function ChainLogo({ src, label, size = 24, className = '' }: ChainLogoProps) {
  const [failed, setFailed] = React.useState(false)
  const initial = label.trim()[0]?.toUpperCase() ?? '?'
  const style = { width: size, height: size, minWidth: size, fontSize: size * 0.42 }

  if (failed || !src) {
    return (
      <span
        className={`inline-flex items-center justify-center rounded-full bg-brand/10 font-semibold text-brand-text select-none ${className}`}
        style={style}
      >
        {initial}
      </span>
    )
  }
  return (
    <img
      src={src}
      alt={label}
      className={`rounded-full object-cover ${className}`}
      style={style}
      onError={() => setFailed(true)}
    />
  )
}

// ─── Status dot ─────────────────────────────────────────────────────────────

const dotColors: Record<string, string> = {
  received:   'bg-success',
  to_settle:  'bg-warning',
  refunded:   'bg-danger',
  completed:  'bg-success',
  in_progress:'bg-brand-text',
  failed:     'bg-danger',
  verified:   'bg-success',
  review:     'bg-warning',
  unverified: 'bg-danger',
}

export function StatusDot({ status }: { status: string }) {
  return (
    <span className={`inline-block size-2 rounded-full ${dotColors[status] ?? 'bg-text-muted'}`} />
  )
}

// ─── Badge pill ──────────────────────────────────────────────────────────────

export function Badge({ count, className = '' }: { count: number; className?: string }) {
  if (count <= 0) return null
  return (
    <span
      className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-brand text-white text-[10px] font-bold tabular-nums ${className}`}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}

// ─── Icon button wrapper ─────────────────────────────────────────────────────

export function IconBtn({
  children,
  label,
  onClick,
  className = '',
}: {
  children: React.ReactNode
  label: string
  onClick?: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`inline-flex items-center justify-center size-11 rounded-2xl text-text-secondary hover:bg-border/30 active:scale-95 transition-all ${className}`}
    >
      {children}
    </button>
  )
}

// ─── Subtle divider ──────────────────────────────────────────────────────────

export function Divider({ className = '' }: { className?: string }) {
  return <div className={`h-px bg-border/60 ${className}`} />
}

// ─── Sheet backdrop + container ─────────────────────────────────────────────

import { AnimatePresence } from 'framer-motion'
import { DESKTOP_QUERY, SHEET_SPRING, SHEET_BACKDROP, SHEET_EXIT } from '@/lib/motion'
import { sheetDrag } from '@/lib/sheetDrag'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { PopupOpen } from '@/hooks/usePopupOpen'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'
import { useBackLayer } from '@/lib/backLayers'

interface SheetProps {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  /** "half" for payment detail; "full" for progress / passcode */
  height?: 'half' | 'full'
  /** Unique per sheet, for drag-to-close bookkeeping. */
  id?: string
}

// One bottom sheet for the whole business UI - the same motion, backdrop,
// corner radius, handle and drag-to-close as the app's ActionSheet, so a
// business sheet opens and lands exactly like every other sheet in the app
// (shared tween, not the old spring bounce). On desktop it's the app's centred
// dialog, like ActionSheet and every other sheet there.
export function Sheet({ open, onClose, children, height = 'half', id = 'biz-sheet' }: SheetProps) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY)
  // Phone / browser Back closes it, like a tap on the dim.
  useBackLayer(open, onClose)
  if (isDesktop) {
    return (
      <AnimatePresence>
        {open && (
          <DesktopDialogFrame key={id} onClose={onClose} maxWidth={440}>
            <div className="flex flex-col" style={{ maxHeight: 'min(86dvh, 760px)', minHeight: height === 'full' ? 'min(80dvh, 720px)' : undefined }}>{children}</div>
          </DesktopDialogFrame>
        )}
      </AnimatePresence>
    )
  }
  return (
    <>
    {open && <PopupOpen />}
    <AnimatePresence>
      {open && [
        <motion.div key={id + '-dim'} transition={SHEET_BACKDROP.transition}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 bg-black/70" onClick={onClose} />,
        <motion.div key={id} {...sheetDrag(id, onClose)}
          initial={{ y: '100%' }} animate={{ y: 0 }} exit={SHEET_EXIT} transition={SHEET_SPRING}
          role="dialog" aria-modal="true"
          className={`fixed bottom-0 left-0 right-0 z-50 mx-auto max-w-md bg-surface border-t border-border rounded-t-3xl flex flex-col${height === 'full' ? ' h-[92dvh]' : ''}`}
          style={{ maxHeight: 'calc(100% - 40px)' }}>
          <div data-sheet-handle className="flex justify-center pt-2.5 pb-1 flex-shrink-0">
            <div style={{ width: 38, height: 5, borderRadius: 3, background: 'var(--border)' }} />
          </div>
          {children}
        </motion.div>,
      ]}
    </AnimatePresence>
    </>
  )
}

// ─── Primary action button ───────────────────────────────────────────────────

export function PrimaryBtn({
  children,
  onClick,
  disabled = false,
  className = '',
  type = 'button',
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  className?: string
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`w-full rounded-2xl py-4 text-sm font-semibold text-white bg-brand hover:bg-brand/90 active:scale-[0.98] transition-all disabled:opacity-40 disabled:cursor-not-allowed ${className}`}
    >
      {children}
    </button>
  )
}

// ─── Ghost / outline button ──────────────────────────────────────────────────

export function GhostBtn({
  children,
  onClick,
  disabled = false,
  className = '',
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`w-full rounded-2xl py-3.5 text-sm font-medium text-text-secondary border border-border hover:border-text-muted active:scale-[0.98] transition-all disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  )
}
