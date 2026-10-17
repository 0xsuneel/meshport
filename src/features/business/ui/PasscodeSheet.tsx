/**
 * PasscodeSheet — 6-digit passcode entry with 3x4 keypad.
 * Dots fill as digits are entered; backspace and delete on last col.
 */
import React, { useState, useEffect } from 'react'
import { X, Delete } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sheet } from './primitives'
import { springs } from './types'

export interface PasscodeSheetProps {
  open: boolean
  title: string
  subtitle?: string
  error?: string
  onComplete: (code: string) => void
  onClose: () => void
}

const KEYS = ['1','2','3','4','5','6','7','8','9','','0','⌫']

export function PasscodeSheet({
  open,
  title,
  subtitle,
  error,
  onComplete,
  onClose,
}: PasscodeSheetProps) {
  const [digits, setDigits] = useState<string[]>([])

  // Reset when sheet opens
  useEffect(() => {
    if (open) setDigits([])
  }, [open])

  // Auto-submit when 6 digits entered
  useEffect(() => {
    if (digits.length === 6) {
      onComplete(digits.join(''))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digits])

  function press(key: string) {
    if (key === '⌫') {
      setDigits((d) => d.slice(0, -1))
    } else if (key !== '' && digits.length < 6) {
      setDigits((d) => [...d, key])
    }
  }

  return (
    <Sheet open={open} onClose={onClose}>
      <div className="flex flex-col items-center px-5 pb-8 pt-2">
        {/* Close */}
        <div className="w-full flex justify-end mb-2">
          <button
            type="button"
            aria-label="Close passcode"
            onClick={onClose}
            className="size-9 flex items-center justify-center rounded-xl text-text-muted hover:bg-border/40 transition-colors"
          >
            <X className="size-4.5" />
          </button>
        </div>

        {/* Title */}
        <p className="text-base font-semibold text-text-primary text-center">{title}</p>
        {subtitle && (
          <p className="mt-1 text-sm text-text-muted text-center text-pretty max-w-[260px]">{subtitle}</p>
        )}

        {/* Dots */}
        <div className="flex items-center justify-center gap-3 my-8">
          {Array.from({ length: 6 }).map((_, i) => {
            const filled = i < digits.length
            return (
              <motion.span
                key={i}
                animate={{
                  scale: filled ? 1.15 : 1,
                  backgroundColor: filled
                    ? error
                      ? 'var(--danger)'
                      : 'var(--brand-text)'
                    : 'var(--border)',
                }}
                transition={springs.snappy}
                className="size-3.5 rounded-full"
              />
            )
          })}
        </div>

        {/* Error */}
        <AnimatePresence>
          {error && (
            <motion.p
              key="err"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="text-xs text-danger mb-4 text-center"
            >
              {error}
            </motion.p>
          )}
        </AnimatePresence>

        {/* Keypad */}
        <div className="grid grid-cols-3 gap-3 w-full max-w-[280px]">
          {KEYS.map((key, i) => {
            if (key === '') return <div key={i} />

            const isBack = key === '⌫'
            return (
              <motion.button
                key={key}
                type="button"
                aria-label={isBack ? 'Backspace' : key}
                onClick={() => press(key)}
                whileTap={{ scale: 0.93 }}
                transition={springs.snappy}
                className={`flex items-center justify-center rounded-2xl min-h-[64px] text-xl font-semibold transition-colors select-none active:bg-border/60 ${
                  isBack
                    ? 'text-text-secondary hover:bg-border/30'
                    : 'bg-surface border border-border text-text-primary hover:bg-border/20'
                }`}
              >
                {isBack ? <Delete className="size-5" /> : key}
              </motion.button>
            )
          })}
        </div>
      </div>
    </Sheet>
  )
}
