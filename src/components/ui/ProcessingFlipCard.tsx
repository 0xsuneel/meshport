// components/ui/ProcessingFlipCard.tsx
//
// Shared "processing → flip → result" modal for P2P actions that move
// money or state on-chain (create offer, top up escrow, release, cancel).
// Front face shows a spinner while the action is in flight; once it
// resolves, the card does a 3D flip to reveal a success/error face with
// the actual message — never a silent toast for something this
// consequential. useProcessingFlip() below is the state/driver half;
// ProcessingFlipCard is the pure render half. Kept in one file since
// neither is useful without the other.

import { useCallback, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Loader2, CheckCircle2, XCircle } from 'lucide-react'

export type FlipPhase = 'processing' | 'success' | 'error'

export interface FlipState {
  open: boolean
  phase: FlipPhase
  processingLabel: string
  title: string
  message: string
}

const INITIAL_STATE: FlipState = { open: false, phase: 'processing', processingLabel: '', title: '', message: '' }

/**
 * Drives a ProcessingFlipCard through one action. Usage:
 *   const { flipState, runFlip, dismissFlip } = useProcessingFlip()
 *   await runFlip('Creating offer…', () => createOfferAndReturnResult(), { successTitle: 'Offer Created' })
 *   <ProcessingFlipCard {...flipState} onDismiss={dismissFlip} />
 *
 * `action` must resolve to { success, message } — matches the shape every
 * p2pService.ts action already returns, so call sites rarely need to
 * reshape anything.
 */
export function useProcessingFlip() {
  const [flipState, setFlipState] = useState<FlipState>(INITIAL_STATE)

  const runFlip = useCallback(async <T extends { success: boolean; message: string }>(
    processingLabel: string,
    action: () => Promise<T>,
    opts?: { successTitle?: string; errorTitle?: string },
  ): Promise<T> => {
    setFlipState({ open: true, phase: 'processing', processingLabel, title: '', message: '' })
    try {
      const result = await action()
      setFlipState({
        open: true,
        phase: result.success ? 'success' : 'error',
        processingLabel,
        title: result.success ? (opts?.successTitle ?? 'Done') : (opts?.errorTitle ?? 'Something Went Wrong'),
        message: result.message,
      })
      return result
    } catch (e: any) {
      const message = e?.message || 'Please check your connection and try again.'
      setFlipState({ open: true, phase: 'error', processingLabel, title: opts?.errorTitle ?? 'Something Went Wrong', message })
      return { success: false, message } as T
    }
  }, [])

  const dismissFlip = useCallback(() => {
    setFlipState(s => (s.phase === 'processing' ? s : { ...s, open: false }))
  }, [])

  return { flipState, runFlip, dismissFlip }
}

export function ProcessingFlipCard({ open, phase, processingLabel, title, message, onDismiss }: FlipState & { onDismiss: () => void }) {
  const resultColor = phase === 'success' ? 'var(--success)' : 'var(--danger)'
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={phase !== 'processing' ? onDismiss : undefined}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 300,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}
        >
          <div style={{ perspective: 1200 }} onClick={e => e.stopPropagation()}>
            <motion.div
              animate={{ rotateY: phase === 'processing' ? 0 : 180 }}
              transition={{ duration: 0.55, ease: 'easeInOut' }}
              style={{ position: 'relative', width: 280, minHeight: 200, transformStyle: 'preserve-3d' }}
            >
              {/* Front face — processing */}
              <div style={{
                position: 'absolute', inset: 0, backfaceVisibility: 'hidden',
                background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 20,
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: 16, padding: 28, boxShadow: '0 20px 50px rgba(0,0,0,0.35)',
              }}>
                <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.9, ease: 'linear' }}>
                  <Loader2 size={34} color="var(--brand)" />
                </motion.div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', textAlign: 'center' }}>{processingLabel}</div>
              </div>

              {/* Back face — result */}
              <div style={{
                position: 'absolute', inset: 0, backfaceVisibility: 'hidden', transform: 'rotateY(180deg)',
                background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 20,
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: 12, padding: 28, textAlign: 'center', boxShadow: '0 20px 50px rgba(0,0,0,0.35)',
              }}>
                {phase === 'success'
                  ? <CheckCircle2 size={42} color={resultColor} />
                  : <XCircle size={42} color={resultColor} />}
                <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)' }}>{title}</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.4 }}>{message}</div>
                <button
                  onClick={onDismiss}
                  style={{
                    marginTop: 6, padding: '10px 26px', borderRadius: 12, border: 'none',
                    background: resultColor, color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer',
                  }}
                >
                  Done
                </button>
              </div>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
