// Chat photos & files: compression, upload with progress, download with
// progress, and a per-session cache so a photo is never downloaded or
// decrypted twice (and the sender's own photo never flashes blank when its
// saved copy replaces the sending one).
//
// Size / dimensions travel in the storage URL's #fragment
// (…/file.jpg#w=1200&h=900&s=183422) — ignored by the server and by fetch,
// but lets a bubble reserve the right shape before the image loads (no
// jumping) and show the file size before downloading.
import { authHeaders } from '@/lib/chatService'

const SUPA_URL = (import.meta.env.VITE_SUPABASE_URL as string) || ''

// ── metadata in the URL fragment ────────────────────────────────────────────
export type MediaMeta = { w?: number; h?: number; s?: number; g?: string }
export function withMeta(url: string, meta: MediaMeta): string {
  const p: string[] = []
  for (const [k, v] of Object.entries(meta)) {
    if (k === 'g') { if (typeof v === 'string' && /^[a-z0-9]{1,24}$/i.test(v)) p.push(`g=${v}`) }
    else if (v != null && Number.isFinite(v)) p.push(`${k}=${Math.round(v as number)}`)
  }
  return p.length ? `${url.split('#')[0]}#${p.join('&')}` : url
}
export function metaOf(url: string): MediaMeta {
  const frag = url.split('#')[1]
  if (!frag) return {}
  const out: MediaMeta = {}
  for (const part of frag.split('&')) {
    const [k, v] = part.split('=')
    // g = the batch a photo/file was sent in (grouped into one bubble).
    if (k === 'g') { if (v && /^[a-z0-9]{1,24}$/i.test(v)) out.g = v; continue }
    const n = Number(v)
    if ((k === 'w' || k === 'h' || k === 's') && Number.isFinite(n)) out[k] = n
  }
  return out
}
const bare = (url: string) => url.split('#')[0]

export function fmtBytes(n?: number | null): string {
  if (!n || !Number.isFinite(n)) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  txt: 'text/plain', csv: 'text/csv', json: 'application/json', zip: 'application/zip',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg',
}
export const extOf = (name: string) => (name.split('.').pop() || '').toLowerCase()
export const mimeOf = (name: string) => MIME[extOf(name)] || 'application/octet-stream'

/** "MeshPort_2026-09-26_1204.jpg" */
export function saveNameFor(dateIso: string, ext = 'jpg'): string {
  const d = new Date(dateIso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `MeshPort_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.${ext}`
}

// ── cache: remote url → local object URL (+ blob) ───────────────────────────
const cache = new Map<string, { url: string; blob: Blob }>()
export function cachedMedia(url: string): { url: string; blob: Blob } | null {
  return cache.get(bare(url)) ?? null
}
export function putCachedMedia(remoteUrl: string, blob: Blob, localUrl?: string) {
  cache.set(bare(remoteUrl), { url: localUrl ?? URL.createObjectURL(blob), blob })
}

const inflight = new Map<string, Promise<{ url: string; blob: Blob }>>()
/**
 * Downloads (and decrypts, when `iv` is set) a chat photo / file, reporting
 * 0..1 progress. Cached for the session; concurrent callers share one fetch.
 */
export function loadMedia(url: string, iv: string | null, key: any, onProgress?: (p: number) => void, mime?: string): Promise<{ url: string; blob: Blob }> {
  const k = bare(url)
  const hit = cache.get(k)
  if (hit) { onProgress?.(1); return Promise.resolve(hit) }
  const running = inflight.get(k)
  if (running) return running
  const job = (async () => {
    const res = await fetch(k)
    if (!res.ok) throw new Error(`Download failed (${res.status})`)
    const total = Number(res.headers.get('content-length')) || metaOf(url).s || 0
    let bytes: ArrayBuffer
    if (res.body && total && onProgress) {
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let got = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value); got += value.length
        onProgress(Math.min(0.99, got / total))
      }
      const all = new Uint8Array(got)
      let off = 0
      for (const c of chunks) { all.set(c, off); off += c.length }
      bytes = all.buffer
    } else {
      bytes = await res.arrayBuffer()
    }
    let blob: Blob
    if (iv) {
      const { decryptBlob } = await import('@/lib/chatCrypto')
      const plain = await decryptBlob(bytes, iv, key)
      blob = mime ? new Blob([plain], { type: mime }) : plain
    } else {
      blob = new Blob([bytes], { type: mime || res.headers.get('content-type') || '' })
    }
    const entry = { url: URL.createObjectURL(blob), blob }
    cache.set(k, entry)
    onProgress?.(1)
    return entry
  })()
  inflight.set(k, job)
  job.finally(() => inflight.delete(k)).catch(() => {})
  return job
}

// ── compression ─────────────────────────────────────────────────────────────
/**
 * Photos are resized + re-encoded before sending (like WhatsApp): standard
 * 1600px / JPEG 0.82, HD 4096px / 0.92. GIFs are kept as they are. Returns
 * null when the browser can't decode the image (e.g. HEIC) — send it as a
 * file then.
 */
export async function preparePhoto(file: File, hd: boolean): Promise<{ blob: Blob; w: number; h: number } | null> {
  const max = hd ? 4096 : 1600
  const quality = hd ? 0.92 : 0.82
  let bmp: ImageBitmap | null = null
  try { bmp = await createImageBitmap(file) } catch { return null }
  try {
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height))
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale))
    if (file.type === 'image/gif') return { blob: file, w: bmp.width, h: bmp.height }
    // Small already, and no resize needed → keep the original bytes.
    if (scale === 1 && file.size < (hd ? 6 : 0.6) * 1024 * 1024 && file.type === 'image/jpeg') return { blob: file, w, h }
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return { blob: file, w: bmp.width, h: bmp.height }
    ctx.drawImage(bmp, 0, 0, w, h)
    const blob: Blob | null = await new Promise(r => canvas.toBlob(b => r(b), 'image/jpeg', quality))
    return blob && blob.size < file.size ? { blob, w, h } : { blob: file, w: bmp.width, h: bmp.height }
  } finally {
    bmp.close?.()
  }
}

// ── upload with progress (XHR — fetch can't report upload progress) ─────────
export type UploadHandle = { promise: Promise<string>; abort: () => void }
/** Uploads to the public `attachments` bucket; resolves to its public URL. */
export function uploadWithProgress(path: string, blob: Blob, contentType: string, onProgress: (p: number) => void): UploadHandle {
  const xhr = new XMLHttpRequest()
  const promise = (async () => {
    const headers = await authHeaders()
    return await new Promise<string>((resolve, reject) => {
      xhr.open('POST', `${SUPA_URL}/storage/v1/object/attachments/${path}`)
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v)
      xhr.setRequestHeader('Content-Type', contentType)
      xhr.setRequestHeader('x-upsert', 'false')
      xhr.setRequestHeader('cache-control', '3600')
      xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(Math.min(0.99, e.loaded / e.total)) }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) { onProgress(1); resolve(`${SUPA_URL}/storage/v1/object/public/attachments/${path}`) }
        else reject(new Error(`Upload failed (${xhr.status})`))
      }
      xhr.onerror = () => reject(new Error('Upload failed — check your connection'))
      xhr.onabort = () => reject(new Error('cancelled'))
      xhr.send(blob)
    })
  })()
  return { promise, abort: () => { try { xhr.abort() } catch { /* not started */ } } }
}
