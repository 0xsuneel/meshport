import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { X } from 'lucide-react'
import { MeshLoader } from '@/components/ui/MeshLoader'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'
import { SHEET_PANEL, EASE_OUT } from '@/lib/motion'
import { usePopupOpen } from '@/hooks/usePopupOpen'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { chainLogoSrc } from '@/lib/chainLogos'
import { subscribeToClaim } from '@/lib/claimService'
import { formatAmount } from '@/lib/utils'
import type { ClaimAllStep } from '@/lib/ubClaim'

export type ClaimAllChain = { chainId: string; label: string; balance: number }

const CSS = `
@keyframes caOkIn{0%{transform:scale(0.9);opacity:0}70%{transform:scale(1.08)}100%{transform:scale(1)}}
@keyframes caDraw{from{stroke-dashoffset:60}to{stroke-dashoffset:0}}
@keyframes caTick{from{transform:scale(.4);opacity:0}to{transform:scale(1);opacity:1}}
.ca-ok{animation:caOkIn .45s var(--ease-out) both}
.ca-ok path{stroke-dasharray:60;stroke-dashoffset:60;animation:caDraw .45s .25s ease-out forwards}
.ca-tick{animation:caTick .25s ease-out both}
@media (prefers-reduced-motion: reduce){.ca-ok,.ca-ok path,.ca-tick{animation:none;stroke-dashoffset:0}}
`

// Claim status (claims row) → where the chain's money is now.
const CLAIM_STAGE: Record<string, string> = {
  submitted: 'Bridging', bridging: 'Verifying', verifying: 'Settling on Arc',
  settling: 'Settling on Arc', completed: 'Arrived on Arc', failed: 'Needs attention - tap Track',
}

/** A sent chain's live stage from its claims row. */
function useClaimStage(claimId?: string) {
  const [stage, setStage] = useState<string | null>(null)
  useEffect(() => {
    if (!claimId) return
    return subscribeToClaim(claimId, c => setStage(CLAIM_STAGE[c.status] ?? null))
  }, [claimId])
  return stage
}

