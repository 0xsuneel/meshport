// The business categories MeshPort supports - one list for the business
// application and for each store - and the words the Business tab uses for
// each (a café has guests, a freelancer sends invoices to clients).

import { useSyncExternalStore } from 'react'
import { useMerchant } from './merchant'

export const BUSINESS_CATEGORIES = [
  'Retail store', 'Grocery / Supermarket', 'Restaurant / Café', 'Online shop', 'Pharmacy',
  'Salon / Beauty', 'Clinic / Healthcare', 'Education / Tutoring', 'Hotel / Stay', 'Events / Tickets',
  'Repair / Workshop', 'Transport / Delivery', 'Services', 'Freelancer', 'Kiosk / Counter',
  'Non-profit / Donations', 'Wholesale', 'Other',
] as const
export type BusinessCategory = typeof BUSINESS_CATEGORIES[number]

/** Merchant category code (ISO 18245) per category - the code UPI and card
 *  networks use. The same table as the database's business_mcc(). */
export const BUSINESS_MCC: Record<BusinessCategory, string> = {
  'Retail store': '5399', 'Grocery / Supermarket': '5411', 'Restaurant / Café': '5812', 'Online shop': '5999',
  'Pharmacy': '5912', 'Salon / Beauty': '7230', 'Clinic / Healthcare': '8099', 'Education / Tutoring': '8299',
  'Hotel / Stay': '7011', 'Events / Tickets': '7922', 'Repair / Workshop': '7699', 'Transport / Delivery': '4215',
  'Services': '7299', 'Freelancer': '8999', 'Kiosk / Counter': '5499', 'Non-profit / Donations': '8398', 'Wholesale': '5099', 'Other': '5999',
}
export const businessMcc = (category: string | null | undefined): string =>
  (category && (BUSINESS_MCC as Record<string, string>)[category]) || '5999'

export interface BizTerms {
  /** "Orders" / "Invoices" */ orders: string
  /** "order" / "invoice" */ order: string
  /** "Customers" / "Guests" / "Clients" */ customers: string
  /** "Customer" / "Guest" / "Client" */ customer: string
  /** "Stores" / "Outlets" / "Branches" */ stores: string
}

const DEFAULT: BizTerms = { orders: 'Orders', order: 'order', customers: 'Customers', customer: 'Customer', stores: 'Stores' }

const TERMS: Partial<Record<BusinessCategory, Partial<BizTerms>>> = {
  'Restaurant / Café': { customers: 'Guests', customer: 'Guest', stores: 'Outlets' },
  'Online shop': { stores: 'Shops' },
  'Services': { orders: 'Invoices', order: 'invoice', customers: 'Clients', customer: 'Client', stores: 'Branches' },
  'Freelancer': { orders: 'Invoices', order: 'invoice', customers: 'Clients', customer: 'Client', stores: 'Workspaces' },
  'Kiosk / Counter': { stores: 'Counters' },
  'Pharmacy': { stores: 'Branches' },
  'Salon / Beauty': { orders: 'Bookings', order: 'booking', customers: 'Clients', customer: 'Client', stores: 'Branches' },
  'Clinic / Healthcare': { orders: 'Bills', order: 'bill', customers: 'Patients', customer: 'Patient', stores: 'Clinics' },
  'Education / Tutoring': { orders: 'Fees', order: 'fee', customers: 'Students', customer: 'Student', stores: 'Centres' },
  'Hotel / Stay': { orders: 'Bookings', order: 'booking', customers: 'Guests', customer: 'Guest', stores: 'Properties' },
  'Events / Tickets': { orders: 'Tickets', order: 'ticket', customers: 'Attendees', customer: 'Attendee', stores: 'Venues' },
  'Repair / Workshop': { orders: 'Jobs', order: 'job', stores: 'Workshops' },
  'Transport / Delivery': { orders: 'Trips', order: 'trip', stores: 'Branches' },
  'Non-profit / Donations': { orders: 'Donations', order: 'donation', customers: 'Donors', customer: 'Donor', stores: 'Branches' },
  'Wholesale': { customers: 'Buyers', customer: 'Buyer', stores: 'Warehouses' },
}

/** Sign-up asks the name in the category's own words (28 Nov, like Paytm):
 *  "Restaurant name - e.g. Corner Café". It becomes the display name. */
