// Home: the payment-reminder popup - bills, payment requests and Split
// Expense shares waiting for this person (lib/dueReminders). One item at a
// time: Pay (the request's own pay screen, passcode-confirmed as always) or
// Hide reminder (this item, for good). "Close all" - and any showing - keeps
// the popup away for 12 hours. Nothing here moves money.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { useAuthStore } from '@/store'
import { Avatar } from '@/components/ui/Avatar'
import { PopupDim } from '@/components/ui/PopupDim'
import { useBackLayer } from '@/lib/backLayers'
import { shortOrderNumber } from '@/lib/orderLabels'
import {
  fetchDueRequests, hideReminder, snoozeReminders, remindersToShow,
  agoText, dueChip, type DueRequest,
} from '@/lib/dueReminders'

const SHOW_AFTER_MS = 1500
// Inside the (solid) card: the next item slides in, the last slides out.
// Like a carousel: both stay opaque, side by side - no see-through mix of two.
const CARD = {
  enter: (d: number) => ({ x: `${d * 100}%` }),
  center: { x: '0%' },
  exit: (d: number) => ({ x: `${d * -100}%` }),
}
const SLIDE = { type: 'tween', ease: [0.32, 0.72, 0, 1], duration: 0.3 } as const
const BAND = { split: 'var(--brand)', bill: '#B9761F', request: '#2B5C8A' } as const
const TITLE = { split: 'Split Expense', bill: 'Bill Reminder', request: 'Payment Request' } as const
/** Checked once per wallet per app session. */
const checked = new Set<string>()

export function money(n: number): string {
  const r = Math.round(n * 100) / 100
  if (Math.abs(r - n) < 1e-9) return `$${r.toFixed(2)}`
  return `$${String(Math.round(n * 1e6) / 1e6)}`
}

function topLine(r: DueRequest): string {
  if (r.kind === 'bill' && r.dueDate) {
    const d = new Date(r.dueDate.length <= 10 ? r.dueDate + 'T00:00:00' : r.dueDate)
    if (!Number.isNaN(d.getTime())) return 'Due: ' + d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  }
  const ago = agoText(r.createdAt)
  if (!ago) return ''
  const verb = r.kind === 'split' ? 'Shared' : r.kind === 'bill' ? 'Sent' : 'Requested'
  return `${verb} ${ago}`
}

