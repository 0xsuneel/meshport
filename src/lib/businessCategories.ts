// The business categories MeshPort supports - one list for the business
// application and for each store - and the words the Business tab uses for
// each (a café has guests, a freelancer sends invoices to clients).

import { useMerchant } from './merchant'

export const BUSINESS_CATEGORIES = [
  'Retail store', 'Grocery / Supermarket', 'Restaurant / Café', 'Online shop', 'Pharmacy',
  'Salon / Beauty', 'Clinic / Healthcare', 'Education / Tutoring', 'Hotel / Stay', 'Events / Tickets',
  'Repair / Workshop', 'Transport / Delivery', 'Services', 'Freelancer', 'Kiosk / Counter',
  'Non-profit / Donations', 'Other',
] as const
export type BusinessCategory = typeof BUSINESS_CATEGORIES[number]

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
}

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
