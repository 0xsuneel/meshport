// How the business's customer list is ordered (Customers screen). Pure, tested.

export type CustomerSort = 'owed' | 'spent' | 'recent' | 'visits'

export const CUSTOMER_SORTS: { id: CustomerSort; label: string }[] = [
  { id: 'owed', label: 'Owes you' },
  { id: 'spent', label: 'Top spent' },
  { id: 'recent', label: 'Recent' },
  { id: 'visits', label: 'Most visits' },
]

export type SortableCustomer = { key: string; total: number; last: string; visits: number }

/**
 * owed   - who owes the most first, then who spent most (the old order)
 * spent  - total paid, highest first
 * recent - last payment or bill, newest first
 * visits - number of payments, then total paid
 * Ties fall back to the name key, so the order never jumps around.
 */
export function sortCustomers<T extends SortableCustomer>(list: T[], by: CustomerSort, owedOf: (key: string) => number): T[] {
  const t = (s: string) => Date.parse(s) || 0
  const cmp: Record<CustomerSort, (a: T, b: T) => number> = {
    owed: (a, b) => owedOf(b.key) - owedOf(a.key) || b.total - a.total,
    spent: (a, b) => b.total - a.total,
    recent: (a, b) => t(b.last) - t(a.last),
    visits: (a, b) => b.visits - a.visits || b.total - a.total,
  }
  return [...list].sort((a, b) => cmp[by](a, b) || a.key.localeCompare(b.key))
}

/** Customers who paid more than once (refunded payments don't count). */
export function repeatCount(list: SortableCustomer[]): number {
  return list.filter(c => c.visits > 1).length
}
