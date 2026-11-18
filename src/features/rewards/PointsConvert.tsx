// Points → USDC (18 Nov 2026, like Paytm's Gold Coins page): the balance on a
// coin, what it's worth, and "Slide to convert to USDC" - the claim runs
// through the rewards contract (no passcode: the wallet frame signs reward
// claims freely). Opened from the Points tile; Back closes it.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { ArrowLeft, ChevronsRight, History, Info, Gift } from 'lucide-react'
import { useBackLayer } from '@/lib/backLayers'
import { PAGE_TRANSITION } from '@/lib/motion'
import { formatAmount } from '@/lib/utils'
import { pointsToUSDC, MIN_CLAIM_POINTS, MAX_DAILY_POINTS } from '@/lib/rewards'

const GOLD = '#A87B17'

function Coin({ size = 54 }: { size?: number }) {
  return (
    <span aria-hidden style={{ width: size, height: size * 1.04, borderRadius: '50%', flex: 'none', display: 'grid', placeItems: 'center', transform: 'rotate(-12deg)',
      background: 'radial-gradient(circle at 34% 28%, #FFE9A3, #F2BE3A 55%, #C98E12 100%)', boxShadow: 'inset -4px -5px 0 rgba(0,0,0,.14), 0 4px 10px rgba(168,123,23,.35)',
      color: '#8A5A00', fontWeight: 900, fontSize: size * 0.42, fontStyle: 'italic' }}>P</span>
  )
}

function UsdcCoin({ size = 54 }: { size?: number }) {
  return (
    <span aria-hidden style={{ width: size, height: size, borderRadius: '50%', flex: 'none', display: 'grid', placeItems: 'center',
      background: 'radial-gradient(circle at 32% 28%, #7DB6F5, #2775CA 70%)', border: '3px solid #DCEBFB', boxShadow: 'inset -4px -5px 0 rgba(0,0,0,.14), 0 4px 10px rgba(39,117,202,.35)',
      color: '#fff', fontWeight: 900, fontSize: size * 0.46 }}>$</span>
  )
}

/** "Slide to convert": drag the knob to the end (or press Enter / Space on it). */
function SlideToConfirm({ label, disabled, busy, onConfirm }: { label: string; disabled?: boolean; busy?: boolean; onConfirm: () => void }) {
  const track = useRef<HTMLDivElement>(null)
  const [x, setX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ px: number; x: number } | null>(null)
  const KNOB = 64, PAD = 6
  const max = () => Math.max(0, (track.current?.offsetWidth ?? 0) - KNOB - PAD * 2)
  // Back to the start once a conversion ends (or fails).
  useEffect(() => { if (!busy) setX(0) }, [busy])
  const done = () => { setX(max()); onConfirm() }
  return (
    <div ref={track} style={{ position: 'relative', height: KNOB + PAD * 2, borderRadius: 999, overflow: 'hidden', userSelect: 'none', touchAction: 'none',
      background: 'color-mix(in srgb, var(--brand) 10%, var(--surface))', border: '1px solid color-mix(in srgb, var(--brand) 22%, transparent)', opacity: disabled ? 0.55 : 1 }}>
      <div aria-hidden style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: x + KNOB + PAD * 2, background: 'color-mix(in srgb, var(--brand) 16%, transparent)', borderRadius: 999,
        transition: dragging ? 'none' : 'width .3s var(--ease-out)' }} />
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', paddingLeft: KNOB, fontSize: 16, fontWeight: 800, color: 'var(--brand-text)', opacity: Math.max(0.25, 1 - x / (max() || 1)) }}>
        {busy ? 'Converting…' : label}
      </div>
      <button type="button" role="slider" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((x / (max() || 1)) * 100)}
        disabled={disabled || busy}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); done() } }}
        onPointerDown={e => { if (disabled || busy) return; start.current = { px: e.clientX, x }; setDragging(true); (e.target as HTMLElement).setPointerCapture(e.pointerId) }}
        onPointerMove={e => { if (!start.current) return; setX(Math.min(max(), Math.max(0, start.current.x + e.clientX - start.current.px))) }}
        onPointerUp={() => {
          if (!start.current) return
          start.current = null; setDragging(false)
          if (x >= max() * 0.85) done(); else setX(0)
        }}
        onPointerCancel={() => { start.current = null; setDragging(false); setX(0) }}
        style={{ position: 'absolute', left: PAD, top: PAD, width: KNOB, height: KNOB, borderRadius: '50%', border: 'none', cursor: disabled ? 'default' : 'grab',
          background: 'var(--brand)', color: '#fff', display: 'grid', placeItems: 'center', boxShadow: '0 4px 12px color-mix(in srgb, var(--brand) 40%, transparent)',
          transform: `translateX(${x}px)`, transition: dragging ? 'none' : 'transform .3s var(--ease-out)' }}>
        <ChevronsRight size={30} strokeWidth={2.2} />
      </button>
    </div>
  )
}

