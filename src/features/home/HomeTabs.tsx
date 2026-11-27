// ── Home (phone): Quick Actions / Updates tabs, and the Pay again card ──────
// One card under the balance (27 Nov) with two tabs side by side; the chosen
// one shows its single row underneath: Home's four actions + More, or the
// latest updates as cards to swipe. The row keeps one height on both tabs, so
// the page under it never jumps; the last tab used is remembered. Pay again
// (the last four people you paid, View all on the right) is its own card, under the ad.

import { useEffect, useState, type ReactNode } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import { useAuthStore } from '@/store'
import { useActivityChangedCount } from '@/lib/activityChanged'
import { useReconnectCount } from '@/lib/connectivity'
import { fetchRecentContacts, recentInitial, recentShortName, recentSendTarget, RECENT_AVATAR_COLORS, type RecentContact } from '@/lib/recentContacts'
import { fetchHomeNews, readCachedHomeNews, NEWS_SOURCE_LABEL, NEWS_SOURCE_TINT, type NewsItem } from '@/lib/news'
import { NewsArt } from '@/features/news/NewsArt'
import { ActionIcon, type ActionIconName } from '@/components/ui/ActionIcon'
import { LockBadge } from '@/components/LockedFeature'
import { Skeleton } from '@/components/ui/Skeleton'
import { timeAgo } from '@/lib/utils'

type Tab = 'actions' | 'updates'
const TABS: { id: Tab; label: string }[] = [
  { id: 'actions', label: 'Quick Actions' },
  { id: 'updates', label: 'Updates' },
]
const TAB_KEY = 'mp_home_tab'
const ROW_H = 76
const FACE = 44

function loadTab(): Tab {
  try { const v = localStorage.getItem(TAB_KEY); if (v === 'actions' || v === 'updates') return v } catch { /* none */ }
  return 'actions'
}

