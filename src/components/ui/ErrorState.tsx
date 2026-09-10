import { motion } from 'framer-motion'
import { AlertCircle, RotateCw } from 'lucide-react'
import { Button } from './Button'

interface ErrorStateProps {
  title?: string
  description?: string
  onRetry?: () => void
  retryLabel?: string
}

/** Shared friendly error layout with an explanation and a retry action. */
export function ErrorState({
  title = 'Something went wrong',
  description = 'Please try again in a moment.',
  onRetry,
  retryLabel = 'Retry',
}: ErrorStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.24, ease: 'easeOut' }}
      className="flex flex-col items-center justify-center text-center px-8 py-16"
    >
      <div className="w-16 h-16 rounded-full flex items-center justify-center mb-5"
        style={{ background: 'color-mix(in srgb, var(--danger) 12%, transparent)' }}>
        <AlertCircle className="w-7 h-7 text-danger" />
      </div>
      <h3 className="text-base font-bold text-text-primary mb-1.5">{title}</h3>
      <p className="text-sm text-text-secondary leading-relaxed max-w-[280px]">{description}</p>
      {onRetry && (
        <div className="mt-6 w-full max-w-[220px]">
          <Button variant="secondary" fullWidth onClick={onRetry}>
            <RotateCw className="w-4 h-4" />
            {retryLabel}
          </Button>
        </div>
      )}
    </motion.div>
  )
}