export function DueRemindersPopup({ enabled = true }: { enabled?: boolean }) {
  const walletAddress = useAuthStore(s => s.walletAddress)
  const isLocked = useAuthStore(s => s.isLocked)
  const navigate = useNavigate()
  const wallet = walletAddress?.toLowerCase() ?? ''
  const [list, setList] = useState<DueRequest[]>([])
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  useEffect(() => {
    if (!enabled || !wallet || isLocked || checked.has(wallet)) return
    let stop = false
    const t = setTimeout(() => {
      if (checked.has(wallet)) return
      checked.add(wallet)
      fetchDueRequests().then(all => {
        // Left Home or locked meanwhile: try again next time Home opens.
        if (stop || !alive.current || useAuthStore.getState().isLocked || window.location.pathname !== '/') { checked.delete(wallet); return }
        const shown = remindersToShow(all, wallet)
        if (!shown.length) return
        snoozeReminders(wallet, shown.map(x => x.code))
        setList(shown); setAt(0); setOpen(true)
      }).catch(e => { checked.delete(wallet); console.warn('[due reminders]', e) })
    }, SHOW_AFTER_MS)
    return () => { stop = true; clearTimeout(t) }
  }, [enabled, wallet, isLocked])

  const closeAll = useCallback(() => {
    if (busy) return
    if (wallet) snoozeReminders(wallet, list.map(x => x.code))
    setOpen(false)
  }, [busy, wallet, list])
  useBackLayer(open, closeAll)
  // Locked (or left Home) while open: close.
  useEffect(() => { if (isLocked && open) setOpen(false) }, [isLocked, open])

  const drop = (code: string) => {
    const next = list.filter(r => r.code !== code)
    setErr(''); setDir(1)
    if (!next.length) { setOpen(false); return }
    setList(next)
    setAt(i => Math.min(i, next.length - 1))
  }

  // Switching cards slides them (old out, new in - no blank frame between);
  // swipe left / right on the card does the same.
  const [dir, setDir] = useState(1)
  // The card's height follows the item shown (eased, not snapped).
  const contentRef = useRef<HTMLDivElement>(null)
  const [h, setH] = useState<number | 'auto'>('auto')
  const maxH = typeof window !== 'undefined' ? Math.max(320, window.innerHeight - 190) : 600
  const go = (i: number) => {
    if (busy || i === at || i < 0 || i >= list.length) return
    setErr(''); setDir(i > at ? 1 : -1); setAt(i)
  }

  const r = list[at]
  const code = open ? r?.code : undefined
  useLayoutEffect(() => {
    const el = contentRef.current
    if (!code || !el) { setH('auto'); return }
    setH(el.offsetHeight)
    const ro = new ResizeObserver(() => setH(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [code])
  const hide = () => { if (!r || busy) return; hideReminder(wallet, r.code); drop(r.code) }
  const pay = async () => {
    if (!r || busy) return
    setBusy(true); setErr('')
    try {
      const { getPayment, isOrderPayable, orderPaySendUrl } = await import('@/lib/merchantPay')
      const v = await getPayment(r.code)
      if (!alive.current) return
      setBusy(false)
      if (!isOrderPayable(v)) { drop(r.code); return }
      setOpen(false)
      navigate(orderPaySendUrl(v))
    } catch (e) {
      console.warn('[due reminders] open payment failed:', e)
      if (!alive.current) return
      setBusy(false)
      setErr("Couldn't open this payment. Try again.")
    }
  }

  const n = list.length
  const what = !r ? '' : r.kind === 'split' && r.split
    ? `${r.split.emoji ? r.split.emoji + ' ' : ''}${r.split.title || 'Split Expense'} · split with ${r.split.people} people`
    : r.kind === 'bill' ? `Bill ${shortOrderNumber(r.orderNumber) || ''}`.trim()
    : r.note ? `“${r.note}”` : `Request ${shortOrderNumber(r.orderNumber) || ''}`.trim()
  const sub = !r ? '' : r.kind === 'split' && r.split
    ? `Your share of ${money(r.split.total)} · USDC`
    : `USDC${r.fromUsername ? ' · ' + r.fromUsername : ''}`
  const chip = !r ? null : r.kind === 'split' && r.split
    ? { text: `${r.split.paid} of ${r.split.people} already paid`, late: false, ok: true }
    : (() => { const c = dueChip(r.dueDate); return c ? { ...c, ok: false } : null })()
  const partly = r && r.due < r.amount - 1e-9

  return createPortal(
    <AnimatePresence>
      {open && r && (
        <motion.div key="due-reminders" role="dialog" aria-modal aria-label="Payment reminders"
          className="fixed inset-0 z-[80] flex items-center justify-center"
          exit={{ opacity: 0, transition: { duration: 0.18 } }}
          onKeyDown={e => { if (e.key === 'Escape') closeAll() }}>
          <PopupDim background="rgba(0,0,0,0.5)" />
          <div className="absolute inset-0 flex flex-col items-center" style={{ padding: 'calc(env(safe-area-inset-top) + 24px) 16px calc(env(safe-area-inset-bottom) + 36px)' }}>
          <div className="flex-1 min-h-0 w-full flex items-center justify-center">
            {/* The card itself stays solid: only what's inside slides between
                items (a card that faded let Home show through it), and its
                height eases to the next item's. Swipe left / right to switch. */}
            <motion.div
              initial={{ opacity: 0, scale: 0.94, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0, height: h }}
              transition={{ type: 'spring', stiffness: 420, damping: 38 }}
              drag={n > 1 && !busy ? 'x' : false} dragConstraints={{ left: 0, right: 0 }} dragElastic={0.35} dragSnapToOrigin
              onDragEnd={(_, info) => {
                const swipe = info.offset.x + info.velocity.x * 0.2
                if (swipe < -60) go(at + 1)
                else if (swipe > 60) go(at - 1)
              }}
              className="relative touch-pan-y"
              style={{ width: 'min(318px, calc(100vw - 32px))', borderRadius: 28, background: 'var(--surface)', boxShadow: '0 30px 60px -20px rgba(0,0,0,.5)', overflowX: 'hidden', overflowY: h === 'auto' || h < maxH ? 'hidden' : 'auto', maxHeight: maxH }}>
            <AnimatePresence initial={false} mode="popLayout" custom={dir}>
            <motion.div key={r.code} ref={contentRef} custom={dir}
              variants={CARD} initial="enter" animate="center" exit="exit"
              transition={SLIDE}
              style={{ background: 'var(--surface)' }}>
              <div className="relative text-center text-white" style={{ padding: '22px 20px 54px', background: BAND[r.kind] }}>
                {n > 1 && (
                  <span className="absolute font-bold" style={{ top: 14, right: 16, fontSize: 11.5, background: 'rgba(255,255,255,.2)', padding: '3px 8px', borderRadius: 99 }}>
                    {at + 1} of {n}
                  </span>
                )}
                <div className="font-bold" style={{ fontSize: 17 }}>{TITLE[r.kind]}</div>
                {topLine(r) && <div style={{ fontSize: 13, opacity: 0.9, marginTop: 4 }}>{topLine(r)}</div>}
              </div>
              <div className="relative mx-auto flex items-center justify-center rounded-full"
                style={{ width: 76, height: 76, marginTop: -38, background: 'var(--surface)', boxShadow: '0 4px 14px rgba(0,0,0,.15)' }}>
                <Avatar name={r.fromName} src={r.fromAvatar} style={{ width: 64, height: 64, fontSize: 26 }} />
              </div>
              <div className="text-center" style={{ padding: '12px 22px 22px' }}>
                <div className="font-bold truncate" style={{ fontSize: 18, color: 'var(--text-primary)' }}>{r.fromName}</div>
                {what && <div className="line-clamp-2" style={{ fontSize: 13.5, color: 'var(--text-secondary)', marginTop: 3 }}>{what}</div>}
                <div className="font-extrabold tabular-nums" style={{ fontSize: 38, letterSpacing: -1, color: 'var(--text-primary)', marginTop: 14 }}>{money(r.due)}</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2 }}>
                  {partly ? `${money(r.due)} left of ${money(r.amount)} · USDC` : sub}
                </div>
                {r.kind === 'bill' && r.items && r.items.length > 0 && (
                  <div className="grid text-left" style={{ marginTop: 12, fontSize: 12.5, color: 'var(--text-secondary)', borderTop: '1px solid var(--border)', paddingTop: 10, gridTemplateColumns: '1fr auto', gap: '3px 10px' }}>
                    {r.items.slice(0, 4).map((it, i) => (
                      <ItemRow key={i} name={`${it.name} × ${it.qty}`} total={Number(it.total ?? it.qty * it.price)} />
                    ))}
                    {r.items.length > 4 && <span style={{ gridColumn: '1 / -1' }}>+{r.items.length - 4} more</span>}
                  </div>
                )}
                {chip && (
                  <span className="inline-block font-bold" style={{
                    fontSize: 12, padding: '4px 10px', borderRadius: 99, marginTop: 10,
                    background: chip.ok ? 'rgb(var(--brand-rgb) / 0.12)' : chip.late ? 'rgb(var(--danger-rgb) / 0.12)' : 'rgb(var(--warning-rgb) / 0.16)',
                    color: chip.ok ? 'var(--brand-text)' : chip.late ? 'var(--danger-text)' : 'var(--warning-text)',
                  }}>{chip.text}</span>
                )}
                {err && <div style={{ fontSize: 12.5, color: 'var(--danger-text)', marginTop: 10 }}>{err}</div>}
                <button type="button" onClick={pay} disabled={busy}
                  className="w-full flex items-center justify-center font-bold text-white active:scale-[0.98] transition-transform disabled:opacity-70"
                  style={{ marginTop: 18, height: 52, borderRadius: 16, background: 'var(--brand)', fontSize: 16 }}>
                  {busy ? 'Opening…' : r.kind === 'bill' ? 'Pay bill' : `Pay ${money(r.due)}`}
                </button>
                <button type="button" onClick={hide} disabled={busy}
                  className="w-full font-bold disabled:opacity-60" style={{ marginTop: 6, padding: '8px 0', fontSize: 14.5, color: 'var(--danger-text)' }}>
                  Hide reminder
                </button>
                {n > 1 && (
                  <div className="flex justify-center" style={{ gap: 6, marginTop: 8 }}>
                    {list.map((x, i) => (
                      <button key={x.code} type="button" aria-label={`Reminder ${i + 1} of ${n}`} onClick={() => go(i)}
                        style={{ padding: '6px 0' }}>
                        <i className="block transition-all" style={{ width: i === at ? 16 : 6, height: 6, borderRadius: 9, background: i === at ? 'var(--brand)' : 'rgba(128,128,128,.4)' }} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
            </AnimatePresence>
            </motion.div>
          </div>
            <button type="button" onClick={closeAll} disabled={busy} className="shrink-0 text-center text-white" style={{ marginTop: 18 }}>
              <span className="mx-auto flex items-center justify-center rounded-full" style={{ width: 48, height: 48, background: 'rgba(255,255,255,.18)' }}>
                <X size={22} />
              </span>
              <span className="block font-bold" style={{ fontSize: 13, marginTop: 8, letterSpacing: '.04em' }}>{n > 1 ? 'CLOSE ALL' : 'CLOSE'}</span>
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function ItemRow({ name, total }: { name: string; total: number }) {
  return (
    <>
      <span className="truncate">{name}</span>
      <b style={{ color: 'var(--text-primary)', fontWeight: 600, textAlign: 'right' }}>{Number.isFinite(total) ? money(total) : ''}</b>
    </>
  )
}
