import { cn } from '@/lib/utils'
import { type ReactNode } from 'react'

interface CardProps {
  children: ReactNode
  className?: string
  onClick?: () => void
  glass?: boolean
}

export function Card({ children, className, onClick, glass }: CardProps) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'rounded-3xl transition-shadow duration-180',
        glass
          ? 'backdrop-blur-xl bg-surface/60 border border-border'
          : 'bg-card border border-border',
        'shadow-elevation-1',
        onClick && 'cursor-pointer active:scale-[0.98] hover:shadow-elevation-2 transition-transform',
        className
      )}
    >
      {children}
    </div>
  )
}
