// Business → Pay staff: saved pay groups (salary, a supplier), once, weekly
// or monthly. Paying one checks this month's amounts, then sends everyone in
// ONE Arc payment through lib/batchPay (the same engine as Bulk Pay) - all
// inside Business. A due group shows here and as a notification; nothing is
// sent without the owner.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Trash2, Users, CalendarClock, Check, Search, AlertCircle, Loader2, ShieldCheck } from 'lucide-react'
import { useAuthStore, useUIStore, useWalletStore } from '@/store'
import { Avatar } from '@/components/ui/Avatar'
import { useLeaveGuard } from '@/lib/leaveGuard'
import { useMerchant } from '@/lib/merchant'
import { isValidAddress } from '@/lib/arcService'
import { searchUsersDb, type DbUser } from '@/lib/supabase'
import { shortenAddress } from '@/lib/utils'
import { getResumableOperation, clearResumableOperation } from '@/lib/resumableOperation'
import { hasAnyActivityForTx } from '@/lib/ActivityService'
import { prepareBatch, findUnpayable, sendBatch, resolvePayee, batchFee, type BatchRecipient } from '@/lib/batchPay'
import {
  listPayouts, savePayout, deletePayout, payoutTotal, markPayoutPaid,
  type BusinessPayout, type PayoutRecipient, type PayoutRepeat,
} from '@/lib/businessPayouts'
import { AmountKeypad, sanitizeAmountInput } from '@/components/ui/AmountKeypad'
import { AmountChip } from '@/components/ui/AmountField'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DESKTOP_QUERY } from '@/lib/motion'
import { BusinessScreen, ScreenLevel, useScreenLevel, PrimaryBtn, GhostBtn, Skeleton, Field, TextInput, ChipSelect } from './ui'
import { usePasscodeGate } from './passcodeGate'
import { unlockKey } from './settlement'

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const short = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
// Local date (YYYY-MM-DD), not UTC.
const today = () => new Date().toLocaleDateString('en-CA')
const dayLabel = (iso: string) => new Date(iso.length === 10 ? iso + 'T00:00:00' : iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`
const REPEATS: Array<{ id: PayoutRepeat; label: string }> = [
  { id: 'none', label: 'Once' }, { id: 'weekly', label: 'Weekly' }, { id: 'monthly', label: 'Monthly' },
]
const RESUME_KEY = 'staffpay'

/** Days from today to a group's next date (negative = overdue), or null when it has none. */
function daysToDue(p: BusinessPayout): number | null {
  if (!p.nextDue || p.repeat === 'none') return null
  return Math.round((new Date(p.nextDue + 'T00:00:00').getTime() - new Date(today() + 'T00:00:00').getTime()) / 86400_000)
}
function dueChip(p: BusinessPayout): { text: string; tone: 'warn' | 'ok' | 'mute' } {
  const days = daysToDue(p)
  if (days === null) return p.lastPaidAt ? { text: `Paid ${new Date(p.lastPaidAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`, tone: 'ok' } : { text: 'Not paid yet', tone: 'mute' }
  if (days < 0) return { text: `Overdue ${-days}d`, tone: 'warn' }
  if (days === 0) return { text: 'Due today', tone: 'warn' }
  if (days <= 7) return { text: `Due ${new Date(p.nextDue + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short' })}`, tone: 'warn' }
  return { text: new Date(p.nextDue + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }), tone: 'mute' }
}
const CHIP = { warn: 'bg-warning/12 text-warning', ok: 'bg-success/12 text-success', mute: 'bg-bg border border-border text-text-secondary' }

// A person on the check-this-month screen.
type RunRow = {
  key: string; input: string; label?: string; amount: string; on: boolean
  payee: Omit<BatchRecipient, 'id' | 'amount'> | null; state: 'checking' | 'ok' | 'missing' | 'refused'; why?: string
}
type Run = { id: number; payoutId: string | null; name: string; nextDue: string | null; repeat: PayoutRepeat; rows: RunRow[] }
type Phase = { kind: 'review' } | { kind: 'sending'; status: string } | { kind: 'done'; paid: RunRow[]; total: number } | { kind: 'failed'; error: string }

type DraftRow = { to: string; name: string; avatar: string | null; amount: string; label: string }
type Draft = { id?: string; name: string; repeat: PayoutRepeat; nextDue: string; rows: DraftRow[] }
const emptyDraft = (once = false): Draft => ({ name: once ? 'One-time payment' : '', repeat: once ? 'none' : 'monthly', nextDue: today(), rows: [] })
// Pay is in dollars and cents: 2 decimals, like the totals.
const amountInput = (v: string) => sanitizeAmountInput(v, 2).slice(0, 9)
/** Keypad on a pre-filled amount: the first key typed starts a new amount
 *  (480, then 5 → 5, not 4805); backspace still edits what's there. */
const firstKeyReplaces = (fresh: { current: boolean }, before: string, next: string) => {
  if (!fresh.current) return next
  fresh.current = false
  return next.length > before.length && next.startsWith(before) ? next.slice(before.length) : next
}
/** Phone: keep the row being edited in view above the keypad sheet. */
const revealRow = (label: string) => requestAnimationFrame(() =>
  document.querySelector(`[aria-label="${CSS.escape(label)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))

export function PayoutsScreen({ open, onBack }: { open: boolean; onBack: () => void }) {
  const toast = useUIStore(s => s.showToastMessage)
  const [list, setList] = useState<BusinessPayout[] | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [run, setRun] = useState<Run | null>(null)
  const [resuming, setResuming] = useState<string | null>(null)

  const load = () => listPayouts().then(setList).catch(() => setList([]))
  useEffect(() => { if (open) { setDraft(null); setRun(null); load() } }, [open])

  // A staff payment that was still confirming when the app closed: say how
  // it ended (Activity is the source of truth), never offer to pay again blind.
  useEffect(() => {
    if (!open) return
    const marker = getResumableOperation(RESUME_KEY)
    const wallet = (marker?.context as any)?.walletAddress as string | undefined
    if (!marker || !wallet) return
    setResuming('Checking your last staff payment…')
    let live = true, tries = 0
    const poll = async () => {
      if (!live) return
      tries++
      if (await hasAnyActivityForTx(wallet, marker.txHash)) {
        clearResumableOperation(RESUME_KEY)
        const id = (marker.context as any)?.payoutId as string | undefined
        if (id) await markPayoutPaid(id).catch(() => {})
        setResuming(null); load()
        toast(`Your staff payment of ${money(Number((marker.context as any)?.totalAmount ?? 0))} went through`, 'success')
        return
      }
      if (tries >= 8) { setResuming('Still confirming - check Activity before paying again.'); return }
      setTimeout(poll, 1500)
    }
    void poll()
    return () => { live = false }
  }, [open])

  // Each run / draft opened gets its own screen (fresh state); the last one
  // stays rendered while it slides off.
  const seq = useRef(0)
  const openDraft = (d: Draft) => { seq.current++; setDraft(d) }
  const startRun = (p: { id: string | null; name: string; recipients: PayoutRecipient[]; nextDue: string | null; repeat: PayoutRepeat }) =>
    setRun({ id: ++seq.current, payoutId: p.id, name: p.name, nextDue: p.nextDue, repeat: p.repeat, rows: p.recipients.map((r, i) => ({
      key: `${i}_${r.to}`, input: r.to, label: r.label, amount: String(r.amount), on: true, payee: null, state: 'checking',
    })) })

  // Next group to pay: overdue or due within a week, soonest first.
  const due = (list ?? []).map(p => ({ p, d: daysToDue(p) })).filter(x => x.d !== null && x.d <= 7).sort((a, b) => a.d! - b.d!)
  const next = due[0]?.p
  const recent = (list ?? []).filter(p => p.lastPaidAt).sort((a, b) => b.lastPaidAt!.localeCompare(a.lastPaidAt!)).slice(0, 3)

  const lastRun = useRef(run)
  if (run) lastRun.current = run
  const lastDraft = useRef<{ draft: Draft; key: number } | null>(null)
  if (draft) lastDraft.current = { draft, key: seq.current }
  // A run (check this month's pay) and a pay group being made or edited push
  // over the list, which stays mounted and shifts left beneath them - like
  // any screen opened from another (Cash out's tracker does the same).
  const { level, covered } = useScreenLevel()

  return (
    <>
    <ScreenLevel.Provider value={{ level, covered: covered || !!run || !!draft }}>
    <BusinessScreen open={open} title="Pay staff" onBack={onBack}
      action={list?.length ? <button type="button" onClick={() => openDraft(emptyDraft())} className="min-h-[36px] px-2 text-[13px] font-semibold text-brand-text">+ New</button> : undefined}
      footer={<GhostBtn onClick={() => openDraft(emptyDraft(true))}>Pay someone once</GhostBtn>}>
      <div className="flex flex-col gap-4 px-5 pt-5 pb-6">
        {resuming && (
          <div className="flex items-center gap-2.5 rounded-2xl bg-card border border-border p-3.5 text-sm text-text-secondary">
            <Loader2 className="size-4 animate-spin text-brand-text shrink-0" /> {resuming}
          </div>
        )}
        {list === null ? (
          <><Skeleton className="h-[112px] rounded-3xl" /><Skeleton className="h-[160px] rounded-2xl" /></>
        ) : list.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <span className="size-12 rounded-full bg-brand/10 text-brand-text inline-flex items-center justify-center"><Users className="size-5" /></span>
            <p className="text-sm font-semibold text-text-primary">Pay your team in one tap</p>
            <p className="text-xs text-text-muted max-w-[270px]">Save your staff salary or a supplier once. Each time it's due, check the amounts and pay everyone together.</p>
            <div className="w-full max-w-[260px] mt-3"><PrimaryBtn onClick={() => openDraft(emptyDraft())}>Create a pay group</PrimaryBtn></div>
          </div>
        ) : (
          <>
            {next && (
              <div className="rounded-3xl bg-brand text-white p-4 flex flex-col gap-1">
                <p className="text-[11px] uppercase tracking-wider opacity-80">{daysToDue(next)! < 0 ? 'Overdue' : daysToDue(next) === 0 ? 'Due today' : 'Due this week'}</p>
                <div className="flex items-end justify-between gap-3">
                  <p className="text-[28px] font-bold tabular-nums leading-tight">{money(due.reduce((s, x) => s + payoutTotal(x.p), 0))}</p>
                  <button type="button" onClick={() => startRun(next)} className="shrink-0 min-h-[34px] px-3.5 rounded-full bg-white/15 text-[13px] font-semibold active:bg-white/25">Pay now</button>
                </div>
                <p className="text-xs opacity-85 truncate">
                  {next.name} · {people(next.recipients.length)} · {dayLabel(next.nextDue!)}{due.length > 1 ? ` · +${due.length - 1} more` : ''}
                </p>
              </div>
            )}
            <div>
              <p className="text-xs font-semibold text-text-secondary mb-2">Pay groups</p>
              <div className="rounded-2xl bg-card border border-border divide-y divide-border">
                {list.map(p => {
                  const chip = dueChip(p)
                  return (
                    <div key={p.id} className="flex items-center gap-3 px-3.5 py-3">
                      <button type="button" className="flex-1 min-w-0 flex items-center gap-3 text-left" onClick={() => openDraft(draftOf(p))}>
                        <Avatar name={p.name} size="sm" />
                        <span className="min-w-0">
                          <span className="block text-[14px] font-semibold text-text-primary truncate">{p.name}</span>
                          <span className="block text-xs text-text-muted truncate">{people(p.recipients.length)} · {REPEATS.find(r => r.id === p.repeat)?.label}</span>
                        </span>
                      </button>
                      <div className="shrink-0 flex flex-col items-end gap-1">
                        <span className="text-[14px] font-semibold tabular-nums text-text-primary">{short(payoutTotal(p))}</span>
                        <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${CHIP[chip.tone]}`}>{chip.text}</span>
                      </div>
                      <button type="button" onClick={() => startRun(p)}
                        className="shrink-0 min-h-[34px] px-3.5 rounded-xl bg-brand text-white text-[12px] font-semibold active:opacity-90">Pay</button>
                    </div>
                  )
                })}
              </div>
            </div>
            {recent.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-text-secondary mb-2">Recently paid</p>
                <div className="rounded-2xl bg-card border border-border divide-y divide-border">
                  {recent.map(p => (
                    <div key={p.id} className="flex items-center gap-3 px-3.5 py-3">
                      <span className="size-5 rounded-full bg-success text-white inline-flex items-center justify-center shrink-0"><Check className="size-3" strokeWidth={3.5} /></span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-[13px] font-semibold text-text-primary truncate">{p.name}</span>
                        <span className="block text-xs text-text-muted">Paid {dayLabel(p.lastPaidAt!)} · see Activity for details</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </BusinessScreen>
    </ScreenLevel.Provider>
    <ScreenLevel.Provider value={{ level: level + 1, covered }}>
      {lastRun.current && <RunScreen key={`run${lastRun.current.id}`} open={open && !!run} run={lastRun.current} onBack={() => { setRun(null); load() }} onEdit={lastRun.current.payoutId ? () => {
        const p = list?.find(x => x.id === run?.payoutId); if (!p) return
        setRun(null); openDraft(draftOf(p))
      } : undefined} />}
      {lastDraft.current && <DraftScreen key={`draft${lastDraft.current.key}`} open={open && !!draft} draft={lastDraft.current.draft} setDraft={setDraft} onDone={(saved, pay) => {
        setDraft(null)
        if (saved && pay) startRun({ id: saved.id, name: saved.name, recipients: saved.recipients, nextDue: saved.nextDue, repeat: saved.repeat })
        else load()
      }} onDelete={async id => {
        try { await deletePayout(id); setDraft(null); load() } catch (e) { toast(e instanceof Error ? e.message : 'Could not delete', 'error') }
      }} />}
    </ScreenLevel.Provider>
    </>
  )
}

const draftOf = (p: BusinessPayout): Draft => ({
  id: p.id, name: p.name, repeat: p.repeat, nextDue: p.nextDue ?? today(),
  rows: p.recipients.map(r => ({ to: r.to, name: r.to, avatar: null, amount: String(r.amount), label: r.label ?? '' })),
})

// ── Check this month's pay, send, done ───────────────────────────────────

function RunScreen({ open, run: initial, onBack, onEdit }: { open: boolean; run: Run; onBack: () => void; onEdit?: () => void }) {
  const toast = useUIStore(s => s.showToastMessage)
  const balance = Number(useWalletStore(s => s.balance)) || 0
  const businessName = useMerchant().application?.businessName || ''
  const gate = usePasscodeGate()
  const [rows, setRows] = useState<RunRow[]>(initial.rows)
  const [phase, setPhase] = useState<Phase>({ kind: 'review' })
  useLeaveGuard(phase.kind === 'sending', 'Staff payment')
  // Phone: a person's amount is entered on the app's AmountKeypad sheet.
  const isDesktop = useMediaQuery(DESKTOP_QUERY)
  const [padKey, setPadKey] = useState<string | null>(null)
  const padRow = rows.find(r => r.key === padKey)
  const padFresh = useRef(false)

  // Who each saved person is now (name, photo, wallet).
  useEffect(() => {
    let live = true
    import('@/lib/arcService').then(m => m.warmArcRpc()).catch(() => {})
    initial.rows.forEach(r => {
      void resolvePayee(r.input).then(payee => {
        if (!live) return
        setRows(rs => rs.map(x => x.key === r.key ? { ...x, payee, state: payee ? 'ok' : 'missing' } : x))
      })
    })
    return () => { live = false }
  }, [initial])

  const chosen = rows.filter(r => r.on)
  const total = chosen.reduce((s, r) => s + (Number(r.amount) || 0), 0)
  const fee = batchFee(chosen.length)
  const checking = chosen.some(r => r.state === 'checking')
  const blocked = chosen.filter(r => r.state === 'missing' || r.state === 'refused')
  const badAmount = chosen.some(r => !(Number(r.amount) > 0))
  const notEnough = total + fee > balance + 1e-9
  const canPay = chosen.length > 0 && !checking && !blocked.length && !badAmount && !notEnough

  const pay = () => {
    if (!canPay) return
    gate.ask('Pay staff', `${money(total)} to ${people(chosen.length)}`, async code => {
      setPhase({ kind: 'sending', status: 'Checking everyone can be paid…' })
      const recipients: BatchRecipient[] = chosen.map(r => ({ ...r.payee!, id: r.key, amount: Number(r.amount) }))
      try { await unlockKey(code) } catch (e) { setPhase({ kind: 'failed', error: e instanceof Error ? e.message : 'Wallet is locked' }); return }
      const prepared = prepareBatch(recipients)
      const refused = await findUnpayable(recipients)
      if (refused.size) {
        setRows(rs => rs.map(r => refused.has(r.key) ? { ...r, state: 'refused', why: refused.get(r.key) } : r))
        setPhase({ kind: 'review' })
        toast(refused.size === 1 ? "1 person can't be paid - untick them to continue" : `${refused.size} people can't be paid - untick them to continue`, 'error')
        return
      }
      const outcome = await sendBatch(recipients, {
        purpose: initial.name, resumeKey: RESUME_KEY, prepared, payroll: { businessName },
        context: initial.payoutId ? { payoutId: initial.payoutId } : undefined,
        onStatus: status => setPhase({ kind: 'sending', status }),
      })
      if (outcome.state === 'locked') { setPhase({ kind: 'review' }); return }
      if (outcome.state === 'failed') { setPhase({ kind: 'failed', error: outcome.error }); return }
      if (initial.payoutId) void markPayoutPaid(initial.payoutId).catch(() => {})
      setPhase({ kind: 'done', paid: chosen, total })
    })
  }

  const setRow = (key: string, patch: Partial<RunRow>) => setRows(rs => rs.map(r => r.key === key ? { ...r, ...patch } : r))
  const name = (r: RunRow) => r.payee?.displayName || r.input
  const handle = (r: RunRow) => r.payee ? (r.payee.username.startsWith('0x') ? shortenAddress(r.payee.walletAddress) : `${r.payee.username.replace(/\.arc$/, '')}.arc`) : r.input

  // One screen for every phase (each its own step: review → sending → done /
  // failed, and back to the list), so a phase change pushes like any step.
  let screen: { title: string; back: () => void; step: string; footer?: ReactNode; action?: ReactNode; body: ReactNode }
  if (phase.kind === 'sending') {
    const at = /Confirming/.test(phase.status) ? 2 : /Sending|Preparing|balance|Connecting|signer/i.test(phase.status) ? 1 : 0
    const steps = [`Checked all ${chosen.length} accounts`, 'Signed on this phone', 'Confirming on Arc · usually 1–2 s']
    screen = { title: 'Paying your staff', back: () => {}, step: 'sending', body: (
        <div className="flex flex-col items-center gap-5 px-5 pt-8 pb-6">
          <Loader2 className="size-14 text-brand-text animate-spin" strokeWidth={1.6} />
          <div className="text-center">
            <p className="text-[30px] font-bold tabular-nums text-text-primary">{money(total)}</p>
            <p className="text-sm text-text-secondary">to {people(chosen.length)} in one payment</p>
          </div>
          <div className="w-full rounded-2xl bg-card border border-border divide-y divide-border">
            {steps.map((s, i) => (
              <div key={s} className="flex items-center gap-3 px-3.5 py-3">
                {i < at ? <span className="size-5 rounded-full bg-success text-white inline-flex items-center justify-center"><Check className="size-3" strokeWidth={3.5} /></span>
                  : <span className={`size-5 rounded-full border-2 ${i === at ? 'border-brand-text' : 'border-border'}`} />}
                <span className={`text-[13px] ${i <= at ? 'text-text-primary font-medium' : 'text-text-muted'}`}>{s}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-text-muted text-center max-w-[280px]">Keep this screen open. If the app closes, it checks how the payment ended when you come back.</p>
        </div>
    ) }
  } else if (phase.kind === 'done') {
    screen = { title: 'Paid', back: onBack, step: 'done', footer: <PrimaryBtn onClick={onBack}>Done</PrimaryBtn>, body: (
        <div className="flex flex-col items-center gap-4 px-5 pt-8 pb-6">
          <span className="size-16 rounded-full bg-success/12 text-success inline-flex items-center justify-center"><Check className="size-8" strokeWidth={3} /></span>
          <div className="text-center">
            <p className="text-[30px] font-bold tabular-nums text-text-primary">{money(phase.total)}</p>
            <p className="text-sm text-text-secondary">{initial.name} · {people(phase.paid.length)}</p>
          </div>
          <div className="w-full rounded-2xl bg-card border border-border divide-y divide-border">
            {phase.paid.map(r => (
              <div key={r.key} className="flex items-center gap-3 px-3.5 py-3">
                <Avatar name={name(r)} src={r.payee?.avatarUrl ?? undefined} size="sm" />
                <span className="flex-1 min-w-0 text-[14px] font-medium text-text-primary truncate">{name(r)}</span>
                <span className="text-[14px] font-semibold tabular-nums text-text-primary">{short(Number(r.amount))}</span>
              </div>
            ))}
          </div>
          {initial.repeat !== 'none' && (
            <div className="w-full flex items-center gap-2.5 rounded-2xl bg-card border border-border p-3.5 text-xs text-text-secondary">
              <CalendarClock className="size-4 text-brand-text shrink-0" /> Next one is due {initial.repeat === 'weekly' ? 'in a week' : 'next month'}. We'll remind you that morning.
            </div>
          )}
          <p className="text-xs text-text-muted">Everyone's payment is in Activity.</p>
        </div>
    ) }
  } else if (phase.kind === 'failed') {
    screen = { title: initial.name, back: onBack, step: 'failed',
      footer: <div className="flex flex-col gap-2"><PrimaryBtn onClick={() => setPhase({ kind: 'review' })}>Back to the list</PrimaryBtn></div>, body: (
        <div className="flex flex-col items-center gap-3 px-5 pt-10 pb-6 text-center">
          <span className="size-14 rounded-full bg-danger/10 text-danger inline-flex items-center justify-center"><AlertCircle className="size-7" /></span>
          <p className="text-base font-semibold text-text-primary">Nobody was paid</p>
          <p className="text-sm text-text-secondary max-w-[300px]">{phase.error}</p>
        </div>
    ) }
  } else {
    screen = { title: initial.name, back: onBack, step: '',
      action: onEdit ? <button type="button" onClick={onEdit} className="min-h-[36px] px-2 text-[13px] font-semibold text-brand-text">Edit group</button> : undefined,
      footer: <PrimaryBtn disabled={!canPay} onClick={pay}>
          {checking ? 'Checking accounts…' : chosen.length ? `Pay ${people(chosen.length)} · ${money(total)}` : 'Pick someone to pay'}
        </PrimaryBtn>, body: (
        <div className="flex flex-col gap-4 px-5 pt-5 pb-6">
          <p className="text-xs text-text-secondary">Untick anyone you're skipping, or change an amount for this time only. The saved group stays the same.</p>
          <div className="rounded-2xl bg-card border border-border divide-y divide-border">
            {rows.map(r => (
              <div key={r.key} className="flex items-center gap-3 px-3.5 py-3">
                <button type="button" role="checkbox" aria-checked={r.on} aria-label={`Pay ${name(r)}`} onClick={() => setRow(r.key, { on: !r.on })}
                  className={`shrink-0 size-6 rounded-lg border-2 inline-flex items-center justify-center ${r.on ? 'bg-brand border-brand text-white' : 'border-border'}`}>
                  {r.on && <Check className="size-3.5" strokeWidth={3.5} />}
                </button>
                <Avatar name={name(r)} src={r.payee?.avatarUrl ?? undefined} size="sm" />
                <span className="flex-1 min-w-0">
                  <span className={`block text-[14px] font-semibold truncate ${r.on ? 'text-text-primary' : 'text-text-muted line-through'}`}>{name(r)}</span>
                  <span className={`block text-xs truncate ${r.state === 'missing' || r.state === 'refused' ? 'text-danger font-medium' : 'text-text-muted'}`}>
                    {r.state === 'checking' ? 'Checking…' : r.state === 'missing' ? 'Account not found' : r.state === 'refused' ? r.why : [handle(r), r.label].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <AmountChip value={r.amount} ariaLabel={`Amount for ${name(r)}`} disabled={!r.on}
                  onChange={v => setRow(r.key, { amount: amountInput(v) })}
                  onTap={isDesktop ? undefined : () => { padFresh.current = true; setPadKey(r.key); revealRow(`Amount for ${name(r)}`) }} editing={padKey === r.key} />
              </div>
            ))}
          </div>
          <div className="rounded-2xl bg-card border border-border p-3.5 flex flex-col gap-1.5 text-[13px]">
            <div className="flex justify-between text-text-secondary"><span>People</span><span className="font-semibold text-text-primary tabular-nums">{chosen.length}</span></div>
            <div className="flex justify-between text-text-secondary"><span>Network fee</span><span className="font-semibold text-text-primary tabular-nums">≈ ${fee.toFixed(3)}</span></div>
            <div className="flex justify-between text-text-secondary"><span>Your balance</span><span className={`font-semibold tabular-nums ${notEnough ? 'text-danger' : 'text-text-primary'}`}>{money(balance)}</span></div>
          </div>
          {notEnough && chosen.length > 0 && <p className="text-xs font-semibold text-danger">Not enough balance: this needs {money(total + fee)} with the fee.</p>}
          {badAmount && <p className="text-xs font-semibold text-danger">Everyone you're paying needs an amount.</p>}
          {blocked.length > 0 && <p className="text-xs font-semibold text-danger">Untick {blocked.length === 1 ? 'the person' : 'the people'} in red, or fix the group, to continue.</p>}
          <p className="flex items-center gap-1.5 text-xs text-text-muted"><ShieldCheck className="size-3.5" /> Everyone is paid together in one payment, or nobody is.</p>
        </div>
    ) }
  }

  return (
    <>
      <BusinessScreen open={open} title={screen.title} onBack={screen.back} step={screen.step} footer={screen.footer} action={screen.action}>
        {screen.body}
      </BusinessScreen>
      {!isDesktop && (
        <AmountKeypad open={open && phase.kind === 'review' && !!padRow?.on} value={padRow?.amount ?? ''} token="USDC" decimals={2} showMax={false}
          balance={balance} onChange={v => { if (padRow) setRow(padRow.key, { amount: amountInput(firstKeyReplaces(padFresh, padRow.amount, v)) }) }} onClose={() => setPadKey(null)} />
      )}
      {gate.sheet}
    </>
  )
}

// ── New / edit pay group ─────────────────────────────────────────────────

function DraftScreen({ open, draft, setDraft, onDone, onDelete }: {
  open: boolean; draft: Draft; setDraft: (d: Draft) => void
  onDone: (saved: BusinessPayout | null, pay: boolean) => void; onDelete: (id: string) => void
}) {
  const toast = useUIStore(s => s.showToastMessage)
  const me = useAuthStore(s => s.user?.id)
  const [busy, setBusy] = useState(false)
  const [q, setQ] = useState('')
  const [found, setFound] = useState<DbUser[]>([])
  const [searching, setSearching] = useState(false)
  // Phone: a person's amount is entered on the app's AmountKeypad sheet.
  const isDesktop = useMediaQuery(DESKTOP_QUERY)
  const [padIdx, setPadIdx] = useState<number | null>(null)
  const padRow = padIdx != null ? draft.rows[padIdx] : undefined
  const padFresh = useRef(false)

  // Saved people show their name and photo, not just what was typed.
  useEffect(() => {
    let live = true
    draft.rows.forEach((r, i) => {
      if (r.name !== r.to) return
      void resolvePayee(r.to).then(p => {
        if (!live || !p) return
        setDraftRows(rows => rows.map((x, j) => j === i ? { ...x, name: p.displayName, avatar: p.avatarUrl ?? null } : x))
      })
    })
    return () => { live = false }
  }, [draft.id])
  const setDraftRows = (f: (rows: DraftRow[]) => DraftRow[]) => setDraft({ ...draft, rows: f(draft.rows) })

  useEffect(() => {
    const t = q.trim()
    if (!t || isValidAddress(t)) { setFound([]); setSearching(false); return }
    setSearching(true)
    const h = setTimeout(() => { searchUsersDb(t, me).then(setFound).catch(() => setFound([])).finally(() => setSearching(false)) }, 250)
    return () => clearTimeout(h)
  }, [q])

  const has = (to: string) => draft.rows.some(r => r.to.toLowerCase() === to.toLowerCase())
  const add = (row: DraftRow) => {
    if (has(row.to)) { toast('Already in this group', 'info'); return }
    setDraft({ ...draft, rows: [...draft.rows, row] }); setQ(''); setFound([])
  }
  const setRow = (i: number, patch: Partial<DraftRow>) => setDraft({ ...draft, rows: draft.rows.map((r, j) => j === i ? { ...r, ...patch } : r) })

  const total = draft.rows.reduce((s, r) => s + (Number(r.amount) || 0), 0)
  const missingAmount = draft.rows.some(r => !(Number(r.amount) > 0))
  const canSave = draft.name.trim().length > 0 && draft.rows.length > 0 && !missingAmount && (draft.repeat === 'none' || !!draft.nextDue)
  const typedAddress = isValidAddress(q.trim()) ? q.trim() : null

  const save = async (pay: boolean) => {
    if (!canSave) return
    setBusy(true)
    try {
      const recipients: PayoutRecipient[] = draft.rows.map(r => ({ to: r.to.trim().replace(/^@/, ''), amount: Number(r.amount), ...(r.label.trim() ? { label: r.label.trim() } : {}) }))
      const saved = await savePayout({ id: draft.id, name: draft.name, recipients, repeat: draft.repeat, nextDue: draft.repeat === 'none' ? null : draft.nextDue || null })
      if (!pay) toast('Pay group saved', 'success')
      onDone(saved, pay)
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not save', 'error') }
    setBusy(false)
  }

  const results = useMemo(() => found.filter(u => !has(u.username)).slice(0, 5), [found, draft.rows])

  return (
    <>
    <BusinessScreen open={open} title={draft.id ? 'Edit pay group' : draft.repeat === 'none' && !draft.id ? 'Pay once' : 'New pay group'} onBack={() => onDone(null, false)} step="draft"
      footer={<div className="flex gap-2">
        <div className="flex-1"><GhostBtn disabled={busy || !canSave} onClick={() => save(false)}>Save</GhostBtn></div>
        <div className="flex-1"><PrimaryBtn disabled={busy || !canSave} onClick={() => save(true)}>{busy ? 'Saving…' : total > 0 ? `Pay ${short(total)}` : 'Pay now'}</PrimaryBtn></div>
      </div>}>
      <div className="flex flex-col gap-5 px-5 pt-5 pb-6">
        <Field label="Name"><TextInput value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} maxLength={60} placeholder="e.g. Staff salary, Milk supplier" /></Field>
        <Field label="Repeats"><ChipSelect options={REPEATS} value={draft.repeat} onChange={id => setDraft({ ...draft, repeat: id as PayoutRepeat })} /></Field>
        {draft.repeat !== 'none' && (
          <Field label="Next payment" hint="We remind you that morning">
            <TextInput type="date" value={draft.nextDue} min={today()} onChange={e => setDraft({ ...draft, nextDue: e.target.value })} />
          </Field>
        )}
        <Field label="Add a person" hint="Name, username or wallet address">
          <div className="flex flex-col gap-2">
            <div className="relative">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-text-muted pointer-events-none" />
              <TextInput value={q} onChange={e => setQ(e.target.value)} placeholder="Search people" autoCapitalize="none" autoCorrect="off" spellCheck={false} className="pl-10" />
            </div>
            {(results.length > 0 || typedAddress || searching) && (
              <div className="rounded-2xl bg-card border border-border divide-y divide-border">
                {searching && !results.length && <p className="px-3.5 py-3 text-xs text-text-muted">Searching…</p>}
                {results.map(u => (
                  <button key={u.id} type="button" onClick={() => add({ to: u.username, name: u.display_name || u.username, avatar: u.avatar_url, amount: '', label: '' })}
                    className="w-full flex items-center gap-3 px-3.5 py-2.5 text-left active:bg-border/30">
                    <Avatar name={u.display_name || u.username} src={u.avatar_url ?? undefined} size="sm" />
                    <span className="flex-1 min-w-0"><span className="block text-[14px] font-semibold text-text-primary truncate">{u.display_name || u.username}</span><span className="block text-xs text-text-muted truncate">{u.username}.arc</span></span>
                    <span className="px-2.5 py-1 rounded-full bg-brand/10 text-brand-text text-xs font-semibold">Add</span>
                  </button>
                ))}
                {typedAddress && (
                  <button type="button" onClick={() => add({ to: typedAddress, name: shortenAddress(typedAddress), avatar: null, amount: '', label: '' })}
                    className="w-full flex items-center gap-3 px-3.5 py-2.5 text-left active:bg-border/30">
                    <Avatar name={typedAddress} size="sm" />
                    <span className="flex-1 min-w-0 text-[14px] font-semibold text-text-primary truncate">{shortenAddress(typedAddress)}</span>
                    <span className="px-2.5 py-1 rounded-full bg-brand/10 text-brand-text text-xs font-semibold">Add</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </Field>
        <Field label={`In this group${draft.rows.length ? ` · ${draft.rows.length}` : ''}`} hint={draft.rows.length ? short(total) : undefined}>
          {draft.rows.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border px-4 py-5 text-center text-xs text-text-muted">Search above to add the people you pay.</p>
          ) : (
            <div className="rounded-2xl bg-card border border-border divide-y divide-border">
              {draft.rows.map((r, i) => (
                <div key={r.to} className="flex items-center gap-3 px-3.5 py-2.5">
                  <Avatar name={r.name} src={r.avatar ?? undefined} size="sm" />
                  <span className="flex-1 min-w-0">
                    <span className="block text-[14px] font-semibold text-text-primary truncate">{r.name}</span>
                    <input value={r.label} onChange={e => setRow(i, { label: e.target.value.slice(0, 30) })} placeholder="Role (optional)" aria-label={`Role for ${r.name}`}
                      className="w-full bg-transparent text-xs text-text-secondary placeholder:text-text-muted focus:outline-none" />
                  </span>
                  <AmountChip value={r.amount} ariaLabel={`Amount for ${r.name}`} onChange={v => setRow(i, { amount: amountInput(v) })}
                    onTap={isDesktop ? undefined : () => { (document.activeElement as HTMLElement | null)?.blur?.(); padFresh.current = true; setPadIdx(i); revealRow(`Amount for ${r.name}`) }}
                    editing={padIdx === i} />
                  <button type="button" aria-label={`Remove ${r.name}`} onClick={() => setDraft({ ...draft, rows: draft.rows.filter((_, j) => j !== i) })}
                    className="shrink-0 size-9 inline-flex items-center justify-center rounded-xl text-text-muted active:bg-border/30">
                    <Trash2 className="size-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Field>
        {missingAmount && draft.rows.length > 0 && <p className="-mt-2 text-xs font-semibold text-danger">Add an amount for everyone in the group.</p>}
        {draft.id && (
          <button type="button" onClick={() => onDelete(draft.id!)} disabled={busy} className="self-center min-h-[44px] px-4 text-sm font-semibold text-danger inline-flex items-center gap-1.5"><Trash2 className="size-4" /> Delete pay group</button>
        )}
      </div>
    </BusinessScreen>
    {!isDesktop && (
      <AmountKeypad open={open && !!padRow} value={padRow?.amount ?? ''} token="USDC" decimals={2} showMax={false}
        onChange={v => { if (padIdx != null && padRow) setRow(padIdx, { amount: amountInput(firstKeyReplaces(padFresh, padRow.amount, v)) }) }} onClose={() => setPadIdx(null)} />
    )}
    </>
  )
}
