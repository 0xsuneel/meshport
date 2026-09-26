// Chat photos & files (WhatsApp-style): photo bubbles that keep their shape
// while loading, upload / download progress rings, file bubbles with size and
// type, the "send photos" preview screen, and the full-screen photo viewer.
import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { X, Loader2 } from 'lucide-react'
import { cachedMedia, loadMedia, metaOf, fmtBytes, extOf, mimeOf, saveNameFor } from './chatMedia'

// ── progress ring ───────────────────────────────────────────────────────────
export function ProgressRing({ progress, size = 46, onCancel, label }: { progress: number; size?: number; onCancel?: () => void; label?: string }) {
  const r = size / 2 - 5
  const c = 2 * Math.PI * r
  const p = Math.max(0.03, Math.min(1, progress))
  const inner = (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={size / 2 - 1} fill="rgba(0,0,0,0.5)" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="3" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - p)} transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: 'stroke-dashoffset 0.2s linear' }} />
      {onCancel && <path d={`M${size / 2 - 5} ${size / 2 - 5}l10 10M${size / 2 + 5} ${size / 2 - 5}l-10 10`} stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />}
    </svg>
  )
  return onCancel
    ? <button type="button" aria-label={label ?? 'Cancel'} onClick={e => { e.stopPropagation(); onCancel() }} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', display: 'flex' }}>{inner}</button>
    : inner
}

// ── photo bubble content ────────────────────────────────────────────────────
/**
 * A chat photo. Reserves its final shape from the size stored with it (no
 * jump when it loads), shows a progress ring while downloading, reuses the
 * session cache (instant for photos you just sent / already opened).
 */
export function ChatImage({ url, iv, convKey, radius, square, upload, failed, onRetry, onTap, maxW = 260 }: {
  url: string; iv: string | null; convKey: any; radius: string
  /** Album tile: fill a square cell. */
  square?: boolean
  /** Sending: upload progress 0..1 + cancel. */
  upload?: { progress: number; onCancel: () => void } | null
  failed?: boolean
  onRetry?: () => void
  onTap?: (localUrl: string) => void
  maxW?: number
}) {
  const initial = cachedMedia(url)
  const [src, setSrc] = useState<string | null>(initial?.url ?? (!iv && url.startsWith('blob:') ? url.split('#')[0] : null))
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState(false)
  const meta = metaOf(url)
  useEffect(() => {
    if (src) return
    let cancelled = false
    loadMedia(url, iv, convKey, p => { if (!cancelled) setProgress(p) })
      .then(r => { if (!cancelled) setSrc(r.url) })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, iv, convKey])

  const ratio = meta.w && meta.h ? meta.h / meta.w : 0.75
  const w = square ? '100%' : maxW
  const h = square ? '100%' : Math.max(120, Math.min(340, Math.round(maxW * ratio)))
  return (
    <div style={{ position: 'relative', width: w, height: h, borderRadius: radius, overflow: 'hidden', background: 'color-mix(in srgb, var(--text-primary) 10%, transparent)', cursor: src && onTap ? 'pointer' : 'default' }}
      onClick={() => { if (src && onTap && !upload) onTap(src) }}>
      {src && <img src={src} alt="Photo" draggable={false} style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }} />}
      {!src && !error && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {progress > 0 ? <ProgressRing progress={progress} /> : <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'rgba(255,255,255,0.8)' }} />}
        </div>
      )}
      {error && !src && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-secondary)' }}>
          <span>Couldn't load this photo</span>
          <button type="button" onClick={e => { e.stopPropagation(); setError(false); setProgress(0); loadMedia(url, iv, convKey, setProgress).then(r => setSrc(r.url)).catch(() => setError(true)) }}
            style={{ border: 'none', borderRadius: 14, padding: '5px 12px', background: 'rgba(0,0,0,0.45)', color: '#fff', fontSize: 12.5, fontWeight: 600 }}>Try again</button>
        </div>
      )}
      {upload && !failed && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.3)' }}>
          <ProgressRing progress={upload.progress} onCancel={upload.onCancel} label="Cancel sending" />
        </div>
      )}
      {failed && onRetry && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.4)' }}>
          <button type="button" onClick={e => { e.stopPropagation(); onRetry() }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, height: 36, borderRadius: 18, border: 'none', background: 'rgba(0,0,0,0.6)', color: '#fff', fontWeight: 700, fontSize: 13, padding: '0 14px', cursor: 'pointer' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 11-3-6.7L21 8" /><path d="M21 3v5h-5" /></svg>
            Retry
          </button>
        </div>
      )}
    </div>
  )
}

