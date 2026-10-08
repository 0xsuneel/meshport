import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import type { NavigateFunction } from 'react-router-dom'
import { useAuthStore } from '@/store'
import { fetchRecentContacts, recentInitial, recentShortName, recentSendTarget, RECENT_AVATAR_COLORS, type RecentContact } from '@/lib/recentContacts'
import { NewsArt } from '@/features/news/NewsArt'
import { fetchHomeNews, readCachedHomeNews, NEWS_SOURCE_LABEL, NEWS_SOURCE_TINT, type NewsItem } from '@/lib/news'

// ── Home: Recent + News, side by side ───────────────────────────────────────
// Two equal boxes under the feature banner (mobile Home), each with a 64px
// content row.
//
// Recent: the last 5 people you paid. One sits in front on the right; the rest
// wait in a queue to its left and step forward one at a time (a countdown ring
// fills around the front avatar first). Tap the front avatar → Pay them.
// With 1–3 people the left side would be empty, so the front person's name
// shows there instead.
//
// News: the latest 4 stories, one at a time, cross-fading every 5 s: the cover
// on top, a one-line headline under it. Swipe to move, tap to open the short
// article.

// Cover (46) + gap (4) + one-line headline (14) in the News box; Recent uses
// the same height so the two boxes line up.
const CONTENT_H = 64
const NEWS_PIC_H = 46
const AVATAR = 44
const QUEUE_STEP_MS = 2600
const NEWS_STEP_MS = 5000

