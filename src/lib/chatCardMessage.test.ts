import { describe, it, expect, vi } from 'vitest'
import { billCardMessage, chatCardMessage, paymentRequestMessage, paymentLink } from './merchantPay'

vi.mock('./supabase', () => ({ supabase: {} }))

describe('chat card messages', () => {
  const base = { code: 'abc123xyz', orderNumber: 'ORD-100042', amount: 8.2, note: 'Table 4' }
  it('bill card: title, items, note, link - the chat sheet format', () => {
    expect(billCardMessage({ ...base, items: [{ name: 'Tea', qty: 2 }, { name: 'Cake', qty: 1 }] }, '8.2'))
      .toBe(`🧾 Bill · Order #ORD-100042 · $8.2 USDC\nTea × 2, Cake × 1\nTable 4\n${paymentLink('abc123xyz')}`)
    expect(billCardMessage({ code: 'abc123xyz', amount: 1 }, '1')).toMatch(/^🧾 Bill · Order #.+ · \$1 USDC\nhttps?:\/\/.+\/r\/abc123xyz/)
  })
  it('picks the card by kind', () => {
    expect(chatCardMessage({ ...base, kind: 'invoice' }, '8.2')).toBe(billCardMessage(base, '8.2'))
    expect(chatCardMessage({ ...base, kind: 'request' }, '8.2')).toBe(paymentRequestMessage(base, '8.2'))
  })
})
