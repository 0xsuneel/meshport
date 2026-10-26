/**
 * RequestForm primitives: Field, TextInput, ChipSelect.
 * Used to compose Payment Link, Send Bill, and Request screens.
 */
import React from 'react'
import type { ReactNode } from './types'

// ─── Field wrapper ───────────────────────────────────────────────────────────

export interface FieldProps {
  label: string
  hint?: string
  children: ReactNode
}

export function Field({ label, hint, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-semibold text-text-secondary">{label}</span>
        {hint && <span className="text-xs text-text-muted">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

// ─── TextInput ───────────────────────────────────────────────────────────────

export type TextInputProps = React.InputHTMLAttributes<HTMLInputElement>

export const TextInput = React.forwardRef<HTMLInputElement, TextInputProps>(
  function TextInput(props, ref) {
    const { className = '', ...rest } = props
    return (
      <input
        ref={ref}
        {...rest}
        className={`w-full rounded-2xl bg-surface border border-border px-4 py-3.5 text-sm ![font-size:max(var(--fs-field,0px),0.875rem)] text-text-primary placeholder:text-text-muted outline-none focus:border-brand-text transition-colors min-h-[52px] ${className}`}
      />
    )
  },
)

// ─── ChipSelect ──────────────────────────────────────────────────────────────

export interface ChipSelectOption {
  id: string
  label: string
}

export interface ChipSelectProps {
  options: ChipSelectOption[]
  value: string
  onChange: (id: string) => void
}

export function ChipSelect({ options, value, onChange }: ChipSelectProps) {
  return (
    <div className="flex flex-wrap gap-2" role="listbox" aria-label="Select option">
      {options.map((opt) => {
        const active = opt.id === value
        return (
          <button
            key={opt.id}
            type="button"
            role="option"
            aria-selected={active}
            onClick={() => onChange(opt.id)}
            className={`rounded-full px-4 py-2 text-xs font-semibold transition-colors min-h-[36px] ${
              active
                ? 'bg-brand text-white'
                : 'bg-surface border border-border text-text-secondary hover:border-text-muted'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
