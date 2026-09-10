/**
 * PasscodeInput — unified 6-digit passcode input
 * Used across: Send, Swap, Chat, Contacts, Claim, Bulk Pay, Profile
 */
import { forwardRef, useEffect, useRef } from 'react'

interface PasscodeInputProps {
  value: string
  onChange: (val: string) => void
  onEnter?: () => void
  error?: string
  placeholder?: string
  autoFocus?: boolean
}

export const PasscodeInput = forwardRef<HTMLInputElement, PasscodeInputProps>(
  ({ value, onChange, onEnter, error, placeholder = 'Enter passcode', autoFocus }, forwardedRef) => {
    const localRef = useRef<HTMLInputElement>(null)

    // Use forwarded ref if provided, otherwise use local ref
    const inputRef = (forwardedRef ?? localRef) as React.RefObject<HTMLInputElement>

    // Android fallback: programmatic focus after animation settles
    // iOS: autoFocus attribute on the input handles it natively
    useEffect(() => {
      if (!autoFocus) return
      const t = setTimeout(() => {
        try { inputRef.current?.focus() } catch {}
      }, 200)
      return () => clearTimeout(t)
    }, []) // empty deps — only run on mount

    return (
      <div className="space-y-2">
        <input
          ref={inputRef}
          type="password"
          inputMode="numeric"
          maxLength={6}
          placeholder={placeholder}
          value={value}
          autoFocus={autoFocus}
          autoComplete="one-time-code"
          onChange={e => onChange(e.target.value.replace(/\D/g, ''))}
          onKeyDown={e => e.key === 'Enter' && value.length === 6 && onEnter?.()}
          className="w-full rounded-2xl px-4 py-3.5 text-text-primary text-center text-xl font-bold focus:outline-none placeholder-text-secondary transition-all"
          style={{
            background: 'var(--surface)',
            border: error
              ? '1.5px solid rgba(239,68,68,0.6)'
              : '1.5px solid var(--border)',
            letterSpacing: value ? '0.45em' : undefined,
            boxShadow: error
              ? '0 0 0 3px rgba(239,68,68,0.08)'
              : value.length === 6
              ? '0 0 0 3px color-mix(in srgb, var(--brand) 16%, transparent)'
              : 'none',
          }}
        />
        {error && (
          <p className="text-xs text-danger text-center font-medium">{error}</p>
        )}
      </div>
    )
  }
)

PasscodeInput.displayName = 'PasscodeInput'
