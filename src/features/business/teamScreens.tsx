// Business → Stores & outlets, Staff & roles.
// Visuals from the Arc Studio kit in ./ui; data from lib/businessTeam.
import { useEffect, useMemo, useState } from 'react'
import { useUIStore } from '@/store'
import { listStores, saveStore, deleteStore, setDefaultStore, listStaff, inviteStaff, updateStaff, removeStaff, type Store, type StaffMember, type StaffRole } from '@/lib/businessTeam'
import { BUSINESS_CATEGORIES, toCategory, useBizTerms } from '@/lib/businessCategories'
import { useMerchant } from '@/lib/merchant'
import {
  BusinessScreen, StoresView, StoreForm, StaffView, StaffForm, Skeleton,
} from './ui'

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// ── Stores & outlets ─────────────────────────────────────────────────────

const STORE_TYPES: string[] = [...BUSINESS_CATEGORIES]

type Editing = { title: string; back: () => void } | null

function StoresBody({ open, onEditing, onChanged, onQr, paymentsByStore, addLockedNote }: {
  addLockedNote?: string
  open: boolean; onEditing: (e: Editing) => void; onChanged: (stores: Store[]) => void; onQr: (id: string) => void
  paymentsByStore: Map<string, { total: number; count: number }>
}) {
  const toast = useUIStore(s => s.showToastMessage)
  // A new store starts with the category the business applied with.
  const defaultType = toCategory(useMerchant().application?.businessType)
  const [stores, setStores] = useState<Store[] | null>(null)
  const [edit, setEdit] = useState<{ id?: string; name: string; type: string; address: string; taxId: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const load = () => listStores().then(s => { setStores(s); onChanged(s) }).catch(() => setStores([]))
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately re-runs only on the listed values
  useEffect(() => { if (open) void load(); else setEdit(null) }, [open])
  // Opening / closing a form tells the screen in the same render, so its
  // title and the form change together and the step push pictures the list
  // (an effect a render later showed the form first, then slid it in again).
  const changeEdit = (e: typeof edit) => { setEdit(e); onEditing(e ? { title: e.id ? 'Edit store' : 'New store', back: () => changeEdit(null) } : null) }

  const save = async () => {
    if (!edit) return
    setBusy(true)
    try { await saveStore({ ...edit, isDefault: !edit.id && !(stores ?? []).length ? true : undefined }); changeEdit(null); await load() }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not save', 'error') }
    setBusy(false)
  }
  const remove = async () => {
    if (!edit?.id) return
    setBusy(true)
    try { await deleteStore(edit.id); changeEdit(null); await load() } catch (e) { toast(e instanceof Error ? e.message : 'Could not delete', 'error') }
    setBusy(false)
  }

  return (
      <div className="px-5 pt-4 pb-6">
        {edit ? (
          <StoreForm name={edit.name} onName={v => setEdit({ ...edit, name: v })} type={edit.type} types={STORE_TYPES} onType={v => setEdit({ ...edit, type: v })}
            address={edit.address} onAddress={v => setEdit({ ...edit, address: v })} taxId={edit.taxId} onTaxId={v => setEdit({ ...edit, taxId: v })} busy={busy} onSave={save}
            onDelete={edit.id ? remove : undefined} onCancel={() => changeEdit(null)} />
        ) : stores === null ? <Skeleton className="h-40 w-full" /> : (
          <StoresView stores={stores.map(s => {
            const p = paymentsByStore.get(s.id)
            return { id: s.id, name: s.name, type: s.type ?? 'Store', address: s.address ?? undefined, taxId: s.taxId ?? undefined, isDefault: s.isDefault,
              payments: p ? `${money(p.total)} · ${p.count} payment${p.count === 1 ? '' : 's'}` : 'No payments yet' }
          })}
            onAdd={() => changeEdit({ name: '', type: defaultType, address: '', taxId: '' })}
            onEdit={id => { const s = stores.find(x => x.id === id); if (s) changeEdit({ id, name: s.name, type: s.type ?? STORE_TYPES[0], address: s.address ?? '', taxId: s.taxId ?? '' }) }}
            onSetPrimary={async id => { try { await setDefaultStore(id); await load(); toast('Main store updated', 'success') } catch (e) { toast(e instanceof Error ? e.message : 'Could not update', 'error') } }}
            onQr={onQr} addLockedNote={addLockedNote} />
        )}
      </div>
  )
}

// ── Staff & roles ────────────────────────────────────────────────────────

function StaffBody({ open, onEditing, stores }: { open: boolean; onEditing: (e: Editing) => void; stores: Store[] }) {
  const terms = useBizTerms()
  const toast = useUIStore(s => s.showToastMessage)
  const [staff, setStaff] = useState<StaffMember[] | null>(null)
  const [edit, setEdit] = useState<{ id?: string; username: string; role: StaffRole; store: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const load = () => listStaff().then(setStaff).catch(() => setStaff([]))
  useEffect(() => { if (open) void load(); else setEdit(null) }, [open])
  const changeEdit = (e: typeof edit) => { setEdit(e); onEditing(e ? { title: e.id ? 'Edit staff' : 'Invite staff', back: () => changeEdit(null) } : null) }
  const storeName = useMemo(() => new Map(stores.map(s => [s.id, s.name])), [stores])

  const save = async () => {
    if (!edit) return
    setBusy(true); setError(undefined)
    try {
      if (edit.id) await updateStaff(edit.id, edit.role, edit.store || null)
      else await inviteStaff(edit.username, edit.role, edit.store || null)
      toast(edit.id ? 'Saved' : 'Invite sent', 'success'); changeEdit(null); await load()
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save') }
    setBusy(false)
  }

  return (
      <div className="px-5 pt-4 pb-6">
        {edit ? (
          <StaffForm checkUser={!edit.id} username={edit.username} onUsername={v => setEdit({ ...edit, username: v })} role={edit.role} onRole={r => setEdit({ ...edit, role: r })}
            stores={[{ id: '', name: `All ${terms.stores.toLowerCase()}` }, ...stores.map(s => ({ id: s.id, name: s.name }))]} store={edit.store} onStore={v => setEdit({ ...edit, store: v })}
            busy={busy} error={error} onSave={save} onCancel={() => changeEdit(null)} />
        ) : staff === null ? <Skeleton className="h-40 w-full" /> : (
          <StaffView staff={staff.map(m => ({ id: m.id, name: `${m.username}.arc`, role: m.role, status: m.status, store: m.storeId ? storeName.get(m.storeId) : undefined }))}
            onInvite={() => { setError(undefined); changeEdit({ username: '', role: 'cashier', store: '' }) }}
            onEdit={id => { const m = staff.find(x => x.id === id); if (m) { setError(undefined); changeEdit({ id, username: m.username, role: m.role, store: m.storeId ?? '' }) } }}
            onRemove={async id => { try { await removeStaff(id); await load() } catch (e) { toast(e instanceof Error ? e.message : 'Could not remove', 'error') } }} />
        )}
      </div>
  )
}

// ── Stores & staff (one screen) ──────────────────────────────────────────

export function TeamScreen({ open, onBack, stores, onChanged, onQr, paymentsByStore, canAddStores = true }: {
  /** Stores are opened once the business is approved */
  canAddStores?: boolean
  open: boolean; onBack: () => void; stores: Store[]; onChanged: (stores: Store[]) => void; onQr: (id: string) => void
  paymentsByStore: Map<string, { total: number; count: number }>
}) {
  const terms = useBizTerms()
  const [view, setView] = useState<'stores' | 'staff'>('stores')
  const [editing, setEditing] = useState<Editing>(null)
  useEffect(() => { if (!open) { setView('stores'); setEditing(null) } }, [open])
  return (
    <BusinessScreen open={open} title={editing?.title ?? `${terms.stores} & staff`} onBack={editing?.back ?? onBack} step={editing?.title ?? ''}>
      {!editing && (
        <div className="px-5 pt-4">
          <div className="flex p-1 rounded-2xl bg-surface border border-border" role="tablist" aria-label="Stores or staff">
            {([['stores', terms.stores], ['staff', 'Staff']] as const).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)}
                className={`flex-1 min-h-[40px] rounded-xl text-sm font-semibold transition-colors ${view === id ? 'bg-card text-text-primary shadow-sm' : 'text-text-muted'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {view === 'stores'
        ? <StoresBody open={open} onEditing={setEditing} onChanged={onChanged} onQr={onQr} paymentsByStore={paymentsByStore}
            addLockedNote={canAddStores ? undefined : 'You can add stores once your business is approved'} />
        : <StaffBody open={open} onEditing={setEditing} stores={stores} />}
    </BusinessScreen>
  )
}

