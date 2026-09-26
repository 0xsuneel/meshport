/**
 * UbProgressTracker.tsx — Track Progress for a Unified Balance claim, same
 * look as the CCTP ClaimProgressTracker. Used by the Bring Funds claim screen
 * and by Hub Activity (tap a processing UB claim).
 */
import { motion } from 'framer-motion'

export type UbTrackerProgress = {
  stage: 'waiting' | 'gas' | 'approving' | 'burning' | 'attesting' | 'minting' | 'done' | 'error'
  msg?: string
  txHash?: string
}

// Track Progress for a Unified Balance claim — same look and step names as
// the CCTP ClaimProgressTracker (Bridging → Verifying → Settling →
// Completed), driven by the live UB stage instead of a claims row:
//   Bridging  = deposit into Unified Balance on the source chain
//   Verifying = Circle Gateway confirms the deposit (source finality)
//   Settling  = Gateway mints to the user's Arc wallet
//   Completed = arrived on Arc
export function UbProgressTracker({ progress, chainLabel }: { progress: UbTrackerProgress; chainLabel: string }) {
  const steps = [
    { label: 'Bridging',  subtitle: `Deposit confirmed on ${chainLabel}` },
    { label: 'Verifying', subtitle: 'Circle Gateway confirmed the deposit' },
    { label: 'Settling',  subtitle: 'Funds landing on Arc' },
    { label: 'Completed', subtitle: 'Balance updated' },
  ]
  const order: Record<string, number> = { waiting: 0, gas: 0, approving: 0, burning: 0, attesting: 1, minting: 2, done: 3 }
  const failed = progress.stage === 'error'
  const isComplete = progress.stage === 'done'
  const currentIdx = failed ? -1 : order[progress.stage] ?? 0
  const heldInUb = failed && !!progress.txHash

  return (
    <div style={{
      background: 'color-mix(in srgb, var(--text-primary) 3%, transparent)',
      border: '1px solid var(--border)', borderRadius: 16, padding: '18px 18px 18px 16px',
    }}>
      {steps.map((s, i) => {
        const stepDone = !failed && (i < currentIdx || (isComplete && i <= currentIdx))
        const active   = !failed && !stepDone && i === currentIdx
        const isLast   = i === steps.length - 1
        return (
          <div key={s.label} style={{ display: 'flex', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
              <div style={{
                position: 'relative', width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                background: stepDone ? 'color-mix(in srgb, var(--success) 15%, transparent)' : 'color-mix(in srgb, var(--text-primary) 4%, transparent)',
                border: stepDone ? '1.5px solid var(--success)' : active ? '1.5px solid var(--brand)' : '1.5px solid var(--border)',
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
                  <motion.svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'relative' }}>
                    <motion.polyline points="20 6 9 17 4 12" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.3 }} />
                  </motion.svg>
                ) : active ? (
                  <div style={{ position: 'relative', width: 7, height: 7, borderRadius: '50%', background: 'var(--brand)' }}/>
                ) : null}
              </div>
              {!isLast && (
                <div style={{ position: 'relative', width: 1.5, flex: 1, minHeight: 22, margin: '2px 0', background: 'var(--border)', overflow: 'hidden' }}>
                  <motion.div
                    initial={false}
                    animate={{ scaleY: stepDone ? 1 : 0 }}
                    transition={{ duration: 0.35, ease: 'easeOut' }}
                    style={{ position: 'absolute', inset: 0, background: 'var(--success)', transformOrigin: 'top' }}
                  />
                </div>
              )}
            </div>
            <div style={{ paddingBottom: isLast ? 0 : 18 }}>
              <p style={{ fontSize: 14, fontWeight: 500, margin: '0 0 2px', color: stepDone ? 'var(--success)' : active ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                {s.label}
              </p>
              <p style={{ fontSize: 12, margin: 0, color: stepDone || active ? 'var(--text-secondary)' : 'color-mix(in srgb, var(--text-secondary) 70%, transparent)' }}>
                {s.subtitle}
              </p>
            </div>
          </div>
        )
      })}

      {failed && (
        <p style={{ fontSize: 12, color: heldInUb ? 'var(--text-secondary)' : 'var(--danger)', margin: '12px 0 0', lineHeight: 1.45 }}>
          {heldInUb
            ? `Your USDC is safe in your Unified Balance on ${chainLabel}. It’s sent to Arc automatically, or finish it from Multichain Hub → Recover.`
            : (progress.msg || 'Claim failed. Please try again.')}
        </p>
      )}
    </div>
  )
}
