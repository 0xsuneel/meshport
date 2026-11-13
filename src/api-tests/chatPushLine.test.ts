// A chat message's push notification text (api/chat pushLine): bills and
// requests read as the chat list shows them - "#170", never "Order #ORD-100170".
import { describe, it, expect } from 'vitest'
const { pushLine } = await import('../../api/chat')

describe('pushLine', () => {
  it('bill and request cards: the short number, as the chat list shows it', () => {
    expect(pushLine('🧾 Bill · Order #ORD-100170 · $0.1 USDC\nDosa × 1\nhttps://meshport.xyz/paylink/r/abc')).toBe('🧾 Bill #170 · $0.1 USDC')
    expect(pushLine('💸 Payment request · Order #ORD-100171 · $1 USDC\nLunch\nhttps://meshport.xyz/paylink/r/def')).toBe('💸 Request #171 · $1 USDC')
    // Older cards without an order number.
    expect(pushLine('💸 Payment request · $2 USDC\nhttps://x')).toBe('💸 Request · $2 USDC')
  })
  it('a Split Expense share says so', () => {
    expect(pushLine('💸 Payment request · Order #ORD-100162 · $0.5 USDC\nSplit · 🛍️ Shopping\nhttps://x')).toBe('Split Expense · 🛍️ Shopping · your share $0.5 USDC')
  })
  it('anything else: its first line', () => {
    expect(pushLine('Hi there\nsecond line')).toBe('Hi there')
  })
})
