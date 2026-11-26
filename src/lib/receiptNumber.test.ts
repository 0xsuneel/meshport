import { describe, it, expect } from 'vitest'
import { receiptNumber } from './receiptNumber'

describe('receiptNumber', () => {
  it('is the same on both sides of a payment', () => {
    const h = '0xac19a786d90e5191e1c3ca35721c1e9f756a03bf030e8231c1733d10fa457894'
    expect(receiptNumber(h)).toBe('MP-AC19A786')
    expect(receiptNumber(`send_${h}`)).toBe('MP-AC19A786')
    expect(receiptNumber(`recv_${h}`)).toBe('MP-AC19A786')
  })
  it('handles Solana signatures and nothing', () => {
    expect(receiptNumber('5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW')).toBe('MP-5VERV8NM')
    expect(receiptNumber(null)).toBeNull()
    expect(receiptNumber('pending')).toBeNull()
  })
})
