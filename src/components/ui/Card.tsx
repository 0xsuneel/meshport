import { cn } from '@/lib/utils'
import { type ReactNode, type KeyboardEvent } from 'react'

interface CardProps {
  children: ReactNode
  className?: string
  onClick?: () => void
  /** Accessible name when the card is tappable and its text isn't enough. */
  'aria-label'?: string
}

// A resting card: the soft UI edge and lift (.soft-card in index.css) -
// one faint edge and one soft shadow, never a hard border.
// Tappable (onClick): presses in like every other card (.mp-press), and is a
// real button for the keyboard and screen readers (Tab, Enter / Space).
export function Card({ children, className, onClick, 'aria-label': ariaLabel }: CardProps) {
  const onKeyDown = onClick ? (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() }
  } : undefined
  return (
    <div
      onClick={onClick}
      onKeyDown={onKeyDown}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={ariaLabel}
      className={cn(
        'rounded-3xl bg-card soft-card',
        onClick && 'cursor-pointer mp-press',
        className
      )}
    >
      {children}
    </div>
  )
}
