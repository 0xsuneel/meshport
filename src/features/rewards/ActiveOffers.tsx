// "Your active offers" on the Rewards page (18 Nov 2026), like Paytm's:
// activate an offer, then each qualifying payment fills its ring (1 of 3,
// 2 of 3...) - counted by the server when it confirms the payment. Finishing
// it in time wins a bonus scratch card with real USDC inside. Tapping an
// offer opens its details: the steps, the reward, how long it runs, the terms.
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, ChevronRight } from 'lucide-react'
import { P2PSheet } from '@/features/p2p/p2pUi'
import { activateOffer, fetchOffers, timeLeft, type RewardOffer } from '@/lib/scratchCards'
import { useUIStore } from '@/store'

const RING = 54

function Ring({ value, steps, label, size = RING }: { value: number; steps: number; label: string; size?: number }) {
  const pct = Math.max(0, Math.min(1, steps ? value / steps : 0)) * 100
  const inner = size - 10
  return (
    <span aria-hidden style={{ width: size, height: size, borderRadius: '50%', flex: 'none', display: 'grid', placeItems: 'center',
      background: `conic-gradient(var(--success) 0 ${pct}%, color-mix(in srgb, var(--success) 15%, transparent) ${pct}% 100%)` }}>
      <i style={{ width: inner, height: inner, borderRadius: '50%', background: 'var(--surface)', display: 'grid', placeItems: 'center', fontStyle: 'normal',
        fontWeight: 900, color: 'var(--brand-text)', fontSize: size > 70 ? 22 : label.length > 2 ? 14 : 18 }}>{label}</i>
    </span>
  )
}

function stateLine(o: RewardOffer): { text: string; color: string } {
  if (o.state === 'running') return { text: `IN PROGRESS · ${timeLeft(o.expiresAt).toUpperCase()}`, color: 'var(--success-text)' }
  if (o.state === 'done') return { text: 'COMPLETED · CARD WON', color: 'var(--success-text)' }
  if (o.state === 'expired') return { text: 'ENDED · ACTIVATE AGAIN', color: 'var(--text-secondary)' }
  return { text: 'NEW OFFER · TAP TO ACTIVATE', color: '#2775CA' }
}

