import type { ReactNode } from 'react'
import { Button } from './Button'

interface EmptyStateProps {
  icon: ReactNode
  title: string
  description?: string
  actionLabel?: string
  onAction?: () => void
}

/** Shared empty-state layout: icon, title, helper text, one primary action. */
export function EmptyState({ icon, title, description, actionLabel, onAction }: EmptyStateProps) {
  return (
    // No entrance of its own: it usually arrives inside a page or step that
    // is already sliding / fading in (a second fade+rise was a double animation).
    <div
      className="flex flex-col items-center justify-center text-center px-8 py-16"
    >
      <div className="w-16 h-16 rounded-full bg-surface border border-border flex items-center justify-center text-text-secondary mb-5">
        {icon}
      </div>
      <h3 className="text-base font-bold text-text-primary mb-1.5">{title}</h3>
      {description && (
        <p className="text-sm text-text-secondary leading-relaxed max-w-[280px]">{description}</p>
      )}
      {actionLabel && onAction && (
        <div className="mt-6 w-full max-w-[220px]">
          <Button variant="primary" fullWidth onClick={onAction}>{actionLabel}</Button>
        </div>
      )}
    </div>
  )
}
