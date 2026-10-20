// Which of a business's stores a QR, request or bill is for: one row naming
// only the current store, with Switch - the same "Switch store" sheet as the
// Business tab (StoreSwitcher) picks another. Receive (My QR, Request) and the
// chat's Request / Bill use it.
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { ArrowLeftRight, Store as StoreIcon, User } from 'lucide-react'
import { Sheet } from '@/features/business/ui/primitives'
import { StoreSwitcher } from '@/features/business/ui/Stores'

export type PickerStore = { id: string; name: string; isDefault?: boolean; personal?: boolean }

export function StorePicker({ stores, value, onChange, label = 'Request for store', hint = 'Payments go to the store you pick' }: {
  stores: PickerStore[]
  value: string
  onChange: (id: string) => void
  /** Over the store's name: "Showing QR for store", "Bill from store". */
  label?: string
  hint?: string
}) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const picked = stores.find(s => s.id === value) ?? stores[0]
  return (
    <>
      <div className="w-full flex items-center gap-3 rounded-2xl px-3 py-2.5 bg-surface border border-border">
        <span className="size-9 rounded-xl flex items-center justify-center bg-brand text-white shrink-0">
          {picked.personal ? <User className="size-[18px]" /> : <StoreIcon className="size-[18px]" />}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[11.5px] text-text-muted truncate">{picked.personal ? label.replace(/ store$/, '') : label}</p>
          <p className="text-sm font-bold text-text-primary truncate">{picked.name}</p>
        </div>
        <button type="button" onClick={() => setOpen(true)} aria-label={`Switch store (now ${picked.name})`}
          className="flex items-center gap-1.5 h-9 px-3 rounded-xl text-[13px] font-semibold text-brand-text shrink-0 active:scale-95 transition-transform"
          style={{ background: 'color-mix(in srgb, var(--brand) 14%, transparent)' }}>
          <ArrowLeftRight className="size-4" /> Switch
        </button>
      </div>
      {/* On top of whatever sheet this row sits in (chat Request / Bill). */}
      {createPortal(
        <Sheet open={open} onClose={() => setOpen(false)} id="store-switch">
          <div className="px-4 pt-1 pb-[calc(env(safe-area-inset-bottom,0px)+16px)]">
            <p className="text-base font-bold text-text-primary px-1 pb-1">Switch store</p>
            <p className="text-xs text-text-muted px-1 pb-3">{hint}</p>
            <StoreSwitcher
              stores={stores.map(s => ({ id: s.id, name: s.name, active: s.id === picked.id, personal: s.personal,
                handle: s.personal ? 'Payments to your account' : s.isDefault ? 'Main store' : 'Store' }))}
              onSwitch={id => { onChange(id); setOpen(false) }}
              onManage={() => { setOpen(false); navigate('/business') }} />
          </div>
        </Sheet>,
        document.body,
      )}
    </>
  )
}
