// components/multichain/MoveProgress.tsx
//
// The one progress page for a Multichain move (Transfer or Bring, CCTP or
// Unified Balance) - from the moment it's confirmed until it lands. Used by
// the live flows (MultichainTransferPage, MultichainClaimPage) and by Hub
// Activity when a running move is tapped (TrackedMove), so it looks and reads
// the same wherever it's opened, on a phone or in the desktop right panel.
//
// Track Progress doesn't open another screen: it stays here, folds the
// amount card and the finished steps away, and highlights the step in
// progress. Callers show their success screen once `current` reaches the
// end (all steps done).

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Check, X } from 'lucide-react'
import { MeshLoader } from '@/components/ui/MeshLoader'
import { TrackDetails, type TrackDetailRow } from './TrackDetails'
import { formatAmount } from '@/lib/utils'
import { chainLogoByName } from '@/lib/chainLogos'
import type { MoveKind, MoveRoute, MoveStepText } from '@/lib/moveSteps'

export interface MoveTx { hash: string; href?: string | null }

/** A chain's logo for the route row; an empty slot of the same size when unknown, so the text stays centred. */
function RouteLogo({ name }: { name: string }) {
  const [ok, setOk] = useState(true)
  const src = chainLogoByName(name)
  return src && ok
    ? <img decoding="async" src={src} alt="" aria-hidden width={30} height={30} onError={() => setOk(false)} style={{ flexShrink: 0, display: 'block' }} />
    : <span aria-hidden style={{ width: 30, height: 30, flexShrink: 0 }} />
}

