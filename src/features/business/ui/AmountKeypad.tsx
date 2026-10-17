/**
 * AmountKeypad — large amount display + underline note input + 3×4 keypad.
 * Parent owns the value string; this component fires onKey per keystroke.
 */
import React from 'react'
import { motion } from 'framer-motion'
import { Delete } from 'lucide-react'
import { springs } from './types'

export type KeypadKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '.' | 'del'

export interface AmountKeypadProps {
  value: string            // raw string like "12.5" — parent formats for display
  onKey: (k: KeypadKey) => void
  note: string
  onNote: (v: string) => void
}

const KEYS: (KeypadKey | '')[] = [
  '1','2','3',
  '4','5','6',
  '7','8','9',
  '.','0','del',
]

// Format a raw string as $X,XXX.XX for display
function formatDisplay(raw: string): string {
  if (!raw || raw === '0') return '$0'
  const [int, dec] = raw.split('.')
  const intFormatted = parseInt(int || '0', 10).toLocaleString('en-US')
  return dec !== undefined ? `$${intFormatted}.${dec}` : `$${intFormatted}`
}

export function AmountKeypad({ value, onKey, note, onNote }: AmountKeypadProps) {
  const display = formatDisplay(value)

  return (
    <div className="flex flex-col items-center gap-6 px-5 pt-6">
      {/* Amount display */}
      <motion.p
        key={display}
        initial={{ opacity: 0.6, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.14, ease: 'easeOut' }}
        className="display text-5xl font-bold tabular-nums text-text-primary text-center tracking-tight"
        aria-live="polite"
        aria-label={`Amount: ${display}`}
      >
        {display}
      </motion.p>

      {/* Note / memo */}
      <div className="w-full max-w-[280px]">
        <input
          type="text"
          value={note}
          onChange={(e) => onNote(e.target.value)}
          placeholder="Add a note (optional)"
          maxLength={60}
          className="w-full bg-transparent text-sm text-center text-text-secondary placeholder:text-text-muted border-b border-border pb-1.5 outline-none focus:border-brand-text transition-colors"
          aria-label="Payment note"
        />
      </div>

      {/* Keypad */}
      <div className="grid grid-cols-3 gap-2.5 w-full max-w-[320px]">
        {KEYS.map((key, i) => {
          if (key === '') return <div key={i} />
          const isDel = key === 'del'
          return (
            <motion.button
              key={key}
              type="button"
              aria-label={isDel ? 'Delete digit' : key === '.' ? 'Decimal point' : key}
              onClick={() => onKey(key)}
              whileTap={{ scale: 0.93 }}
              transition={springs.snappy}
              // Same keys as the app's amount keypad (Pay, Swap…).
              className={`flex items-center justify-center rounded-[14px] h-14 font-semibold select-none bg-surface border border-border ${
                isDel ? 'text-text-secondary' : key === '.' ? 'text-[28px] text-text-primary' : 'text-2xl text-text-primary'
              }`}
            >
              {isDel ? <Delete className="size-5" /> : key}
            </motion.button>
          )
        })}
      </div>
    </div>
  )
}