export function PointsConvertPage({
  totalPoints, maxClaimable, dailyRemaining, canConvert, claiming, loading, onConvert, onClose, onHistory, historyCount, history, usdcMicro, lifetime, dailyLimit = MAX_DAILY_POINTS,
}: {
  totalPoints: number
  /** What one slide converts: all of it, within the per-claim and daily limits. */
  maxClaimable: number
  dailyRemaining: number
  canConvert: boolean
  claiming: boolean
  loading: boolean
  onConvert: () => void
  onClose: () => void
  onHistory: () => void
  historyCount: number
  /** The live contract's daily limit in points (one claim may use all of it). */
  dailyLimit?: number
  /** "Lifetime earned …" under the slider. */
  lifetime?: string
  /** The latest points earned (rows from the Rewards page). */
  history: ReactNode
  /** Set: the USDC-rewards version of the page (USDC won on scratch cards,
   *  micro-USDC) - "Slide to move to your wallet". totalPoints / maxClaimable
   *  are then that USDC's value in contract points (1 pt = 500 micro). */
  usdcMicro?: number
}) {
  useBackLayer(true, onClose)
  const info = useRef<HTMLDivElement>(null)
  const U = usdcMicro !== undefined
  const usd = (pts: number) => `$${pointsToUSDC(pts).toFixed(2)}`
  const capHit = totalPoints >= MIN_CLAIM_POINTS && dailyRemaining < MIN_CLAIM_POINTS
  const toFirst = Math.max(0, MIN_CLAIM_POINTS - totalPoints)
  const accent = U ? '#2775CA' : GOLD
  const chip = (icon: ReactNode, text: ReactNode, onClick: () => void) => (
    <button type="button" onClick={onClick} className="mp-press"
      style={{ flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderRadius: 16, background: 'var(--surface)', border: '1px solid var(--soft-edge)', boxShadow: 'var(--soft-card)', fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'inherit' }}>
      {icon}{text}
    </button>
  )
  return createPortal(
    <motion.div role="dialog" aria-modal="true" aria-label={U ? 'Move USDC rewards' : 'Convert points'}
      initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={PAGE_TRANSITION}
      style={{ position: 'fixed', inset: 0, zIndex: 250, background: 'var(--bg)', display: 'flex', flexDirection: 'column', willChange: 'transform' }}>
      <div className="header-row mp-glass-header flex-shrink-0 gap-3 px-5 pt-header pb-header" style={{ position: 'relative' }}>
        <button type="button" onClick={onClose} className="back-btn" aria-label="Back"><ArrowLeft className="w-5 h-5 text-text-primary" /></button>
        <h1 aria-label={U ? 'MeshPort USDC rewards' : 'MeshPort Points'} style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', marginTop: 'calc(var(--safe-top, 0px) / 2)', display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1, pointerEvents: 'none' }}>
          <b style={{ fontSize: 24, fontWeight: 900, letterSpacing: '-.5px', fontStyle: 'italic', textTransform: 'uppercase', background: 'linear-gradient(180deg, #1C8A7F, #0E524C)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', paddingRight: 2 }}>MeshPort</b>
          <small style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.14em', color: accent, marginTop: 3 }}>{U ? 'USDC REWARDS' : 'POINTS'}</small>
        </h1>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', paddingBottom: 'calc(var(--safe-bottom) + 24px)' }}>
        <div style={{ maxWidth: 480, margin: '0 auto' }}>
          <div style={{ position: 'relative', textAlign: 'center', padding: '20px 16px 22px' }}>
            <span aria-hidden style={{ position: 'absolute', left: '17%', top: 6, color: '#E3B341', fontSize: 22 }}>✦</span>
            <span aria-hidden style={{ position: 'absolute', right: '15%', top: 34, color: '#E3B341', fontSize: 20 }}>✦</span>
            <h2 style={{ fontSize: 27, fontWeight: 800, letterSpacing: '-.4px', lineHeight: 1.22, color: 'var(--text-primary)' }}>{U ? <>Scratch cards win<br />you real USDC</> : <>Every payment<br />earns you points</>}</h2>
          </div>

          {/* Balance + slide to convert */}
          <div style={{ margin: '0 16px', background: 'var(--surface)', border: '1px solid var(--soft-edge)', boxShadow: 'var(--soft-card)', borderRadius: 30, padding: '22px 18px 20px', textAlign: 'center' }}>
            <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>{U ? 'USDC rewards balance' : 'Points balance'}</div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 8 }}>
              {U ? <UsdcCoin /> : <Coin />}
              <span style={{ fontSize: 52, fontWeight: 900, letterSpacing: '-1.5px', fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)' }}>{loading ? '–' : U ? `$${(usdcMicro! / 1e6).toFixed(2)}` : totalPoints.toLocaleString()}</span>
            </div>
            <div style={{ fontSize: 17, fontWeight: 800, color: accent, marginTop: 8 }}>{U ? 'Real USDC, ready for your main balance' : `Are worth ${usd(totalPoints)} real USDC`}</div>
            <div style={{ marginTop: 22 }}>
              {toFirst > 0 ? (
                <div style={{ position: 'relative', height: 64, borderRadius: 999, overflow: 'hidden', background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
                  <div style={{ position: 'absolute', inset: 0, width: `${Math.min(100, (totalPoints / MIN_CLAIM_POINTS) * 100)}%`, background: 'color-mix(in srgb, var(--brand) 18%, transparent)' }} />
                  <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 15, fontWeight: 700, color: 'var(--text-secondary)' }}>
                    {U ? (usdcMicro! > 0 ? `Win ${usd(toFirst)} more to move it` : 'Scratch cards to win USDC') : `${toFirst} more points to convert`}
                  </div>
                </div>
              ) : capHit ? (
                <div style={{ padding: '18px 12px', borderRadius: 999, background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', fontSize: 14, fontWeight: 700, color: 'var(--text-secondary)' }}>
                  Today's limit reached - {U ? 'move it' : 'convert'} again after 00:00 UTC
                </div>
              ) : (
                <SlideToConfirm label={U ? 'Slide to move to your wallet' : 'Slide to convert to USDC'} disabled={!canConvert} busy={claiming} onConfirm={onConvert} />
              )}
            </div>
            {toFirst === 0 && !capHit && (
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 10 }}>
                {U ? `Moves ${usd(maxClaimable)} USDC to your main balance · no passcode`
                  : `Converts ${maxClaimable.toLocaleString()} pts → ${usd(maxClaimable)} USDC to your wallet · no passcode`}
              </div>
            )}
            {lifetime && (
              <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 14, background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)', fontSize: 13, color: 'var(--text-secondary)' }}>
                Lifetime earned <b style={{ color: 'var(--text-primary)' }}>{lifetime}</b>
              </div>
            )}
          </div>

          <div className="sr-strip" style={{ display: 'flex', gap: 10, overflowX: 'auto', padding: '18px 16px 4px' }}>
            {chip(<History size={20} color="var(--brand-text)" />, <>View history <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{historyCount}</span></>, onHistory)}
            {chip(<Info size={20} color="var(--brand-text)" />, 'How it works', () => info.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }))}
            {chip(<Gift size={20} color="var(--brand-text)" />, 'Scratch cards', onClose)}
          </div>

          <div style={{ textAlign: 'center', margin: '26px 16px 12px' }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
              <span aria-hidden style={{ width: 60, height: 1, background: `linear-gradient(90deg, transparent, ${accent})` }} />
              <b style={{ fontSize: 24, fontWeight: 800, color: accent }}>{U ? 'USDC to your wallet' : 'Points to USDC'}</b>
              <span aria-hidden style={{ width: 60, height: 1, background: `linear-gradient(270deg, transparent, ${accent})` }} />
            </div>
            <div style={{ fontSize: 14.5, color: 'var(--text-secondary)', marginTop: 6 }}>Real USDC on Arc, straight to your MeshPort wallet</div>
          </div>
          <div ref={info} style={{ margin: '0 16px', background: 'var(--surface)', border: '1px solid var(--soft-edge)', boxShadow: 'var(--soft-card)', borderRadius: 24, padding: '6px 16px' }}>
            {(U ? [
              ['Minimum', `${usd(MIN_CLAIM_POINTS)} at a time`],
              ['Per move', `Up to ${usd(dailyLimit)}`],
              ['Daily limit', `${usd(dailyLimit)} a day, shared with points · ${usd(dailyRemaining)} left today`],
              ['Win USDC', 'Random USDC in scratch cards on payments of $1 or more, and in cards from completed offers'],
            ] : [
              ['Rate', `1,000 pts = $${formatAmount(pointsToUSDC(1000))} USDC`],
              ['Per conversion', `${MIN_CLAIM_POINTS} – ${dailyLimit.toLocaleString()} pts`],
              ['Daily limit', `${dailyLimit.toLocaleString()} pts (${usd(dailyLimit)}) · ${dailyRemaining.toLocaleString()} left today`],
              ['Earn points', 'Random points for each payment, swap, chat pay, multichain and bulk pay - once a day each, plus scratch cards'],
            ]).map(([k, v], i) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '12px 0', borderTop: i ? '1px solid var(--border)' : 'none', fontSize: 14 }}>
                <span style={{ color: 'var(--text-secondary)', flex: 'none' }}>{k}</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 600, textAlign: 'right' }}>{v}</span>
              </div>
            ))}
          </div>

          <p className="text-xs font-bold text-text-secondary" style={{ margin: '24px 20px 6px' }}>{U ? 'USDC won' : 'Recent points'}</p>
          <div>{history}</div>
        </div>
      </div>
    </motion.div>,
    document.body,
  )
}
