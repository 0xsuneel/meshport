// The gift beside Share on the payment success page (approved preview, 18
// Nov): its badge is the number of scratch cards waiting. When this payment's
// card arrives (the server grants it when it confirms the payment, a few
// seconds after this page shows), it pops up - "You won a scratch card!" -
// then flies into the gift and the count goes up. Tap: the Rewards page.
// Personal accounts with Rewards on only (as the Rewards page).
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Gift } from 'lucide-react'
import { useSettingsStore } from '@/store/settingsStore'
import { useAuthStore } from '@/store'
import { useBusinessTab } from '@/lib/merchant'
import { fetchScratchCards, onCardCount } from '@/lib/scratchCards'

const SEEN_KEY = 'mp-scratch-seen'
const POLL_MS = 2500
const WATCH_MS = 40_000
// A card this recent that hasn't popped up yet is this payment's.
const RECENT_MS = 90_000

function seenIds(): Set<string> {
  try { return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) || '[]')) } catch { return new Set() }
}
function markSeen(ids: string[]) {
  try { sessionStorage.setItem(SEEN_KEY, JSON.stringify([...new Set([...seenIds(), ...ids])].slice(-60))) } catch { /* private mode */ }
}

export function ScratchGift({ watch = true }: { watch?: boolean }) {
  const navigate = useNavigate()
  const business = useBusinessTab()
  const rewardsOff = useSettingsStore(s => s.settings.rewards_enabled?.enabled === false)
  const signedIn = useAuthStore(s => !!s.user)
  const on = !business && !rewardsOff && signedIn

  const [count, setCount] = useState<number | null>(null)
  const [won, setWon] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const pulse = () => { const el = btn.current; if (!el) return; el.classList.remove('sg-pulse'); void el.offsetWidth; el.classList.add('sg-pulse') }

  useEffect(() => onCardCount(n => setCount(n)), [])

  useEffect(() => {
    if (!on) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const started = Date.now()
    let first = true
    const check = async () => {
      let list: { id: string; createdAt: string }[]
      try { list = await fetchScratchCards() } catch { list = [] }
      if (!live) return
      const seen = seenIds()
      const fresh = list.filter(c => !seen.has(c.id) && Date.now() - Date.parse(c.createdAt) < RECENT_MS)
      if (fresh.length) {
        markSeen(fresh.map(c => c.id))
        // The badge counts the new card only once it has landed in the gift.
        setCount(list.length - fresh.length)
        celebrate(list.length)
        return
      }
      if (first) { first = false; setCount(list.length); markSeen(list.map(c => c.id)) }
      if (watch && Date.now() - started < WATCH_MS) timer = setTimeout(check, POLL_MS)
    }
    const celebrate = (total: number) => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setCount(total); pulse(); return }
      setWon(true)
      timer = setTimeout(() => {
        if (!live) return
        const from = cardRef.current?.getBoundingClientRect(), to = btn.current?.getBoundingClientRect()
        setWon(false)
        if (!from || !to) { setCount(total); pulse(); return }
        const f = document.createElement('div')
        Object.assign(f.style, {
          position: 'fixed', left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, zIndex: '1300',
          borderRadius: '22px', background: 'linear-gradient(135deg, #12665F, #2BA393)', pointerEvents: 'none',
        })
        document.body.appendChild(f)
        const dx = (to.left + to.width / 2) - (from.left + from.width / 2), dy = (to.top + to.height / 2) - (from.top + from.height / 2)
        const a = f.animate([
          { transform: 'translate(0,0) scale(1)', borderRadius: '22px' },
          { transform: `translate(${dx * 0.55}px, ${dy * 0.45 - 40}px) scale(.45)`, offset: 0.55 },
          { transform: `translate(${dx}px, ${dy}px) scale(.1)`, borderRadius: '50%', opacity: 0.9 },
        ], { duration: 720, easing: 'cubic-bezier(.5,0,.2,1)' })
        a.onfinish = () => { f.remove(); if (live) { setCount(total); pulse() } }
      }, 1500)
    }
    void check()
    return () => { live = false; if (timer) clearTimeout(timer) }
  }, [on, watch])

  if (!on) return null
  const n = count ?? 0
  return (
    <>
      <style>{`.sg-pulse{animation:sgPulse .5s ease}@keyframes sgPulse{40%{transform:scale(1.25)}}`}</style>
      <button ref={btn} type="button" onClick={() => navigate('/rewards')} className="back-btn"
        aria-label={n ? `Rewards - ${n} scratch card${n === 1 ? '' : 's'} to scratch` : 'Rewards'} style={{ position: 'relative' }}>
        <Gift className="w-5 h-5 text-text-primary" />
        <span aria-hidden style={{ position: 'absolute', top: 0, right: -2, minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9, background: '#E5484D', color: '#fff',
          fontSize: 11, fontWeight: 800, lineHeight: '18px', textAlign: 'center', border: '2px solid var(--bg)', boxSizing: 'content-box',
          transform: n > 0 ? 'scale(1)' : 'scale(0)', transition: 'transform .25s cubic-bezier(.3,1.6,.5,1)' }}>{n > 49 ? '50+' : n}</span>
      </button>
      {won && createPortal(
        <div aria-live="polite" style={{ position: 'fixed', inset: 0, zIndex: 1250, display: 'grid', placeItems: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.45)' }} />
          <div className="sg-won" style={{ position: 'relative', width: 250, textAlign: 'center', color: '#fff' }}>
            <style>{`.sg-won{animation:sgIn .45s cubic-bezier(.3,1.5,.5,1) both}@keyframes sgIn{from{transform:scale(.6);opacity:0}to{transform:none;opacity:1}}`}</style>
            <p style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>You won a scratch card!</p>
            <div ref={cardRef} style={{ width: 200, height: 200, margin: '0 auto', borderRadius: 22, position: 'relative', overflow: 'hidden', display: 'grid', placeItems: 'center',
              background: 'linear-gradient(135deg, #12665F 0%, #1C8A7F 55%, #2BA393 100%)', boxShadow: '0 18px 40px rgba(0,0,0,.35)' }}>
              <span style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(115deg, rgba(255,255,255,.08) 0 12px, transparent 12px 24px)' }} />
              <span style={{ position: 'relative', width: 64, height: 64, borderRadius: 18, background: 'rgba(255,255,255,.18)', display: 'grid', placeItems: 'center' }}>
                <Gift size={34} color="#fff" strokeWidth={2} />
              </span>
              <small style={{ position: 'absolute', bottom: 16, left: 0, right: 0, fontSize: 12, fontWeight: 700, letterSpacing: '.04em', opacity: 0.9 }}>SAVED TO YOUR REWARDS</small>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