export function MoveProgress({
  kind, route, fromLabel, toLabel, amount, steps, current, failed, safe, activeElapsed, txs, notes,
  holdText, onViewHub, onBack, backIcon = 'back', loading = false, details, trackButton = true, timeSteps = false,
}: {
  kind: MoveKind; route: MoveRoute
  fromLabel: string; toLabel: string
  amount: number
  steps: MoveStepText[]
  /** Index of the step in progress; steps.length when all are done. */
  current: number
  /** Why the step in progress failed - marks it red. */
  failed?: string | null
  /** The server or Circle finishes it from here: say so and offer the Hub. */
  safe: boolean
  /** Seconds the step in progress has been running (a live timer). */
  activeElapsed?: number
  /** No activeElapsed from the caller: time the step in progress here, from
   *  when it became the current step on this screen. */
  timeSteps?: boolean
  /** Per step: the transaction it produced, shown once it's done. */
  txs?: Array<MoveTx | undefined>
  /** Extra lines under the checklist (e.g. "taking longer than usual"). */
  notes?: ReactNode
  /** Shown while the page has to stay open. */
  holdText?: string
  onViewHub?: () => void
  onBack?: () => void
  backIcon?: 'back' | 'close'
  /** Status not known yet: keep every step neutral instead of guessing. */
  loading?: boolean
  details?: TrackDetailRow[]
  /** Offer Track Progress (the live flow). Off when the page itself is the tracker (opened from Hub Activity). */
  trackButton?: boolean
}) {
  const [focus, setFocus] = useState(false)
  const [showDone, setShowDone] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const n = steps.length
  const at = Math.min(Math.max(current, 0), n)
  const running = at < n
  const errored = !!failed && running
  const title = kind === 'transfer'
    ? (safe && running ? 'Transfer submitted' : 'Transferring')
    : (safe && running ? 'Bring submitted' : 'Bringing funds')
  const pct = loading ? 0 : Math.round((at / n) * 100)
  const activeStep = running ? steps[at] : null
  const statusLine = loading ? 'Checking progress…'
    : errored ? failed!
    : activeStep ? activeStep.active : 'Finishing…'
  const folded = focus && !showDone

  // Own step timer (timeSteps): restarts whenever the step in progress changes.
  const stepStartRef = useRef<{ at: number; since: number } | null>(null)
  const [, setTick] = useState(0)
  const ownTimer = timeSteps && activeElapsed == null && running && !errored && !loading
  if (ownTimer && stepStartRef.current?.at !== at) stepStartRef.current = { at, since: Date.now() }
  useEffect(() => {
    if (!ownTimer) return
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [ownTimer])
  const elapsed = activeElapsed ?? (ownTimer && stepStartRef.current ? Math.floor((Date.now() - stepStartRef.current.since) / 1000) : undefined)

  const toggleFocus = () => {
    setFocus(f => !f)
    setShowDone(false)
    requestAnimationFrame(() => listRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
  }

  const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 22, padding: 16 } as const

  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px' }}>
        {onBack && (
          <button onClick={onBack} aria-label={backIcon === 'close' ? 'Close' : 'Back'} className="back-btn" style={{ flexShrink: 0 }}>
            {backIcon === 'close' ? <X className="w-5 h-5 text-text-primary" /> : <ArrowLeft className="w-5 h-5 text-text-primary" />}
          </button>
        )}
        <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, padding: '5px 10px', borderRadius: 999, background: 'color-mix(in srgb, var(--brand) 18%, transparent)', color: 'var(--accent-text)', whiteSpace: 'nowrap' }}>
          {route === 'ub' ? 'Unified Balance' : 'CCTP'}
        </span>
      </div>

      {!focus && (
        <div style={{ ...card, textAlign: 'center' }}>
          <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.5px', color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{formatAmount(amount)} USDC</div>
          {/* Route: from-chain logo at the left edge, "From – To" in the middle,
              to-chain logo at the right edge. Plain logos, no backdrop. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
            <RouteLogo name={fromLabel} />
            <div style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {fromLabel} <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>–</span> {toLabel}
            </div>
            <RouteLogo name={toLabel} />
          </div>
          <div style={{ maxWidth: 200, height: 6, borderRadius: 4, background: 'var(--border)', overflow: 'hidden', margin: '14px auto 0' }}>
            <div style={{ width: `${Math.max(pct, loading ? 0 : 6)}%`, height: '100%', background: errored ? 'var(--danger)' : 'var(--brand)', transition: 'width .4s' }} />
          </div>
          <p role="status" style={{ fontSize: 14, fontWeight: 600, margin: '10px 0 0', color: errored ? 'var(--danger-text)' : 'var(--text-primary)', overflowWrap: 'anywhere' }}>{statusLine}</p>
          {activeStep && !errored && !loading && (
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '3px 0 0' }}>Usually {activeStep.eta}</p>
          )}
        </div>
      )}

      <div ref={listRef} style={{ ...card, padding: '14px 16px', scrollMarginTop: 12 }}>
        <p style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', margin: '0 0 12px' }}>
          <span>{focus ? 'Remaining steps' : 'Progress'}</span>
          {!loading && <span style={{ textTransform: 'none', letterSpacing: 0 }}>{at} of {n} done</span>}
        </p>
        {folded && at > 0 && (
          <button onClick={() => setShowDone(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 12px', marginBottom: 12, borderRadius: 12, border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--text-primary) 3%, transparent)', cursor: 'pointer', textAlign: 'left', fontSize: 13, fontWeight: 600 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--success-text)', whiteSpace: 'nowrap', flexShrink: 0 }}><Check size={14} strokeWidth={2.5} aria-hidden /> {at} done</span>
            <span style={{ marginLeft: 'auto', color: 'var(--text-secondary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{steps[at - 1].done} · Show</span>
          </button>
        )}
        {steps.map((s, i) => {
          if (folded && i < at) return null
          const done = !loading && i < at
          const active = !loading && i === at && !errored
          const bad = !loading && i === at && errored
          const tx = done ? txs?.[i] : undefined
          // The amount card already says what's happening now, how long it
          // usually takes and what failed - the running step only repeats
          // that while the card is folded away (Track Progress).
          const text = done ? s.done : active ? (focus ? s.active : '') : bad ? (focus ? failed! : 'Didn’t finish') : s.upcoming
          const isLast = i === n - 1
          return (
            <div key={s.label} style={{ display: 'flex', gap: 12 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                <span style={{
                  width: 24, height: 24, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)',
                  border: `1.5px solid ${done ? 'var(--success)' : bad ? 'var(--danger)' : active ? 'var(--brand)' : 'var(--border)'}`,
                  background: done ? 'color-mix(in srgb, var(--success) 15%, transparent)' : bad ? 'color-mix(in srgb, var(--danger) 15%, transparent)' : active ? 'color-mix(in srgb, var(--brand) 15%, transparent)' : 'transparent',
                }}>
                  {done ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                  ) : bad ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  ) : active ? <MeshLoader size={15} label="In progress" /> : i + 1}
                </span>
                {!isLast && <div style={{ width: 1.5, flex: 1, minHeight: 16, margin: '2px 0', background: done ? 'var(--success)' : 'var(--border)' }} />}
              </div>
              <div style={{
                flex: 1, minWidth: 0, paddingBottom: isLast ? 0 : 14,
                ...(focus && active ? { background: 'color-mix(in srgb, var(--brand) 8%, transparent)', borderRadius: 12, padding: '8px 10px 10px', marginBottom: isLast ? 0 : 10 } : {}),
              }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: done ? 'var(--success-text)' : bad ? 'var(--danger-text)' : active ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{s.label}</span>
                  {active && (
                    <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: 'var(--accent-text)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                      {elapsed != null && elapsed > 0 ? `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}` : focus ? s.eta : ''}
                    </span>
                  )}
                </div>
                {text && <p style={{ fontSize: 13, lineHeight: 1.4, margin: '2px 0 0', color: bad ? 'var(--danger-text)' : 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{text}</p>}
                {tx && (tx.href
                  ? <a href={tx.href} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-block', marginTop: 3, fontSize: 12, fontFamily: 'monospace', color: 'var(--accent-text)', textDecoration: 'none' }}>{tx.hash.slice(0, 10)}…{tx.hash.slice(-6)} ↗</a>
                  : <span style={{ display: 'inline-block', marginTop: 3, fontSize: 12, fontFamily: 'monospace', color: 'var(--text-secondary)' }}>{tx.hash.slice(0, 10)}…{tx.hash.slice(-6)}</span>)}
              </div>
            </div>
          )
        })}
        {notes}
      </div>

      {safe && running && !errored && (
        <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--accent-text)', padding: '10px 12px', borderRadius: 14, background: 'color-mix(in srgb, var(--brand) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--brand) 30%, transparent)' }}>
          Safe to leave – {kind === 'transfer' ? 'Circle and MeshPort finish this transfer' : 'MeshPort finishes this on its servers'}. It stays in Hub Activity, and tapping it opens this page again.
        </div>
      )}

      {details && details.length > 0 && <TrackDetails rows={details} />}

      <div style={{ flex: 1 }} />

      <div style={{
        position: 'sticky', bottom: 0, margin: '0 -12px -12px', padding: '12px 16px calc(env(safe-area-inset-bottom, 0px) + 16px)',
        background: 'var(--bg)', borderTop: '1px solid var(--border)', display: 'flex', gap: 10,
      }}>
        {safe || !running ? (
          <>
            {onViewHub && (
              <button onClick={onViewHub}
                style={{ flex: 1, minWidth: 0, padding: 14, borderRadius: 999, border: '1.5px solid var(--brand)', background: 'transparent', fontSize: 15, fontWeight: 700, color: 'var(--accent-text)', cursor: 'pointer' }}>
                View in Hub
              </button>
            )}
            {running && trackButton && (
              <button onClick={toggleFocus} aria-pressed={focus}
                style={{ flex: 1, minWidth: 0, padding: 14, borderRadius: 999, border: 'none', background: 'var(--brand)', fontSize: 15, fontWeight: 700, color: '#fff', cursor: 'pointer' }}>
                {focus ? 'Show all' : 'Track Progress'}
              </button>
            )}
          </>
        ) : (
          <p style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center', margin: 0 }}>
            {holdText ?? `Keep this screen open until the ${kind} ${safe ? 'is submitted' : 'finishes'} – your funds are safe.`}
          </p>
        )}
      </div>
    </div>
  )
}