function Box({ title, onViewAll, children }: { title: string; onViewAll?: () => void; children: ReactNode }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 10, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>{title}</span>
        {onViewAll && (
          <button onClick={onViewAll}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 1, padding: '4px 0 4px 6px', margin: '-4px 0',
              background: 'none', border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: 'var(--brand-text)', whiteSpace: 'nowrap' }}>
            View all
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6"/></svg>
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

function Face({ c, i, size = AVATAR }: { c: RecentContact; i: number; size?: number }) {
  const [ok, setOk] = useState(true)
  const base = { width: size, height: size, borderRadius: '50%', border: '2px solid var(--surface)', boxSizing: 'border-box' as const }
  if (c.avatar_url && ok) {
    return <img src={c.avatar_url} alt="" draggable={false} onError={() => setOk(false)} style={{ ...base, objectFit: 'cover', display: 'block' }} />
  }
  return (
    <div style={{ ...base, background: RECENT_AVATAR_COLORS[i % RECENT_AVATAR_COLORS.length], display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.36, fontWeight: 700, color: '#fff' }}>
      {recentInitial(c)}
    </div>
  )
}

const FRONT_SHADOW = '0 6px 16px -6px color-mix(in srgb, var(--brand) 60%, transparent), 0 2px 4px rgba(0,0,0,0.08)'

// Slot 0 = front (right edge, full size); the queue fans out to the left,
// each place smaller and quieter. Short queues (≤3) overlap more so the
// front person's name fits beside them.
function slotPose(slot: number, right: number, n: number) {
  if (slot === 0) return { x: right, scale: 1, opacity: 1 }
  const [first, step] = n <= 3 ? [24, 12] : [30, 16]
  return { x: right - first - (slot - 1) * step, scale: 0.76 - (slot - 1) * 0.07, opacity: 0.95 - (slot - 1) * 0.18 }
}

/** Left edge of the queue as drawn (avatars shrink around their centre). */
function queueLeftEdge(n: number, right: number) {
  const back = slotPose(n - 1, right, n)
  return back.x + (AVATAR * (1 - back.scale)) / 2
}

function RecentBox({ navigate }: { navigate: NavigateFunction }) {
  const walletAddress = useAuthStore(s => s.walletAddress)
  const reduce = useReducedMotion()
  // Same cache key as the Home Recent row used, so the list is there instantly.
  const cacheKey = walletAddress ? `meshport_recents_${walletAddress.toLowerCase()}_5` : ''
  const [people, setPeople] = useState<RecentContact[]>(() => {
    try { const c = cacheKey ? JSON.parse(localStorage.getItem(cacheKey) || 'null') : null; return Array.isArray(c) ? c : [] } catch { return [] }
  })
  const [loaded, setLoaded] = useState(() => { try { return !!cacheKey && localStorage.getItem(cacheKey) != null } catch { return false } })

  useEffect(() => {
    if (!walletAddress) return
    let cancelled = false
    fetchRecentContacts(walletAddress, { activityLimit: 20, maxAddresses: 10, resultLimit: 5 })
      .then(list => {
        if (cancelled) return
        setPeople(list)
        try { if (cacheKey) localStorage.setItem(cacheKey, JSON.stringify(list)) } catch { /* storage full */ }
      })
      .catch(e => console.error('RecentBox load error:', e))
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [walletAddress, cacheKey])

  const n = people.length
  // order[slot] = index into people; order[0] is in front.
  const [order, setOrder] = useState<number[]>([])
  const [step, setStep] = useState(0)
  const [paused, setPaused] = useState(false)
  // Bumped on every release after a press, so the timer and the ring restart together.
  const [resumes, setResumes] = useState(0)
  const pausedRef = useRef(false)
  const hold = () => { pausedRef.current = true; setPaused(true) }
  const release = () => { if (!pausedRef.current) return; pausedRef.current = false; setPaused(false); setResumes(r => r + 1) }
  const peopleKey = people.map(p => p.wallet_address).join(',')
  useEffect(() => { setOrder(people.map((_, i) => i)); setStep(0) }, [peopleKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const rotating = n >= 2 && !reduce
  useEffect(() => {
    if (!rotating || paused) return
    const t = setTimeout(() => {
      if (document.visibilityState !== 'visible') { setStep(s => s + 1); return }
      setOrder(o => o.length > 1 ? [...o.slice(1), o[0]] : o)
      setStep(s => s + 1)
    }, QUEUE_STEP_MS)
    return () => clearTimeout(t)
  }, [rotating, paused, step, resumes])

  const areaRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [loaded, n])

  const front = order.length ? people[order[0]] : people[0]
  const pay = (c: RecentContact | undefined) => {
    if (c) navigate(`/pay?to=${encodeURIComponent(recentSendTarget(c))}`, { state: { returnTo: '/' } })
  }

  let content: ReactNode
  if (!loaded && n === 0) {
    content = (
      <div style={{ height: CONTENT_H, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 6 }}>
        <div style={{ width: AVATAR, height: AVATAR, borderRadius: '50%', background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)' }} />
      </div>
    )
  } else if (n === 0) {
    content = (
      <button onClick={() => navigate('/pay')}
        style={{ height: CONTENT_H, width: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-start', gap: 2,
          background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)' }}>No one yet</span>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--brand-text)' }}>Pay someone ›</span>
      </button>
    )
  } else {
    const right = Math.max(0, width - 50)
    const leftmost = queueLeftEdge(n, right)
    content = (
      <div ref={areaRef} role="button" tabIndex={0} aria-label={front ? `Pay ${recentShortName(front)}` : 'Pay'}
        onClick={() => pay(front)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pay(front) } }}
        onPointerDown={hold} onPointerUp={release} onPointerLeave={release} onPointerCancel={release}
        style={{ position: 'relative', height: CONTENT_H, cursor: 'pointer', WebkitTapHighlightColor: 'transparent', touchAction: 'pan-y' }}>
        {n <= 3 && front && width > 0 && (
          // Who is in front, for short queues. Re-keyed per person so it fades between names.
          <motion.div key={front.wallet_address} initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}
            style={{ position: 'absolute', left: 0, top: 0, bottom: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center',
              maxWidth: Math.max(0, leftmost - 4), minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{recentShortName(front)}</span>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--brand-text)', whiteSpace: 'nowrap' }}>Tap to pay</span>
          </motion.div>
        )}
        {width > 0 && people.map((c, i) => {
          const slot = Math.max(0, order.indexOf(i))
          const pose = slotPose(slot, right, n)
          const justLeftFront = rotating && step > 0 && slot === n - 1
          return (
            <motion.div key={c.wallet_address}
              initial={false}
              animate={justLeftFront
                // Lifts off the front, then reappears quietly at the back of the queue.
                ? { x: [right, right + 6, pose.x, pose.x], y: [0, -10, 0, 0], scale: [1, 0.6, pose.scale * 0.8, pose.scale], opacity: [1, 0, 0, pose.opacity] }
                : { ...pose, y: 0 }}
              transition={justLeftFront
                ? { duration: 0.8, times: [0, 0.45, 0.47, 1], ease: 'easeOut' }
                : { type: 'spring', stiffness: 260, damping: 22, delay: reduce ? 0 : slot * 0.045 }}
              style={{ position: 'absolute', left: 0, top: (CONTENT_H - AVATAR) / 2, width: AVATAR, height: AVATAR, zIndex: 10 - slot,
                borderRadius: '50%', boxShadow: slot === 0 ? FRONT_SHADOW : 'none',
                filter: slot === 0 ? 'none' : `saturate(${0.75 - (slot - 1) * 0.1}) brightness(${1.04 + (slot - 1) * 0.04})`,
                transition: 'box-shadow .6s ease, filter .6s ease', transformOrigin: 'center' }}>
              <Face c={c} i={i} />
            </motion.div>
          )
        })}
        {rotating && width > 0 && (
          // Countdown ring: fills around the front avatar, then the next person steps forward.
          <svg key={`${step}-${resumes}`} viewBox="0 0 54 54" aria-hidden
            style={{ position: 'absolute', left: right - 5, top: (CONTENT_H - 54) / 2, width: 54, height: 54, zIndex: 20, pointerEvents: 'none', transform: 'rotate(-90deg)' }}>
            <circle cx="27" cy="27" r="25" fill="none" strokeWidth="2.2" stroke="color-mix(in srgb, var(--brand) 14%, transparent)" />
            <circle cx="27" cy="27" r="25" fill="none" strokeWidth="2.2" strokeLinecap="round" stroke="var(--brand)"
              strokeDasharray="157" strokeDashoffset="157"
              style={{ animation: `mpRingFill ${QUEUE_STEP_MS}ms linear forwards`, animationPlayState: paused ? 'paused' : 'running' }} />
          </svg>
        )}
      </div>
    )
  }

  return <Box title="Recent" onViewAll={n > 0 ? () => navigate('/recent-paid') : undefined}>{content}</Box>
}

function NewsBox({ navigate }: { navigate: NavigateFunction }) {
  const reduce = useReducedMotion()
  const [items, setItems] = useState<NewsItem[]>(() => readCachedHomeNews())
  const [loaded, setLoaded] = useState(() => items.length > 0)
  const [cur, setCur] = useState(0)
  const [paused, setPaused] = useState(false)
  const [broken, setBroken] = useState<Record<string, true>>({})

  useEffect(() => {
    let cancelled = false
    fetchHomeNews(4).then(list => { if (!cancelled) { setItems(list); setCur(0) } }).finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [])

  const n = items.length
  useEffect(() => {
    if (n < 2 || reduce || paused) return
    const t = setTimeout(() => { if (document.visibilityState === 'visible') setCur(c => (c + 1) % n) }, NEWS_STEP_MS)
    return () => clearTimeout(t)
  }, [n, reduce, paused, cur])

  const x0 = useRef<number | null>(null)
  const item = items[cur] ?? items[0]

  let content: ReactNode
  if (!n) {
    content = (
      <div style={{ height: CONTENT_H, borderRadius: 10, display: 'flex', alignItems: 'center', padding: '0 8px',
        background: loaded ? 'color-mix(in srgb, var(--text-primary) 4%, transparent)' : 'color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
        {loaded && <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.3 }}>Arc, Circle and MeshPort updates show here</span>}
      </div>
    )
  } else {
    content = (
      <div role="link" tabIndex={0} aria-label={item?.title}
        onPointerDown={e => { x0.current = e.clientX; setPaused(true) }}
        onPointerUp={e => {
          const dx = e.clientX - (x0.current ?? e.clientX)
          x0.current = null; setPaused(false)
          if (Math.abs(dx) > 30 && n > 1) { setCur(c => (c + (dx < 0 ? 1 : -1) + n) % n); return }
          if (item) navigate(`/news/${item.id}`)
        }}
        onPointerLeave={() => { x0.current = null; setPaused(false) }}
        onPointerCancel={() => { x0.current = null; setPaused(false) }}
        onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && item) { e.preventDefault(); navigate(`/news/${item.id}`) } }}
        style={{ position: 'relative', height: CONTENT_H, cursor: 'pointer',
          touchAction: 'pan-y', userSelect: 'none', WebkitTapHighlightColor: 'transparent' }}>
        {items.map((it, k) => {
          const on = k === cur
          return (
            <div key={it.id} aria-hidden={!on}
              style={{ position: 'absolute', inset: 0, opacity: on ? 1 : 0, transition: reduce ? 'none' : 'opacity .7s ease' }}>
              {/* The cover is shown as is: Arc's covers carry their own title text
                  and Circle's are white, so nothing is drawn over it but the label. */}
              <div style={{ position: 'relative', height: NEWS_PIC_H, borderRadius: 10, overflow: 'hidden', background: NEWS_SOURCE_TINT[it.source] }}>
                {it.image_url && !broken[it.id] ? (
                  <>
                    <img src={it.image_url} alt="" draggable={false} loading={k === 0 ? 'eager' : 'lazy'}
                      onError={() => setBroken(b => ({ ...b, [it.id]: true }))}
                      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover',
                        transform: on || reduce ? 'scale(1)' : 'scale(1.08)', transition: reduce ? 'none' : 'transform 5.5s cubic-bezier(.2,.6,.3,1)' }} />
                    <span style={{ position: 'absolute', top: 4, left: 4, background: 'rgba(0,0,0,0.45)', borderRadius: 999, padding: '1px 7px',
                      color: '#fff', fontSize: 9.5, fontWeight: 700, lineHeight: '15px' }}>{NEWS_SOURCE_LABEL[it.source]}</span>
                  </>
                ) : (
                  // No picture: a drawn cover (icon + label) instead of an empty block.
                  <NewsArt item={it} variant="row" />
                )}
              </div>
              <div style={{ marginTop: 4, fontSize: 11.5, fontWeight: 650, lineHeight: '14px', color: 'var(--text-primary)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {it.title}
              </div>
            </div>
          )
        })}
        {n > 1 && (
          // Bottom-right of the cover, clear of the source label and of a drawn cover's text.
          <div aria-hidden style={{ position: 'absolute', top: NEWS_PIC_H - 13, right: 5, display: 'flex', gap: 3, padding: '2px 3px', borderRadius: 4, background: 'rgba(0,0,0,0.28)' }}>
            {items.map((it, k) => (
              <i key={it.id} style={{ display: 'block', height: 4, width: k === cur ? 10 : 4, borderRadius: 2,
                background: k === cur ? '#fff' : 'rgba(255,255,255,0.5)', transition: 'width .35s ease, background .35s' }} />
            ))}
          </div>
        )}
      </div>
    )
  }

  return <Box title="Updates" onViewAll={() => navigate('/news')}>{content}</Box>
}

export function RecentNewsRow({ navigate }: { navigate: NavigateFunction }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
      <style>{'@keyframes mpRingFill { to { stroke-dashoffset: 0 } }'}</style>
      <RecentBox navigate={navigate} />
      <NewsBox navigate={navigate} />
    </div>
  )
}