// ── reply quote thumbnail (WhatsApp: small square on the quote's right) ─────
/** A photo's small square preview (decrypts via the shared media cache). */
export function QuoteThumb({ url, iv, convKey, size = 46 }: { url: string; iv: string | null; convKey: any; size?: number }) {
  const [src, setSrc] = useState<string | null>(() => cachedMedia(url)?.url ?? (!iv && url.startsWith('blob:') ? url.split('#')[0] : null))
  useEffect(() => {
    if (src) return
    let cancelled = false
    loadMedia(url, iv, convKey).then(r => { if (!cancelled) setSrc(r.url) }).catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, iv, convKey])
  return (
    <div style={{ width: size, height: size, flexShrink: 0, borderRadius: 6, overflow: 'hidden', background: 'rgba(127,127,127,0.25)' }}>
      {src && <img src={src} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
    </div>
  )
}

/** A file's small type tile (PDF / DOCX …) for reply quotes. */
export function FileTypeTile({ name, size = 46 }: { name: string; size?: number }) {
  const ext = extOf(name)
  return (
    <div style={{ width: size, height: size, flexShrink: 0, borderRadius: 6, background: TYPE_COLOR[ext] || '#6b7780', color: '#fff',
      fontSize: 10, fontWeight: 800, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 6, textTransform: 'uppercase' }}>
      {(ext || 'file').slice(0, 4)}
    </div>
  )
}

// ── file bubble content ─────────────────────────────────────────────────────
const TYPE_COLOR: Record<string, string> = { pdf: '#d95c4a', doc: '#3b6fd4', docx: '#3b6fd4', xls: '#2f8a5a', xlsx: '#2f8a5a', csv: '#2f8a5a', ppt: '#d0772f', pptx: '#d0772f', zip: '#7a6a4f', txt: '#6b7780' }
/**
 * A file: type badge, name, size and type; tap to download (progress ring),
 * then tap to open. Opening happens on that second tap, so it's a real user
 * gesture — browsers don't block it the way they block a popup opened after
 * a download.
 */
export function ChatFile({ name, url, iv, convKey, isMine, upload, failed, onRetry, onOpenImage }: {
  name: string; url: string; iv: string | null; convKey: any; isMine: boolean
  upload?: { progress: number; onCancel: () => void } | null
  failed?: boolean
  onRetry?: () => void
  onOpenImage?: (localUrl: string) => void
}) {
  const ext = extOf(name)
  const isImg = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)
  const meta = metaOf(url)
  const [ready, setReady] = useState<{ url: string; blob: Blob } | null>(() => cachedMedia(url))
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState('')
  const sub = isMine ? 'rgba(255,255,255,0.72)' : 'var(--text-secondary)'

  const download = async () => {
    setError(''); setProgress(0.01)
    try {
      const r = await loadMedia(url, iv, convKey, p => setProgress(p), mimeOf(name))
      setReady(r); setProgress(null)
    } catch (e) {
      setProgress(null); setError(e instanceof Error ? e.message : 'Download failed')
    }
  }
  const open = () => {
    if (!ready) return
    if (isImg && onOpenImage) { onOpenImage(ready.url); return }
    // PDFs, text, images open in a tab; everything else saves.
    if (/^(application\/pdf|text\/|image\/)/.test(ready.blob.type || mimeOf(name))) {
      const w = window.open(ready.url, '_blank', 'noopener')
      if (w) return
    }
    save()
  }
  const save = () => {
    if (!ready) return
    const a = document.createElement('a')
    a.href = ready.url; a.download = name
    document.body.appendChild(a); a.click(); a.remove()
  }

  const action = upload && !failed ? <ProgressRing progress={upload.progress} size={38} onCancel={upload.onCancel} label="Cancel sending" />
    : failed && onRetry ? (
      <button type="button" aria-label="Retry sending" onClick={e => { e.stopPropagation(); onRetry() }}
        style={{ width: 36, height: 36, borderRadius: '50%', border: `1.5px solid ${sub}`, background: 'none', color: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 11-3-6.7L21 8" /><path d="M21 3v5h-5" /></svg>
      </button>
    ) : progress != null ? <ProgressRing progress={progress} size={38} />
    : !ready ? (
      <button type="button" aria-label={`Download ${name}`} onClick={e => { e.stopPropagation(); download() }}
        style={{ width: 36, height: 36, borderRadius: '50%', border: `1.5px solid ${sub}`, background: 'none', color: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v11M7 11l5 5 5-5M5 20h14" /></svg>
      </button>
    ) : null

  return (
    <div onClick={() => { if (ready) open(); else if (!upload && progress == null) download() }}
      style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 220, maxWidth: 270, borderRadius: 12, padding: '9px 10px', cursor: 'pointer',
        background: isMine ? 'rgba(0,0,0,0.18)' : 'color-mix(in srgb, var(--text-primary) 7%, transparent)' }}>
      <div style={{ width: 36, height: 44, borderRadius: 6, flexShrink: 0, background: TYPE_COLOR[ext] ?? '#56626a', color: '#fff', fontSize: 9.5, fontWeight: 800,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 5, boxSizing: 'border-box' }}>{(ext || 'file').slice(0, 4).toUpperCase()}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</p>
        <p style={{ fontSize: 11.5, color: error ? '#ff8a7a' : sub, marginTop: 2 }}>
          {error || [fmtBytes(meta.s), (ext || 'file').toUpperCase(), upload ? (failed ? 'not sent' : 'sending…') : ready ? 'tap to open' : ''].filter(Boolean).join(' · ')}
        </p>
      </div>
      {action}
      {ready && !upload && (
        <button type="button" aria-label={`Save ${name}`} onClick={e => { e.stopPropagation(); save() }}
          style={{ width: 32, height: 32, border: 'none', background: 'none', color: sub, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v11M7 11l5 5 5-5M5 20h14" /></svg>
        </button>
      )}
    </div>
  )
}

// ── send-photos preview ─────────────────────────────────────────────────────
export type PreviewItem = { id: string; file: File; url: string; caption: string }
/**
 * Full-screen preview before sending photos: switch between them, remove,
 * add more, a caption for each, and an HD toggle.
 */
export function MediaPreview({ items, recipient, onChange, onAddMore, onClose, onSend }: {
  items: PreviewItem[]; recipient: string
  onChange: (items: PreviewItem[]) => void
  onAddMore: () => void
  onClose: () => void
  onSend: (items: PreviewItem[], hd: boolean) => void
}) {
  const [idx, setIdx] = useState(0)
  const [hd, setHd] = useState(false)
  const cur = items[Math.min(idx, items.length - 1)]
  useEffect(() => { if (idx > items.length - 1) setIdx(Math.max(0, items.length - 1)) }, [items.length, idx])
  if (!cur) return null
  const remove = () => {
    URL.revokeObjectURL(cur.url)
    const next = items.filter(i => i.id !== cur.id)
    if (!next.length) { onClose(); return }
    onChange(next)
  }
  const tb: React.CSSProperties = { width: 40, height: 40, borderRadius: '50%', border: 'none', background: 'rgba(255,255,255,0.12)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="absolute inset-0 z-[80] flex flex-col" style={{ background: '#000', color: '#fff' }}>
      <div className="flex items-center gap-2 px-3 pt-header pb-2">
        <button style={tb} aria-label="Close" onClick={onClose}><X className="w-5 h-5" /></button>
        <p className="flex-1 min-w-0 truncate text-[13px]" style={{ color: 'rgba(255,255,255,0.7)' }}>To {recipient}</p>
        <button type="button" aria-pressed={hd} aria-label={hd ? 'HD quality on' : 'HD quality off'} onClick={() => setHd(v => !v)}
          style={{ height: 32, borderRadius: 16, padding: '0 11px', fontWeight: 800, fontSize: 12.5, cursor: 'pointer', border: '1.5px solid #fff', background: hd ? '#fff' : 'transparent', color: hd ? '#000' : '#fff' }}>HD</button>
        <button style={tb} aria-label="Remove this photo" onClick={remove}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
        </button>
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center">
        <img src={cur.url} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
      </div>
      <div className="flex gap-2 px-3 py-2 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
        {items.map((it, i) => (
          <button key={it.id} type="button" onClick={() => setIdx(i)} aria-label={`Photo ${i + 1}`}
            style={{ width: 52, height: 52, flexShrink: 0, borderRadius: 8, padding: 0, overflow: 'hidden', cursor: 'pointer', border: 'none',
              outline: i === idx ? '2.5px solid var(--link)' : 'none', outlineOffset: 1 }}>
            <img src={it.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </button>
        ))}
        <button type="button" onClick={onAddMore} aria-label="Add more photos"
          style={{ width: 52, height: 52, flexShrink: 0, borderRadius: 8, border: '1.5px dashed rgba(255,255,255,0.5)', background: 'none', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>
      <div className="flex items-end gap-2 px-3 pt-1" style={{ paddingBottom: 'calc(14px + env(safe-area-inset-bottom, 0px))' }}>
        <label className="flex-1 flex items-center rounded-full px-4" style={{ minHeight: 46, background: '#1d2327' }}>
          <input value={cur.caption} maxLength={1000} placeholder="Add a caption…"
            onChange={e => onChange(items.map(i => i.id === cur.id ? { ...i, caption: e.target.value } : i))}
            className="flex-1 bg-transparent text-[15px] focus:outline-none" style={{ color: '#fff' }} />
        </label>
        <button type="button" aria-label={`Send ${items.length} photo${items.length === 1 ? '' : 's'}`} onClick={() => onSend(items, hd)}
          style={{ position: 'relative', width: 50, height: 50, borderRadius: '50%', border: 'none', background: 'var(--brand)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 20.4l17.5-7.5a1 1 0 000-1.8L3.4 3.6a1 1 0 00-1.4 1.1L4 11l9 1-9 1-2 6.3a1 1 0 001.4 1.1z" /></svg>
          {items.length > 1 && <span style={{ position: 'absolute', top: -4, right: -4, width: 20, height: 20, borderRadius: '50%', background: '#fff', color: '#000', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{items.length}</span>}
        </button>
      </div>
    </motion.div>
  )
}

// ── full-screen viewer ──────────────────────────────────────────────────────
export type ViewerItem = { id: string; url: string; iv: string | null; sender: string; createdAt: string; msg: any }
/**
 * Photos in this chat, swipe left/right between them; pinch or double-tap to
 * zoom (drag to pan while zoomed); swipe down to close. Reply / Forward /
 * Save (named MeshPort_<date>_<time>.jpg) / Share.
 */
export function ChatImageViewer({ items, startId, convKey, onClose, onReply, onForward }: {
  items: ViewerItem[]; startId: string; convKey: any
  onClose: () => void
  onReply?: (msg: any) => void
  onForward?: (msg: any) => void
}) {
  const [idx, setIdx] = useState(() => Math.max(0, items.findIndex(i => i.id === startId)))
  const item = items[idx]
  const [src, setSrc] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [toast, setToast] = useState('')
  const [zoom, setZoom] = useState({ s: 1, x: 0, y: 0 })
  const [drag, setDrag] = useState({ x: 0, y: 0 })
  const g = useRef<{ mode: 'none' | 'swipe' | 'pan' | 'pinch'; sx: number; sy: number; d0: number; s0: number; zx: number; zy: number; lastTap: number }>({ mode: 'none', sx: 0, sy: 0, d0: 0, s0: 1, zx: 0, zy: 0, lastTap: 0 })

  useEffect(() => {
    if (!item) return
    let cancelled = false
    setZoom({ s: 1, x: 0, y: 0 })
    const hit = cachedMedia(item.url)
    setSrc(hit?.url ?? (!item.iv && item.url.startsWith('blob:') ? item.url : null)); setProgress(0)
    if (!hit && !(item.url.startsWith('blob:'))) loadMedia(item.url, item.iv, convKey, p => { if (!cancelled) setProgress(p) }).then(r => { if (!cancelled) setSrc(r.url) }).catch(() => {})
    // Preload the neighbours so swiping is instant.
    for (const n of [items[idx - 1], items[idx + 1]]) if (n && !n.url.startsWith('blob:')) loadMedia(n.url, n.iv, convKey).catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx])

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 2200) }
  const blobFor = async (): Promise<Blob | null> => {
    const hit = item ? cachedMedia(item.url) : null
    if (hit) return hit.blob
    if (src) { try { return await (await fetch(src)).blob() } catch { return null } }
    return null
  }
  const save = async () => {
    const b = await blobFor(); if (!b || !item) return
    const name = saveNameFor(item.createdAt, (b.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg'))
    const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = name
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 1500)
    flash(`Saved as ${name}`)
  }
  const share = async () => {
    const b = await blobFor(); if (!b || !item) return
    const file = new File([b], saveNameFor(item.createdAt), { type: b.type || 'image/jpeg' })
    try {
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return }
    } catch (e: any) { if (e?.name === 'AbortError') return }
    save()
  }

  const dist = (t: React.TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches
    if (t.length === 2) { g.current = { ...g.current, mode: 'pinch', d0: dist(t), s0: zoom.s }; return }
    const now = Date.now()
    if (now - g.current.lastTap < 280) { // double tap
      setZoom(z => z.s > 1 ? { s: 1, x: 0, y: 0 } : { s: 2.5, x: 0, y: 0 })
      g.current.lastTap = 0; g.current.mode = 'none'; return
    }
    g.current = { ...g.current, lastTap: now, mode: zoom.s > 1 ? 'pan' : 'swipe', sx: t[0].clientX, sy: t[0].clientY, zx: zoom.x, zy: zoom.y }
  }
  const onTouchMove = (e: React.TouchEvent) => {
    const t = e.touches, st = g.current
    if (st.mode === 'pinch' && t.length === 2) {
      const s = Math.max(1, Math.min(5, st.s0 * dist(t) / st.d0))
      setZoom(z => ({ s, x: s === 1 ? 0 : z.x, y: s === 1 ? 0 : z.y }))
    } else if (st.mode === 'pan') {
      setZoom(z => ({ ...z, x: st.zx + (t[0].clientX - st.sx), y: st.zy + (t[0].clientY - st.sy) }))
    } else if (st.mode === 'swipe') {
      setDrag({ x: t[0].clientX - st.sx, y: t[0].clientY - st.sy })
    }
  }
  const onTouchEnd = () => {
    const st = g.current
    if (st.mode === 'swipe') {
      const { x, y } = drag
      if (y > 110 && Math.abs(y) > Math.abs(x)) { onClose(); return }
      if (x < -70 && idx < items.length - 1) setIdx(i => i + 1)
      else if (x > 70 && idx > 0) setIdx(i => i - 1)
    }
    g.current.mode = 'none'
    setDrag({ x: 0, y: 0 })
  }

  const counter = useMemo(() => items.length > 1 ? `${idx + 1} of ${items.length}` : '', [idx, items.length])
  if (!item) return null
  const ab: React.CSSProperties = { border: 'none', background: 'none', color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, fontSize: 10.5, cursor: 'pointer', minWidth: 52 }
  const time = new Date(item.createdAt)
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="absolute inset-0 z-[100] flex flex-col select-none" style={{ background: '#000', color: '#fff', touchAction: 'none' }}>
      <div className="flex items-center gap-3 px-3 pt-header pb-3" style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.75), rgba(0,0,0,0))', position: 'relative', zIndex: 2 }}>
        <button onClick={onClose} aria-label="Close" style={{ width: 40, height: 40, border: 'none', background: 'none', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-[15.5px] font-semibold truncate">{item.sender}</p>
          <p className="text-[12px]" style={{ color: 'rgba(255,255,255,0.7)' }}>{time.toLocaleDateString([], { day: 'numeric', month: 'short' })}, {time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</p>
        </div>
        {counter && <span className="text-[13px]" style={{ color: 'rgba(255,255,255,0.8)' }}>{counter}</span>}
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center overflow-hidden"
        onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
        onDoubleClick={() => setZoom(z => z.s > 1 ? { s: 1, x: 0, y: 0 } : { s: 2.5, x: 0, y: 0 })}
        style={{ opacity: drag.y > 0 ? Math.max(0.3, 1 - drag.y / 400) : 1 }}>
        {src ? (
          <img src={src} alt="Photo" draggable={false}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain',
              transform: `translate(${zoom.x + drag.x}px, ${zoom.y + Math.max(0, drag.y)}px) scale(${zoom.s})`,
              transition: g.current.mode === 'none' ? 'transform 0.2s ease' : 'none' }} />
        ) : progress > 0 ? <ProgressRing progress={progress} size={56} /> : <Loader2 className="w-7 h-7 animate-spin" />}
      </div>
      {items.length > 1 && (
        <>
          {idx > 0 && <button aria-label="Previous photo" onClick={() => setIdx(i => i - 1)} className="hidden lg:flex absolute left-3 top-1/2 w-11 h-11 rounded-full items-center justify-center" style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff' }}>‹</button>}
          {idx < items.length - 1 && <button aria-label="Next photo" onClick={() => setIdx(i => i + 1)} className="hidden lg:flex absolute right-3 top-1/2 w-11 h-11 rounded-full items-center justify-center" style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff' }}>›</button>}
        </>
      )}
      <div className="flex justify-around px-3 pt-2" style={{ paddingBottom: 'calc(18px + env(safe-area-inset-bottom, 0px))', background: 'linear-gradient(to top, rgba(0,0,0,0.8), rgba(0,0,0,0))', position: 'relative', zIndex: 2 }}>
        {onReply && (
          <button style={ab} onClick={() => { onReply(item.msg); onClose() }} aria-label="Reply">
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 016 6v4" /></svg>Reply
          </button>
        )}
        {onForward && (
          <button style={ab} onClick={() => { onForward(item.msg); onClose() }} aria-label="Forward">
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 14l5-5-5-5" /><path d="M20 9H10a6 6 0 00-6 6v4" /></svg>Forward
          </button>
        )}
        <button style={ab} onClick={save} aria-label="Save to device">
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v11M7 11l5 5 5-5M5 20h14" /></svg>Save
        </button>
        <button style={ab} onClick={share} aria-label="Share">
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" /></svg>Share
        </button>
      </div>
      {toast && (
        <div className="absolute left-1/2 -translate-x-1/2 rounded-xl px-4 py-2.5 text-[13px]" style={{ bottom: 110, background: 'rgba(40,48,52,0.95)', whiteSpace: 'nowrap', zIndex: 3 }}>{toast}</div>
      )}
    </motion.div>
  )
}
