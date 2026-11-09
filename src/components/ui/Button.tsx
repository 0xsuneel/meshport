import { cn } from '@/lib/utils'
import { type ReactNode, type ButtonHTMLAttributes } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
  size?: 'sm' | 'md' | 'lg'
  fullWidth?: boolean
  /** Working: spinner, taps ignored, but the button keeps its full colour
   *  (it is busy, not unavailable). */
  loading?: boolean
  children: ReactNode
}

const variants = {
  primary: 'bg-brand text-white shadow-elevation-2 hover:brightness-105 border border-black/10',
  secondary: 'bg-surface text-text-primary border border-border hover:bg-bg',
  ghost: 'bg-transparent hover:bg-text-primary/5 active:bg-text-primary/10 text-text-primary',
  danger: 'bg-danger text-white border border-black/10',
  outline: 'border border-border hover:bg-text-primary/5 active:bg-text-primary/10 text-text-primary',
}

const sizes = {
  sm: 'px-4 py-2.5 text-sm rounded-xl min-h-[40px]',
  md: 'px-6 py-3.5 text-base rounded-2xl min-h-[48px]',
  lg: 'px-8 py-4 text-lg rounded-2xl min-h-[56px]',
}

export function Button({
  variant = 'primary',
  size = 'md',
  fullWidth,
  loading,
  children,
  className,
  disabled,
  ...props
}: ButtonProps) {
  const inactive = disabled || loading
  return (
    <button
      className={cn(
        // Press: a quick shrink on touch-down, a softer release (the shared
        // --ease-out curve) - the same feel as .mp-press elsewhere.
        'font-semibold transition-[transform,filter,opacity,background-color,box-shadow] duration-150 ease-[cubic-bezier(0.32,0.72,0,1)] flex items-center justify-center gap-2 select-none',
        'active:scale-[0.97] active:duration-75 hover:scale-[1.01]',
        variants[variant],
        sizes[size],
        fullWidth && 'w-full',
        inactive && 'cursor-not-allowed active:scale-100 hover:scale-100',
        // Disabled reads as unavailable; loading stays solid (it's working).
        disabled && !loading && 'opacity-40 shadow-none',
        loading && 'cursor-progress',
        className
      )}
      disabled={inactive}
      aria-busy={loading || undefined}
      type="button"
      {...props}
    >
      {loading && (
        <svg className="animate-spin h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
      {children}
    </button>
  )
}
