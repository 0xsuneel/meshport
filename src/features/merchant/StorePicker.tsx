// Which of a business's stores a request or bill is for: a pill that opens
// the same floating list as Pay's token picker. Receive → Request and the
// chat's Request / Bill use it.
import { useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { Store as StoreIcon } from 'lucide-react'
import { TokenMenu } from '@/components/ui/TokenMenu'

/** Which store a business's request is for: the same pill + list as My QR's picker. */
export function StorePicker({ stores, value, onChange }: { stores: { id: string; name: string }[]; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const icon = <span className="inline-flex items-center justify-center size-[22px] rounded-full bg-brand/15 text-brand-text"><StoreIcon className="size-3.5" /></span>
  const picked = stores.find(s => s.id === value) ?? stores[0]
  return (
    <div style={{ position: 'relative', zIndex: open ? 41 : undefined, alignSelf: 'flex-start', minWidth: 180, maxWidth: '100%' }}>
      <button type="button" onClick={e => { e.stopPropagation(); setOpen(v => !v) }} aria-expanded={open} aria-label={`Store: ${picked.name}`}
        className="w-full flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-full active:opacity-70"
        style={{ background: 'color-mix(in srgb, var(--brand) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--brand) 35%, transparent)' }}>
        {icon}
        <span className="flex-1 min-w-0 truncate text-left text-sm font-bold text-text-primary">{picked.name}</span>
        <svg className="w-2.5 h-2.5 flex-shrink-0" style={{ color: 'var(--brand-text)', transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      <AnimatePresence>
        {open && <TokenMenu ariaLabel="Choose store" selected={picked.id} options={stores.map(s => ({ id: s.id, label: s.name, icon }))} onSelect={onChange} onClose={() => setOpen(false)} />}
      </AnimatePresence>
    </div>
  )
}
