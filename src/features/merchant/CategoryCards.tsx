// "What kind of business?" (28 Nov, like Paytm's Select Business Type): the
// categories as big cards in groups - Shops, Food, stay & events, Services,
// Other - and what picking one changes (the words MeshPort uses).
import { Check, ShoppingBag, Apple, Pill, ShoppingCart, Store, Boxes, Coffee, BedDouble, Ticket, Scissors, Stethoscope, GraduationCap, Wrench, Truck, Briefcase, Sparkles, HeartHandshake, CircleEllipsis } from 'lucide-react'
import { BUSINESS_GROUPS, bizTerms, type BusinessCategory } from '@/lib/businessCategories'

const ICON: Record<BusinessCategory, React.ElementType> = {
  'Retail store': ShoppingBag, 'Grocery / Supermarket': Apple, 'Pharmacy': Pill, 'Online shop': ShoppingCart, 'Kiosk / Counter': Store, 'Wholesale': Boxes,
  'Restaurant / Café': Coffee, 'Hotel / Stay': BedDouble, 'Events / Tickets': Ticket,
  'Salon / Beauty': Scissors, 'Clinic / Healthcare': Stethoscope, 'Education / Tutoring': GraduationCap, 'Repair / Workshop': Wrench, 'Transport / Delivery': Truck, 'Freelancer': Briefcase,
  'Services': Sparkles, 'Non-profit / Donations': HeartHandshake, 'Other': CircleEllipsis,
}
// Short names on the cards; the full name stays what's saved.
const SHORT: Partial<Record<BusinessCategory, string>> = {
  'Grocery / Supermarket': 'Grocery', 'Clinic / Healthcare': 'Clinic', 'Education / Tutoring': 'Tutoring', 'Repair / Workshop': 'Repair',
  'Transport / Delivery': 'Delivery', 'Non-profit / Donations': 'Non-profit', 'Kiosk / Counter': 'Kiosk / Counter',
}

export function CategoryCards({ value, onChange }: { value: string; onChange: (c: BusinessCategory) => void }) {
  const t = bizTerms(value)
  return (
    <div className="flex flex-col gap-4">
      {BUSINESS_GROUPS.map(g => (
        <div key={g.title}>
          <p className="text-[12.5px] font-semibold text-text-muted mb-2 px-0.5">{g.title}</p>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={g.title}>
            {g.items.map(c => {
              const Icon = ICON[c], on = value === c
              return (
                <button key={c} type="button" role="radio" aria-checked={on} onClick={() => onChange(c)}
                  className="relative flex flex-col items-center gap-1.5 rounded-2xl px-1.5 py-3 text-center border-[1.5px] active:scale-[0.98] transition-transform"
                  style={on ? { borderColor: 'var(--brand-text)', background: 'color-mix(in srgb, var(--brand) 10%, var(--card))' } : { borderColor: 'var(--border)', background: 'var(--card)' }}>
                  {on && <span className="absolute top-1.5 right-1.5 size-[18px] rounded-full bg-brand text-white inline-flex items-center justify-center"><Check className="size-3" strokeWidth={3} /></span>}
                  <span className="inline-flex items-center justify-center size-10 rounded-[12px]" style={{ background: `var(--tile-${g.tint})`, color: `var(--tile-${g.tint}-ink)` }}><Icon className="size-[19px]" /></span>
                  <span className="text-[12px] font-semibold leading-tight text-text-primary">{SHORT[c] ?? c}</span>
                </button>
              )
            })}
          </div>
        </div>
      ))}
      {value && (
        <p className="rounded-2xl bg-surface border border-border px-3.5 py-2.5 text-[12.5px] text-text-muted">
          <b className="text-text-primary">{value}</b> · customers are <b className="text-text-primary">{t.customers}</b>, stores are <b className="text-text-primary">{t.stores}</b>
          {t.orders !== 'Orders' && <>, orders are <b className="text-text-primary">{t.orders}</b></>}
        </p>
      )}
    </div>
  )
}
