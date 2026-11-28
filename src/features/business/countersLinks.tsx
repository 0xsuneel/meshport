// Business → Counters and Payment links (28 Nov, like Paytm for Business).
// A counter has its own Shop QR; payments on it show which counter took them.
// A payment link sells one thing (a fixed price or any amount), paid once or
// many times, and lists the payments it brought in.
import { useMemo, useState } from 'react'
import { Plus, QrCode, Link2, Trash2, Copy, Share2, ChevronRight, Pause, Play } from 'lucide-react'
import { useUIStore } from '@/store'
import { errorText } from '@/lib/errorText'
import { saveCounter, deleteCounter, counterQrUrl, savePayLink, setPayLinkActive, deletePayLink, payLinkUrl, type Counter, type PayLink } from '@/lib/businessCounters'
import type { MerchantPayment } from '@/lib/merchantPay'
import type { Store, StaffMember } from '@/lib/businessTeam'
import { BusinessScreen } from './ui'
import { ShopQrBody } from './screens'

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString()
const TINTS = ['mint', 'butter', 'peach', 'sky'] as const
const card = 'rounded-[20px] bg-card border border-border'
const label = 'block text-[13px] font-semibold text-text-secondary mb-1.5 px-0.5'
const input = 'w-full h-12 px-4 rounded-2xl bg-card border border-border text-[15px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand/40'

function Tile({ i, icon }: { i: number; icon: React.ReactNode }) {
  const t = TINTS[i % TINTS.length]
  return <span className="inline-flex items-center justify-center size-10 rounded-xl shrink-0" style={{ background: `var(--tile-${t})`, color: `var(--tile-${t}-ink)` }}>{icon}</span>
}
function Chip({ on, children, onClick }: { on: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} className="h-9 px-3.5 rounded-full text-[13px] font-semibold border"
      style={on ? { background: 'var(--brand)', color: '#fff', borderColor: 'transparent' } : { background: 'var(--card)', color: 'var(--text-secondary)', borderColor: 'var(--border)' }}>{children}</button>
  )
}
function Primary({ children, onClick, busy, disabled }: { children: React.ReactNode; onClick: () => void; busy?: boolean; disabled?: boolean }) {
  return <button type="button" onClick={onClick} disabled={busy || disabled} className="w-full h-12 rounded-2xl bg-brand text-white text-[15px] font-bold disabled:opacity-50 active:opacity-90">{busy ? 'Saving…' : children}</button>
}

