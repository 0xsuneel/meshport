/**
 * ClaimProgressTracker.tsx
 *
 * Server-truth progress checklist for a single claim, shown on the "Track
 * Progress" screen (Submitted is confirmed on the screen before this one):
 *   ✓ Bridging → ✓ Verifying → ✓ Settling → ✓ Completed
 *
 * Driven entirely by Supabase Realtime (subscribeToClaim). No setInterval,
 * no polling — the claim-worker Edge Function updates the row server-side,
 * this component just reflects whatever the row currently says. Safe to
 * mount/unmount freely; processing continues either way.
 */
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { subscribeToClaim, CLAIM_STEPS, TRACK_PROGRESS_STEPS, type Claim } from '@/lib/claimService'

const COLORS = {
  surface: 'color-mix(in srgb, var(--text-primary) 3%, transparent)',
  primary: 'var(--brand)',
  success: 'var(--success)',
  error:   'var(--danger)',
  text:    'var(--text-primary)',
  muted:   'var(--text-secondary)',
  mutedDim:'color-mix(in srgb, var(--text-secondary) 70%, transparent)',
  border:  'var(--border)',
}

export function ClaimProgressTracker({ claimId, initialClaim }: { claimId: string; initialClaim?: Claim | null }) {
  // Starting from the real current status when the caller already has it
  // (e.g. MultichainClaimPage's Hub deep-link already fetched this exact
  // claim to decide whether to show 'tracking' or 'done') avoids defaulting
  // to the earliest step and then visibly jumping to wherever the claim
  // actually is once this component's own fetch resolves a moment later —
  // that default-then-jump was the flicker on opening this screen.
  const [claim, setClaim] = useState<Claim | null>(initialClaim ?? null)

  useEffect(() => {
    const unsubscribe = subscribeToClaim(claimId, setClaim)
    return unsubscribe
  }, [claimId])

  const status = claim?.status ?? 'submitted'
  const failed = status === 'failed'
  const currentIdx = failed ? -1 : CLAIM_STEPS.findIndex(s => s.key === status)
  const isComplete = status === 'completed'

  return (
    <div style={{
      background: COLORS.surface,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 16,
      padding: '18px 18px 18px 16px',
    }}>
      {TRACK_PROGRESS_STEPS.map((s, i) => {
        const idx = CLAIM_STEPS.findIndex(cs => cs.key === s.key)
        const stepDone = !failed && (idx < currentIdx || (isComplete && idx <= currentIdx))
        const active   = !failed && !stepDone && idx === currentIdx
        const isLast   = i === TRACK_PROGRESS_STEPS.length - 1

        return (
          <div key={s.key} style={{ display: 'flex', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
              <div style={{
                position: 'relative', width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                background: stepDone ? 'color-mix(in srgb, var(--success) 15%, transparent)' : 'color-mix(in srgb, var(--text-primary) 4%, transparent)',
                border: stepDone ? `1.5px solid ${COLORS.success}` : active ? `1.5px solid ${COLORS.primary}` : '1.5px solid var(--border)',
              }}>
                {active && (
                  <motion.div
                    initial={{ y: '100%' }}
                    animate={{ y: ['100%', '35%', '35%'] }}
                    transition={{ duration: 1.6, repeat: Infinity, times: [0, 0.6, 1], ease: 'easeInOut' }}
                    style={{ position: 'absolute', inset: 0, background: 'color-mix(in srgb, var(--brand) 30%, transparent)' }}
                  />
                )}
                {stepDone ? (
                  <motion.svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={COLORS.success} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'relative' }}>
                    <motion.polyline points="20 6 9 17 4 12" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.3 }} />
                  </motion.svg>
                ) : active ? (
                  <div style={{ position: 'relative', width: 7, height: 7, borderRadius: '50%', background: COLORS.primary }}/>
                ) : null}
              </div>
              {!isLast && (
                <div style={{ position: 'relative', width: 1.5, flex: 1, minHeight: 22, margin: '2px 0', background: 'var(--border)', overflow: 'hidden' }}>
                  <motion.div
                    initial={false}
                    animate={{ scaleY: stepDone ? 1 : 0 }}
                    transition={{ duration: 0.35, ease: 'easeOut' }}
                    style={{ position: 'absolute', inset: 0, background: COLORS.success, transformOrigin: 'top' }}
                  />
                </div>
              )}
            </div>

            <div style={{ paddingBottom: isLast ? 0 : 18 }}>
              <p style={{
                fontSize: 14, fontWeight: 500, margin: '0 0 2px',
                color: stepDone ? COLORS.success : active ? COLORS.text : COLORS.muted,
              }}>
                {s.label}
              </p>
              <p style={{ fontSize: 12, margin: 0, color: stepDone || active ? COLORS.muted : COLORS.mutedDim }}>
                {s.subtitle}
              </p>
            </div>
          </div>
        )
      })}

      {failed && (
        <p style={{ fontSize: 12, color: COLORS.error, margin: '12px 0 0' }}>
          {claim?.error ?? 'Claim failed. Please try again or contact support.'}
        </p>
      )}

      {/* Non-terminal diagnostics — claim-worker persists `error` (and bumps
          `last_error_at`) on transient hiccups well before it ever gives up
          and sets status:'failed', and separately flags `needs_review` once
          the >10min stuck-claim watchdog fires. Previously neither was ever
          read here, so a claim sitting on the same pulsing dot for 10+
          minutes gave zero indication anything was even being checked —
          indistinguishable from a claim that was quietly working as
          expected. This doesn't change what's happening server-side, it
          just stops hiding detail the server already computed. */}
      {!failed && !isComplete && claim?.needsReview && (
        <p style={{ fontSize: 12, color: COLORS.muted, margin: '12px 0 0' }}>
          This is taking longer than usual — our team has been notified and is
          keeping an eye on it. No action needed; it will keep retrying automatically.
        </p>
      )}
      {/* Removed: this used to show claim?.error directly (raw server text,
          including internal RPC URLs) — the needsReview message above
          already covers "this is taking a while" for the user, without
          leaking implementation detail that isn't meaningful to them. */}
    </div>
  )
}
