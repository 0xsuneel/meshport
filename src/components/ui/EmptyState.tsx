import { motion } from 'framer-motion'
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
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: 'easeOut' }}
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
    </motion.div>
  )
}
