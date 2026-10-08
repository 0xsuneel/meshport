import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useUIStore } from '@/store'
import { copyToClipboard } from '@/lib/utils'
import { fetchNewsItem, newsHost, NEWS_SOURCE_LABEL, type NewsItem } from '@/lib/news'
import { NewsCover, newsMeta } from './NewsPage'

// /news/:id — the short article: cover, headline, summary and the opening
// paragraphs. "Read full article" opens the original page on arc.io /
// circle.com / status.arc.io. MeshPort posts are shown in full here (they're
// ours), so they only get a button when the post links somewhere.

export function NewsArticlePage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { showToastMessage } = useUIStore()
  const [item, setItem] = useState<NewsItem | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading')

  useEffect(() => {
    let cancelled = false
    setState('loading')
    fetchNewsItem(id).then(it => { if (!cancelled) { setItem(it); setState(it ? 'ready' : 'missing') } })
    return () => { cancelled = true }
  }, [id])

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

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)', paddingBottom: 100 }}>
      <div style={{ position: 'relative' }}>
        {item
          ? <NewsCover item={item} style={{ width: '100%', aspectRatio: '1200 / 630', maxHeight: 320 }} />
          : <div style={{ width: '100%', aspectRatio: '1200 / 630', maxHeight: 320, background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)' }} />}
        <button onClick={back} aria-label="Back"
          style={{ position: 'absolute', top: 'calc(env(safe-area-inset-top, 0px) + 14px)', left: 14, width: 38, height: 38, borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
            background: 'rgba(0,0,0,0.42)', border: 'none', backdropFilter: 'blur(8px)' }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M15 6L9 12l6 6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
      </div>

      <div style={{ padding: '18px 20px 0', maxWidth: 680, margin: '0 auto' }}>
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
              style={{ fontSize: 14, fontWeight: 600, color: 'var(--brand-text)', background: 'none', border: 'none', cursor: 'pointer' }}>See all news</button>
          </div>
        )}

        {state === 'ready' && item && (
          <>
            <span style={{ display: 'inline-block', fontSize: 11.5, fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase',
              color: 'var(--brand-text)', marginBottom: 8 }}>{NEWS_SOURCE_LABEL[item.source]}</span>
            <h1 style={{ margin: 0, fontSize: 22, lineHeight: 1.25, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.3px', textWrap: 'balance' } as React.CSSProperties}>
              {item.title}
            </h1>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 8 }}>{newsMeta(item, false)}</div>

            {item.summary && (
              <p style={{ fontSize: 15.5, lineHeight: 1.6, fontWeight: 600, color: 'var(--text-primary)', margin: '18px 0 0' }}>{item.summary}</p>
            )}
            {item.body.map((p, i) => (
              <p key={i} style={{ fontSize: 15, lineHeight: 1.65, color: 'var(--text-primary)', opacity: 0.88, margin: '14px 0 0' }}>{p}</p>
            ))}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 24 }}>
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
                  fontSize: 14.5, fontWeight: 600, border: '1px solid var(--border)' }}>
                Share
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
