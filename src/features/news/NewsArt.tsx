import type { ReactNode } from 'react'
import { isLiveStatusNotice, newsDate, NEWS_SOURCE_TINT, type NewsItem } from '@/lib/news'

// Cover drawn for a story that has no picture (Arc network notices, MeshPort
// posts without a cover, or an image that failed to load): the source's
// colour, an icon tile and a short label, so the slot never looks empty.
//   row   — wide and short (Home Updates box): icon left, one short label right
//   stack — small thumbnail (Updates list): icon over a one-word label
//   hero  — article header: large icon and label

type Variant = 'row' | 'stack' | 'hero'

function Glyph({ item, size }: { item: NewsItem; size: number }) {
  const s = { width: size, height: size, display: 'block' as const }
  switch (item.source) {
    case 'arc_status':
      // Signal / pulse line
      return (
        <svg viewBox="0 0 24 24" style={s} fill="none" stroke="#C2410C" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 12h4l2.5-6 5 12 2.5-6H21" />
        </svg>
      )
    case 'meshport':
      return (
        <svg viewBox="8 8 184 184" style={s}>
          <g stroke="#0F5C57" strokeWidth="12" strokeLinecap="round"><line x1="100" y1="100" x2="62" y2="64"/><line x1="100" y1="100" x2="146" y2="58"/><line x1="100" y1="100" x2="150" y2="118"/><line x1="100" y1="100" x2="108" y2="152"/><line x1="100" y1="100" x2="54" y2="142"/></g>
          <g fill="#FFFFFF" stroke="#0F5C57" strokeWidth="12"><circle cx="62" cy="64" r="12"/><circle cx="146" cy="58" r="13"/><circle cx="150" cy="118" r="9"/><circle cx="108" cy="152" r="8"/><circle cx="54" cy="142" r="16"/><circle cx="100" cy="100" r="22"/></g>
        </svg>
      )
    case 'circle_dev':
      // Code brackets
      return (
        <svg viewBox="0 0 24 24" style={s} fill="none" stroke="#3B4A6B" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14" />
        </svg>
      )
    case 'circle':
      return (
        <svg viewBox="0 0 24 24" style={s} fill="none" strokeWidth="3.2">
          <defs><linearGradient id="mpCircleRing" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#25D3A0" /><stop offset="1" stopColor="#7A5CFF" /></linearGradient></defs>
          <circle cx="12" cy="12" r="7.5" stroke="url(#mpCircleRing)" />
        </svg>
      )
    default:
      // Arc: an arch
      return (
        <svg viewBox="0 0 24 24" style={s} fill="none" stroke="#1F6F66" strokeWidth="2.6" strokeLinecap="round">
          <path d="M5 19V12a7 7 0 0 1 14 0v7" />
        </svg>
      )
  }
}

function labels(item: NewsItem): { title: string; sub: string | null; live: boolean } {
  switch (item.source) {
    case 'arc_status': return { title: 'Network notice', sub: item.status_label, live: isLiveStatusNotice(item) }
    case 'meshport':   return { title: 'MeshPort update', sub: newsDate(item.published_at), live: false }
    case 'circle':     return { title: 'Circle', sub: item.topic ?? newsDate(item.published_at), live: false }
    case 'circle_dev': return { title: item.topic ?? 'Developer update', sub: 'Release notes', live: false }
    default:           return { title: 'Arc', sub: item.topic ?? newsDate(item.published_at), live: false }
  }
}

export function NewsArt({ item, variant, children }: { item: NewsItem; variant: Variant; children?: ReactNode }) {
  const { title, sub, live } = labels(item)
  const tile = variant === 'hero' ? 64 : variant === 'stack' ? 30 : 28
  const glyph = Math.round(tile * 0.62)
  const tileEl = (
    <span style={{ width: tile, height: tile, borderRadius: tile * 0.3, background: '#fff', flex: 'none',
      display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 12px -4px rgba(0,0,0,0.35)' }}>
      <Glyph item={item} size={glyph} />
    </span>
  )
  const subEl = sub && (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: variant === 'hero' ? 13 : 10, fontWeight: 600,
      color: 'rgba(255,255,255,0.85)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
      {live && <i style={{ width: 6, height: 6, borderRadius: '50%', background: '#FBBF24', flex: 'none', boxShadow: '0 0 0 3px rgba(251,191,36,0.25)' }} />}
      {sub}
    </span>
  )
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: NEWS_SOURCE_TINT[item.source], color: '#fff' }}>
      {/* Soft rings, so the block reads as a designed cover rather than a gap. */}
      <svg aria-hidden viewBox="0 0 100 100" preserveAspectRatio="xMaxYMid slice"
        style={{ position: 'absolute', right: '-12%', top: '-30%', height: '160%', opacity: 0.16 }}>
        <circle cx="70" cy="50" r="22" fill="none" stroke="#fff" strokeWidth="1.2" />
        <circle cx="70" cy="50" r="36" fill="none" stroke="#fff" strokeWidth="1" />
        <circle cx="70" cy="50" r="50" fill="none" stroke="#fff" strokeWidth="0.8" />
      </svg>
      {variant === 'row' && (
        // The headline sits under this cover, so one short label is enough:
        // a notice's status (with a live dot), otherwise the source name.
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px' }}>
          {tileEl}
          <span style={{ minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>
            {live && <i style={{ width: 7, height: 7, borderRadius: '50%', background: '#FBBF24', flex: 'none', boxShadow: '0 0 0 3px rgba(251,191,36,0.3)' }} />}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {item.source === 'arc_status' ? (item.status_label || 'Network notice') : item.source === 'meshport' ? 'MeshPort' : title}
            </span>
          </span>
        </div>
      )}
      {variant === 'stack' && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, padding: '0 6px' }}>
          {tileEl}
          {subEl || <span style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>{title}</span>}
        </div>
      )}
      {variant === 'hero' && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
          {tileEl}
          <span style={{ fontSize: 16, fontWeight: 700 }}>{title}</span>
          {subEl}
        </div>
      )}
      {children}
    </div>
  )
}
