// Business → Credit book, Check a QR, staff Attendance and Limits & charges
// (28 Nov, like Paytm for Business's Khata, QR check, staff tools and limits).
import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2, MessageCircle, Link2, ScanLine, ShieldCheck, ShieldAlert, ImagePlus, BookOpen, Clock } from 'lucide-react'
import jsQR from 'jsqr'
import { useUIStore } from '@/store'
import { errorText } from '@/lib/errorText'
import { addLedgerEntry, deleteLedgerCustomer, deleteLedgerEntry, ledgerBalance, saveLedgerCustomer, setStaffAlerts, shiftMinutes, hm, type LedgerCustomer, type LedgerEntry, type Shift } from '@/lib/businessLedger'
import { createPaymentRequest, paymentLink } from '@/lib/merchantPay'
import { contactOf } from '@/lib/shareLinks'
import { checkQr, type QrCheck } from '@/lib/qrCheck'
import { nativeQrDetector, detectNative, decodeJsqr, centreSquare } from '@/lib/qrDecode'
import { CROSS_CHAIN_FEE, SWAP_FEE } from '@/lib/feePolicy'
import type { Counter } from '@/lib/businessCounters'
import type { StaffMember } from '@/lib/businessTeam'
import { BusinessScreen } from './ui'

const usd = (n: number) => `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const card = 'rounded-[20px] bg-card border border-border'
const input = 'w-full h-12 px-4 rounded-2xl bg-card border border-border text-[15px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand/40'
const label = 'block text-[13px] font-semibold text-text-secondary mb-1.5 px-0.5'
const TINTS = ['butter', 'peach', 'sky', 'mint'] as const
const ago = (iso: string) => {
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)
  return d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : d < 7 ? `${d} days ago` : new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' })
}
function Primary({ children, onClick, busy, disabled, tone }: { children: React.ReactNode; onClick: () => void; busy?: boolean; disabled?: boolean; tone?: 'credit' | 'paid' }) {
  const style = tone === 'credit' ? { background: 'color-mix(in srgb, var(--danger) 14%, transparent)', color: 'var(--danger-text, var(--danger))' }
    : tone === 'paid' ? { background: 'color-mix(in srgb, var(--success, #1d8b6f) 16%, transparent)', color: 'var(--success-text, #1d8b6f)' } : undefined
  return <button type="button" onClick={onClick} disabled={busy || disabled} style={style}
    className={`w-full h-12 rounded-2xl text-[15px] font-bold disabled:opacity-50 active:opacity-90 ${tone ? '' : 'bg-brand text-white'}`}>{busy ? 'Saving…' : children}</button>
}

// ── Credit book ─────────────────────────────────────────────────────────────
export function CreditBookScreen({ open, onBack, customers, entries, storeName, onChanged }: {
  open: boolean; onBack: () => void; customers: LedgerCustomer[]; entries: LedgerEntry[]; storeName: string; onChanged: () => void
}) {
  const toast = useUIStore(s => s.showToastMessage)
  const [view, setView] = useState<{ k: 'list' } | { k: 'add' } | { k: 'one'; id: string } | { k: 'entry'; id: string; kind: 'credit' | 'payment' }>({ k: 'list' })
  const [form, setForm] = useState({ name: '', contact: '', amount: '', note: '' })
  const [busy, setBusy] = useState(false)
  const bal = (id: string) => ledgerBalance(entries, id)
  const rows = useMemo(() => [...customers].map(c => ({ c, b: bal(c.id), last: entries.find(e => e.customerId === c.id)?.createdAt ?? c.createdAt }))
    .sort((a, b) => Math.abs(b.b) - Math.abs(a.b)), [customers, entries]) // eslint-disable-line react-hooks/exhaustive-deps
  const toGet = rows.reduce((t, r) => t + Math.max(0, r.b), 0)
  const advances = rows.reduce((t, r) => t + Math.max(0, -r.b), 0)
  const one = view.k === 'one' || view.k === 'entry' ? customers.find(c => c.id === view.id) ?? null : null
  const back = () => view.k === 'list' ? onBack() : view.k === 'entry' ? setView({ k: 'one', id: view.id }) : setView({ k: 'list' })

  const addCustomer = async () => {
    setBusy(true)
    try { const c = await saveLedgerCustomer({ name: form.name, contact: form.contact }); onChanged(); setView({ k: 'one', id: c.id }); setForm({ name: '', contact: '', amount: '', note: '' }) }
    catch (e) { toast(errorText(e, 'Could not add them'), 'error') } finally { setBusy(false) }
  }
  const addEntry = async () => {
    if (view.k !== 'entry') return
    setBusy(true)
    try { await addLedgerEntry(view.id, view.kind, Number(form.amount), form.note); onChanged(); setView({ k: 'one', id: view.id }); setForm(f => ({ ...f, amount: '', note: '' })) }
    catch (e) { toast(errorText(e, 'Could not save'), 'error') } finally { setBusy(false) }
  }
  // A pay link for what they owe - entered in the book when it's paid.
  const payLinkFor = async (c: LedgerCustomer) => {
    const b = bal(c.id)
    if (!(b > 0)) { toast('Nothing to collect', 'info'); return null }
    const i = await createPaymentRequest({ amount: b, note: `Credit book · ${c.name}`, expiresInMinutes: 14 * 24 * 60, ledgerCustomerId: c.id })
    return paymentLink(i.code)
  }
  const remind = async (c: LedgerCustomer) => {
    try {
      const url = await payLinkFor(c); if (!url) return
      const text = `Hi ${c.name}, a reminder from ${storeName}: ${usd(bal(c.id))} to pay. Pay in USDC: ${url}`
      const phone = contactOf(c.contact).phone
      window.open(phone ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}` : `https://wa.me/?text=${encodeURIComponent(text)}`, '_blank')
    } catch (e) { toast(errorText(e, 'Could not make the pay link'), 'error') }
  }
  const sendLink = async (c: LedgerCustomer) => {
    try {
      const url = await payLinkFor(c); if (!url) return
      const text = `${storeName}: ${usd(bal(c.id))} to pay. Pay in USDC:`
      if (navigator.share) { try { await navigator.share({ text, url }); return } catch (e: any) { if (e?.name === 'AbortError') return } }
      await navigator.clipboard.writeText(`${text} ${url}`); toast('Pay link copied', 'success')
    } catch (e) { toast(errorText(e, 'Could not make the pay link'), 'error') }
  }

  const title = view.k === 'add' ? 'Add customer' : view.k === 'entry' ? (view.kind === 'credit' ? 'Gave credit' : 'Got paid') : one ? one.name : 'Credit book'
  return (
    <BusinessScreen open={open} title={title} onBack={back} step={view.k === 'list' ? '' : view.k}
      footer={view.k === 'list' ? <Primary onClick={() => setView({ k: 'add' })}><span className="inline-flex items-center gap-1.5"><Plus className="size-4" /> Add customer</span></Primary>
        : view.k === 'add' ? <Primary busy={busy} disabled={!form.name.trim()} onClick={() => void addCustomer()}>Add</Primary>
        : view.k === 'entry' ? <Primary busy={busy} disabled={!(Number(form.amount) > 0)} tone={view.kind === 'credit' ? 'credit' : 'paid'} onClick={() => void addEntry()}>{view.kind === 'credit' ? 'Save credit' : 'Save payment'}</Primary>
        : one ? <div className="grid grid-cols-2 gap-2.5"><Primary tone="credit" onClick={() => setView({ k: 'entry', id: one.id, kind: 'credit' })}>Gave credit</Primary><Primary tone="paid" onClick={() => setView({ k: 'entry', id: one.id, kind: 'payment' })}>Got paid</Primary></div> : undefined}>
      {view.k === 'list' && (
        <div className="px-5 pt-1 pb-6 flex flex-col gap-3">
          <div className={`${card} grid grid-cols-2 px-4 py-3.5`}>
            <div><p className="text-[12px] text-text-muted">You'll get</p><p className="text-[22px] font-extrabold tabular-nums" style={{ color: 'var(--danger-text, var(--danger))' }}>{usd(toGet)}</p></div>
            <div className="text-right"><p className="text-[12px] text-text-muted">Advances you hold</p><p className="text-[22px] font-extrabold tabular-nums" style={{ color: 'var(--success-text, #1d8b6f)' }}>{usd(advances)}</p></div>
          </div>
          {rows.length === 0 ? (
            <div className={`${card} px-6 py-8 text-center`}>
              <span className="inline-flex size-11 items-center justify-center rounded-2xl bg-surface border border-border mb-3"><BookOpen className="size-5 text-text-muted" /></span>
              <p className="text-sm font-medium text-text-secondary">No one in your credit book</p>
              <p className="text-xs text-text-muted mt-1">Add a customer who takes goods now and pays later</p>
            </div>
          ) : (
            <>
              <p className="text-[13px] font-semibold text-text-secondary px-0.5">{rows.length} customer{rows.length === 1 ? '' : 's'}</p>
              <div className={`${card} overflow-hidden divide-y divide-border`}>
                {rows.map(({ c, b, last }, i) => (
                  <button key={c.id} type="button" onClick={() => setView({ k: 'one', id: c.id })} className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-border/20">
                    <span className="size-10 rounded-full inline-flex items-center justify-center font-extrabold shrink-0" style={{ background: `var(--tile-${TINTS[i % 4]})`, color: `var(--tile-${TINTS[i % 4]}-ink)` }}>{(c.name.trim()[0] || '?').toUpperCase()}</span>
                    <span className="flex-1 min-w-0"><span className="block text-[14.5px] font-semibold text-text-primary truncate">{c.name}</span>
                      <span className="block text-[12px] text-text-muted truncate">{[c.contact, ago(last)].filter(Boolean).join(' · ')}</span></span>
                    <span className="text-right shrink-0"><span className="block text-[14.5px] font-extrabold tabular-nums" style={{ color: b > 0 ? 'var(--danger-text, var(--danger))' : b < 0 ? 'var(--success-text, #1d8b6f)' : 'var(--text-muted)' }}>{usd(b)}</span>
                      <span className="block text-[11.5px] text-text-muted">{b > 0 ? 'to get' : b < 0 ? 'advance' : 'settled'}</span></span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {view.k === 'add' && (
        <div className="px-5 pt-2 pb-6 flex flex-col gap-4">
          <div><span className={label}>Name</span><input className={input} value={form.name} maxLength={80} placeholder="e.g. Ravi Kumar" aria-label="Name" onChange={e => setForm({ ...form, name: e.target.value })} /></div>
          <div><span className={label}>Phone or email <span className="font-normal text-text-muted">(for reminders)</span></span>
            <input className={input} value={form.contact} maxLength={120} inputMode="email" placeholder="Phone (with country code) or email" aria-label="Phone or email" onChange={e => setForm({ ...form, contact: e.target.value })} /></div>
        </div>
      )}

      {one && view.k === 'one' && (
        <div className="px-5 pt-1 pb-6 flex flex-col gap-3">
          <div className={`${card} px-4 py-4 text-center`}>
            <p className="text-[12.5px] text-text-muted">{bal(one.id) >= 0 ? "You'll get" : 'Advance you hold'}</p>
            <p className="text-[32px] font-extrabold tabular-nums" style={{ color: bal(one.id) > 0 ? 'var(--danger-text, var(--danger))' : 'var(--success-text, #1d8b6f)' }}>{usd(bal(one.id))}</p>
            {bal(one.id) > 0 && (
              <div className="flex gap-2 justify-center mt-2">
                <button type="button" onClick={() => void remind(one)} className="h-9 px-3 rounded-full border border-border bg-surface text-[12.5px] font-semibold inline-flex items-center gap-1.5"><MessageCircle className="size-4 text-brand-text" /> Remind on WhatsApp</button>
                <button type="button" onClick={() => void sendLink(one)} className="h-9 px-3 rounded-full border border-border bg-surface text-[12.5px] font-semibold inline-flex items-center gap-1.5"><Link2 className="size-4 text-brand-text" /> Send pay link</button>
              </div>
            )}
          </div>
          <p className="text-[13px] font-semibold text-text-secondary px-0.5">Entries</p>
          {entries.filter(e => e.customerId === one.id).length === 0 ? <p className="text-[13px] text-text-muted px-0.5">No entries yet.</p> : (
            <div className={`${card} overflow-hidden divide-y divide-border`}>
              {entries.filter(e => e.customerId === one.id).map(e => (
                <div key={e.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="flex-1 min-w-0"><span className="block text-[14px] font-semibold text-text-primary truncate">{e.note || (e.kind === 'credit' ? 'Credit' : 'Payment')}</span>
                    <span className="block text-[12px] text-text-muted">{new Date(e.createdAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span></span>
                  <span className="text-[14.5px] font-extrabold tabular-nums" style={{ color: e.kind === 'credit' ? 'var(--danger-text, var(--danger))' : 'var(--success-text, #1d8b6f)' }}>{e.kind === 'credit' ? '+' : '−'}{usd(e.amount)}</span>
                  {!e.fromPayLink && <button type="button" aria-label="Delete entry" onClick={() => void deleteLedgerEntry(e.id).then(onChanged).catch(err => toast(errorText(err, 'Could not delete'), 'error'))} className="text-text-muted"><Trash2 className="size-4" /></button>}
                </div>
              ))}
            </div>
          )}
          <p className="text-[12px] text-text-muted px-0.5">A payment through the pay link is entered for you.</p>
          <button type="button" onClick={() => void deleteLedgerCustomer(one.id).then(() => { onChanged(); setView({ k: 'list' }) }).catch(err => toast(errorText(err, 'Could not remove'), 'error'))}
            className="self-start inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-danger"><Trash2 className="size-4" /> Remove {one.name}</button>
        </div>
      )}

      {view.k === 'entry' && (
        <div className="px-5 pt-2 pb-6 flex flex-col gap-4">
          <div><span className={label}>Amount</span>
            <div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-[20px] font-bold text-text-muted">$</span>
              <input autoFocus className={`${input} !h-14 pl-9 !text-[22px] font-extrabold tabular-nums`} value={form.amount} inputMode="decimal" placeholder="0.00" aria-label="Amount"
                onChange={e => setForm({ ...form, amount: e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1').slice(0, 10) })} /></div></div>
          <div><span className={label}>{view.kind === 'credit' ? 'What did they take?' : 'Note'} <span className="font-normal text-text-muted">(optional)</span></span>
            <input className={input} value={form.note} maxLength={140} placeholder={view.kind === 'credit' ? 'e.g. Groceries' : 'e.g. Paid in cash'} aria-label="Note" onChange={e => setForm({ ...form, note: e.target.value })} /></div>
        </div>
      )}
    </BusinessScreen>
  )
}

// ── Check a QR ──────────────────────────────────────────────────────────────
export function CheckQrScreen({ open, onBack, me, counters, storeName, onPrint }: {
  open: boolean; onBack: () => void; me: { username: string; wallet: string | null }; counters: Counter[]; storeName: string
  /** Print your own QR (a replacement sticker). */ onPrint: () => void
}) {
  const [result, setResult] = useState<QrCheck | null>(null)
  const [camError, setCamError] = useState<string | null>(null)
  const video = useRef<HTMLVideoElement>(null)
  const file = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!open || result) return
    let stop = false, stream: MediaStream | null = null, timer = 0
    const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d', { willReadFrequently: true })
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } })
        if (stop) { stream.getTracks().forEach(t => t.stop()); return }
        const v = video.current!; v.srcObject = stream; await v.play().catch(() => {})
        const native = await nativeQrDetector()
        const tick = async () => {
          if (stop) return
          let text: string | null = null
          try {
            if (v.videoWidth) text = native ? await detectNative(native, v) : ctx ? decodeJsqr(ctx, v, v.videoWidth, v.videoHeight, 640, centreSquare(v.videoWidth, v.videoHeight)) : null
          } catch { /* next frame */ }
          if (text) { setResult(checkQr(text, me)); return }
          timer = window.setTimeout(() => void tick(), 180)
        }
        void tick()
      } catch { setCamError("Can't use the camera - allow it in your phone's settings, or upload a photo of the QR.") }
    })()
    return () => { stop = true; clearTimeout(timer); stream?.getTracks().forEach(t => t.stop()) }
  }, [open, result]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!open) { setResult(null); setCamError(null) } }, [open])

  const fromPhoto = async (f: File) => {
    const img = await createImageBitmap(f)
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height)
    const text = jsQR(d.data, d.width, d.height, { inversionAttempts: 'attemptBoth' })?.data
    setResult(text ? checkQr(text, me) : { verdict: 'unknown', text: 'No QR found in that photo' })
  }
  const counterName = result?.verdict === 'yours' && result.counterId ? counters.find(c => c.id === result.counterId)?.name : null
  return (
    <BusinessScreen open={open} title="Check a QR" onBack={result ? () => setResult(null) : onBack} step={result ? 'result' : ''}
      footer={result ? (result.verdict === 'not_yours'
        ? <div className="grid grid-cols-2 gap-2.5"><button type="button" onClick={() => setResult(null)} className={`${card} h-12 text-[15px] font-bold`}>Scan another</button><Primary onClick={onPrint}>Print my QR</Primary></div>
        : <button type="button" onClick={() => setResult(null)} className={`${card} w-full h-12 text-[15px] font-bold`}>Scan another</button>) : undefined}>
      {!result && (
        <div className="px-5 pt-1 pb-6 flex flex-col gap-3">
          <p className="text-[13px] text-text-muted px-0.5">Point at the QR at your counter. Someone could cover it with theirs - check it now and then.</p>
          <div className="relative rounded-[22px] overflow-hidden bg-black aspect-square">
            {camError ? <p className="absolute inset-0 flex items-center justify-center text-center px-6 text-[13.5px] text-white/80">{camError}</p>
              : <video ref={video} playsInline muted className="absolute inset-0 w-full h-full object-cover" />}
            <div className="absolute inset-[18%] rounded-3xl border-[3px] border-white/85 pointer-events-none" />
            <ScanLine className="absolute left-1/2 top-3 -translate-x-1/2 size-6 text-white/80" />
          </div>
          <input ref={file} type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void fromPhoto(f); e.target.value = '' }} />
          <button type="button" onClick={() => file.current?.click()} className={`${card} h-12 inline-flex items-center justify-center gap-2 text-[14px] font-semibold`}><ImagePlus className="size-4 text-brand-text" /> Upload a photo of the QR</button>
        </div>
      )}
      {result && (
        <div className="px-5 pt-1 pb-6 flex flex-col gap-3">
          <div className={`${card} px-5 py-7 text-center`}>
            <span className="inline-flex size-[72px] rounded-full items-center justify-center mb-3"
              style={result.verdict === 'yours' ? { background: 'color-mix(in srgb, var(--success, #1d8b6f) 16%, transparent)', color: 'var(--success-text, #1d8b6f)' } : { background: 'color-mix(in srgb, var(--danger) 14%, transparent)', color: 'var(--danger-text, var(--danger))' }}>
              {result.verdict === 'yours' ? <ShieldCheck className="size-9" /> : <ShieldAlert className="size-9" />}
            </span>
            <p className="text-[20px] font-extrabold text-text-primary">{result.verdict === 'yours' ? 'This is your QR' : result.verdict === 'not_yours' ? 'Not your QR' : "Not a payment QR"}</p>
            <p className="text-[13.5px] text-text-muted mt-1">{result.verdict === 'yours' ? `Payments go to ${storeName}${counterName ? ` · ${counterName}` : ''}` : result.verdict === 'not_yours' ? 'Money paid to this QR goes to someone else' : 'It doesn\'t pay anyone on MeshPort'}</p>
          </div>
          {result.verdict !== 'unknown' && (
            <div className={`${card} divide-y divide-border text-[13.5px]`}>
              <div className="flex justify-between px-4 py-3"><span className="text-text-muted">Pays</span><b style={result.verdict === 'not_yours' ? { color: 'var(--danger-text, var(--danger))' } : undefined}>{result.verdict === 'yours' ? `${me.username.replace(/\.arc$/i, '')}.arc` : result.pays}</b></div>
              <div className="flex justify-between px-4 py-3"><span className="text-text-muted">Type</span><b>{result.verdict === 'yours' ? { shop: 'Shop QR', counter: 'Counter QR', link: 'Payment link', wallet: 'Your wallet address' }[result.kind] : result.kind === 'wallet' ? 'Plain wallet address' : 'Another MeshPort shop'}</b></div>
              {counterName && <div className="flex justify-between px-4 py-3"><span className="text-text-muted">Counter</span><b>{counterName}</b></div>}
            </div>
          )}
          {result.verdict === 'not_yours' && <p className="text-[12.5px] text-text-muted px-0.5">Take it down and put your own QR up.</p>}
        </div>
      )}
    </BusinessScreen>
  )
}

