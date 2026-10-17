/**
 * StoreSwitcher — bottom-sheet body listing stores with a switch action.
 * StoresView — list of stores with Add / Edit / QR actions.
 * StoreForm — create/edit form for a store.
 */
import React from 'react'
import { Store, QrCode, Pencil, Plus, Loader2, ChevronDown, Trash2, CheckCircle2, LayoutGrid, Lock } from 'lucide-react'

// ─── StoreSwitcher ────────────────────────────────────────────────────────────

export interface SwitcherStore {
  id: string
  name: string
  handle: string
  active: boolean
  /** The "All stores" row - totals for every store, not a store itself */
  all?: boolean
}

export interface StoreSwitcherProps {
  stores: SwitcherStore[]
  onSwitch: (id: string) => void
  onManage: () => void
}

export function StoreSwitcher({ stores, onSwitch, onManage }: StoreSwitcherProps) {
  return (
    <div className="flex flex-col gap-1">
      {stores.map(store => (
        <button
          key={store.id}
          type="button"
          onClick={() => onSwitch(store.id)}
          className={[
            'flex items-center gap-3 px-4 py-3.5 rounded-2xl transition-all text-left',
            store.active ? 'bg-brand/10' : 'hover:bg-card',
          ].join(' ')}
        >
          <span className={[
            'size-9 rounded-xl flex items-center justify-center shrink-0',
            store.active ? 'bg-brand text-white' : 'bg-card border border-border text-text-muted',
          ].join(' ')}>
            {store.all ? <LayoutGrid className="size-4.5" /> : <Store className="size-4.5" />}
          </span>
          <div className="flex-1 min-w-0">
            <p className={`text-sm font-semibold truncate ${store.active ? 'text-brand-text' : 'text-text-primary'}`}>
              {store.name}
            </p>
            <p className="text-xs text-text-muted truncate">{store.handle}</p>
          </div>
          {store.active && <CheckCircle2 className="size-5 text-brand-text shrink-0" />}
        </button>
      ))}

      <div className="pt-2 border-t border-border mt-1">
        <button
          type="button"
          onClick={onManage}
          className="w-full h-11 text-sm text-text-secondary font-medium hover:text-text-primary transition-colors"
        >
          Manage all stores
        </button>
      </div>
    </div>
  )
}

// ─── StoresView ───────────────────────────────────────────────────────────────

export interface StoreEntry {
  id: string
  name: string
  type: string
  address?: string
  isDefault: boolean
  payments: string   // "$1,240 · 32 payments"
}

export interface StoresViewProps {
  stores: StoreEntry[]
  onAdd: () => void
  onEdit: (id: string) => void
  onQr: (id: string) => void
  /** Set when stores can't be added yet (business not approved) */
  addLockedNote?: string
}

export function StoresView({ stores, onAdd, onEdit, onQr, addLockedNote }: StoresViewProps) {
  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      {stores.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Store className="size-10 text-text-muted" />
          <p className="text-text-secondary font-medium">No stores yet</p>
          <p className="text-sm text-text-muted">
            {addLockedNote ? 'Your shops and outlets show here.' : 'Add a shop or outlet. Each one gets its own QR, and its payments are counted separately.'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {stores.map(store => (
            <div
              key={store.id}
              className="bg-card border border-border/50 rounded-2xl p-4 flex flex-col gap-3"
            >
              <div className="flex items-start gap-3">
                <span className="size-10 rounded-xl bg-brand/10 text-brand-text flex items-center justify-center shrink-0">
                  <Store className="size-5" />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-text-primary truncate">{store.name}</p>
                    {store.isDefault && (
                      <span className="px-1.5 py-0.5 rounded bg-brand/10 text-brand-text text-[10px] font-bold">
                        Main
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-text-muted mt-0.5">{store.type}</p>
                  {store.address && (
                    <p className="text-xs text-text-muted truncate mt-0.5">{store.address}</p>
                  )}
                  <p className="text-xs text-text-secondary mt-1 tabular-nums">{store.payments}</p>
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  aria-label={`Show QR for ${store.name}`}
                  onClick={() => onQr(store.id)}
                  className="flex-1 h-10 rounded-xl bg-brand/10 text-brand-text text-sm font-medium flex items-center justify-center gap-2 hover:bg-brand/15 transition-colors"
                >
                  <QrCode className="size-4" />
                  QR code
                </button>
                <button
                  type="button"
                  aria-label={`Edit ${store.name}`}
                  onClick={() => onEdit(store.id)}
                  className="h-10 w-10 rounded-xl border border-border text-text-secondary flex items-center justify-center hover:bg-border/30 transition-colors"
                >
                  <Pencil className="size-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {addLockedNote ? (
        <p className="flex items-center justify-center gap-2 rounded-2xl bg-surface border border-border px-4 py-3 text-sm text-text-secondary text-center">
          <Lock className="size-4 shrink-0" /> {addLockedNote}
        </p>
      ) : <button
        type="button"
        onClick={onAdd}
        className="w-full h-12 rounded-2xl border border-dashed border-border text-text-secondary text-sm font-medium flex items-center justify-center gap-2 hover:border-brand/40 hover:text-brand-text transition-all"
      >
        <Plus className="size-4.5" />
        Add store
      </button>}
    </div>
  )
}

// ─── StoreForm ────────────────────────────────────────────────────────────────

export interface StoreFormProps {
  name: string
  onName: (v: string) => void
  type: string
  types: string[]
  onType: (v: string) => void
  address: string
  onAddress: (v: string) => void
  busy?: boolean
  onSave: () => void
  onDelete?: () => void
  onCancel: () => void
}

export function StoreForm({
  name, onName, type, types, onType, address, onAddress,
  busy, onSave, onDelete, onCancel,
}: StoreFormProps) {
  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-text-muted font-medium uppercase tracking-wide">Store name</span>
        <input
          type="text"
          value={name}
          onChange={e => onName(e.target.value)}
          placeholder="e.g. Sharma General Store"
          className="h-12 px-4 rounded-2xl bg-card border border-border text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
        />
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-text-muted font-medium uppercase tracking-wide">Store type</span>
        <div className="relative">
          <select
            value={type}
            onChange={e => onType(e.target.value)}
            className="w-full h-12 pl-4 pr-10 rounded-2xl bg-card border border-border text-text-primary text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-brand/40"
          >
            {types.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-text-muted pointer-events-none" />
        </div>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-text-muted font-medium uppercase tracking-wide">Address <span className="normal-case font-normal opacity-60">(optional)</span></span>
        <input
          type="text"
          value={address}
          onChange={e => onAddress(e.target.value)}
          placeholder="e.g. 12 MG Road, Bangalore"
          className="h-12 px-4 rounded-2xl bg-card border border-border text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
        />
      </label>

      <div className="flex gap-3 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 h-12 rounded-2xl border border-border text-text-secondary text-sm font-medium hover:bg-border/20 transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={busy || !name.trim()}
          className="flex-1 h-12 rounded-2xl bg-brand text-white font-semibold text-sm disabled:opacity-60 flex items-center justify-center gap-2"
        >
          {busy && <Loader2 className="size-4 animate-spin" />}
          Save store
        </button>
      </div>

      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          className="w-full h-11 rounded-2xl text-danger text-sm font-medium flex items-center justify-center gap-2 hover:bg-danger/5 transition-colors"
        >
          <Trash2 className="size-4" />
          Delete store
        </button>
      )}
    </div>
  )
}