/** One of Home's actions: the icon on a soft tile of its tone, the name under it. */
export function TabAction({ icon, label, ariaLabel, tone, onClick, dot, locked }: {
  icon: ActionIconName; label: string; ariaLabel?: string; tone: 'peach' | 'mint' | 'butter'
  onClick: () => void; dot?: boolean; locked?: boolean
}) {
  return (
    <button type="button" onClick={onClick} aria-label={ariaLabel ?? label} className="mp-press"
      style={{ minWidth: 0, background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, opacity: locked ? 0.45 : 1 }}>
      <span style={{ position: 'relative', width: 46, height: 46, borderRadius: 15, background: `var(--tile-${tone})`, display: 'grid', placeItems: 'center' }}>
        <ActionIcon name={icon} size={26} color={`var(--tile-${tone}-ink)`} />
        {dot && <span aria-label="Open P2P trade" style={{ position: 'absolute', top: -3, right: -3, width: 11, height: 11, borderRadius: '50%', background: 'var(--danger)', border: '2px solid var(--surface)' }} />}
        {locked && <LockBadge />}
      </span>
      <span style={{ maxWidth: '100%', fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
    </button>
  )
}

function Face({ c, i }: { c: RecentContact; i: number }) {
  const [ok, setOk] = useState(true)
  const base = { width: FACE, height: FACE, borderRadius: '50%', flexShrink: 0 } as const
  if (c.avatar_url && ok) return <img decoding="async" src={c.avatar_url} alt="" draggable={false} onError={() => setOk(false)} style={{ ...base, objectFit: 'cover', display: 'block' }} />
  return (
    <span style={{ ...base, background: RECENT_AVATAR_COLORS[i % RECENT_AVATAR_COLORS.length], display: 'grid', placeItems: 'center', fontSize: 16, fontWeight: 700, color: '#fff' }}>
      {recentInitial(c)}
    </span>
  )
}

const cell = { minWidth: 0, background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 } as const
const cellLabel = { maxWidth: '100%', fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as const

function PayAgainRow({ navigate }: { navigate: NavigateFunction }) {
  const walletAddress = useAuthStore(s => s.walletAddress)
  // Same cache key as Home's Recent box always used, so the faces are there at once.
  const cacheKey = walletAddress ? `meshport_recents_${walletAddress.toLowerCase()}_5` : ''
  const [people, setPeople] = useState<RecentContact[]>(() => {
    try { const c = cacheKey ? JSON.parse(localStorage.getItem(cacheKey) || 'null') : null; return Array.isArray(c) ? c : [] } catch { return [] }
  })
  const [loaded, setLoaded] = useState(() => { try { return !!cacheKey && localStorage.getItem(cacheKey) != null } catch { return false } })
  const reconnects = useReconnectCount()
  const changed = useActivityChangedCount()
  useEffect(() => {
    if (!walletAddress) return
    let cancelled = false
    fetchRecentContacts(walletAddress, { activityLimit: 20, maxAddresses: 10, resultLimit: 5 })
      .then(list => {
        if (cancelled) return
        setPeople(list)
        try { if (cacheKey) localStorage.setItem(cacheKey, JSON.stringify(list)) } catch { /* storage full */ }
      })
      .catch(e => console.error('Pay again load error:', e))
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [walletAddress, cacheKey, reconnects, changed])

  // Pay again is for paying others: your own account (a self-payment) is left out here.
  const shown = people.filter(p => !p.isSelf)
  if (!loaded && shown.length === 0) {
    return (
      <div aria-busy="true" aria-label="Loading recent people" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', justifyItems: 'center', paddingBottom: 18 }}>
        {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="rounded-full" style={{ width: FACE, height: FACE }} />)}
      </div>
    )
  }
  if (shown.length === 0) {
    return (
      <button type="button" onClick={() => navigate('/pay')} className="mp-press"
        style={{ width: '100%', height: 62, border: 'none', background: 'none', cursor: 'pointer', font: 'inherit', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>No one yet</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--brand-text)' }}>Pay someone ›</span>
      </button>
    )
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
      {shown.slice(0, 4).map((c, i) => (
        <button key={c.wallet_address} type="button" className="mp-press" aria-label={`Pay ${recentShortName(c)}`} style={cell}
          onClick={() => navigate(`/pay?to=${encodeURIComponent(recentSendTarget(c))}`, { state: { returnTo: '/' } })}>
          <Face c={c} i={i} />
          <span style={cellLabel}>{recentShortName(c)}</span>
        </button>
      ))}
      {Array.from({ length: Math.max(0, 4 - shown.length) }, (_, i) => <span key={`gap-${i}`} />)}
      {/* View all: a round button at the right end of the row. */}
      <button type="button" className="mp-press" style={cell} onClick={() => navigate('/recent-paid', { state: { from: '/' } })}>
        <span style={{ width: FACE, height: FACE, borderRadius: '50%', background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', boxShadow: 'inset 0 0 0 1px var(--border)', display: 'grid', placeItems: 'center', color: 'var(--text-primary)' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
        </span>
        <span style={cellLabel}>View all</span>
      </button>
    </div>
  )
}

function UpdatesRow({ navigate }: { navigate: NavigateFunction }) {
  const [items, setItems] = useState<NewsItem[]>(() => readCachedHomeNews())
  const [loaded, setLoaded] = useState(() => items.length > 0)
  const [broken, setBroken] = useState<Record<string, true>>({})
  const reconnects = useReconnectCount()
  useEffect(() => {
    let cancelled = false
    if (reconnects) setBroken({})
    fetchHomeNews(4).then(list => { if (!cancelled) setItems(list) }).finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [reconnects])

  if (!items.length) {
    return loaded
      ? <div style={{ height: ROW_H - 8, display: 'grid', placeItems: 'center', fontSize: 12.5, color: 'var(--text-secondary)' }}>Arc, Circle and MeshPort updates show here</div>
      : <Skeleton className="rounded-[12px]" style={{ height: ROW_H - 12 }} />
  }
  return (
    // Cards to swipe sideways; the last one is a way into all updates.
    <div className="no-scrollbar" style={{ display: 'flex', gap: 8, overflowX: 'auto', scrollSnapType: 'x mandatory', overscrollBehaviorX: 'contain', margin: '0 -12px', padding: '0 12px', scrollPaddingInline: 12 }}>
      {items.map(it => (
        <button key={it.id} type="button" className="mp-press" onClick={() => navigate(`/news/${it.id}`)}
          style={{ flex: '0 0 262px', scrollSnapAlign: 'start', display: 'flex', gap: 10, alignItems: 'center', textAlign: 'left', padding: 6, borderRadius: 14,
            border: '1px solid var(--border)', cursor: 'pointer', font: 'inherit', background: 'var(--surface)' }}>
          {/* The cover at its own wide shape (16:9): covers carry their own
              title text, and a square crop cut it off. */}
          <span style={{ position: 'relative', width: 96, height: 54, borderRadius: 9, overflow: 'hidden', flexShrink: 0, background: NEWS_SOURCE_TINT[it.source] }}>
            {it.image_url && !broken[it.id]
              ? <img decoding="async" src={it.image_url} alt="" draggable={false} onError={() => setBroken(b => ({ ...b, [it.id]: true }))}
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
              : <NewsArt item={it} variant="thumb" />}
          </span>
          <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 12.5, fontWeight: 650, lineHeight: '16px', color: 'var(--text-primary)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{it.title}</span>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{NEWS_SOURCE_LABEL[it.source]} · {timeAgo(it.published_at)}</span>
          </span>
        </button>
      ))}
      <button type="button" className="mp-press" onClick={() => navigate('/news')}
        style={{ flex: '0 0 76px', scrollSnapAlign: 'end', borderRadius: 14, border: '1px solid var(--border)', cursor: 'pointer', font: 'inherit', fontSize: 12.5, fontWeight: 650,
          color: 'var(--brand-text)', background: 'var(--surface)' }}>View all ›</button>
    </div>
  )
}

const panelStyle = (on: boolean) => ({
  gridArea: '1 / 1', minWidth: 0, display: 'flex', flexDirection: 'column' as const, justifyContent: 'center',
  visibility: on ? 'visible' as const : 'hidden' as const, pointerEvents: on ? 'auto' as const : 'none' as const,
})

export function HomeTabs({ navigate, actions }: { navigate: NavigateFunction; actions: ReactNode }) {
  const [tab, setTab] = useState<Tab>(loadTab)
  const pick = (t: Tab) => { setTab(t); try { localStorage.setItem(TAB_KEY, t) } catch { /* this visit only */ } }
  return (
    <div style={{ background: 'var(--glass-fill)', border: '1px solid var(--border)', borderRadius: 20, boxShadow: 'var(--glass-card)', padding: 6 }}>
      <div role="tablist" aria-label="Home" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 4, padding: 4, borderRadius: 14,
        background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)' }}>
        {TABS.map(t => {
          const on = t.id === tab
          return (
            <button key={t.id} type="button" role="tab" aria-selected={on} onClick={() => pick(t.id)}
              style={{ height: 36, borderRadius: 11, border: 'none', cursor: 'pointer', font: 'inherit', fontSize: 'min(13.5px, 3.5vw)', fontWeight: 650, whiteSpace: 'nowrap', padding: '0 4px',
                background: on ? 'var(--surface)' : 'transparent', color: on ? 'var(--brand-text)' : 'var(--text-secondary)',
                boxShadow: on ? '0 1px 3px rgba(0,0,0,0.08)' : 'none', transition: 'background .2s, color .2s' }}>
              {t.label}
            </button>
          )
        })}
      </div>
      {/* Both rows stay mounted, stacked in one grid cell; only the chosen one
          shows. Mounting a row on each tap reloaded the news pictures and
          redrew the icons - the flicker when switching tabs. The cell is as
          tall as the taller row, so the page never jumps. */}
      <div style={{ display: 'grid', padding: '12px 6px 6px', minHeight: ROW_H }}>
        <div role="tabpanel" aria-hidden={tab !== 'actions'} style={panelStyle(tab === 'actions')}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 2 }}>{actions}</div>
        </div>
        <div role="tabpanel" aria-hidden={tab !== 'updates'} style={panelStyle(tab === 'updates')}>
          <UpdatesRow navigate={navigate} />
        </div>
      </div>
    </div>
  )
}

/** Pay again: a heading (like Assets), then a card - the last four people you paid, View all on the right. */
export function PayAgainCard({ navigate }: { navigate: NavigateFunction }) {
  return (
    <div>
      <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.3px', color: 'var(--text-primary)', margin: '0 2px 10px' }}>Pay again</div>
      <div style={{ background: 'var(--glass-fill)', border: '1px solid var(--border)', borderRadius: 20, boxShadow: 'var(--glass-card)', padding: '12px 6px' }}>
        <PayAgainRow navigate={navigate} />
      </div>
    </div>
  )
}
