// The top of the Rewards page (approved preview, 18 Nov): the "win real USDC"
// banner, three balances (USDC won · Points · Scratch cards), the band of
// cards waiting to be scratched, the active offer and the ways to earn more.
//
// Real data only: the cards and balances come from the server
// (lib/scratchCards). A card's prize is decided by the server when the
// payment is confirmed and is only learned by scratching it - never listed.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useStaggerIn } from '@/lib/staggerIn'
import { Skeleton } from '@/components/ui/Skeleton'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { ArrowLeftRight, Gift, Globe, Layers, MessageCircle } from 'lucide-react'
import {
  fetchRewardSummary, fetchScratchCards, scratchCard, emitCardCount, fmtUsdcMicro, usdcClaimPoints, fetchRewardToday, type RewardToday, fetchScratchHistory, type ScratchWin,
  MIN_USDC_CLAIM_MICRO, type ScratchPrize,
} from '@/lib/scratchCards'
import { useUIStore } from '@/store'
import { timeAgo } from '@/lib/utils'
import { ActiveOffers } from './ActiveOffers'

const USDC_BLUE = '#2775CA'
const BAND = '#0E2A28'
const LOOKS = [
  { bg: 'linear-gradient(160deg, #1C8A7F, #0E524C)', strip: '#9FE3D2', coat: ['#1C8A7F', '#0E524C'] },
  { bg: 'linear-gradient(160deg, #E0A423, #A86B06)', strip: '#FFE08A', coat: ['#E0A423', '#A86B06'] },
  { bg: 'linear-gradient(160deg, #3B82D6, #1E4E9A)', strip: '#B9D6F7', coat: ['#3B82D6', '#1E4E9A'] },
  { bg: 'linear-gradient(160deg, #B5375A, #6E1630)', strip: '#F4B5C6', coat: ['#B5375A', '#6E1630'] },
] as const

const CSS = `
.sr-bump{animation:srBump .45s ease}
@keyframes srBump{40%{transform:scale(1.08)}}
.sr-strip::-webkit-scrollbar{display:none}
.sr-strip{scrollbar-width:none}
.sr-modal{animation:srPop .35s cubic-bezier(.3,1.4,.5,1) both}
@keyframes srPop{from{transform:scale(.7);opacity:0}to{transform:none;opacity:1}}
@media (prefers-reduced-motion: reduce){.sr-bump,.sr-modal{animation:none}}
`

/** A number that counts up (or down) to its new value. */
function CountUp({ value, format }: { value: number; format: (v: number) => string }) {
  const [shown, setShown] = useState(value)
  const from = useRef(value)
  useEffect(() => {
    const a = from.current, b = value
    from.current = value
    if (a === b || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setShown(b); return }
    const t0 = performance.now()
    let raf = 0
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 900), e = 1 - Math.pow(1 - k, 3)
      setShown(a + (b - a) * e)
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value])
  return <>{format(shown)}</>
}

