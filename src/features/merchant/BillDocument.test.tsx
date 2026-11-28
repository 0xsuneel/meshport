// The bill document (Save as PDF) from a chat card's view: the business,
// bill number, who it's for, the lines and the pay link.
import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/supabase', () => ({ supabase: {} }))
import { renderToStaticMarkup } from 'react-dom/server'
import { BillDocument } from './BillDocument'

const view = {
  amount: 12.29, createdAt: '2026-11-27T10:00:00Z', paidAt: null, orderNumber: 'ORD-100124', dueDate: '2026-12-04',
  customerUsername: 'riya', note: 'Thank you', taxPercent: 5,
  items: [{ name: 'Coffee', qty: 2, price: 3.5, total: 7 }, { name: 'Sandwich', qty: 1, price: 6, total: 6 }],
}
const details = { subtotal: 13, discountType: 'percent' as const, discountValue: 10, discountAmount: 1.3, taxName: 'VAT', taxInclusive: false,
  taxAmount: 0.59, billToName: null, footer: 'Payment due within 7 days.', storeAddress: 'Shop 4, Al Fahidi St' }

describe('bill document', () => {
  it('a waiting bill: number, customer, lines, footer and how to pay', () => {
    const html = renderToStaticMarkup(<BillDocument intent={view} details={details} business="Sharma General Store" taxId="TRN 1001" link="https://meshport.xyz/paylink/r/AB12" />)
    for (const s of ['Sharma General Store', 'Shop 4, Al Fahidi St', 'Tax ID TRN 1001', 'BILL #124', 'riya.arc', 'Coffee', 'Discount 10%', 'VAT 5%', '$12.29',
      'Payment due within 7 days.', 'https://meshport.xyz/paylink/r/AB12']) expect(html).toContain(s)
  })
  it('a paid one is a receipt, with no pay box', () => {
    const html = renderToStaticMarkup(<BillDocument intent={{ ...view, paidAt: '2026-11-28T09:00:00Z' }} details={details} business="Shop" link="x" paid />)
    expect(html).toContain('RECEIPT #124')
    expect(html).not.toContain('in USDC</div>')
  })
})
