// Swap amountOut is read from the confirmed swap's own receipt (the SDK's
// slow status poll is skipped once Arc confirmed the swap).
import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/supabase', () => ({ supabase: {}, authApiHeaders: async () => ({}) }))
import { amountOutFromReceipt } from './swapService'

const WALLET = '0x1111111111111111111111111111111111111111'
const pad = (a: string) => '0x' + a.toLowerCase().replace('0x', '').padStart(64, '0')
const TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const USDC = '0x3600000000000000000000000000000000000000'
const CIRBTC = '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF'

describe('amountOutFromReceipt', () => {
  it('sums the token Transfer logs to the wallet (6 decimals)', () => {
    const r = { logs: [
      { address: USDC, topics: [TOPIC, pad('0xaa'), pad(WALLET)], data: '0x' + (12_345_678n).toString(16) }, // 12.345678
      { address: USDC, topics: [TOPIC, pad(WALLET), pad('0xbb')], data: '0x' + (999n).toString(16) },          // outgoing - ignored
      { address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', topics: [TOPIC, pad('0xaa'), pad(WALLET)], data: '0x10' }, // other token
    ] }
    expect(amountOutFromReceipt(r, 'USDC', WALLET)).toBe('12.345678')
  })
  it('handles 8-decimal cirBTC and trims zeros; empty when nothing matched', () => {
    const r = { logs: [{ address: CIRBTC, topics: [TOPIC, pad('0xaa'), pad(WALLET)], data: '0x' + (25_000n).toString(16) }] }
    expect(amountOutFromReceipt(r, 'cirBTC', WALLET)).toBe('0.00025')
    expect(amountOutFromReceipt({ logs: [] }, 'USDC', WALLET)).toBe('')
    expect(amountOutFromReceipt(null, 'USDC', WALLET)).toBe('')
  })
})
