import { describe, it, expect } from 'vitest'
import { walletEventRow } from './walletEvents'

describe('walletEventRow', () => {
  it('rounds timings, lowercases the wallet and trims long text', () => {
    const row = walletEventRow({
      wallet: '0xABCDEF', kind: 'privy', event: 'sign', ok: false, ms: 12_000.6,
      steps: { wait: 0.4, sign: 11_999.9, bad: Number.NaN }, error: 'x'.repeat(400), detail: 'signTypedData',
    })
    expect(row.wallet_address).toBe('0xabcdef')
    expect(row.ms).toBe(12_001)
    expect(row.steps).toEqual({ wait: 0, sign: 12_000 })
    expect(row.error).toHaveLength(300)
    expect(row.wallet_kind).toBe('privy')
  })
  it('leaves unknown fields empty', () => {
    const row = walletEventRow({ wallet: '0xa', kind: '', event: 'open', ok: true })
    expect(row).toMatchObject({ wallet_kind: 'unknown', ms: null, steps: null, error: null, detail: null, path: null })
  })
})
