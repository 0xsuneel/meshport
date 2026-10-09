import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { NewsArt } from './NewsArt'
import {
  fetchNewsPage, fetchLiveStatusNotices, newsDate, NEWS_PAGE_SIZE, NEWS_SOURCE_LABEL, NEWS_SOURCE_TINT,
  type NewsItem, type NewsSource,
} from '@/lib/news'

// /news — every story, newest first, with source filters. Live Arc network
// notices are pinned at the top. Tapping a story opens /news/:id.

const FILTERS: { key: NewsSource | null; label: string }[] = [
  { key: null, label: 'All' },
  { key: 'arc', label: 'Arc' },
  { key: 'circle', label: 'Circle' },
  { key: 'circle_dev', label: 'Developer' },
  { key: 'meshport', label: 'MeshPort' },
  { key: 'arc_status', label: 'Network status' },
]

export function newsMeta(it: NewsItem, withSource = true): string {
  return [withSource ? NEWS_SOURCE_LABEL[it.source] : null, it.source === 'arc_status' ? it.status_label : it.topic, newsDate(it.published_at),
    it.read_minutes ? `${it.read_minutes} min read` : null].filter(Boolean).join(' · ')
}

export function NewsCover({ item, style, children, variant = 'stack' }: { item: NewsItem; style?: React.CSSProperties; children?: ReactNode; variant?: 'stack' | 'hero' }) {
  const [ok, setOk] = useState(true)
  return (
    <div style={{ position: 'relative', overflow: 'hidden', background: NEWS_SOURCE_TINT[item.source], ...style }}>
      {item.image_url && ok
        ? <img src={item.image_url} alt="" loading="lazy" onError={() => setOk(false)}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
        : <NewsArt item={item} variant={variant} />}
      {children}
    </div>
  )
}

export function NewsPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const [filter, setFilter] = useState<NewsSource | null>(null)
  const [items, setItems] = useState<NewsItem[]>([])
  const [live, setLive] = useState<NewsItem[]>([])
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const reqId = useRef(0)

  const load = useCallback(async (reset: boolean) => {
    const id = ++reqId.current
    setLoading(true); setError(null)
    try {
      const page = await fetchNewsPage({ source: filter, before: reset ? null : items[items.length - 1]?.published_at })
      if (id !== reqId.current) return
      setItems(prev => reset ? page : [...prev, ...page.filter(p => !prev.some(q => q.id === p.id))])
      setMore(page.length === NEWS_PAGE_SIZE)
    } catch (e) {
      if (id === reqId.current) setError(e instanceof Error ? e.message : 'Could not load updates')
    } finally {
      if (id === reqId.current) setLoading(false)
    }
  }, [filter, items])

  useEffect(() => { setItems([]); setMore(true); load(true) }, [filter]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fetchLiveStatusNotices().then(setLive) }, [])

  // Loads the next page as the end of the list scrolls into view.
  const sentinel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sentinel.current
    if (!el || !more || loading || error) return
    const io = new IntersectionObserver(entries => { if (entries[0]?.isIntersecting) load(false) }, { rootMargin: '300px' })
    io.observe(el)
    return () => io.disconnect()
  }, [more, loading, error, load])

  const showLive = (filter === null || filter === 'arc_status') ? live : []

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)', paddingBottom: 90 }}>
      <div style={{
        position: 'sticky', top: 0, zIndex: 20,
        background: 'color-mix(in srgb, var(--bg) 95%, transparent)', backdropFilter: 'blur(20px)',
        paddingTop: 'calc(env(safe-area-inset-top, 0px) + var(--header-gap, 22px))', paddingLeft: 20, paddingRight: 20, paddingBottom: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 44 }}>
          {!isDesktop && (
            <button onClick={() => navigate('/')} className="back-btn" aria-label="Back">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path d="M15 6L9 12l6 6" stroke="var(--text-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          )}
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.2px' }}>Updates</div>
        </div>
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', margin: '8px -20px 0', padding: '0 20px 4px', scrollbarWidth: 'none' }}>
          {FILTERS.map(f => {
            const on = filter === f.key
            return (
              <button key={f.label} onClick={() => setFilter(f.key)}
                style={{ flex: 'none', fontSize: 13, fontWeight: 600, borderRadius: 999, padding: '6px 13px', cursor: 'pointer',
                  border: `1px solid ${on ? 'var(--brand)' : 'var(--border)'}`, background: on ? 'var(--brand)' : 'var(--surface)',
                  color: on ? '#fff' : 'var(--text-secondary)' }}>
                {f.label}
              </button>
            )
          })}
        </div>
      </div>

      <div style={{ padding: '6px 20px 0' }}>
        {showLive.map(it => (
          <button key={it.id} onClick={() => navigate(`/news/${it.id}`)}
            style={{ width: '100%', display: 'flex', gap: 10, alignItems: 'flex-start', textAlign: 'left', cursor: 'pointer', marginBottom: 10,
              background: 'color-mix(in srgb, #F59E0B 12%, var(--surface))', border: '1px solid color-mix(in srgb, #F59E0B 40%, transparent)',
              borderRadius: 14, padding: '10px 12px', color: 'var(--text-primary)' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', marginTop: 1 }}>
              <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>
            </svg>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700 }}>{it.title}</span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                {[it.status_label, 'status.arc.io', newsDate(it.published_at)].filter(Boolean).join(' · ')}
              </span>
            </span>
          </button>
        ))}

        {items.filter(it => !showLive.some(l => l.id === it.id)).map(it => (
          <button key={it.id} onClick={() => navigate(`/news/${it.id}`)}
            style={{ width: '100%', display: 'flex', gap: 12, alignItems: 'center', textAlign: 'left', cursor: 'pointer',
              background: 'none', border: 'none', borderBottom: '1px solid var(--border)', padding: '12px 0', color: 'var(--text-primary)' }}>
            {/* Same shape as the covers (1200×630), so their own title text isn't cut off at the sides. */}
            <NewsCover item={it} style={{ width: 112, aspectRatio: '1200 / 630', borderRadius: 10, flex: 'none' }} />
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ fontSize: 14, fontWeight: 650, lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{it.title}</span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{newsMeta(it)}</span>
            </span>
          </button>
        ))}

        {loading && Array.from({ length: items.length ? 2 : 6 }, (_, i) => (
          <div key={`s${i}`} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
            <div style={{ width: 112, aspectRatio: '1200 / 630', borderRadius: 10, background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)' }} />
            <div style={{ flex: 1 }}>
              <div style={{ width: '90%', height: 12, borderRadius: 6, background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', marginBottom: 8 }} />
              <div style={{ width: '50%', height: 10, borderRadius: 6, background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)' }} />
            </div>
          </div>
        ))}

        {error && (
          <div style={{ textAlign: 'center', padding: '28px 0' }}>
            <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 10 }}>Couldn't load updates</div>
            <button onClick={() => load(items.length === 0)}
              style={{ fontSize: 14, fontWeight: 600, color: 'var(--brand-text)', background: 'none', border: 'none', cursor: 'pointer' }}>Try again</button>
          </div>
        )}

        {!loading && !error && items.length === 0 && (
          <div style={{ textAlign: 'center', padding: '56px 0', fontSize: 14, color: 'var(--text-secondary)' }}>No updates yet</div>
        )}

        <div ref={sentinel} style={{ height: 1 }} />
      </div>
    </div>
  )
}
