// Business → Payouts: pay staff and suppliers. Saved lists (once, weekly or
// monthly) are sent through Bulk Pay on this device; a due one shows here
// and as a notification - nothing is sent without the owner.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Trash2, Users, CalendarClock } from 'lucide-react'
import { useUIStore } from '@/store'
import {
  listPayouts, savePayout, deletePayout, payoutTotal,
  type BusinessPayout, type PayoutRecipient, type PayoutRepeat, type BulkPayPrefill,
} from '@/lib/businessPayouts'
import { BusinessScreen, PrimaryBtn, GhostBtn, Skeleton, Field, TextInput, ChipSelect } from './ui'

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
// Local date (YYYY-MM-DD), not UTC.
const today = () => new Date().toLocaleDateString('en-CA')
const REPEATS: Array<{ id: PayoutRepeat; label: string }> = [
  { id: 'none', label: 'Once' }, { id: 'weekly', label: 'Weekly' }, { id: 'monthly', label: 'Monthly' },
]

function dueText(p: BusinessPayout): { text: string; due: boolean } {
  // A one-time payout has no schedule (older ones were saved with a date).
  if (!p.nextDue || p.repeat === 'none') return { text: p.lastPaidAt ? `Paid ${new Date(p.lastPaidAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : 'No date', due: false }
  const days = Math.round((new Date(p.nextDue + 'T00:00:00').getTime() - new Date(today() + 'T00:00:00').getTime()) / 86400_000)
  if (days < 0) return { text: `Overdue ${-days} day${days === -1 ? '' : 's'}`, due: true }
  if (days === 0) return { text: 'Due today', due: true }
  if (days === 1) return { text: 'Due tomorrow', due: false }
  return { text: `Due ${new Date(p.nextDue + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`, due: false }
}

type Draft = { id?: string; name: string; repeat: PayoutRepeat; nextDue: string; rows: Array<{ to: string; amount: string; label: string }> }
const emptyDraft = (): Draft => ({ name: '', repeat: 'monthly', nextDue: today(), rows: [{ to: '', amount: '', label: '' }] })

export function PayoutsScreen({ open, onBack }: { open: boolean; onBack: () => void }) {
  const navigate = useNavigate()
  const toast = useUIStore(s => s.showToastMessage)
  const [list, setList] = useState<BusinessPayout[] | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)

  const load = () => listPayouts().then(setList).catch(() => setList([]))
  useEffect(() => { if (open) { setDraft(null); load() } }, [open])

  const pay = (p: { id: string; name: string; recipients: PayoutRecipient[] }) => {
    const bulkPay: BulkPayPrefill = { payoutId: p.id, purpose: p.name, recipients: p.recipients.map(r => ({ input: r.to, amount: Number(r.amount) })) }
    navigate('/bulk-payout', { state: { bulkPay } })
  }

  const rows = draft?.rows ?? []
  const clean = rows.filter(r => r.to.trim() || r.amount.trim())
  const rowError = clean.some(r => !r.to.trim() || !(Number(r.amount) > 0)) ? 'Each person needs a username or address and an amount' : null
  const total = clean.reduce((s, r) => s + (Number(r.amount) || 0), 0)
  const canSave = !!draft && draft.name.trim().length > 0 && clean.length > 0 && !rowError && (draft.repeat === 'none' || !!draft.nextDue)

  const save = async (andPay: boolean) => {
    if (!draft || !canSave) return
    setBusy(true)
    try {
      const recipients: PayoutRecipient[] = clean.map(r => ({ to: r.to.trim().replace(/^@/, ''), amount: Number(r.amount), ...(r.label.trim() ? { label: r.label.trim() } : {}) }))
      const saved = await savePayout({ id: draft.id, name: draft.name, recipients, repeat: draft.repeat, nextDue: draft.repeat === 'none' ? null : draft.nextDue || null })
      if (andPay) { pay(saved); return }
      toast('Payout saved', 'success'); setDraft(null); load()
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not save', 'error') }
    setBusy(false)
  }
  const remove = async () => {
    if (!draft?.id) return
    setBusy(true)
    try { await deletePayout(draft.id); setDraft(null); load() } catch (e) { toast(e instanceof Error ? e.message : 'Could not delete', 'error') }
    setBusy(false)
  }
  const setRow = (i: number, k: 'to' | 'amount' | 'label', v: string) =>
    setDraft(d => d && ({ ...d, rows: d.rows.map((r, j) => j === i ? { ...r, [k]: k === 'amount' ? v.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1').slice(0, 9) : v } : r) }))

  if (draft) {
    return (
      <BusinessScreen open={open} title={draft.id ? 'Edit payout' : 'New payout'} onBack={() => setDraft(null)}
        footer={<div className="flex gap-2">
          <div className="flex-1"><GhostBtn disabled={busy || !canSave} onClick={() => save(false)}>Save</GhostBtn></div>
          <div className="flex-1"><PrimaryBtn disabled={busy || !canSave} onClick={() => save(true)}>{busy ? 'Saving…' : total > 0 ? `Pay ${money(total)}` : 'Pay now'}</PrimaryBtn></div>
        </div>}>
        <div className="flex flex-col gap-5 px-5 pt-5 pb-6">
          <Field label="Name"><TextInput value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} maxLength={60} placeholder="e.g. Staff salary, Milk supplier" /></Field>
          <Field label="Repeat"><ChipSelect options={REPEATS} value={draft.repeat} onChange={id => setDraft({ ...draft, repeat: id as PayoutRepeat })} /></Field>
          {draft.repeat !== 'none' && (
            <Field label="Next payment" hint="We remind you on this day">
              <TextInput type="date" value={draft.nextDue} min={today()} onChange={e => setDraft({ ...draft, nextDue: e.target.value })} />
            </Field>
          )}
          <Field label="People" hint={clean.length ? `${clean.length} · ${money(total)}` : undefined}>
            <div className="flex flex-col gap-2">
              {rows.map((r, i) => (
                <div key={i} className="flex flex-col gap-2 rounded-2xl bg-surface border border-border p-3">
                  <div className="flex gap-2">
                    <TextInput value={r.to} onChange={e => setRow(i, 'to', e.target.value)} placeholder="username.arc or 0x…" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                    <button type="button" aria-label="Remove" onClick={() => setDraft({ ...draft, rows: rows.length > 1 ? rows.filter((_, j) => j !== i) : [{ to: '', amount: '', label: '' }] })}
                      className="shrink-0 size-12 inline-flex items-center justify-center rounded-2xl border border-border text-text-muted active:bg-border/30">
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <TextInput inputMode="decimal" value={r.amount} onChange={e => setRow(i, 'amount', e.target.value)} placeholder="Amount ($)" />
                    <TextInput value={r.label} onChange={e => setRow(i, 'label', e.target.value)} maxLength={30} placeholder="Role (optional)" />
                  </div>
                </div>
              ))}
              {rows.length < 100 && (
                <button type="button" onClick={() => setDraft({ ...draft, rows: [...rows, { to: '', amount: '', label: '' }] })}
                  className="min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-2xl border border-dashed border-border text-sm font-semibold text-brand-text active:bg-border/30">
                  <Plus className="size-4" /> Add person
                </button>
              )}
            </div>
          </Field>
          {rowError && <p className="text-xs font-semibold text-danger">{rowError}</p>}
          {draft.id && (
            <button type="button" onClick={remove} disabled={busy} className="self-center min-h-[44px] px-4 text-sm font-semibold text-danger">Delete payout</button>
          )}
        </div>
      </BusinessScreen>
    )
  }

  return (
    <BusinessScreen open={open} title="Payouts" onBack={onBack}
      footer={<PrimaryBtn onClick={() => setDraft(emptyDraft())}>New payout</PrimaryBtn>}>
      <div className="flex flex-col gap-3 px-5 pt-5 pb-6">
        <p className="text-sm text-text-secondary">Pay staff and suppliers in one go. Repeating payouts remind you when they're due.</p>
        {list === null ? (
          <><Skeleton className="h-[76px] rounded-2xl" /><Skeleton className="h-[76px] rounded-2xl" /></>
        ) : list.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <span className="size-12 rounded-full bg-brand/10 text-brand-text inline-flex items-center justify-center"><Users className="size-5" /></span>
            <p className="text-sm font-semibold text-text-primary">No payouts yet</p>
            <p className="text-xs text-text-muted max-w-[260px]">Save your staff salary or a supplier's bill once, then pay it with one tap.</p>
          </div>
        ) : list.map(p => {
          const d = dueText(p)
          return (
            <div key={p.id} className="flex items-center gap-3 rounded-2xl bg-surface border border-border p-4">
              <button type="button" className="flex-1 min-w-0 text-left" onClick={() => setDraft({
                id: p.id, name: p.name, repeat: p.repeat, nextDue: p.nextDue ?? today(),
                rows: p.recipients.map(r => ({ to: r.to, amount: String(r.amount), label: r.label ?? '' })),
              })}>
                <span className="block text-[15px] font-semibold text-text-primary truncate">{p.name}</span>
                <span className="mt-0.5 flex items-center gap-1 text-xs text-text-muted">
                  {money(payoutTotal(p))} · {p.recipients.length} {p.recipients.length === 1 ? 'person' : 'people'}
                  {p.repeat !== 'none' && <> · {p.repeat === 'weekly' ? 'Weekly' : 'Monthly'}</>}
                </span>
                <span className={`mt-1 inline-flex items-center gap-1 text-xs font-semibold ${d.due ? 'text-warning' : 'text-text-secondary'}`}>
                  <CalendarClock className="size-3.5" /> {d.text}
                </span>
              </button>
              <button type="button" onClick={() => pay(p)}
                className="shrink-0 min-h-[40px] px-4 rounded-xl bg-brand text-white text-[13px] font-semibold active:opacity-90">Pay</button>
            </div>
          )
        })}
      </div>
    </BusinessScreen>
  )
}
