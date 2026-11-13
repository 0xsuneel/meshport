// Business → Bill → Scan: the camera reads product barcodes one after another.
// A saved product's barcode adds it to the bill (again = one more); an unknown
// one asks for the name and price once and saves it with the barcode, so next
// time it is just a scan. "Enter manually" for a code the camera can't read.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Keyboard, ScanLine } from 'lucide-react'
import { nativeBarcodeDetector, detectNativeBarcode, zxingReader, luminance, centreStrip } from '@/lib/barcodeDecode'
import { cleanBarcode, itemForBarcode, type SavedItem } from '@/lib/businessItems'

const SAME_CODE_MS = 2200 // the same barcode held in view counts once
const TICK_MS = 140

export function BarcodeScanner({ open, items, onAdd, onSaveNew, onClose }: {
  open: boolean
  /** Saved products (with their barcodes) */
  items: SavedItem[]
  /** Add one of this product to the bill */
  onAdd: (it: SavedItem) => void
  /** Save an unknown product with its barcode; throws with a message */
  onSaveNew: (name: string, price: number, barcode: string) => Promise<SavedItem>
  onClose: () => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const [camError, setCamError] = useState<string | null>(null)
  const [last, setLast] = useState<{ text: string; tone: 'ok' | 'warn' } | null>(null)
  const [added, setAdded] = useState(0)
  const [unknown, setUnknown] = useState<string | null>(null) // a code to name
  const [manual, setManual] = useState(false)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  // Read in the camera loop without restarting it.
  const itemsRef = useRef(items); itemsRef.current = items
  const pausedRef = useRef(false); pausedRef.current = !!unknown || manual
  const lastCode = useRef<{ code: string; at: number } | null>(null)

  const handle = (raw: string) => {
    const c = cleanBarcode(raw)
    if (!c) { setLast({ text: 'That code isn\'t a product barcode', tone: 'warn' }); return }
    const now = Date.now()
    if (lastCode.current && lastCode.current.code === c && now - lastCode.current.at < SAME_CODE_MS) return
    lastCode.current = { code: c, at: now }
    try { navigator.vibrate?.(35) } catch { /* no vibration */ }
    const it = itemForBarcode(itemsRef.current, c)
    if (it) {
      onAdd(it); setAdded(n => n + 1)
      setLast({ text: `Added ${it.name} · $${it.price.toFixed(2)}`, tone: 'ok' })
    } else {
      setUnknown(c); setName(''); setPrice(''); setFormError(null)
    }
  }
  const handleRef = useRef(handle); handleRef.current = handle

  // Reset each time it opens.
  useEffect(() => {
    if (!open) return
    setCamError(null); setLast(null); setAdded(0); setUnknown(null); setManual(false); setCode(''); lastCode.current = null
  }, [open])

  // Camera + reading loop.
  useEffect(() => {
    if (!open) return
    let stop = false
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ;(async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } })
      } catch (e) {
        if (!stop) setCamError((e as Error)?.name === 'NotAllowedError' ? 'Camera access is off. Allow it in your browser settings, or enter the code.' : 'The camera couldn\'t start. Enter the code instead.')
        return
      }
      if (stop) { stream.getTracks().forEach(t => t.stop()); return }
      const v = video.current
      if (!v) return
      v.srcObject = stream
      try { await v.play() } catch { /* autoplay with muted+playsInline normally works */ }
      const native = await nativeBarcodeDetector()
      const zx = native ? null : await zxingReader().catch(() => null)
      const tick = async () => {
        if (stop) return
        if (!pausedRef.current && v.readyState >= 2 && v.videoWidth) {
          try {
            let found: string | null = null
            if (native) found = await detectNativeBarcode(native, v)
            else if (zx && ctx) {
              const r = centreStrip(v.videoWidth, v.videoHeight)
              const scale = Math.min(1, 900 / r.w)
              canvas.width = Math.round(r.w * scale); canvas.height = Math.round(r.h * scale)
              ctx.drawImage(v, r.x, r.y, r.w, r.h, 0, 0, canvas.width, canvas.height)
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
              found = zx.decode(luminance(img.data), canvas.width, canvas.height)
            }
            if (found && !stop) handleRef.current(found)
          } catch { /* a frame that can't be read - try the next */ }
        }
        if (!stop) timer = setTimeout(tick, TICK_MS)
      }
      void tick()
    })()
    return () => { stop = true; if (timer) clearTimeout(timer); stream?.getTracks().forEach(t => t.stop()) }
  }, [open])

  const saveNew = async () => {
    if (!unknown) return
    const p = Number(price)
    if (!name.trim()) { setFormError('Add a name'); return }
    if (!(p > 0)) { setFormError('Add a price'); return }
    setBusy(true); setFormError(null)
    try {
      const it = await onSaveNew(name.trim(), p, unknown)
      onAdd(it); setAdded(n => n + 1)
      setLast({ text: `Saved and added ${it.name} · $${it.price.toFixed(2)}`, tone: 'ok' })
      setUnknown(null)
      lastCode.current = { code: unknown, at: Date.now() }
    } catch (e) { setFormError(e instanceof Error ? e.message : 'Could not save') }
    setBusy(false)
  }
  const submitManual = () => {
    const c = cleanBarcode(code)
    if (!c) { setFormError('Enter the numbers under the barcode'); return }
    setManual(false); setCode(''); setFormError(null); lastCode.current = null
    handle(c)
  }

  if (!open) return null
  const input = 'w-full h-11 rounded-xl border border-border bg-bg px-3 text-[15px] text-text-primary outline-none focus:border-brand'
  return createPortal(
    <div className="fixed inset-0 z-[400] flex flex-col bg-black" role="dialog" aria-label="Scan barcodes">
      <div className="relative flex-1 min-h-0 overflow-hidden">
        <video ref={video} muted playsInline className="absolute inset-0 w-full h-full object-cover" />
        {/* Viewfinder: a wide band, the shape of a barcode */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="relative rounded-2xl" style={{ width: '86%', maxWidth: 520, aspectRatio: '2.2 / 1', boxShadow: '0 0 0 9999px rgba(0,0,0,0.5)', border: '2px solid rgba(255,255,255,0.9)' }}>
            {!camError && <div className="absolute left-3 right-3 top-1/2 h-0.5 bg-red-500/80" />}
          </div>
        </div>
        <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-4" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 12px)' }}>
          <span className="text-white text-[15px] font-semibold">Scan barcodes</span>
          <button type="button" aria-label="Close scanner" onClick={onClose}
            className="size-10 rounded-full grid place-items-center bg-black/50 text-white"><X size={20} /></button>
        </div>
        <p className="absolute left-0 right-0 text-center text-white/90 text-[13px] px-6" style={{ bottom: 18 }}>
          {camError ?? 'Hold a barcode inside the box'}
        </p>
      </div>

      <div className="bg-surface rounded-t-3xl px-5 pt-4" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)' }}>
        {unknown ? (
          <div className="flex flex-col gap-2.5">
            <p className="text-[15px] font-bold text-text-primary">New product</p>
            <p className="text-xs text-text-muted -mt-1.5">Barcode {unknown} · saved for next time</p>
            <input className={input} placeholder="Name" value={name} maxLength={80} autoFocus onChange={e => { setName(e.target.value); setFormError(null) }} />
            <input className={input} placeholder="Price (USDC)" inputMode="decimal" value={price}
              onChange={e => { setPrice(e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1')); setFormError(null) }}
              onKeyDown={e => { if (e.key === 'Enter') void saveNew() }} />
            {formError && <p className="text-xs text-danger">{formError}</p>}
            <div className="flex gap-2.5">
              <button type="button" onClick={() => { setUnknown(null); setFormError(null) }} className="flex-1 h-12 rounded-2xl border border-border text-sm font-semibold text-text-primary">Skip</button>
              <button type="button" onClick={() => void saveNew()} disabled={busy} className="flex-1 h-12 rounded-2xl bg-brand text-white text-sm font-semibold disabled:opacity-50">{busy ? 'Saving…' : 'Save and add'}</button>
            </div>
          </div>
        ) : manual ? (
          <div className="flex flex-col gap-2.5">
            <p className="text-[15px] font-bold text-text-primary">Enter the barcode</p>
            <input className={input} placeholder="Numbers under the barcode" inputMode="numeric" value={code} autoFocus
              onChange={e => { setCode(e.target.value); setFormError(null) }} onKeyDown={e => { if (e.key === 'Enter') submitManual() }} />
            {formError && <p className="text-xs text-danger">{formError}</p>}
            <div className="flex gap-2.5">
              <button type="button" onClick={() => { setManual(false); setFormError(null) }} className="flex-1 h-12 rounded-2xl border border-border text-sm font-semibold text-text-primary">Back</button>
              <button type="button" onClick={submitManual} className="flex-1 h-12 rounded-2xl bg-brand text-white text-sm font-semibold">Find</button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2.5 min-h-[22px]">
              <ScanLine size={18} className="text-brand-text shrink-0" />
              <p className={`text-sm font-medium truncate ${last?.tone === 'warn' ? 'text-warning' : 'text-text-primary'}`}>
                {last?.text ?? 'Scan each item - it goes straight on the bill'}
              </p>
            </div>
            <div className="flex gap-2.5">
              <button type="button" onClick={() => { setManual(true); setFormError(null) }}
                className="flex-1 h-12 rounded-2xl border border-border text-sm font-semibold text-text-primary inline-flex items-center justify-center gap-2">
                <Keyboard size={17} /> Enter manually
              </button>
              <button type="button" onClick={onClose} className="flex-1 h-12 rounded-2xl bg-brand text-white text-sm font-semibold">
                {added ? `Done · ${added} added` : 'Done'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
