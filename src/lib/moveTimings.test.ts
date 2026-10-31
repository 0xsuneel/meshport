import { describe, it, expect } from 'vitest'
import { timingRow, startMoveTimer } from './moveTimings'

describe('timingRow', () => {
  it('rounds times, lowercases the wallet and trims long errors', () => {
    const row = timingRow({
      kind: 'transfer', wallet: '0xAbC', route: 'cctp', chain: 'Ethereum_Sepolia',
      steps: { passcode: 412.6, wallet_open: 1290.2, mint: 61000.9 }, totalMs: 61010.4,
      ok: false, error: 'x'.repeat(500), txHash: '0xhash',
    })
    expect(row.wallet_address).toBe('0xabc')
    expect(row.steps).toEqual({ passcode: 413, wallet_open: 1290, mint: 61001 })
    expect(row.total_ms).toBe(61010)
    expect(row.token).toBe('USDC')
    expect(row.error).toHaveLength(200)
  })
})

describe('startMoveTimer', () => {
  it('keeps the first time a step is reached, and finishes once', () => {
    const t = startMoveTimer('swap')
    t.mark('approve-sent')
    t.mark('approve-sent')
    expect(t.finished).toBe(false)
    t.finish({ ok: true })
    expect(t.finished).toBe(true)
    t.finish({ ok: false }) // no second save
    t.mark('late') // ignored after finish
    expect(t.finished).toBe(true)
  })
})