export function ScratchRewards({ isDesktop, totalPoints, onPointsWon, onClaimUsdc, onClaimPoints, onOpenPoints, onOpenUsdc, onUsdc, onUsdcLifetime, lifetimePoints, claiming, refreshKey }: {
  isDesktop: boolean
  totalPoints: number
  /** Points credited by a scratched card (the page re-reads its balance). */
  onPointsWon: (points: number) => void
  /** Claim the USDC won to the wallet (contract points value). */
  onClaimUsdc: (points: number) => void
  /** Claim points as USDC (the claim sheet); undefined while there aren't enough. */
  onClaimPoints?: () => void
  /** Tapping the Points tile: the points → USDC page. */
  onOpenPoints?: () => void
  /** Tapping the USDC tile: the USDC → wallet page. */
  onOpenUsdc?: () => void
  /** The USDC won, each time it changes (the USDC page shows it live). */
  onUsdc?: (micro: number) => void
  /** USDC won all-time (micro), for the convert page. */
  onUsdcLifetime?: (micro: number) => void
  /** Points earned all-time (user_points.lifetime_points). */
  lifetimePoints?: number
  claiming: boolean
  /** Bumped by the page after a claim: re-read the balances. */
  refreshKey: number
}) {
  const navigate = useNavigate()
  const [usdcMicro, setUsdcMicro] = useState(0)
  useEffect(() => { onUsdc?.(usdcMicro) }, [usdcMicro, onUsdc])
  const [usdcLifetime, setUsdcLifetime] = useState(0)
  const [today, setToday] = useState<RewardToday | null>(null)
  const [wins, setWins] = useState<ScratchWin[] | null>(null)
  const limitHit = !!today && today.cards >= today.cardsLimit
  useEffect(() => { onUsdcLifetime?.(usdcLifetime) }, [usdcLifetime, onUsdcLifetime])
  const [cards, setCards] = useState<{ id: string; createdAt: string }[] | null>(null)
  const [open, setOpen] = useState<{ id: string; look: number } | null>(null)
  const usdcTile = useRef<HTMLDivElement>(null)
  const ptsTile = useRef<HTMLDivElement>(null)
  const bandRef = useRef<HTMLDivElement>(null)
  // The points tile shows the page's balance, held back while a won prize
  // is flying to it so it counts up when it lands.
  const [ptsHold, setPtsHold] = useState<number | null>(null)

  // Skeletons until the first full read (18 Nov 2026: the page used to fill
  // in piece by piece - $0.00, "–", "No cards right now", then the real
  // state). Everything is read together and shown at once; a refresh keeps
  // what's on screen until its new numbers are in.
  const [ready, setReady] = useState(false)
  // The page's sections arrive one after another as it opens (19 Nov 2026) -
  // banner, balances, lifetime, today, the cards, offers, ways to earn.
  const revealRef = useRef<HTMLDivElement>(null)
  useStaggerIn(revealRef, true)
  const load = useCallback(async () => {
    try {
      const [s, list, t, w] = await Promise.all([
        fetchRewardSummary(), fetchScratchCards(),
        fetchRewardToday().catch(() => null),
        fetchScratchHistory(4).catch(() => [] as ScratchWin[]),
      ])
      setUsdcMicro(s.usdcMicro)
      setUsdcLifetime(s.usdcLifetimeMicro)
      setToday(t)
      setWins(w)
      setCards(list)
      emitCardCount(list.length)
      setReady(true)
    } catch { /* weak network: keep what's shown */ }
  }, [])
  useEffect(() => { void load() }, [load, refreshKey])

  const bump = (el: HTMLElement | null) => { if (!el) return; el.classList.remove('sr-bump'); void el.offsetWidth; el.classList.add('sr-bump') }

  // A card scratched: its prize flies from the card to its balance, which counts up.
  const landed = (id: string, prize: ScratchPrize, from: DOMRect | null) => {
    setOpen(null)
    setCards(c => {
      const next = (c ?? []).filter(x => x.id !== id)
      emitCardCount(next.length)
      return next
    })
    if (prize.already || prize.kind === 'none') { void load(); return }
    const usdc = prize.kind === 'usdc'
    const target = usdc ? usdcTile.current : ptsTile.current
    const apply = () => {
      bump(target)
      if (usdc) setUsdcMicro(m => m + prize.usdcMicro)
      else { setPtsHold(null); onPointsWon(prize.points) }
    }
    if (!usdc) setPtsHold(totalPoints)
    const to = target?.getBoundingClientRect()
    if (!from || !to || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { apply(); return }
    const f = document.createElement('div')
    Object.assign(f.style, {
      position: 'fixed', left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, zIndex: '1200',
      borderRadius: '50%', display: 'grid', placeItems: 'center', fontWeight: '900', fontSize: '26px', pointerEvents: 'none',
      background: usdc ? USDC_BLUE : '#F5B82E', color: usdc ? '#fff' : '#7A5200',
    })
    f.textContent = usdc ? '$' : '★'
    document.body.appendChild(f)
    const dx = (to.left + to.width / 2) - (from.left + from.width / 2), dy = (to.top + 32) - (from.top + from.height / 2)
    const anim = f.animate([
      { transform: 'translate(0,0) scale(1)' },
      { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 60}px) scale(.8)`, offset: 0.5 },
      { transform: `translate(${dx}px, ${dy}px) scale(.35)`, opacity: 0.85 },
    ], { duration: 750, easing: 'cubic-bezier(.5,0,.2,1)' })
    anim.onfinish = () => { f.remove(); apply() }
  }

  const claimPts = usdcClaimPoints(usdcMicro)
  const m = isDesktop ? 0 : 14
  const tile = (ref: React.RefObject<HTMLDivElement | null> | null, value: ReactNode, label: string, color: string, top?: ReactNode, onClick?: () => void) => (
    <div ref={ref ?? undefined} onClick={onClick} role={onClick ? 'button' : undefined}
      style={{ position: 'relative', background: 'var(--surface)', border: '1px solid var(--soft-edge)', borderRadius: 22, padding: '18px 6px 16px', textAlign: 'center', boxShadow: 'var(--soft-card)', cursor: onClick ? 'pointer' : 'default' }}>
      {top}
      <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.5px', fontVariantNumeric: 'tabular-nums', color, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {ready ? value : <Skeleton style={{ width: '62%', height: 26, borderRadius: 8 }} />}
      </div>
      <div style={{ fontSize: 13.5, color: 'var(--text-secondary)', marginTop: 4 }}>{label}</div>
    </div>
  )

  const earn = [
    { to: '/chat', bg: '#12665F', soft: '#E3F2EE', Icon: MessageCircle, k: 'PAY IN CHAT', line: 'Send money as you chat' },
    { to: '/swap', bg: '#2B5CE6', soft: '#E3ECFD', Icon: ArrowLeftRight, k: 'SWAP', line: 'USDC, EURC and cirBTC' },
    { to: '/multichain', bg: '#0E7490', soft: '#DDF3F8', Icon: Globe, k: 'MULTICHAIN', line: 'USDC across 20+ chains' },
    { to: '/bulk-payout', bg: '#C2410C', soft: '#FDEBDD', Icon: Layers, k: 'BULK PAY', line: 'Pay many people at once' },
  ]

  return (
    <div ref={revealRef}>
      <style>{CSS}</style>
      {/* Banner */}
      <div style={{ position: 'relative', margin: `4px ${m}px 0`, height: 168, borderRadius: 22, overflow: 'hidden', padding: '18px 16px',
        background: 'linear-gradient(120deg, color-mix(in srgb, #2BA393 16%, var(--surface)) 0%, color-mix(in srgb, #3B9BC8 16%, var(--surface)) 100%)' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 800, color: 'var(--brand-text)' }}>
          <i style={{ width: 18, height: 18, borderRadius: 6, background: 'var(--brand)', display: 'grid', placeItems: 'center', color: '#fff', fontStyle: 'normal', fontSize: 11 }}>✦</i> Scratch &amp; win
        </div>
        <h2 style={{ fontSize: 21, fontWeight: 800, letterSpacing: '-0.4px', lineHeight: 1.18, marginTop: 8, maxWidth: 200, color: 'var(--text-primary)' }}>Pay with MeshPort &amp; win real USDC</h2>
        <button type="button" onClick={() => navigate('/pay')} className="mp-press"
          style={{ position: 'absolute', left: 16, bottom: 16, display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--brand)', color: '#fff', fontSize: 13.5, fontWeight: 800, padding: '9px 16px', borderRadius: 999, border: 'none', cursor: 'pointer' }}>
          Pay now →
        </button>
        <div aria-hidden style={{ position: 'absolute', right: 8, top: 18, width: 150, height: 140 }}>
          <Coin gold size={58} left={6} top={6} font={22} />
          <Coin size={92} left={40} top={20} font={38} />
          <Coin gold size={44} left={104} top={2} font={18} />
        </div>
        <span style={{ position: 'absolute', right: 14, bottom: 16, background: '#fff', color: USDC_BLUE, fontSize: 11.5, fontWeight: 800, padding: '6px 10px', borderRadius: 999, boxShadow: '0 4px 10px rgba(0,0,0,.08)' }}>Real USDC rewards</span>
      </div>

      {/* Balances */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, margin: `26px ${m}px 0` }}>
        {tile(usdcTile, <CountUp value={usdcMicro} format={v => fmtUsdcMicro(Math.round(v))} />, 'USDC won', USDC_BLUE,
          ready && claimPts > 0 ? (
            <button type="button" disabled={claiming} onClick={e => { e.stopPropagation(); if (onOpenUsdc) onOpenUsdc(); else onClaimUsdc(claimPts) }}
              style={{ position: 'absolute', top: -11, left: '50%', transform: 'translateX(-50%)', whiteSpace: 'nowrap', fontSize: 11.5, fontWeight: 800, padding: '3px 10px', borderRadius: 7, background: USDC_BLUE, color: '#fff', border: 'none', cursor: 'pointer', opacity: claiming ? 0.6 : 1 }}>
              {claiming ? 'Claiming…' : 'Claim'}
            </button>
          ) : undefined, onOpenUsdc)}
        {tile(ptsTile, <CountUp value={ptsHold ?? totalPoints} format={v => Math.round(v).toLocaleString()} />, 'Points', 'var(--brand-text)',
          ready && onClaimPoints ? (
            <button type="button" disabled={claiming} onClick={e => { e.stopPropagation(); onClaimPoints() }}
              style={{ position: 'absolute', top: -11, left: '50%', transform: 'translateX(-50%)', whiteSpace: 'nowrap', fontSize: 11.5, fontWeight: 800, padding: '3px 10px', borderRadius: 7, background: 'var(--brand)', color: '#fff', border: 'none', cursor: 'pointer', opacity: claiming ? 0.6 : 1 }}>
              Claim
            </button>
          ) : undefined, onOpenPoints)}
        {tile(null, cards?.length ?? 0, 'Scratch cards', 'var(--brand-text)', undefined,
          () => bandRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }))}
      </div>
      {/* Lifetime earned: all the USDC won and points earned, ever. */}
      <div style={{ margin: `16px ${m}px 0`, background: 'var(--surface)', border: '1px solid var(--soft-edge)', boxShadow: 'var(--soft-card)', borderRadius: 20,
        display: 'grid', gridTemplateColumns: '1fr 1px 1fr', alignItems: 'center', padding: '14px 6px' }}>
        <div style={{ textAlign: 'center' }}>
          <small style={{ display: 'block', fontSize: 11.5, color: 'var(--text-secondary)', fontWeight: 700, letterSpacing: '.02em' }}>LIFETIME USDC EARNED</small>
          <b style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 26, fontSize: 19, fontWeight: 800, marginTop: 3, color: USDC_BLUE }}>
            {ready ? fmtUsdcMicro(usdcLifetime) : <Skeleton style={{ width: 64, height: 19, borderRadius: 7 }} />}
          </b>
        </div>
        <span aria-hidden style={{ background: 'var(--border)', height: 34 }} />
        <div style={{ textAlign: 'center' }}>
          <small style={{ display: 'block', fontSize: 11.5, color: 'var(--text-secondary)', fontWeight: 700, letterSpacing: '.02em' }}>LIFETIME POINTS EARNED</small>
          <b style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 26, fontSize: 19, fontWeight: 800, marginTop: 3, color: 'var(--brand-text)' }}>
            {ready ? (lifetimePoints ?? 0).toLocaleString() : <Skeleton style={{ width: 52, height: 19, borderRadius: 7 }} />}
          </b>
        </div>
      </div>
      {!ready && (
        <div aria-hidden style={{ margin: `10px ${m}px 0`, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          {[96, 132, 96].map((w, i) => <Skeleton key={i} style={{ width: w, height: 28, borderRadius: 999 }} />)}
        </div>
      )}
      {ready && today && (
        <div style={{ margin: `10px ${m}px 0`, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          {[
            ['Today', `${Math.min(today.points, today.pointsLimit)} / ${today.pointsLimit} pts`],
            ['USDC today', `${fmtUsdcMicro(Math.min(today.usdcMicro, today.usdcLimitMicro))} / ${fmtUsdcMicro(today.usdcLimitMicro)}`],
            ['Cards today', `${Math.min(today.cards, today.cardsLimit)} / ${today.cardsLimit}`],
          ].map(([k, v]) => (
            <span key={k} style={{ fontSize: 12, padding: '6px 10px', borderRadius: 999, background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', color: 'var(--text-secondary)' }}>
              {k} <b style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{v}</b>
            </span>
          ))}
        </div>
      )}
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: `10px ${m + 4}px 0`, textAlign: 'center' }}>
        {usdcMicro > 0 && claimPts === 0
          ? `Claim your USDC to your wallet from ${fmtUsdcMicro(MIN_USDC_CLAIM_MICRO)}`
          : 'USDC you win is claimed straight to your MeshPort wallet'}
      </p>

      {/* Cards waiting to be scratched. None: the last wins and why (approved
          preview, 18 Nov 2026) - all 10 won today, or pay to win one; a new
          user who has never scratched gets a slim strip. */}
      {ready && cards !== null && cards.length === 0 && wins !== null && wins.length === 0 && !limitHit ? (
        <div ref={bandRef} style={{ marginTop: 22, background: BAND, padding: '14px 16px', borderRadius: isDesktop ? 18 : 0, display: 'flex', alignItems: 'center', gap: 12 }}>
          <span aria-hidden style={{ width: 40, height: 40, borderRadius: 12, flex: 'none', display: 'grid', placeItems: 'center', background: 'rgba(255,224,138,.15)' }}>
            <Gift size={20} color="#FFE08A" />
          </span>
          <div style={{ flex: 1, minWidth: 0, color: 'rgba(255,255,255,.8)', fontSize: 13.5, lineHeight: 1.35 }}>
            <b style={{ display: 'block', color: '#fff', fontSize: 14.5 }}>Win scratch cards</b>
            Every payment wins one - points or real USDC
          </div>
          <button type="button" onClick={() => navigate('/pay')} className="mp-press"
            style={{ flex: 'none', background: '#fff', color: 'var(--brand)', fontWeight: 800, fontSize: 13, padding: '8px 14px', borderRadius: 999, border: 'none', cursor: 'pointer' }}>Pay now</button>
        </div>
      ) : (
      <div ref={bandRef} style={{ marginTop: 22, background: BAND, padding: '18px 0 18px', borderRadius: isDesktop ? 18 : 0 }}>
        <h3 style={{ color: '#fff', fontSize: 15, fontWeight: 800, letterSpacing: '.04em', padding: ready && cards && cards.length === 0 ? '0 16px 6px' : '0 16px 14px' }}>SCRATCH &amp; CLAIM YOUR REWARDS</h3>
        {ready && cards !== null && cards.length === 0 ? (<>
          <div style={{ color: 'rgba(255,255,255,.75)', fontSize: 13.5, padding: '0 16px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            {limitHit
              ? <span>You've won all <b style={{ color: '#fff' }}>{today?.cardsLimit ?? 10} cards</b> today · new cards after 00:00 UTC</span>
              : <span>No cards right now · <b style={{ color: '#fff' }}>every payment wins one</b></span>}
            {!limitHit && (
              <button type="button" onClick={() => navigate('/pay')} className="mp-press"
                style={{ flex: 'none', background: '#fff', color: 'var(--brand)', fontWeight: 800, fontSize: 13, padding: '8px 14px', borderRadius: 999, border: 'none', cursor: 'pointer' }}>Pay now</button>
            )}
          </div>
          {!!wins?.length && (<>
            <div style={{ color: 'rgba(255,255,255,.55)', fontSize: 11.5, fontWeight: 800, letterSpacing: '.06em', padding: '4px 16px 8px' }}>YOUR LAST WINS</div>
            <div className="sr-strip" style={{ display: 'flex', gap: 10, overflowX: 'auto', padding: '0 16px' }}>
              {wins.map(w => {
                const usdc = w.kind === 'usdc'
                return (
                  <div key={w.id} style={{ flex: '0 0 96px', height: 104, borderRadius: 12, background: 'rgba(255,255,255,.07)', border: '1px solid rgba(255,255,255,.12)',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 4 }}>
                    <i style={{ width: 30, height: 30, borderRadius: '50%', display: 'grid', placeItems: 'center', fontStyle: 'normal', fontWeight: 900, fontSize: 14,
                      background: usdc ? USDC_BLUE : '#F5B82E', color: usdc ? '#fff' : '#7A5200' }}>{usdc ? '$' : '★'}</i>
                    <b style={{ color: '#fff', fontSize: 15, fontWeight: 800 }}>{usdc ? fmtUsdcMicro(w.usdcMicro) : `${w.points} pts`}</b>
                    <small style={{ color: 'rgba(255,255,255,.55)', fontSize: 11 }}>{usdc ? 'USDC · ' : ''}{timeAgo(w.scratchedAt)}</small>
                  </div>
                )
              })}
            </div>
          </>)}
        </>) : (
        <div className="sr-strip" style={{ display: 'flex', gap: 12, overflowX: 'auto', padding: '0 16px' }}>
          {!ready || cards === null
            ? [0, 1, 2].map(i => <div key={i} className="mp-skel" aria-hidden style={{ flex: '0 0 140px', height: 210, borderRadius: '10px 10px 0 0', ['--skel-fill' as string]: 'rgba(255,255,255,.08)' }} />)
            : cards.map((c, i) => <TallCard key={c.id} look={i % LOOKS.length} onClick={() => setOpen({ id: c.id, look: i % LOOKS.length })} />)}
        </div>
        )}
      </div>
      )}

      {/* Active offers: activate, fill the ring, win a USDC card */}
      <ActiveOffers margin={m} refreshKey={refreshKey + (cards?.length ?? 0)} />

      {/* Ways to earn more */}
      <div style={{ margin: `26px ${m}px 8px`, background: 'var(--surface)', border: '1px solid var(--soft-edge)', boxShadow: 'var(--soft-card)', borderRadius: 24, padding: '18px 0 18px 14px' }}>
        <h4 style={{ fontSize: 21, fontWeight: 800, letterSpacing: '-0.3px', marginBottom: 4, paddingLeft: 4, color: 'var(--text-primary)' }}>Ways to earn more</h4>
        <div className="sr-strip" style={{ display: 'flex', gap: 10, overflowX: 'auto', padding: '38px 14px 0 0' }}>
          {earn.map(e => (
            <button key={e.to} type="button" onClick={() => navigate(e.to)} className="mp-press"
              style={{ position: 'relative', flex: '0 0 132px', height: 178, borderRadius: 14, padding: '40px 8px 0', textAlign: 'center', color: '#fff', background: e.bg, border: 'none', cursor: 'pointer', fontFamily: 'inherit', marginTop: 0 }}>
              <span style={{ position: 'absolute', top: -32, left: '50%', transform: 'translateX(-50%)', width: 64, height: 64, borderRadius: '50%', background: 'var(--surface)', boxShadow: '0 4px 12px rgba(0,0,0,.12)', display: 'grid', placeItems: 'center' }}>
                <span style={{ width: 44, height: 44, borderRadius: '50%', display: 'grid', placeItems: 'center', background: e.soft, color: e.bg }}><e.Icon size={22} strokeWidth={2.2} /></span>
              </span>
              <small style={{ display: 'block', fontSize: 12, fontWeight: 800, letterSpacing: '.05em', opacity: 0.9 }}>{e.k}</small>
              <b style={{ display: 'block', fontSize: 13.5, fontWeight: 700, marginTop: 6, lineHeight: 1.3 }}>{e.line}</b>
              <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: 9, fontSize: 13, fontWeight: 800, background: 'rgba(0,0,0,.22)', borderRadius: '0 0 14px 14px' }}>Try now →</span>
            </button>
          ))}
        </div>
      </div>

      {open && <ScratchModal key={open.id} id={open.id} look={open.look}
        onDone={(prize, from) => landed(open.id, prize, from)}
        onClose={(prize) => { setOpen(null); if (prize) { if (prize.kind === 'points' && !prize.already) onPointsWon(prize.points); void load() } }} />}
    </div>
  )
}

function Coin({ gold, size, left, top, font }: { gold?: boolean; size: number; left: number; top: number; font: number }) {
  return (
    <div style={{ position: 'absolute', width: size, height: size, left, top, fontSize: font, borderRadius: '50%', display: 'grid', placeItems: 'center', fontWeight: 900,
      boxShadow: '0 8px 18px rgba(0,0,0,.18), inset 0 -5px 0 rgba(0,0,0,.12)',
      ...(gold
        ? { background: 'radial-gradient(circle at 32% 28%, #FFE79A, #F5B82E 70%)', color: '#8A5A00', border: '4px solid #FFF3CC' }
        : { background: `radial-gradient(circle at 32% 28%, #7DB6F5, ${USDC_BLUE} 70%)`, color: '#fff', border: '4px solid #DCEBFB' }) }}>
      {gold ? '★' : '$'}
    </div>
  )
}

function TallCard({ look, onClick }: { look: number; onClick: () => void }) {
  const L = LOOKS[look]
  return (
    <button type="button" onClick={onClick} aria-label="Scratch card - tap to scratch" className="mp-press"
      style={{ flex: '0 0 140px', height: 210, borderRadius: '10px 10px 0 0', position: 'relative', overflow: 'hidden', cursor: 'pointer', padding: 7, border: 'none', background: L.bg }}>
      <span style={{ position: 'absolute', inset: 0, background: 'repeating-conic-gradient(from 0deg at 50% 62%, rgba(255,255,255,.10) 0 10deg, transparent 10deg 20deg)' }} />
      <span style={{ position: 'absolute', inset: '7px 7px 0', border: '2px dotted rgba(255,255,255,.55)', borderBottom: 0, borderRadius: '6px 6px 0 0' }} />
      <span style={{ position: 'absolute', left: '50%', bottom: 30, transform: 'translateX(-50%)', width: 108, height: 92, borderRadius: '54px 54px 12px 12px', background: 'rgba(8,24,22,.82)', border: '3px solid rgba(255,255,255,.75)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 10 }}>
        <span style={{ position: 'absolute', top: -22, width: 40, height: 40, borderRadius: '50%', background: 'rgb(8,24,22)', border: '3px solid rgba(255,255,255,.75)', display: 'grid', placeItems: 'center' }}>
          <Gift size={20} color="#FFE08A" strokeWidth={2.2} />
        </span>
        <b style={{ color: '#FFE08A', fontSize: 17, fontWeight: 900, letterSpacing: '.02em', lineHeight: 1, textShadow: '0 2px 0 rgba(0,0,0,.4)', fontStyle: 'italic' }}>SCRATCH<br />CARD</b>
      </span>
      <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 30, display: 'grid', placeItems: 'center', fontSize: 13.5, fontWeight: 700, color: '#1B1D1F', background: L.strip }}>Points or USDC</span>
    </button>
  )
}

/** The card, big: the server reveals (and credits) its prize as it opens;
 *  rubbing off half the coat shows it, then it flies to its balance. */
function ScratchModal({ id, look, onDone, onClose }: {
  id: string; look: number
  onDone: (prize: ScratchPrize, from: DOMRect | null) => void
  onClose: (prize: ScratchPrize | null) => void
}) {
  const [prize, setPrize] = useState<ScratchPrize | null>(null)
  const [cleared, setCleared] = useState(false)
  const [after, setAfter] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const iconRef = useRef<HTMLDivElement>(null)
  const prizeRef = useRef<ScratchPrize | null>(null)
  const finished = useRef(false)
  // The card is only opened (prize revealed and credited by the server) once
  // the person starts rubbing it - tapping it, or closing it unscratched,
  // leaves it waiting.
  const asked = useRef(false)
  const live = useRef(true)
  useEffect(() => () => { live.current = false }, [])
  const reveal = useCallback(() => {
    if (asked.current) return
    asked.current = true
    scratchCard(id).then(p => { if (live.current) { prizeRef.current = p; setPrize(p) } }).catch(() => {
      if (!live.current) return
      useUIStore.getState().showToastMessage("Couldn't open this card - try again", 'error')
      finished.current = true
      onClose(null)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Revealed (half rubbed off) and the prize known: say where it went, then fly.
  useEffect(() => {
    if (!cleared || !prize || finished.current) return
    setAfter(true)
    const t = setTimeout(() => { finished.current = true; onDone(prize, iconRef.current?.getBoundingClientRect() ?? null) }, 900)
    return () => clearTimeout(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleared, prize])

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    // Layout size (offsetWidth ignores the pop-in's scale transform).
    const r = { width: cv.offsetWidth || 250, height: cv.offsetHeight || 250 }, dpr = window.devicePixelRatio || 1
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr)
    const c = cv.getContext('2d', { willReadFrequently: true })
    if (!c) return
    c.scale(dpr, dpr)
    const [a, b] = LOOKS[look].coat
    const g = c.createLinearGradient(0, 0, r.width, r.height); g.addColorStop(0, a); g.addColorStop(1, b)
    c.fillStyle = g; c.fillRect(0, 0, r.width, r.height)
    c.save(); c.translate(r.width / 2, r.height / 2); c.fillStyle = 'rgba(255,255,255,.09)'
    for (let i = 0; i < 18; i++) { c.rotate(Math.PI / 9); c.beginPath(); c.moveTo(0, 0); c.lineTo(-14, -r.width); c.lineTo(14, -r.width); c.fill() }
    c.restore()
    c.strokeStyle = 'rgba(255,255,255,.6)'; c.setLineDash([2, 5]); c.lineWidth = 2; c.strokeRect(10, 10, r.width - 20, r.height - 20); c.setLineDash([])
    c.fillStyle = '#FFE08A'; c.font = 'italic 900 26px system-ui, sans-serif'; c.textAlign = 'center'
    c.fillText('SCRATCH', r.width / 2, r.height / 2 - 2); c.fillText('HERE', r.width / 2, r.height / 2 + 28)
    c.globalCompositeOperation = 'destination-out'; c.strokeStyle = '#000'; c.fillStyle = '#000'
    // Only the person's own rubbing clears it: a finger (or mouse button)
    // held down and moved. The tap that opened the card is ignored.
    const opened = performance.now()
    let down = false, done = false, last: { x: number; y: number } | null = null, rubbed = 0
    const scratch = (e: PointerEvent) => {
      if (!down || done) return
      const bb = cv.getBoundingClientRect()
      const k = r.width / (bb.width || r.width)
      const x = (e.clientX - bb.left) * k, y = (e.clientY - bb.top) * k
      if (last) {
        rubbed += Math.hypot(x - last.x, y - last.y)
        c.lineWidth = 36; c.lineCap = 'round'
        c.beginPath(); c.moveTo(last.x, last.y); c.lineTo(x, y); c.stroke()
      }
      last = { x, y }
      if (rubbed < 12) return
      reveal()
      const px = c.getImageData(0, 0, cv.width, cv.height).data
      let clear = 0
      for (let i = 3; i < px.length; i += 64) if (px[i] === 0) clear++
      if (clear / (px.length / 64) > 0.55) {
        done = true
        cv.style.transition = 'opacity .3s'; cv.style.opacity = '0'
        setCleared(true)
      }
    }
    const onDown = (e: PointerEvent) => {
      if (performance.now() - opened < 300) return
      down = true; last = null
      try { cv.setPointerCapture(e.pointerId) } catch { /* fine */ }
      scratch(e)
    }
    const onUp = () => { down = false; last = null }
    cv.addEventListener('pointerdown', onDown)
    cv.addEventListener('pointermove', scratch)
    cv.addEventListener('pointerup', onUp)
    cv.addEventListener('pointercancel', onUp)
    return () => {
      cv.removeEventListener('pointerdown', onDown)
      cv.removeEventListener('pointermove', scratch)
      cv.removeEventListener('pointerup', onUp)
      cv.removeEventListener('pointercancel', onUp)
    }
  }, [look, reveal])

  const usdc = prize?.kind === 'usdc'
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Scratch card" style={{ position: 'fixed', inset: 0, zIndex: 1100, display: 'grid', placeItems: 'center' }}>
      <div onClick={() => { if (!finished.current) { finished.current = true; onClose(prizeRef.current) } }}
        style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.6)' }} />
      <div className="sr-modal" style={{ position: 'relative', textAlign: 'center', color: '#fff' }}>
        <p style={{ fontSize: 15, fontWeight: 800, marginBottom: 14 }}>Scratch to reveal your reward</p>
        <div style={{ width: 250, height: 250, borderRadius: 24, position: 'relative', overflow: 'hidden', background: 'var(--surface)', boxShadow: '0 20px 50px rgba(0,0,0,.4)', display: 'grid', placeItems: 'center', color: 'var(--text-primary)' }}>
          {prize && prize.kind === 'none' && (
            <div style={{ padding: '0 18px' }}>
              <div style={{ width: 64, height: 64, borderRadius: '50%', margin: '0 auto 10px', display: 'grid', placeItems: 'center', fontSize: 32,
                background: 'color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>🍀</div>
              <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-.4px', color: 'var(--text-primary)' }}>Better luck next time</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>No prize on this card</div>
            </div>
          )}
          {prize && prize.kind !== 'none' && (
            <div>
              <div ref={iconRef} style={{ width: 64, height: 64, borderRadius: '50%', margin: '0 auto 10px', display: 'grid', placeItems: 'center', fontWeight: 900, fontSize: 26,
                background: usdc ? USDC_BLUE : '#F5B82E', color: usdc ? '#fff' : '#7A5200' }}>{usdc ? '$' : '★'}</div>
              <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: '-1px', color: usdc ? USDC_BLUE : 'var(--brand-text)' }}>
                {usdc ? fmtUsdcMicro(prize.usdcMicro) : prize.points}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>{usdc ? 'USDC cashback' : 'points'}</div>
            </div>
          )}
          <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', touchAction: 'none', cursor: 'grab' }} />
        </div>
        <div style={{ marginTop: 14, fontSize: 13.5, opacity: after ? 0.95 : 0, transition: 'opacity .3s', minHeight: 20 }}>
          {prize && (prize.kind === 'none' ? 'Keep paying with MeshPort to win more cards' : usdc ? 'Added to your USDC - claim it to your wallet anytime' : 'Added to your points')}
        </div>
      </div>
    </div>,
    document.body,
  )
}
