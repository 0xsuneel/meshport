/**
 * Shared micro-components used across the business UI kit.
 * Pure presentational — no state, no fetching.
 */
import React from 'react'

// ─── Skeleton shimmer ────────────────────────────────────────────────────────

export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={`mp-pulse rounded-xl bg-border/40 ${className}`}
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
    <img decoding="async"
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
      className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-brand text-white text-[11px] font-bold tabular-nums ${className}`}
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
      className={`inline-flex items-center justify-center size-11 rounded-2xl text-text-secondary hover:bg-border/30 active:scale-95 transition ${className}`}
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

import { ActionSheet } from '@/components/ui/ActionSheet'

interface SheetProps {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  /** "half" for payment detail; "full" for progress / passcode */
  height?: 'half' | 'full'
  /** Unique per sheet, for drag-to-close bookkeeping (generated when left out). */
  id?: string
}

// The business UI's bottom sheet is the app's one sheet (ActionSheet): the
// same motion, dim, corner radius, handle, drag-to-close and Back as every
// other sheet; a centred dialog on desktop.
export function Sheet({ open, onClose, children, height = 'half', id }: SheetProps) {
  return <ActionSheet open={open} onClose={onClose} id={id} fixed height={height === 'full' ? 'full' : 'auto'}>{children}</ActionSheet>
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
      className={`w-full rounded-2xl py-4 text-sm font-semibold text-white bg-brand hover:bg-brand/90 active:scale-[0.98] transition disabled:opacity-40 disabled:cursor-not-allowed ${className}`}
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
      className={`w-full rounded-2xl py-3.5 text-sm font-medium text-text-secondary border border-border hover:border-text-muted active:scale-[0.98] transition disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  )
}
