// Chat Request / Bill sheets: amount input, unfinished bill items, bill money.
import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/supabase', () => ({ supabase: {}, authApiHeaders: async () => ({}) }))
import { cleanRequestAmount } from './ChatRequestSheet'
import { rowProblem, billMoney } from '@/features/merchant/InvoiceComposer'

describe('cleanRequestAmount', () => {
  it('keeps digits and one dot, up to 6 decimals (USDC)', () => {
    expect(cleanRequestAmount('12.50')).toBe('12.50')
    expect(cleanRequestAmount('1.2.3')).toBe('1.23')
    expect(cleanRequestAmount('0.1234567')).toBe('0.123456')
    expect(cleanRequestAmount('$1,000')).toBe('1000')
  })
  it('adds a leading zero and drops extra ones', () => {
    expect(cleanRequestAmount('.5')).toBe('0.5')
    expect(cleanRequestAmount('007')).toBe('7')
    expect(cleanRequestAmount('0.')).toBe('0.')
  })
})

describe('rowProblem', () => {
  const row = (name: string, qty: string, price: string) => ({ id: 1, name, qty, price })
  it('blank and complete items are fine', () => {
    expect(rowProblem(row('', '1', ''))).toBeNull()
    expect(rowProblem(row('Dosa', '2', '3.5'))).toBeNull()
  })
  it('says what a started item still needs', () => {
    expect(rowProblem(row('Vada', '1', ''))).toBe('Add a price')
    expect(rowProblem(row('', '1', '2'))).toBe('Add a name')
    expect(rowProblem(row('Vada', '0', '2'))).toBe('Add a quantity')
  })
})

describe('billMoney', () => {
  it('always shows cents', () => {
    expect(billMoney(9.4)).toBe('9.40')
    expect(billMoney(102)).toBe('102.00')
    expect(billMoney(1234.5)).toBe('1,234.50')
    expect(billMoney(0.123456)).toBe('0.123456')
  })
})
