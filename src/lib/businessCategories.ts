// The business categories MeshPort supports - one list for the business
// application and for each store - and the words the Business tab uses for
// each (a café has guests, a freelancer sends invoices to clients).

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

/** The signed-in business's words, from the category it applied with. */
export function useBizTerms(): BizTerms {
  return bizTerms(useMerchant().application?.businessType)
}

/** "invoice" → "Invoice" */
export const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)
