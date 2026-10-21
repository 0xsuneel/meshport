/**
 * VoiceSheet — configure voice payment alerts.
 * Toggle on/off, test the voice, close. English only.
 */
import React from 'react'
import { X, Mic, Volume2 } from 'lucide-react'
import { motion } from 'framer-motion'
import { Sheet, PrimaryBtn, Divider } from './primitives'
import { springs } from './types'

export interface VoiceSheetProps {
  open: boolean
  enabled: boolean
  onToggle: () => void
  onTest: () => void
  onClose: () => void
}

export function VoiceSheet({
  open,
  enabled,
  onToggle,
  onTest,
  onClose,
}: VoiceSheetProps) {
  return (
    <Sheet open={open} onClose={onClose}>
      <div className="flex flex-col px-5 pb-8 pt-2">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <p className="text-base font-semibold text-text-primary">Voice alerts</p>
          <button
            type="button"
            aria-label="Close voice settings"
            onClick={onClose}
            className="size-9 flex items-center justify-center rounded-xl text-text-muted hover:bg-border/40 transition-colors"
          >
            <X className="size-4.5" />
          </button>
        </div>

        {/* Icon + description */}
        <div className="flex flex-col items-center text-center py-4">
          <span
            className={`inline-flex items-center justify-center size-16 rounded-3xl mb-3 ${
              enabled ? 'bg-brand/15' : 'bg-border/40'
            }`}
          >
            <Mic className={`size-7 ${enabled ? 'text-brand-text' : 'text-text-muted'}`} />
          </span>
          <p className="text-sm font-medium text-text-primary">
            {enabled ? 'Voice alerts are on' : 'Voice alerts are off'}
          </p>
          <p className="text-xs text-text-muted mt-1 text-pretty max-w-[240px]">
            Hear a spoken confirmation every time a payment arrives — great for busy counters.
          </p>
        </div>

        <Divider className="my-3" />

        {/* Toggle row */}
        <div className="flex items-center justify-between py-3">
          <div>
            <p className="text-sm font-medium text-text-primary">Enable voice alerts</p>
            <p className="text-xs text-text-muted mt-0.5">Plays on payment received</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Toggle voice alerts"
            onClick={onToggle}
            className={`relative inline-flex items-center h-7 w-12 rounded-full transition-colors shrink-0 ${
              enabled ? 'bg-brand' : 'bg-border'
            }`}
          >
            <motion.span
              className="absolute size-5 rounded-full bg-white shadow"
              animate={{ x: enabled ? 22 : 3 }}
              transition={springs.snappy}
            />
          </button>
        </div>

        <Divider className="mb-5" />

        {/* Test button */}
        <button
          type="button"
          onClick={onTest}
          disabled={!enabled}
          className="w-full flex items-center justify-center gap-2 rounded-2xl py-3.5 border border-border text-sm font-medium text-text-secondary hover:border-text-muted active:scale-[0.98] transition-all disabled:opacity-40 disabled:cursor-not-allowed mb-3"
        >
          <Volume2 className="size-4" />
          Test voice — &ldquo;Received 24 dollars&rdquo;
        </button>

        <PrimaryBtn onClick={onClose}>Done</PrimaryBtn>
      </div>
    </Sheet>
  )
}