// ── Attendance (owner) ──────────────────────────────────────────────────────
export function AttendanceScreen({ open, onBack, staff, shifts, counters, onChanged }: {
  open: boolean; onBack: () => void; staff: StaffMember[]; shifts: Shift[]; counters: Counter[]; onChanged: () => void
}) {
  const toast = useUIStore(s => s.showToastMessage)
  const active = staff.filter(s => s.status === 'active' && s.authUid)
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
  const today = (uid: string) => shifts.filter(s => s.staffUid === uid && Date.parse(s.checkIn) >= todayStart.getTime())
  const isIn = (uid: string) => today(uid).some(s => !s.checkOut)
  const counterOf = (uid: string) => counters.find(c => c.staffUids.includes(uid))?.name ?? null
  const inNow = active.filter(s => isIn(s.authUid!)).length
  const week = (uid: string) => shifts.filter(s => s.staffUid === uid).reduce((t, s) => t + shiftMinutes(s), 0)
  const toggle = async (s: StaffMember) => {
    try { await setStaffAlerts(s.id, !s.paymentAlerts); onChanged() } catch (e) { toast(errorText(e, 'Could not change alerts'), 'error') }
  }
  return (
    <BusinessScreen open={open} title="Attendance" onBack={onBack}>
      <div className="px-5 pt-1 pb-6 flex flex-col gap-3">
        <div className={`${card} grid grid-cols-3 px-4 py-3.5`}>
          <div><p className="text-[12px] text-text-muted">In now</p><p className="text-[22px] font-extrabold">{inNow}</p></div>
          <div><p className="text-[12px] text-text-muted">Off</p><p className="text-[22px] font-extrabold">{active.length - inNow}</p></div>
          <div className="text-right"><p className="text-[12px] text-text-muted">Staff</p><p className="text-[22px] font-extrabold">{active.length}</p></div>
        </div>
        {active.length === 0 ? (
          <div className={`${card} px-6 py-8 text-center`}>
            <span className="inline-flex size-11 items-center justify-center rounded-2xl bg-surface border border-border mb-3"><Clock className="size-5 text-text-muted" /></span>
            <p className="text-sm font-medium text-text-secondary">No staff yet</p>
            <p className="text-xs text-text-muted mt-1">Invite staff in Stores &amp; staff - they check in from their own phone</p>
          </div>
        ) : (
          <>
            <p className="text-[13px] font-semibold text-text-secondary px-0.5">Today</p>
            <div className={`${card} overflow-hidden divide-y divide-border`}>
              {active.map((s, i) => {
                const t = today(s.authUid!), open = t.find(x => !x.checkOut), first = t[t.length - 1]
                return (
                  <div key={s.id} className="flex items-center gap-3 px-4 py-3">
                    <span className="size-10 rounded-full inline-flex items-center justify-center font-extrabold shrink-0" style={{ background: `var(--tile-${TINTS[(i + 3) % 4]})`, color: `var(--tile-${TINTS[(i + 3) % 4]}-ink)` }}>{s.username[0]?.toUpperCase()}</span>
                    <span className="flex-1 min-w-0"><span className="block text-[14.5px] font-semibold truncate">{s.username}.arc</span>
                      <span className="block text-[12px] text-text-muted truncate">{[counterOf(s.authUid!), open ? `in since ${new Date(open.checkIn).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : first ? `${hm(t.reduce((m, x) => m + shiftMinutes(x), 0))} today` : 'Off today', `${hm(week(s.authUid!))} this week`].filter(Boolean).join(' · ')}</span></span>
                    <span className="text-[10.5px] font-bold px-1.5 py-px rounded-md" style={open ? { background: 'var(--tile-mint)', color: 'var(--tile-mint-ink)' } : { background: 'var(--surface)', color: 'var(--text-muted)' }}>{open ? 'In' : 'Off'}</span>
                  </div>
                )
              })}
            </div>
            <p className="text-[13px] font-semibold text-text-secondary px-0.5 mt-1">Payment alerts for staff</p>
            <div className={`${card} overflow-hidden divide-y divide-border`}>
              {active.map(s => (
                <div key={s.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="flex-1 min-w-0"><span className="block text-[14.5px] font-semibold truncate">{s.username}.arc</span>
                    <span className="block text-[12px] text-text-muted truncate">{counterOf(s.authUid!) ? `Payments at ${counterOf(s.authUid!)}` : 'Add them to a counter first'}</span></span>
                  <button type="button" role="switch" aria-checked={!!s.paymentAlerts} aria-label={`Payment alerts for ${s.username}`} onClick={() => void toggle(s)} disabled={!counterOf(s.authUid!)}
                    className="relative inline-flex items-center h-7 w-12 rounded-full shrink-0 disabled:opacity-40" style={{ background: s.paymentAlerts ? 'var(--brand)' : 'var(--border)' }}>
                    <span className="absolute size-5 rounded-full bg-white shadow transition-transform" style={{ transform: `translateX(${s.paymentAlerts ? 24 : 4}px)` }} />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </BusinessScreen>
  )
}

// ── Limits & charges ────────────────────────────────────────────────────────
const pct = (bps: number) => `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`
export function LimitsScreen({ open, onBack, shopLimits, onEditShopLimits }: {
  open: boolean; onBack: () => void
  shopLimits: { min: number | null; max: number | null }
  onEditShopLimits?: () => void
}) {
  const range = shopLimits.min != null && shopLimits.max != null ? `${usd(shopLimits.min)} – ${usd(shopLimits.max)}`
    : shopLimits.min != null ? `From ${usd(shopLimits.min)}` : shopLimits.max != null ? `Up to ${usd(shopLimits.max)}` : 'Any amount'
  const row = (k: string, v: React.ReactNode) => <div className="flex justify-between gap-4 px-4 py-3 text-[13.5px]"><span className="text-text-muted">{k}</span><b className="text-right">{v}</b></div>
  return (
    <BusinessScreen open={open} title="Limits & charges" onBack={onBack}>
      <div className="px-5 pt-1 pb-6 flex flex-col gap-3">
        <p className="text-[13px] font-semibold text-text-secondary px-0.5">What MeshPort charges</p>
        <div className={`${card} divide-y divide-border`}>
          {row('Payments you take on Arc', 'No MeshPort fee')}
          {row('Moving money from other networks', `${pct(CROSS_CHAIN_FEE.bps)} · min ${usd(CROSS_CHAIN_FEE.minUsd)}, max ${usd(CROSS_CHAIN_FEE.capUsd)}`)}
          {row('Swap USDC ⇄ EURC', `${pct(SWAP_FEE.bps)} · max ${usd(SWAP_FEE.capUsd)}`)}
          {row('Cash out to your bank', "The partner's fee, shown before you confirm")}
        </div>
        <p className="text-[13px] font-semibold text-text-secondary px-0.5 mt-1">Payment limits</p>
        <div className={`${card} divide-y divide-border`}>
          {row('Largest single payment', '$100,000')}
          {row('Shop QR payments', onEditShopLimits ? <button type="button" onClick={onEditShopLimits} className="text-brand-text font-bold">{range} · Edit</button> : range)}
          {row('Shop QR orders open at once', '30')}
        </div>
        <p className="text-[12px] text-text-muted px-0.5">Network gas on Arc is paid in USDC and is a fraction of a cent.</p>
      </div>
    </BusinessScreen>
  )
}

// ── Staff: check in / check out (staff mode) ────────────────────────────────
export function StaffCheckIn({ owner, counterName }: { owner: string; counterName: string | null }) {
  const toast = useUIStore(s => s.showToastMessage)
  const [shifts, setShifts] = useState<Shift[] | null>(null)
  const [busy, setBusy] = useState(false)
  const load = () => { void import('@/lib/businessLedger').then(m => m.listAttendance(7)).then(setShifts).catch(() => setShifts([])) }
  useEffect(load, [owner]) // eslint-disable-line react-hooks/exhaustive-deps
  const open = shifts?.find(s => !s.checkOut) ?? null
  const go = async () => {
    setBusy(true)
    try {
      const m = await import('@/lib/businessLedger')
      if (open) { await m.checkOut(owner); toast('Checked out', 'success') } else { await m.checkIn(owner); toast('Checked in', 'success') }
      load()
    } catch (e) { toast(errorText(e, open ? 'Could not check out' : 'Could not check in'), 'error') } finally { setBusy(false) }
  }
  const days = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of shifts ?? []) { const k = new Date(s.checkIn).toLocaleDateString([], { weekday: 'short' }); m.set(k, (m.get(k) ?? 0) + shiftMinutes(s)) }
    return [...m.entries()].slice(0, 5)
  }, [shifts])
  return (
    <div className="mx-5 rounded-[20px] bg-card border border-border px-4 py-3.5 flex flex-col gap-2.5">
      <div className="flex items-center gap-3">
        <span className="flex-1 min-w-0">
          <span className="block text-[12.5px] text-text-muted truncate">{[counterName, open ? `In since ${new Date(open.checkIn).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Not checked in'].filter(Boolean).join(' · ')}</span>
          <span className="block text-[15px] font-bold text-text-primary">{open ? hm(shiftMinutes(open)) + ' today' : 'Start your shift'}</span>
        </span>
        <button type="button" onClick={() => void go()} disabled={busy || shifts === null}
          className={`h-10 px-4 rounded-xl text-[14px] font-bold disabled:opacity-50 ${open ? 'border border-border bg-surface text-text-primary' : 'bg-brand text-white'}`}>
          {busy ? '…' : open ? 'Check out' : 'Check in'}
        </button>
      </div>
      {days.length > 0 && <p className="text-[12px] text-text-muted">This week: {days.map(([d, m]) => `${d} ${hm(m)}`).join(' · ')}</p>}
      {!open && <p className="text-[11.5px] text-text-muted">Uses your location once, when your phone allows it.</p>}
    </div>
  )
}