// ── Counters ────────────────────────────────────────────────────────────────
export function CountersScreen({ open, onBack, counters, stores, staff, payments, handle, storeName, onChanged, onSeePayments }: {
  open: boolean; onBack: () => void; counters: Counter[]; stores: Store[]; staff: StaffMember[]
  payments: MerchantPayment[]; handle: string; storeName: string
  onChanged: () => void
  /** Opens Payments filtered to this counter. */
  onSeePayments: (c: Counter) => void
}) {
  const toast = useUIStore(s => s.showToastMessage)
  const [view, setView] = useState<{ kind: 'list' } | { kind: 'edit'; c: { id?: string; name: string; storeId: string | null; staffUids: string[] } } | { kind: 'qr'; id: string }>({ kind: 'list' })
  const [busy, setBusy] = useState(false)
  const today = useMemo(() => {
    const m = new Map<string, { n: number; total: number }>()
    for (const p of payments) if (p.counterId && isToday(p.createdAt)) { const v = m.get(p.counterId) ?? { n: 0, total: 0 }; v.n++; v.total += p.amount; m.set(p.counterId, v) }
    return m
  }, [payments])
  const storeOf = (id: string | null) => stores.find(s => s.id === id)?.name ?? stores.find(s => s.isDefault)?.name ?? null
  const staffOf = (c: Counter) => staff.filter(s => s.authUid && c.staffUids.includes(s.authUid)).map(s => s.username)
  const shown = view.kind === 'qr' ? counters.find(c => c.id === view.id) ?? null : null
  const back = () => view.kind === 'list' ? onBack() : setView({ kind: 'list' })

  const save = async () => {
    if (view.kind !== 'edit') return
    setBusy(true)
    try { await saveCounter(view.c); onChanged(); setView({ kind: 'list' }); toast(view.c.id ? 'Counter saved' : 'Counter added', 'success') }
    catch (e) { toast(errorText(e, 'Could not save the counter'), 'error') }
    finally { setBusy(false) }
  }
  const remove = async (id: string) => {
    setBusy(true)
    try { await deleteCounter(id); onChanged(); setView({ kind: 'list' }); toast('Counter removed', 'success') }
    catch (e) { toast(errorText(e, 'Could not remove the counter'), 'error') }
    finally { setBusy(false) }
  }

  const title = view.kind === 'edit' ? (view.c.id ? 'Edit counter' : 'New counter') : shown ? shown.name : 'Counters'
  return (
    <BusinessScreen open={open} title={title} onBack={back} step={view.kind === 'list' ? '' : view.kind}
      footer={view.kind === 'list' ? <Primary onClick={() => setView({ kind: 'edit', c: { name: counters.length ? `Counter ${counters.length + 1}` : 'Main counter', storeId: stores.find(s => s.isDefault)?.id ?? null, staffUids: [] } })}><span className="inline-flex items-center gap-1.5"><Plus className="size-4" /> Add counter</span></Primary>
        : view.kind === 'edit' ? <Primary busy={busy} onClick={() => void save()}>{view.c.id ? 'Save' : 'Add counter'}</Primary> : undefined}>
      {view.kind === 'list' && (
        <div className="px-5 pt-1 pb-6 flex flex-col gap-3">
          <p className="text-[13px] text-text-muted px-0.5">Each counter has its own QR. Payments show which counter took them.</p>
          {counters.length === 0 ? (
            <div className={`${card} px-6 py-8 text-center`}>
              <span className="inline-flex size-11 items-center justify-center rounded-2xl bg-surface border border-border mb-3"><QrCode className="size-5 text-text-muted" /></span>
              <p className="text-sm font-medium text-text-secondary">No counters yet</p>
              <p className="text-xs text-text-muted mt-1">Add one for each till, window or table - each gets its own QR</p>
            </div>
          ) : (
            <div className={`${card} overflow-hidden divide-y divide-border`}>
              {counters.map((c, i) => {
                const t = today.get(c.id), who = staffOf(c)
                return (
                  <button key={c.id} type="button" onClick={() => setView({ kind: 'qr', id: c.id })} className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-border/20">
                    <Tile i={i} icon={<QrCode className="size-5" />} />
                    <span className="flex-1 min-w-0">
                      <span className="block text-[14.5px] font-semibold text-text-primary truncate">{c.name}</span>
                      <span className="block text-[12px] text-text-muted truncate">{[stores.length > 1 ? storeOf(c.storeId) : null, who.length ? who.map(u => `${u}.arc`).join(', ') : 'No staff'].filter(Boolean).join(' · ')}</span>
                    </span>
                    <span className="text-right shrink-0">
                      <span className="block text-[14.5px] font-bold tabular-nums text-text-primary">{usd(t?.total ?? 0)}</span>
                      <span className="block text-[11.5px] text-text-muted">{t?.n ?? 0} today</span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
          {staff.length > 0 && <p className="text-[12px] text-text-muted px-0.5">Staff see only the counters they're added to.</p>}
        </div>
      )}

      {view.kind === 'edit' && (
        <div className="px-5 pt-2 pb-6 flex flex-col gap-4">
          <div><span className={label}>Name</span>
            <input className={input} value={view.c.name} maxLength={40} placeholder="e.g. Counter 2, Takeaway window" aria-label="Counter name"
              onChange={e => setView({ kind: 'edit', c: { ...view.c, name: e.target.value } })} /></div>
          {stores.length > 1 && <div><span className={label}>Store</span>
            <div className="flex flex-wrap gap-2">{stores.map(s => <Chip key={s.id} on={view.c.storeId === s.id} onClick={() => setView({ kind: 'edit', c: { ...view.c, storeId: s.id } })}>{s.name}</Chip>)}</div></div>}
          <div><span className={label}>Staff at this counter</span>
            {staff.filter(s => s.authUid && s.status === 'active').length === 0
              ? <p className="text-[13px] text-text-muted px-0.5">Invite staff in Stores &amp; staff, then add them here.</p>
              : <div className="flex flex-wrap gap-2">{staff.filter(s => s.authUid && s.status === 'active').map(s => {
                  const on = view.c.staffUids.includes(s.authUid!)
                  return <Chip key={s.id} on={on} onClick={() => setView({ kind: 'edit', c: { ...view.c, staffUids: on ? view.c.staffUids.filter(x => x !== s.authUid) : [...view.c.staffUids, s.authUid!] } })}>{s.username}.arc</Chip>
                })}</div>}
          </div>
          {view.c.id && <button type="button" onClick={() => void remove(view.c.id!)} disabled={busy} className="inline-flex items-center gap-1.5 self-start text-[14px] font-semibold text-danger"><Trash2 className="size-4" /> Remove counter</button>}
        </div>
      )}

      {shown && (
        <div className="pb-6">
          <ShopQrBody active={open} storeName={storeName} handle={handle} url={counterQrUrl(window.location.origin, handle, shown)}
            place={{ label: 'Counter', value: shown.name }} />
          <div className="px-5 grid grid-cols-3 gap-2 -mt-2">
            <div className={`${card} px-3 py-2.5 text-center`}><p className="text-[16px] font-bold tabular-nums">{today.get(shown.id)?.n ?? 0}</p><p className="text-[11px] text-text-muted">Today</p></div>
            <div className={`${card} px-3 py-2.5 text-center`}><p className="text-[16px] font-bold tabular-nums">{usd(today.get(shown.id)?.total ?? 0)}</p><p className="text-[11px] text-text-muted">Taken today</p></div>
            <div className={`${card} px-3 py-2.5 text-center min-w-0`}><p className="text-[14px] font-bold truncate">{staffOf(shown)[0] ? `${staffOf(shown)[0]}.arc` : '—'}</p><p className="text-[11px] text-text-muted">Staff</p></div>
          </div>
          <div className="px-5 mt-3 flex flex-col gap-2">
            <button type="button" onClick={() => onSeePayments(shown)} className={`${card} w-full h-12 inline-flex items-center justify-center gap-1 text-[14px] font-semibold text-text-primary`}>See this counter's payments <ChevronRight className="size-4" /></button>
            <button type="button" onClick={() => setView({ kind: 'edit', c: { id: shown.id, name: shown.name, storeId: shown.storeId, staffUids: shown.staffUids } })} className="h-11 text-[14px] font-semibold text-brand-text">Edit counter</button>
          </div>
        </div>
      )}
    </BusinessScreen>
  )
}

// ── Payment links ───────────────────────────────────────────────────────────
type LinkDraft = { id?: string; title: string; description: string; fixed: boolean; amount: string; multi: boolean; askContact: boolean; counterId: string | null }

export function PayLinksScreen({ open, onBack, links, counters, payments, handle, storeName, onChanged }: {
  open: boolean; onBack: () => void; links: PayLink[]; counters: Counter[]
  payments: MerchantPayment[]; handle: string; storeName: string; onChanged: () => void
}) {
  const toast = useUIStore(s => s.showToastMessage)
  const [view, setView] = useState<{ kind: 'list' } | { kind: 'edit'; d: LinkDraft } | { kind: 'one'; id: string } | { kind: 'qr'; id: string }>({ kind: 'list' })
  const [busy, setBusy] = useState(false)
  const stats = useMemo(() => {
    const m = new Map<string, { n: number; total: number; list: MerchantPayment[] }>()
    for (const p of payments) if (p.linkId) { const v = m.get(p.linkId) ?? { n: 0, total: 0, list: [] }; v.n++; v.total += p.amount; v.list.push(p); m.set(p.linkId, v) }
    return m
  }, [payments])
  const one = view.kind === 'one' || view.kind === 'qr' ? links.find(l => l.id === view.id) ?? null : null
  const back = () => view.kind === 'list' ? onBack() : view.kind === 'qr' ? setView({ kind: 'one', id: view.id }) : setView({ kind: 'list' })
  const urlOf = (l: PayLink) => payLinkUrl(window.location.origin, handle, l.slug)

  const save = async () => {
    if (view.kind !== 'edit') return
    const d = view.d
    const amount = d.fixed ? Number(d.amount) : null
    setBusy(true)
    try {
      const saved = await savePayLink({ id: d.id, title: d.title, description: d.description, amount, multi: d.multi, askContact: d.askContact, counterId: d.counterId,
        storeId: counters.find(c => c.id === d.counterId)?.storeId ?? null }, links.map(l => l.slug))
      onChanged(); setView({ kind: 'one', id: saved.id }); toast(d.id ? 'Link saved' : 'Link created', 'success')
    } catch (e) { toast(errorText(e, 'Could not save the link'), 'error') }
    finally { setBusy(false) }
  }
  const copy = async (l: PayLink) => { try { await navigator.clipboard.writeText(urlOf(l)); toast('Link copied', 'success') } catch { toast('Could not copy', 'error') } }
  const share = async (l: PayLink) => {
    const text = `${storeName}: ${l.title}${l.amount !== null ? ` - ${usd(l.amount)}` : ''}. Pay in USDC:`
    try { if (navigator.share) { await navigator.share({ title: l.title, text, url: urlOf(l) }); return } } catch (e: any) { if (e?.name === 'AbortError') return }
    void copy(l)
  }
  const toggle = async (l: PayLink) => {
    try { await setPayLinkActive(l.id, !l.active); onChanged(); toast(l.active ? 'Link paused' : 'Link is live again', 'success') }
    catch (e) { toast(errorText(e, 'Could not change the link'), 'error') }
  }
  const remove = async (l: PayLink) => {
    try { await deletePayLink(l.id); onChanged(); setView({ kind: 'list' }); toast('Link deleted', 'success') }
    catch (e) { toast(errorText(e, 'Could not delete the link'), 'error') }
  }

  const title = view.kind === 'edit' ? (view.d.id ? 'Edit link' : 'New payment link') : one ? one.title : 'Payment links'
  const d = view.kind === 'edit' ? view.d : null
  const set = (patch: Partial<LinkDraft>) => d && setView({ kind: 'edit', d: { ...d, ...patch } })
  return (
    <BusinessScreen open={open} title={title} onBack={back} step={view.kind === 'list' ? '' : view.kind}
      footer={view.kind === 'list' ? <Primary onClick={() => setView({ kind: 'edit', d: { title: '', description: '', fixed: true, amount: '', multi: true, askContact: false, counterId: null } })}><span className="inline-flex items-center gap-1.5"><Plus className="size-4" /> New payment link</span></Primary>
        : d ? <Primary busy={busy} disabled={!d.title.trim() || (d.fixed && !(Number(d.amount) > 0))} onClick={() => void save()}>{d.id ? 'Save' : 'Create link'}</Primary> : undefined}>
      {view.kind === 'list' && (
        <div className="px-5 pt-1 pb-6 flex flex-col gap-3">
          <p className="text-[13px] text-text-muted px-0.5">A link for a product or a fixed price. Anyone with it can pay - as many times as you like.</p>
          {links.length === 0 ? (
            <div className={`${card} px-6 py-8 text-center`}>
              <span className="inline-flex size-11 items-center justify-center rounded-2xl bg-surface border border-border mb-3"><Link2 className="size-5 text-text-muted" /></span>
              <p className="text-sm font-medium text-text-secondary">No payment links yet</p>
              <p className="text-xs text-text-muted mt-1">Make one and share it on WhatsApp, Instagram or your website</p>
            </div>
          ) : (
            <div className={`${card} overflow-hidden divide-y divide-border`}>
              {links.map(l => {
                const s = stats.get(l.id)
                return (
                  <button key={l.id} type="button" onClick={() => setView({ kind: 'one', id: l.id })} className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-border/20">
                    <Tile i={3} icon={<Link2 className="size-5" />} />
                    <span className="flex-1 min-w-0">
                      <span className="block text-[14.5px] font-semibold text-text-primary truncate">{l.title}</span>
                      <span className="block text-[12px] text-text-muted truncate">{l.amount !== null ? usd(l.amount) : 'Any amount'} · paid {s?.n ?? 0} {s?.n === 1 ? 'time' : 'times'}{!l.multi ? ' · once' : ''}</span>
                    </span>
                    <span className="text-right shrink-0">
                      <span className="block text-[14.5px] font-bold tabular-nums text-text-primary">{usd(s?.total ?? 0)}</span>
                      <span className="inline-block mt-0.5 text-[10.5px] font-bold px-1.5 py-px rounded-md" style={l.active ? { background: 'var(--tile-mint)', color: 'var(--tile-mint-ink)' } : { background: 'var(--surface)', color: 'var(--text-muted)' }}>{l.active ? 'Active' : 'Paused'}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}

      {d && (
        <div className="px-5 pt-2 pb-6 flex flex-col gap-4">
          <div><span className={label}>What's it for?</span>
            <input className={input} value={d.title} maxLength={80} placeholder="e.g. Weekly veg box" aria-label="What it's for" onChange={e => set({ title: e.target.value })} /></div>
          <div><span className={label}>Price</span>
            <div className="flex p-1 rounded-2xl bg-surface border border-border mb-2" role="radiogroup" aria-label="Price">
              {([[true, 'Fixed price'], [false, 'Customer enters']] as const).map(([v, t]) => (
                <button key={t} type="button" role="radio" aria-checked={d.fixed === v} onClick={() => set({ fixed: v })}
                  className="flex-1 h-9 rounded-xl text-[13px] font-bold" style={d.fixed === v ? { background: 'var(--brand)', color: '#fff' } : { color: 'var(--text-muted)' }}>{t}</button>
              ))}
            </div>
            {d.fixed && <div className="relative"><span className="absolute left-4 top-1/2 -translate-y-1/2 text-[20px] font-bold text-text-muted">$</span>
              <input className={`${input} !h-14 pl-9 !text-[22px] font-extrabold tabular-nums`} value={d.amount} inputMode="decimal" placeholder="0.00" aria-label="Price"
                onChange={e => set({ amount: e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1').slice(0, 10) })} /></div>}
          </div>
          <div><span className={label}>Description <span className="font-normal text-text-muted">(optional)</span></span>
            <input className={input} value={d.description} maxLength={200} placeholder="What they get, when it's delivered" aria-label="Description" onChange={e => set({ description: e.target.value })} /></div>
          <div><span className={label}>Can be paid</span>
            <div className="flex gap-2"><Chip on={d.multi} onClick={() => set({ multi: true })}>Many times</Chip><Chip on={!d.multi} onClick={() => set({ multi: false })}>Once</Chip></div></div>
          <div className={`${card} divide-y divide-border`}>
            <div className="flex items-center gap-3 px-4 py-3">
              <span className="flex-1"><span className="block text-[14.5px] font-semibold text-text-primary">Ask for their name &amp; phone</span><span className="block text-[12px] text-text-muted">For a delivery or a booking</span></span>
              <button type="button" role="switch" aria-checked={d.askContact} aria-label="Ask for their name and phone" onClick={() => set({ askContact: !d.askContact })}
                className="relative inline-flex items-center h-7 w-12 rounded-full shrink-0" style={{ background: d.askContact ? 'var(--brand)' : 'var(--border)' }}>
                <span className="absolute size-5 rounded-full bg-white shadow transition-transform" style={{ transform: `translateX(${d.askContact ? 24 : 4}px)` }} />
              </button>
            </div>
            {counters.length > 0 && (
              <div className="px-4 py-3"><span className="block text-[14.5px] font-semibold text-text-primary mb-2">Counter <span className="text-[12px] font-normal text-text-muted">- payments show it</span></span>
                <div className="flex flex-wrap gap-2"><Chip on={!d.counterId} onClick={() => set({ counterId: null })}>None</Chip>
                  {counters.map(c => <Chip key={c.id} on={d.counterId === c.id} onClick={() => set({ counterId: c.id })}>{c.name}</Chip>)}</div></div>
            )}
          </div>
        </div>
      )}

      {one && view.kind === 'one' && (
        <div className="px-5 pt-1 pb-6 flex flex-col gap-3">
          <div className={`${card} px-4 py-3.5`}>
            <p className="text-[12.5px] text-text-muted break-all">{urlOf(one).replace(/^https?:\/\//, '')}</p>
            <p className="text-[26px] font-extrabold tabular-nums text-text-primary mt-1">{one.amount !== null ? usd(one.amount) : 'Any amount'}</p>
            {one.description && <p className="text-[13px] text-text-secondary mt-0.5">{one.description}</p>}
            <div className="grid grid-cols-3 gap-2 mt-3">
              <button type="button" onClick={() => void copy(one)} className="h-10 rounded-xl border border-border bg-surface text-[13px] font-semibold inline-flex items-center justify-center gap-1.5"><Copy className="size-4" /> Copy</button>
              <button type="button" onClick={() => void share(one)} className="h-10 rounded-xl border border-border bg-surface text-[13px] font-semibold inline-flex items-center justify-center gap-1.5"><Share2 className="size-4" /> Share</button>
              <button type="button" onClick={() => setView({ kind: 'qr', id: one.id })} className="h-10 rounded-xl border border-border bg-surface text-[13px] font-semibold inline-flex items-center justify-center gap-1.5"><QrCode className="size-4" /> QR</button>
            </div>
          </div>
          <div className={`${card} grid grid-cols-3 px-2 py-3 text-center`}>
            <div><p className="text-[16px] font-bold tabular-nums">{stats.get(one.id)?.n ?? 0}</p><p className="text-[11px] text-text-muted">Paid</p></div>
            <div><p className="text-[16px] font-bold tabular-nums">{usd(stats.get(one.id)?.total ?? 0)}</p><p className="text-[11px] text-text-muted">Collected</p></div>
            <button type="button" onClick={() => void toggle(one)} className="inline-flex flex-col items-center">
              <span className="inline-flex items-center gap-1 text-[15px] font-bold" style={{ color: one.active ? 'var(--brand-text)' : 'var(--text-muted)' }}>{one.active ? <><Pause className="size-4" /> Active</> : <><Play className="size-4" /> Paused</>}</span>
              <span className="text-[11px] text-text-muted">{one.active ? 'Tap to pause' : 'Tap to turn on'}</span>
            </button>
          </div>
          <p className="text-[13px] font-semibold text-text-secondary px-0.5 mt-1">Payments for this link</p>
          {(stats.get(one.id)?.list.length ?? 0) === 0 ? <p className="text-[13px] text-text-muted px-0.5">No payments yet - share the link to get paid.</p> : (
            <div className={`${card} overflow-hidden divide-y divide-border`}>
              {stats.get(one.id)!.list.slice(0, 50).map(p => (
                <div key={p.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="flex-1 min-w-0">
                    <span className="block text-[14px] font-semibold text-text-primary truncate">{p.payerName || (p.customerUsername ? `${p.customerUsername}.arc` : `${p.from.slice(0, 6)}…${p.from.slice(-4)}`)}</span>
                    <span className="block text-[12px] text-text-muted">{new Date(p.createdAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>
                  </span>
                  <span className="text-[14px] font-bold tabular-nums text-brand-text">+{usd(p.amount)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-between mt-2">
            <button type="button" onClick={() => setView({ kind: 'edit', d: { id: one.id, title: one.title, description: one.description ?? '', fixed: one.amount !== null, amount: one.amount !== null ? String(one.amount) : '', multi: one.multi, askContact: one.askContact, counterId: one.counterId } })}
              className="h-10 text-[14px] font-semibold text-brand-text">Edit link</button>
            <button type="button" onClick={() => void remove(one)} className="h-10 inline-flex items-center gap-1.5 text-[14px] font-semibold text-danger"><Trash2 className="size-4" /> Delete</button>
          </div>
        </div>
      )}

      {one && view.kind === 'qr' && (
        <ShopQrBody active={open} storeName={storeName} handle={handle} url={urlOf(one)}
          place={{ label: 'Link', value: one.title }} caption={one.amount !== null ? `Scan and pay ${usd(one.amount)}` : 'Scan, type the amount and pay'} />
      )}
    </BusinessScreen>
  )
}