const NAME_ASK: Record<BusinessCategory, [label: string, example: string]> = {
  'Retail store': ['Shop name', 'Main Street Store'], 'Grocery / Supermarket': ['Store name', 'Green Grocers'],
  'Restaurant / Café': ['Restaurant name', 'Corner Café'], 'Online shop': ['Shop name', 'Urban Threads'],
  'Pharmacy': ['Pharmacy name', 'City Pharmacy'], 'Salon / Beauty': ['Salon name', 'Glow Salon'],
  'Clinic / Healthcare': ['Clinic name', 'Bright Smile Clinic'], 'Education / Tutoring': ['Institute name', 'Bright Minds Tutoring'],
  'Hotel / Stay': ['Hotel name', 'Lakeview Stay'], 'Events / Tickets': ['Event or organiser name', 'City Music Fest'],
  'Repair / Workshop': ['Workshop name', 'QuickFix Repairs'], 'Transport / Delivery': ['Business name', 'Swift Couriers'],
  'Services': ['Business name', 'Sparkle Cleaning'], 'Freelancer': ['Your name or brand', 'Anita Designs'],
  'Kiosk / Counter': ['Stall name', 'Corner Kiosk'], 'Non-profit / Donations': ['Organisation name', 'Hope Foundation'],
  'Wholesale': ['Business name', 'Metro Traders'], 'Other': ['Business name', 'Your business'],
}
export function nameAskFor(category: string | null | undefined): { label: string; example: string } {
  const c = BUSINESS_CATEGORIES.find(x => x === category)
  const [label, example] = c ? NAME_ASK[c] : ['Business name', 'Your business']
  return { label, example }
}
/** A display name customers will see: 2-50 characters; letters, numbers,
 *  spaces and & ' . , - only (Paytm: "between 2-50 chars, no special char"). */
export function displayNameError(name: string): string | null {
  const n = name.trim()
  if (n.length < 2) return 'Use at least 2 characters'
  if (n.length > 50) return 'Keep it to 50 characters'
  if (!/^[\p{L}\p{N}][\p{L}\p{N} &'’.,-]*$/u.test(n)) return "Use letters, numbers, spaces and & ' . , - only"
  return null
}

/** The categories in groups, as big cards at sign-up (28 Nov, like Paytm's "Select Business Type"). */
export const BUSINESS_GROUPS: { title: string; tint: 'mint' | 'butter' | 'peach' | 'sky'; items: BusinessCategory[] }[] = [
  { title: 'Shops', tint: 'mint', items: ['Retail store', 'Grocery / Supermarket', 'Pharmacy', 'Online shop', 'Kiosk / Counter', 'Wholesale'] },
  { title: 'Food, stay & events', tint: 'butter', items: ['Restaurant / Café', 'Hotel / Stay', 'Events / Tickets'] },
  { title: 'Services', tint: 'peach', items: ['Salon / Beauty', 'Clinic / Healthcare', 'Education / Tutoring', 'Repair / Workshop', 'Transport / Delivery', 'Freelancer'] },
  { title: 'Other', tint: 'sky', items: ['Services', 'Non-profit / Donations', 'Other'] },
]

/** A saved category, or the first one when it's missing or no longer listed. */
export function toCategory(v: string | null | undefined): BusinessCategory {
  return BUSINESS_CATEGORIES.find(c => c === v) ?? BUSINESS_CATEGORIES[0]
}

export function bizTerms(category: string | null | undefined): BizTerms {
  const c = BUSINESS_CATEGORIES.find(x => x === category)
  return { ...DEFAULT, ...(c ? TERMS[c] : undefined) }
}

// The category of the store the Business tab works as (28 Nov: a category
// belongs to each store, like Paytm's shops) - BusinessPage sets it when the
// store changes. null until then: the category the business applied with.
let activeCategory: string | null = null
const categoryListeners = new Set<() => void>()
export function setActiveStoreCategory(category: string | null | undefined): void {
  const c = category?.trim() || null
  if (c === activeCategory) return
  activeCategory = c
  categoryListeners.forEach(l => l())
}
const subscribeCategory = (l: () => void) => { categoryListeners.add(l); return () => { categoryListeners.delete(l) } }

/** The signed-in business's words: the selected store's category (a clinic
 *  branch says "Patients", a restaurant "Guests"), else the one it applied with. */
export function useBizTerms(): BizTerms {
  const applied = useMerchant().application?.businessType
  const store = useSyncExternalStore(subscribeCategory, () => activeCategory, () => null)
  return bizTerms(store ?? applied)
}

/** "invoice" → "Invoice" */
export const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)