function Badge({ kind }: { kind: 'wait' | 'working' | 'done' | 'error' }) {
  const base: React.CSSProperties = { width: 24, height: 24, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }
  if (kind === 'done') return (
    <span className="ca-tick" style={{ ...base, background: 'color-mix(in srgb, var(--success) 15%, transparent)', border: '1.5px solid var(--success)' }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
    </span>
  )
  if (kind === 'error') return (
    <span className="ca-tick" style={{ ...base, background: 'color-mix(in srgb, var(--danger) 12%, transparent)', border: '1.5px solid var(--danger)', color: 'var(--danger)', fontSize: 13, fontWeight: 800 }}>!</span>
  )
  if (kind === 'working') return <span style={{ ...base, border: '1.5px solid var(--brand)' }}><MeshLoader size={15} label="Sending" /></span>
  return <span style={{ ...base, border: '1.5px solid var(--border)' }} />
}

function ChainRow({ chain, step, first, onTrack }: { chain: ClaimAllChain; step?: ClaimAllStep; first: boolean; onTrack: (claimId: string) => void }) {
  const [logoOk, setLogoOk] = useState(true)
  const live = useClaimStage(step?.state === 'done' ? step.claimId : undefined)
  const kind = !step ? 'wait' : step.state
  const status = !step ? 'Waiting' : step.state === 'done' ? (live ?? step.msg) : step.msg
  const canTrack = step?.state === 'done' && !!step.claimId
  return (
    <div onClick={canTrack ? () => onTrack(step!.claimId!) : undefined}
      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', cursor: canTrack ? 'pointer' : 'default',
        borderTop: first ? 'none' : '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
      {logoOk
        ? <img decoding="async" src={chainLogoSrc(chain.chainId)} alt="" width={34} height={34} onError={() => setLogoOk(false)} style={{ borderRadius: '50%', flexShrink: 0 }} />
        : <span style={{ width: 34, height: 34, borderRadius: '50%', flexShrink: 0, background: 'color-mix(in srgb, var(--text-primary) 8%, transparent)' }} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{chain.label}</div>
        <div style={{ fontSize: 12, marginTop: 2, lineHeight: 1.35, color: kind === 'error' ? 'var(--danger)' : 'var(--text-secondary)' }}>{status}</div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>${formatAmount(chain.balance)}</div>
        {canTrack && <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--brand-text)', marginTop: 2 }}>Track ›</div>}
      </div>
      <Badge kind={kind} />
    </div>
  )
}

/**
 * Claim All's tracking screen: the animated logo while chains go out one by
 * one, a rail filling per chain, each chain's live state (Bridging →
 * Verifying → Settling from its claims row once sent), then a drawn check -
 * or what failed with a Retry for just those chains. Track › opens that
 * chain's Track Progress in the Multichain Hub.
 */
export function ClaimAllScreen({ chains, steps, running, onClose, onRetry, onTrack, onViewHub }: {
  chains: ClaimAllChain[]
  steps: Record<string, ClaimAllStep>
  running: boolean
  onClose: () => void
  onRetry: (chainIds: string[]) => void
  onTrack: (claimId: string) => void
  onViewHub: () => void
}) {
  usePopupOpen()
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const total = chains.reduce((s, c) => s + c.balance, 0)
  const sent = chains.filter(c => steps[c.chainId]?.state === 'done')
  const failed = chains.filter(c => steps[c.chainId]?.state === 'error')
  const sentAmount = sent.reduce((s, c) => s + c.balance, 0)
  const phase = running ? 'running' : failed.length === 0 ? 'success' : sent.length === 0 ? 'failed' : 'partial'
  const pct = total > 0 ? (sentAmount / total) * 100 : 0

  const title = phase === 'partial' ? `$${formatAmount(sentAmount)} of $${formatAmount(total)}` : `$${formatAmount(total)} USDC`
  const sub = phase === 'running' ? 'Moving to your Arc balance · MeshPort pays the gas'
    : phase === 'success' ? 'On its way to Arc · usually a few minutes'
    : phase === 'partial' ? `${sent.length} chain${sent.length === 1 ? '' : 's'} sent · ${failed.length} didn't go through`
    : 'Nothing was sent'
  const note = phase === 'running' ? 'Keep MeshPort open until every chain is sent. After that, Circle finishes the move on its own - you can close the app.'
    : phase === 'success' ? 'Tap Track on any chain for its live Bridging → Verifying → Settling → Completed steps.'
    : `Nothing was taken from ${failed.map(c => c.label).join(', ')}. Retry now - it doesn't wait for the next Claim All.`

  const btn: React.CSSProperties = { height: 50, borderRadius: 14, border: 'none', fontSize: 15, fontWeight: 700, cursor: 'pointer', width: '100%' }
  const primary: React.CSSProperties = { ...btn, background: 'var(--brand)', color: '#fff' }
  const secondary: React.CSSProperties = { ...btn, background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', color: 'var(--text-primary)' }
  const ring = (c: string) => ({ position: 'absolute' as const, inset: 4, borderRadius: '50%', background: c, boxShadow: `0 0 0 10px color-mix(in srgb, ${c} 14%, transparent)` })

  const panel = (
    <div role="dialog" aria-label="Claim All" aria-live="polite"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', background: isDesktop ? 'var(--surface)' : 'var(--bg)', color: 'var(--text-primary)' }}>
      <style>{CSS}</style>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: isDesktop ? '18px 18px 4px' : 'calc(env(safe-area-inset-top, 0px) + 14px) 16px 4px' }}>
        <span style={{ width: 34 }} />
        <span style={{ fontSize: 16, fontWeight: 700 }}>Claim All</span>
        <button onClick={onClose} aria-label="Close" style={{ width: 34, height: 34, borderRadius: '50%', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', color: 'var(--text-secondary)' }}><X size={17} /></button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 8 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '18px 20px 8px', textAlign: 'center' }}>
          <div style={{ position: 'relative', width: 76, height: 76 }}>
            {phase === 'running' && <div style={{ position: 'absolute', inset: 4 }}><MeshLoader size={68} label="Claiming" /></div>}
            {phase === 'success' && (
              <div className="ca-ok" style={ring('var(--success)')}>
                <svg viewBox="0 0 84 84" style={{ position: 'absolute', inset: 0 }}><path d="M25 43 L37 55 L60 31" stroke="#fff" strokeWidth={7} fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </div>
            )}
            {(phase === 'partial' || phase === 'failed') && (
              <div className="ca-ok" style={{ ...ring(phase === 'partial' ? '#F59E0B' : 'var(--danger)'), color: '#fff', fontSize: 32, fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>!</div>
            )}
          </div>
          <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: -0.5, marginTop: 16, fontVariantNumeric: 'tabular-nums' }}>{title}</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>{sub}</div>
        </div>

        <div style={{ margin: '14px 20px 6px', height: 6, borderRadius: 9, background: 'color-mix(in srgb, var(--text-primary) 7%, transparent)', overflow: 'hidden' }}>
          <motion.div initial={false} animate={{ width: `${pct}%` }} transition={{ duration: 0.5, ease: EASE_OUT }}
            style={{ height: '100%', borderRadius: 9, background: 'var(--success)' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-secondary)', margin: '0 20px' }}>
          <span>{sent.length} of {chains.length} chain{chains.length === 1 ? '' : 's'} sent</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>${formatAmount(sentAmount)}</span>
        </div>

        <div style={{ margin: '16px 16px 0', borderRadius: 16, padding: '4px 14px', border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--text-primary) 3%, transparent)' }}>
          {chains.map((c, i) => <ChainRow key={c.chainId} chain={c} step={steps[c.chainId]} first={i === 0} onTrack={onTrack} />)}
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '14px 20px 0', lineHeight: 1.45 }}>{note}</p>
      </div>

      <div style={{ padding: isDesktop ? 16 : '12px 16px calc(env(safe-area-inset-bottom, 0px) + 16px)', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {phase === 'running' && <button disabled style={{ ...secondary, opacity: 0.55, cursor: 'default' }}>Claiming…</button>}
        {phase === 'success' && <>
          <button onClick={onClose} style={primary}>Done</button>
          <button onClick={onViewHub} style={secondary}>View in Multichain Hub</button>
        </>}
        {(phase === 'partial' || phase === 'failed') && <>
          <button onClick={() => onRetry(failed.map(c => c.chainId))} style={primary}>
            {failed.length === 1 ? `Retry ${failed[0].label}` : `Retry ${failed.length} chains`}
          </button>
          {sent.length > 0
            ? <button onClick={onViewHub} style={secondary}>View in Multichain Hub</button>
            : <button onClick={onClose} style={secondary}>Close</button>}
        </>}
      </div>
    </div>
  )

  // Desktop: the app's centred popup (dim, pop-in, Esc, tap-outside).
  // Phone: a full screen that slides up on the bottom-sheet motion.
  if (isDesktop) return (
    <DesktopDialogFrame onClose={onClose} bare maxWidth={420} zIndex={100}>
      <div data-leave-guard={running ? '' : undefined}
        style={{ position: 'relative', width: '100%', maxHeight: 'min(760px, calc(100vh - 48px))', height: 720, borderRadius: 24, overflow: 'hidden', border: '1px solid var(--border)', boxShadow: 'var(--shadow-3)' }}>
        {panel}
      </div>
    </DesktopDialogFrame>
  )
  return createPortal(
    <motion.div data-leave-guard={running ? '' : undefined} {...SHEET_PANEL}
      style={{ position: 'fixed', inset: 0, zIndex: 100 }}>
      {panel}
    </motion.div>,
    document.body,
  )
}
