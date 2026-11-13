import { describe, it, expect, vi } from 'vitest'

vi.stubEnv('SUPABASE_SERVICE_KEY', 'test')
const { paymentProof } = await import('../../api/chat')

// A payment card needs a real payment from the sender's wallet to the other
// person (api/chat.ts paymentProof): the token's own Transfer log.
const FROM = '0x0baf9b2c44f377208b3c5f833afbab8414d69d5d'
const TO = '0x2222222222222222222222222222222222222222'
const KEY = '0x7777777777777777777777777777777777777777'
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
const USDC = '0x3600000000000000000000000000000000000000'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const pad = (a: string) => '0x' + a.slice(2).padStart(64, '0')
const log = (from: string, to: string, units: bigint, address = USDC) => ({ address, topics: [TRANSFER, pad(from), pad(to)], data: '0x' + units.toString(16) })
const ok = { status: '0x1' }

describe('chat payment card proof', () => {
  it('an ERC-20 payment: the USDC Transfer from the wallet to the recipient proves it, whoever sent the tx', () => {
    const tx = { from: KEY, to: PERMIT2, value: '0x0' }
    const rc = { ...ok, logs: [log(FROM, TO, 2_500_000n), log(FROM, KEY, 1435n)] }
    expect(paymentProof(tx, rc, FROM, TO, 'USDC', 2.5)).toBe('ok')
    expect(paymentProof(tx, rc, FROM, TO, 'USDC', 2.6)).toBe('invalid') // not that much
  })

  it('not proof: a Transfer to someone else, from someone else, on another contract, or a reverted tx', () => {
    const tx = { from: KEY, to: PERMIT2, value: '0x0' }
    expect(paymentProof(tx, { ...ok, logs: [log(FROM, KEY, 9_000_000n)] }, FROM, TO, 'USDC', 1)).toBe('invalid')
    expect(paymentProof(tx, { ...ok, logs: [log(KEY, TO, 9_000_000n)] }, FROM, TO, 'USDC', 1)).toBe('invalid')
    expect(paymentProof(tx, { ...ok, logs: [log(FROM, TO, 9_000_000n, '0x1111111111111111111111111111111111111111')] }, FROM, TO, 'USDC', 1)).toBe('invalid')
    expect(paymentProof(tx, { status: '0x0', logs: [log(FROM, TO, 9_000_000n)] }, FROM, TO, 'USDC', 1)).toBe('invalid')
  })

  it('native USDC: a plain transfer counts only when the wallet itself sent it', () => {
    const value = '0x' + (10n ** 18n).toString(16)
    expect(paymentProof({ from: FROM, to: TO, value }, { ...ok, logs: [] }, FROM, TO, 'USDC', 1)).toBe('ok')
    expect(paymentProof({ from: KEY, to: TO, value }, { ...ok, logs: [] }, FROM, TO, 'USDC', 1)).toBe('invalid')
  })

  it('an order payment through MeshPortCheckout: its Paid event (payer, business, price) proves it', () => {
    const CHECKOUT = '0xda51a32edfc723e3de9aaf0a452fd2f71e6019f1'
    const PAID = '0xd56bd66d88b32d3be3ce941b0583d226db715ff80336148925cb9acf8800c34a'
    const word = (n: bigint) => n.toString(16).padStart(64, '0')
    const paid = (payer: string, merchant: string, price: bigint, address = CHECKOUT) =>
      ({ address, topics: [PAID, pad(payer), pad(merchant), '0x' + 'ab'.repeat(32)], data: '0x' + word(price) + word(price / 160n) })
    const tx = { from: FROM, to: CHECKOUT, value: '0x' + (10n ** 18n).toString(16) }
    const one = 10n ** 18n
    // The business gets the price minus the fee - the Paid event carries the full price.
    expect(paymentProof(tx, { ...ok, logs: [paid(FROM, TO, one)] }, FROM, TO, 'USDC', 1, CHECKOUT)).toBe('ok')
    expect(paymentProof(tx, { ...ok, logs: [paid(FROM, TO, one)] }, FROM, TO, 'USDC', 1.5, CHECKOUT)).toBe('invalid') // not that much
    expect(paymentProof(tx, { ...ok, logs: [paid(KEY, TO, one)] }, FROM, TO, 'USDC', 1, CHECKOUT)).toBe('invalid')   // someone else paid
    expect(paymentProof(tx, { ...ok, logs: [paid(FROM, KEY, one)] }, FROM, TO, 'USDC', 1, CHECKOUT)).toBe('invalid')  // another business
    // The same event from any other contract is not proof (anyone can emit it).
    expect(paymentProof(tx, { ...ok, logs: [paid(FROM, TO, one, '0x1111111111111111111111111111111111111111')] }, FROM, TO, 'USDC', 1, CHECKOUT)).toBe('invalid')
    // No checkout configured: not accepted.
    expect(paymentProof(tx, { ...ok, logs: [paid(FROM, TO, one)] }, FROM, TO, 'USDC', 1, '')).toBe('invalid')
    expect(paymentProof(tx, { status: '0x0', logs: [paid(FROM, TO, one)] }, FROM, TO, 'USDC', 1, CHECKOUT)).toBe('invalid')
  })
})
