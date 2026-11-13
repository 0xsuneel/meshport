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
  fetchDueRequests, hideReminder, snoozeReminders, remindersToShow, visibleReminders, hiddenCodes,
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
// The person left the popup to pay one reminder: back on Home, the others
// show again (a payment is not "close all"). Per wallet; cleared when shown.
const resumeAfterPay = new Set<string>()

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
        // Only Close all starts the 12 h wait (and Hide removes one for good):
        // being shown alone doesn't - else paying one reminder, or leaving
        // Home, silenced all the others. Back from paying one: every reminder
        // still open shows again (the one just paid is no longer due).
        const resuming = resumeAfterPay.delete(wallet)
        const shown = resuming ? visibleReminders(all, hiddenCodes(wallet)) : remindersToShow(all, wallet)
        if (!shown.length) return
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
  // The app lock coming up isn't "close all" either: after unlocking, Home shows them again.
  useEffect(() => { if (isLocked && open) { setOpen(false); if (wallet) checked.delete(wallet) } }, [isLocked, open, wallet])

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
  // Every card the same size: the tallest of all the reminders shown (each
  // one measured off-screen), so switching never changes the card's shape.
  const measureRef = useRef<HTMLDivElement>(null)
  const [h, setH] = useState<number | null>(null)
  const maxH = typeof window !== 'undefined' ? Math.max(320, window.innerHeight - 190) : 600
  const go = (i: number) => {
    if (busy || i === at || i < 0 || i >= list.length) return
    setErr(''); setDir(i > at ? 1 : -1); setAt(i)
  }

  const r = list[at]
  const listKey = open ? list.map(x => x.code).join(',') + (err ? '|err' : '') : ''
  useLayoutEffect(() => {
    const box = measureRef.current
    if (!listKey || !box) { setH(null); return }
    const measure = () => setH(Math.max(0, ...Array.from(box.children, c => (c as HTMLElement).offsetHeight)))
    measure()
    const ro = new ResizeObserver(measure)
    Array.from(box.children).forEach(c => ro.observe(c))
    return () => ro.disconnect()
  }, [listKey])
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
      // Paying one is not closing them all: back on Home, the rest show again.
      resumeAfterPay.add(wallet)
      checked.delete(wallet)
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

  // One reminder's card contents (shown, and measured off-screen for the
  // shared height). `fill`: stretched to the card, Pay / Hide at its foot.
  const body = (x: DueRequest, idx: number, fill: boolean) => {
    const what = x.kind === 'split' && x.split
      ? `${x.split.emoji ? x.split.emoji + ' ' : ''}${x.split.title || 'Split Expense'} · split with ${x.split.people} people`
      : x.kind === 'bill' ? `Bill ${shortOrderNumber(x.orderNumber) || ''}`.trim()
      : x.note ? `“${x.note}”` : `Request ${shortOrderNumber(x.orderNumber) || ''}`.trim()
    const sub = x.kind === 'split' && x.split ? `Your share of ${money(x.split.total)} · USDC` : `USDC${x.fromUsername ? ' · ' + x.fromUsername : ''}`
    const chip = x.kind === 'split' && x.split
      ? { text: `${x.split.paid} of ${x.split.people} already paid`, late: false, ok: true }
      : (() => { const c = dueChip(x.dueDate); return c ? { ...c, ok: false } : null })()
    const partly = x.due < x.amount - 1e-9
    const shown = idx === at
    return (
      <div className="flex flex-col" style={{ height: fill ? '100%' : undefined, background: 'var(--surface)' }}>
        <div className="relative text-center text-white shrink-0" style={{ padding: '22px 20px 54px', background: BAND[x.kind] }}>
          {n > 1 && (
            <span className="absolute font-bold" style={{ top: 14, right: 16, fontSize: 11.5, background: 'rgba(255,255,255,.2)', padding: '3px 8px', borderRadius: 99 }}>
              {idx + 1} of {n}
            </span>
          )}
          <div className="font-bold" style={{ fontSize: 17 }}>{TITLE[x.kind]}</div>
          {topLine(x) && <div style={{ fontSize: 13, opacity: 0.9, marginTop: 4 }}>{topLine(x)}</div>}
        </div>
        <div className="relative mx-auto flex items-center justify-center rounded-full shrink-0"
          style={{ width: 76, height: 76, marginTop: -38, background: 'var(--surface)', boxShadow: '0 4px 14px rgba(0,0,0,.15)' }}>
          <Avatar name={x.fromName} src={x.fromAvatar} style={{ width: 64, height: 64, fontSize: 26 }} />
        </div>
        <div className="text-center flex flex-col flex-1" style={{ padding: '12px 22px 14px' }}>
          <div className="font-bold truncate" style={{ fontSize: 18, color: 'var(--text-primary)' }}>{x.fromName}</div>
          {what && <div className="line-clamp-2" style={{ fontSize: 13.5, color: 'var(--text-secondary)', marginTop: 3 }}>{what}</div>}
          <div className="font-extrabold tabular-nums" style={{ fontSize: 38, letterSpacing: -1, color: 'var(--text-primary)', marginTop: 14 }}>{money(x.due)}</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2 }}>
            {partly ? `${money(x.due)} left of ${money(x.amount)} · USDC` : sub}
          </div>
          {x.kind === 'bill' && x.items && x.items.length > 0 && (
            <div className="grid text-left" style={{ marginTop: 12, fontSize: 12.5, color: 'var(--text-secondary)', borderTop: '1px solid var(--border)', paddingTop: 10, gridTemplateColumns: '1fr auto', gap: '3px 10px' }}>
              {x.items.slice(0, 3).map((it, k) => (
                <ItemRow key={k} name={`${it.name} × ${it.qty}`} total={Number(it.total ?? it.qty * it.price)} />
              ))}
              {x.items.length > 3 && <span style={{ gridColumn: '1 / -1' }}>+{x.items.length - 3} more</span>}
            </div>
          )}
          {chip && (
            <span className="self-center font-bold" style={{
              fontSize: 12, padding: '4px 10px', borderRadius: 99, marginTop: 10,
              background: chip.ok ? 'rgb(var(--brand-rgb) / 0.12)' : chip.late ? 'rgb(var(--danger-rgb) / 0.12)' : 'rgb(var(--warning-rgb) / 0.16)',
              color: chip.ok ? 'var(--brand-text)' : chip.late ? 'var(--danger-text)' : 'var(--warning-text)',
            }}>{chip.text}</span>
          )}
          {/* Pay / Hide always at the same place, at the card's foot. */}
          <div className="mt-auto" style={{ paddingTop: 14 }}>
            {err && shown && <div style={{ fontSize: 12.5, color: 'var(--danger-text)', marginBottom: 8 }}>{err}</div>}
            <button type="button" onClick={pay} disabled={busy} tabIndex={fill ? undefined : -1}
              className="w-full flex items-center justify-center font-bold text-white active:scale-[0.98] transition-transform disabled:opacity-70"
              style={{ height: 52, borderRadius: 16, background: 'var(--brand)', fontSize: 16 }}>
              {busy && shown ? 'Opening…' : x.kind === 'bill' ? 'Pay bill' : `Pay ${money(x.due)}`}
            </button>
            <button type="button" onClick={hide} disabled={busy} tabIndex={fill ? undefined : -1}
              className="w-full font-bold disabled:opacity-60" style={{ marginTop: 6, padding: '8px 0', fontSize: 14.5, color: 'var(--danger-text)' }}>
              Hide reminder
            </button>
          </div>
        </div>
      </div>
    )
  }
  const cardW = 'min(318px, calc(100vw - 32px))'
  // The page dots sit inside the card, in a strip under its contents.
  const DOTS_H = n > 1 ? 30 : 0
  const cardH = h == null ? undefined : Math.min(h, maxH) + DOTS_H

  return createPortal(
    <AnimatePresence>
      {open && r && (
        <motion.div key="due-reminders" role="dialog" aria-modal aria-label="Payment reminders"
          className="fixed inset-0 z-[80] flex items-center justify-center"
          exit={{ opacity: 0, transition: { duration: 0.18 } }}
          onKeyDown={e => { if (e.key === 'Escape') closeAll() }}>
          <PopupDim background="rgba(0,0,0,0.5)" />
          {/* Every reminder laid out off-screen at the card's width: the card
              takes the tallest one's height (the same shape for all). */}
          <div ref={measureRef} aria-hidden className="fixed pointer-events-none"
            style={{ left: -10000, top: 0, width: cardW, visibility: 'hidden' }}>
            {list.map((x, k) => <div key={x.code}>{body(x, k, false)}</div>)}
          </div>
          {/* The card and Close all right under it, centred together. */}
          <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ padding: 'calc(env(safe-area-inset-top) + 24px) 16px calc(env(safe-area-inset-bottom) + 24px)' }}>
            {/* The card itself never moves while swiping: it is solid from its
                first frame (a fade showed Home through it) and stays put - only
                its contents follow the finger and slide to the next one. */}
            <motion.div
              initial={{ scale: 0.94, y: 12 }} animate={{ scale: 1, y: 0 }}
              transition={{ type: 'spring', stiffness: 420, damping: 38 }}
              className="relative overflow-hidden shrink-0"
              style={{ width: cardW, height: cardH, borderRadius: 28, background: 'var(--surface)', boxShadow: '0 30px 60px -20px rgba(0,0,0,.5)' }}>
            <div className="absolute left-0 right-0 top-0 overflow-hidden" style={{ bottom: DOTS_H }}>
            <AnimatePresence initial={false} mode="popLayout" custom={dir}>
            <motion.div key={r.code} custom={dir}
              variants={CARD} initial="enter" animate="center" exit="exit"
              transition={SLIDE}
              drag={n > 1 && !busy ? 'x' : false} dragConstraints={{ left: 0, right: 0 }} dragElastic={0.6} dragSnapToOrigin
              onDragEnd={(_, info) => {
                const swipe = info.offset.x + info.velocity.x * 0.2
                if (swipe < -60 && at < n - 1) go(at + 1)
                else if (swipe > 60 && at > 0) go(at - 1)
              }}
              className="absolute inset-0 touch-pan-y"
              style={{ overflowY: h != null && h > maxH ? 'auto' : 'hidden' }}>
              {body(r, at, true)}
            </motion.div>
            </AnimatePresence>
            </div>
            {n > 1 && (
              <div className="absolute left-0 right-0 bottom-0 flex items-start justify-center" style={{ height: DOTS_H, gap: 6 }}>
                {list.map((x, k) => (
                  <button key={x.code} type="button" aria-label={`Reminder ${k + 1} of ${n}`} onClick={() => go(k)} style={{ padding: '2px 0 10px' }}>
                    <i className="block transition-all" style={{ width: k === at ? 16 : 6, height: 6, borderRadius: 9, background: k === at ? 'var(--brand)' : 'rgba(128,128,128,.4)' }} />
                  </button>
                ))}
              </div>
            )}
            </motion.div>
            <button type="button" onClick={closeAll} disabled={busy}
              className="shrink-0 flex items-center gap-2 font-bold text-white active:scale-95 transition-transform"
              style={{ marginTop: 16, padding: '11px 22px', borderRadius: 99, background: 'rgba(255,255,255,.18)', fontSize: 13.5, letterSpacing: '.04em' }}>
              <X size={18} strokeWidth={2.6} />
              {n > 1 ? 'CLOSE ALL' : 'CLOSE'}
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