export function ActiveOffers({ margin, refreshKey }: { margin: number; refreshKey: number }) {
  const navigate = useNavigate()
  const [offers, setOffers] = useState<RewardOffer[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => { fetchOffers().then(setOffers).catch(() => { /* not available yet: the always-on card still shows */ }) }, [])
  useEffect(() => { load() }, [load, refreshKey])
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  const open = offers.find(o => o.id === openId) ?? null
  const activate = async (o: RewardOffer) => {
    setBusy(true)
    try {
      await activateOffer(o.id)
      useUIStore.getState().showToastMessage('Offer activated - start paying to fill it', 'success')
      load()
    } catch {
      useUIStore.getState().showToastMessage("Couldn't activate this offer - try again", 'error')
    } finally { setBusy(false) }
  }

  const card = (key: string, ring: React.ReactNode, small: { text: string; color: string }, title: string, onClick: () => void) => (
    <button key={key} type="button" onClick={onClick} className="mp-press"
      style={{ flex: '0 0 290px', textAlign: 'left', background: 'var(--surface)', border: '1px solid var(--soft-edge)', boxShadow: 'var(--soft-card)', borderRadius: 22, padding: 14, display: 'flex', gap: 14, alignItems: 'center', cursor: 'pointer', fontFamily: 'inherit' }}>
      {ring}
      <span style={{ flex: 1, minWidth: 0 }}>
        <small style={{ display: 'block', fontSize: 11.5, fontWeight: 800, letterSpacing: '.03em', color: small.color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{small.text}</small>
        <b style={{ display: 'block', fontSize: 15, fontWeight: 600, marginTop: 3, lineHeight: 1.3, color: 'var(--text-primary)' }}>{title}</b>
      </span>
      <ChevronRight size={18} color="var(--text-secondary)" style={{ flex: 'none' }} />
    </button>
  )

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: `26px ${margin + 4}px 12px` }}>
        <h4 style={{ fontSize: 21, fontWeight: 900, letterSpacing: '-0.2px', textTransform: 'uppercase', color: 'var(--text-primary)' }}>Your active offers</h4>
      </div>
      <div className="sr-strip" style={{ display: 'flex', gap: 10, overflowX: 'auto', padding: `2px ${margin}px 4px` }}>
        {offers.map(o => card(o.id,
          <Ring value={o.state === 'idle' || o.state === 'expired' ? 0 : o.progress} steps={o.steps}
            label={o.state === 'done' ? '✓' : o.state === 'running' ? `${o.progress}/${o.steps}` : '$'} />,
          stateLine(o), `${o.title} ${o.line}`, () => setOpenId(o.id)))}
        {/* Always on: every payment wins a card. */}
        {card('every', <Ring value={1} steps={1} label="$" />, { text: 'ALWAYS ON · EVERY PAYMENT', color: 'var(--success-text)' },
          'Every payment wins a card - random points or real USDC', () => navigate('/pay'))}
      </div>

      <P2PSheet open={!!open} onClose={() => setOpenId(null)} title="Offer details" id="rw-offer">
        {open && (() => {
          const running = open.state === 'running'
          const filled = running || open.state === 'done' ? open.progress : 0
          return (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <Ring size={84} value={filled} steps={open.steps} label={open.state === 'done' ? '✓' : `${filled}/${open.steps}`} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.03em', color: stateLine(open).color }}>{stateLine(open).text}</div>
                  <div style={{ fontSize: 19, fontWeight: 800, color: 'var(--text-primary)', marginTop: 4, lineHeight: 1.25 }}>{open.title} {open.line}</div>
                </div>
              </div>

              <div style={{ marginTop: 18, background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)', borderRadius: 16, padding: '4px 14px' }}>
                {Array.from({ length: open.steps }, (_, i) => {
                  const done = i < filled
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderTop: i ? '1px solid var(--border)' : 'none' }}>
                      <span style={{ width: 24, height: 24, borderRadius: '50%', flex: 'none', display: 'grid', placeItems: 'center',
                        background: done ? 'var(--success)' : 'transparent', border: done ? 'none' : '2px solid var(--border)' }}>
                        {done && <Check size={14} color="#fff" strokeWidth={3} />}
                      </span>
                      <span style={{ fontSize: 14, color: done ? 'var(--text-primary)' : 'var(--text-secondary)', fontWeight: done ? 600 : 500 }}>
                        Payment {i + 1} of ${open.minUsd} or more
                      </span>
                    </div>
                  )
                })}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderTop: '1px solid var(--border)' }}>
                  <span style={{ width: 24, height: 24, borderRadius: 7, flex: 'none', display: 'grid', placeItems: 'center', background: '#2775CA', color: '#fff', fontWeight: 900, fontSize: 13 }}>$</span>
                  <span style={{ fontSize: 14, color: 'var(--text-primary)', fontWeight: 600 }}>Win a scratch card with real USDC</span>
                </div>
              </div>

              <div style={{ marginTop: 14, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                <b style={{ color: 'var(--text-primary)' }}>How it works</b>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, listStyle: 'disc' }}>
                  <li>Activate it, then pay with MeshPort Pay - each payment of ${open.minUsd} or more counts once it's confirmed.</li>
                  <li>Finish all {open.steps} within {open.windowDays} days of activating.{running && open.expiresAt ? ` ${timeLeft(open.expiresAt)}.` : ''}</li>
                  <li>Payments to your own wallet don't count. Personal accounts only.</li>
                  <li>The USDC card lands in Scratch &amp; claim - scratch it, then claim the USDC to your wallet.</li>
                  <li>When it's done or runs out, you can activate it again.</li>
                </ul>
              </div>

              {running ? (
                <button type="button" onClick={() => { setOpenId(null); navigate('/pay') }}
                  style={{ width: '100%', border: 'none', borderRadius: 14, padding: 15, fontSize: 15, fontWeight: 800, color: '#fff', background: 'var(--brand)', marginTop: 16, cursor: 'pointer' }}>
                  Pay now
                </button>
              ) : (
                <button type="button" disabled={busy} onClick={() => { void activate(open) }}
                  style={{ width: '100%', border: 'none', borderRadius: 14, padding: 15, fontSize: 15, fontWeight: 800, color: '#fff', background: 'var(--brand)', marginTop: 16, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
                  {busy ? 'Activating…' : open.state === 'idle' ? 'Activate offer' : 'Activate again'}
                </button>
              )}
            </div>
          )
        })()}
      </P2PSheet>
    </>
  )
}
