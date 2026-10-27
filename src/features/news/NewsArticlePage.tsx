import { useEffect, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DesktopTwoColumn } from '@/components/layout/DesktopTwoColumn'
import { useUIStore } from '@/store'
import { copyToClipboard } from '@/lib/utils'
import { fetchNewsItem, fetchNewsPage, markNewsRead, newsDate, newsHost, NEWS_SOURCE_LABEL, type NewsItem } from '@/lib/news'
import { NewsCover, newsMeta } from './NewsPage'

// /news/:id - the short article: cover, headline, summary and the opening
// paragraphs. "Read full article" opens the original page on arc.io /
// circle.com / status.arc.io. MeshPort posts are shown in full here (they're
// ours), so they only get a button when the post links somewhere.

export function NewsArticlePage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const location = useLocation()
  const { showToastMessage } = useUIStore()
  const [item, setItem] = useState<NewsItem | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading')

  useEffect(() => {
    let cancelled = false
    setState('loading')
    fetchNewsItem(id).then(it => { if (!cancelled) { setItem(it); setState(it ? 'ready' : 'missing'); if (it) markNewsRead(it.id) } })
    return () => { cancelled = true }
  }, [id])

  // Desktop: other stories for the "More updates" panel beside the article.
  const [more, setMore] = useState<NewsItem[] | null>(null)
  useEffect(() => {
    if (!isDesktop) return
    let cancelled = false
    fetchNewsPage().then(list => { if (!cancelled) setMore(list) }).catch(() => { if (!cancelled) setMore([]) })
    return () => { cancelled = true }
  }, [isDesktop])

  // Opened from inside the app → go back where we came from; opened from a shared link → News.
  const back = () => { if (location.key !== 'default') navigate(-1); else navigate('/news') }

  const openOriginal = () => { if (item?.url) window.open(item.url, '_blank', 'noopener,noreferrer') }

  const share = async () => {
    if (!item) return
    const url = item.url || window.location.href
    try {
      if (navigator.share) { await navigator.share({ title: item.title, url }); return }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
    }
    const ok = await copyToClipboard(url)
    showToastMessage(ok ? 'Link copied' : 'Could not copy link', ok ? 'success' : 'error')
  }

  const host = item ? newsHost(item) : null

  const cover = (
    <>
      {/* Phone: the cover runs edge to edge (capped height). Desktop: the
          whole cover, uncropped, at the top of the article column. */}
      <div style={{ position: 'relative' }}>
        {item
          ? <NewsCover item={item} variant="hero" style={isDesktop
              ? { width: '100%', aspectRatio: '1200 / 630', borderRadius: 18, boxShadow: 'var(--shadow-1)' }
              : { width: '100%', aspectRatio: '1200 / 630', maxHeight: 320 }} />
          : <div style={{ width: '100%', aspectRatio: '1200 / 630', maxHeight: isDesktop ? undefined : 320, borderRadius: isDesktop ? 18 : 0, background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)' }} />}
        <button onClick={back} aria-label="Back"
          style={{ position: 'absolute', top: isDesktop ? 14 : 'calc(env(safe-area-inset-top, 0px) + 14px)', left: 14, width: 38, height: 38, borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
            background: 'rgba(0,0,0,0.42)', border: 'none', backdropFilter: 'blur(8px)' }}>
          {/* Same arrow as every back button; the dark circle keeps it readable over the photo. */}
          <ArrowLeft className="w-5 h-5" style={{ color: '#fff' }} />
        </button>
      </div>

    </>
  )
  const article = (
    <>
      <div style={isDesktop ? { paddingTop: 24 } : { padding: '18px 20px 0', maxWidth: 680, margin: '0 auto' }}>
        {state === 'loading' && (
          <div>
            <div style={{ width: '85%', height: 20, borderRadius: 8, background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', marginBottom: 10 }} />
            <div style={{ width: '55%', height: 12, borderRadius: 6, background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)', marginBottom: 22 }} />
            {[0, 1, 2].map(i => <div key={i} style={{ width: '100%', height: 12, borderRadius: 6, background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)', marginBottom: 10 }} />)}
          </div>
        )}

        {state === 'missing' && (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>This story isn't available</div>
            <button onClick={() => navigate('/news')}
              style={{ fontSize: 14, fontWeight: 600, color: 'var(--brand-text)', background: 'none', border: 'none', cursor: 'pointer' }}>See all updates</button>
          </div>
        )}

        {state === 'ready' && item && (
          <>
            <span style={{ display: 'inline-block', fontSize: 12, fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase',
              color: 'var(--brand-text)', marginBottom: 8 }}>{NEWS_SOURCE_LABEL[item.source]}</span>
            <h1 style={{ margin: 0, fontSize: isDesktop ? 30 : 22, lineHeight: 1.25, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.3px', textWrap: 'balance' } as React.CSSProperties}>
              {item.title}
            </h1>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 8 }}>{newsMeta(item, false)}</div>

            {item.summary && (
              <p style={{ fontSize: 16, lineHeight: 1.6, fontWeight: 600, color: 'var(--text-primary)', margin: '18px 0 0' }}>{item.summary}</p>
            )}
            {item.body.map((p, i) => (
              <p key={i} style={{ fontSize: 15, lineHeight: 1.65, color: 'var(--text-primary)', opacity: 0.88, margin: '14px 0 0' }}>{p}</p>
            ))}

            <div style={{ display: 'flex', flexDirection: isDesktop ? 'row' : 'column', gap: 8, marginTop: 24 }}>
              {item.url && (
                <button onClick={openOriginal}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '14px 16px', borderRadius: 14, cursor: 'pointer',
                    background: 'var(--brand)', color: '#fff', fontSize: 15, fontWeight: 700, border: '1px solid color-mix(in srgb, black 12%, transparent)' }}>
                  {item.source === 'meshport' ? 'Open link' : `Read full article${host ? ` on ${host}` : ''}`}
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7M8 7h9v9"/></svg>
                </button>
              )}
              <button onClick={share}
                style={{ padding: '13px 16px', borderRadius: 14, cursor: 'pointer', background: 'var(--surface)', color: 'var(--text-primary)',
                  fontSize: 15, fontWeight: 600, border: '1px solid var(--border)' }}>
                Share
              </button>
            </div>
          </>
        )}
      </div>
    </>
  )

  if (!isDesktop) {
    return (
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', background: 'var(--bg)', paddingBottom: 100 }}>
        {cover}
        {article}
      </div>
    )
  }

  // Desktop: the article on the left, "More updates" and the story's details
  // on the right - the shared 65/35 layout (DesktopTwoColumn) of Swap and
  // Activity, so the page is filled instead of one narrow column in the
  // middle. Each column scrolls on its own, so the panel stays in view.
  const others = (more ?? []).filter(n => n.id !== id).slice(0, 6)
  const facts: [string, string][] = item ? [
    ['Source', NEWS_SOURCE_LABEL[item.source]],
    ...(item.source === 'arc_status' && item.status_label ? [['Status', item.status_label] as [string, string]] : item.topic ? [['Topic', item.topic] as [string, string]] : []),
    ['Published', newsDate(item.published_at)],
    ...(item.read_minutes ? [['Read time', `${item.read_minutes} min`] as [string, string]] : []),
    ...(host ? [['Original', host] as [string, string]] : []),
  ] : []
  return (
    <div style={{ flex: 1, minHeight: 0, height: '100%', background: 'var(--bg)' }}>
      <DesktopTwoColumn
        main={<div style={{ paddingBottom: 26 }}>
          {cover}
          {article}
        </div>}
        side={<aside style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 18, padding: '14px 16px 6px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>More updates</span>
              <button onClick={() => navigate('/news')} style={{ fontSize: 13, fontWeight: 600, color: 'var(--brand-text)', background: 'none', border: 'none', cursor: 'pointer' }}>View all</button>
            </div>
            {more === null ? [0, 1, 2, 3].map(i => (
              <div key={i} style={{ display: 'flex', gap: 12, padding: '10px 0' }}>
                <div style={{ width: 52, height: 52, borderRadius: 12, background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)' }} />
                <div style={{ flex: 1 }}><div style={{ height: 11, width: '85%', borderRadius: 6, background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)' }} /><div style={{ height: 9, width: '45%', borderRadius: 6, marginTop: 8, background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)' }} /></div>
              </div>
            )) : others.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', padding: '10px 0 12px', margin: 0 }}>No other updates yet</p>
            ) : others.map((n, i) => (
              <button key={n.id} onClick={() => navigate(`/news/${n.id}`)}
                style={{ display: 'flex', gap: 12, width: '100%', padding: '10px 0', textAlign: 'left', cursor: 'pointer', background: 'none', border: 'none',
                  borderBottom: i < others.length - 1 ? '1px solid var(--border)' : 'none' }}>
                <NewsCover item={n} variant="thumb" style={{ width: 52, height: 52, borderRadius: 12, flexShrink: 0 }} />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: 13, fontWeight: 600, lineHeight: 1.35, color: 'var(--text-primary)' }}>{n.title}</span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>{NEWS_SOURCE_LABEL[n.source]} · {newsDate(n.published_at)}</span>
                </span>
              </button>
            ))}
          </div>
          {facts.length > 0 && (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--soft-edge)', boxShadow: 'var(--soft-card)', borderRadius: 18, padding: '14px 16px 4px' }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Details</span>
              {facts.map(([k, v], i) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 0', fontSize: 13, borderBottom: i < facts.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{k}</span>
                  <span style={{ fontWeight: 600, textAlign: 'right', color: k === 'Status' ? 'var(--success-text)' : 'var(--text-primary)' }}>{v}</span>
                </div>
              ))}
            </div>
          )}
        </aside>}
      />
    </div>
  )
}
