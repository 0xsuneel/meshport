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

// ─── Fade-up entrance ────────────────────────────────────────────────────────

export function FadeUp({
  children,
  delay = 0,
  className = '',
}: {
  children: React.ReactNode
  delay?: number
  className?: string
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1], delay }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

// ─── Sheet backdrop + container ─────────────────────────────────────────────

import { AnimatePresence } from 'framer-motion'
import { springs } from './types'

interface SheetProps {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  /** "half" for payment detail; "full" for progress / passcode */
  height?: 'half' | 'full'
}

export function Sheet({ open, onClose, children, height = 'half' }: SheetProps) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={onClose}
        >
          {/* backdrop */}
          <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" />
          <motion.section
            className={`relative w-full max-w-md overflow-hidden rounded-t-[28px] bg-surface shadow-2xl ${
              height === 'full' ? 'h-[92dvh] flex flex-col' : ''
            }`}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={springs.sheet}
            onClick={(e) => e.stopPropagation()}
          >
            {/* drag handle */}
            <div className="flex justify-center pt-3 pb-1 shrink-0">
              <div className="h-[4px] w-10 rounded-full bg-border" />
            </div>
            {children}
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
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
