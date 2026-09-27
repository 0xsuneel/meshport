import { cn } from '@/lib/utils'
import { type ReactNode, type ButtonHTMLAttributes } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
  size?: 'sm' | 'md' | 'lg'
  fullWidth?: boolean
  loading?: boolean
  children: ReactNode
}

const variants = {
  primary: 'bg-brand text-white shadow-elevation-2 hover:brightness-105 border border-black/10',
  secondary: 'bg-surface text-text-primary border border-border hover:bg-bg',
  ghost: 'bg-transparent hover:bg-text-primary/5 active:bg-text-primary/10 text-text-primary',
  danger: 'bg-danger text-white shadow-elevation-1 border border-black/10',
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
  return (
    <button
      className={cn(
        'font-semibold transition-all duration-150 flex items-center justify-center gap-2 active:scale-[0.98] hover:scale-[1.01]',
        variants[variant],
        sizes[size],
        fullWidth && 'w-full',
        (disabled || loading) && 'opacity-40 cursor-not-allowed active:scale-100 hover:scale-100 shadow-none',
        className
      )}
      disabled={disabled || loading}
      type="button"
      {...props}
    >
      {loading && (
        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
      {children}
    </button>
  )
}
