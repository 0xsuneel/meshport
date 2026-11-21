// The admin "Relayer gas" page: which account sends on each chain, how a balance reads, when it is low.
import { describe, it, expect } from 'vitest'
import { RELAYER_GAS_CHAINS, approxUsd, formatNative, gasStatus, signerFor } from '../../supabase/functions/_shared/relayerGas'
import { CHAINS } from '../../api/bridge-relay'

const CIRCLE = '0x1111111111111111111111111111111111111111'
const KEY = '0x2222222222222222222222222222222222222222'
const E = 10n ** 18n

describe('the chain list matches what the relayer sends on', () => {
  it('every relay chain is listed with the same id, and Arc too', () => {
    for (const [key, c] of Object.entries(CHAINS)) {
      const row = RELAYER_GAS_CHAINS.find(r => r.key === key)
      expect(row, key).toBeTruthy()
      expect(row!.chainId, key).toBe(c.id)
      expect(row!.usd, key).toBe(c.gasUsd)
    }
    expect(RELAYER_GAS_CHAINS.find(r => r.key === 'Arc_Testnet')?.chainId).toBe(5042002)
    expect(RELAYER_GAS_CHAINS).toHaveLength(Object.keys(CHAINS).length + 1)
  })
})

describe('which account sends where (as api/_lib/relayerSigner.ts decides)', () => {
  it('circle mode: the Circle wallet, except on the chains Circle cannot sign (then the key account)', () => {
    const env = { mode: 'circle', address: CIRCLE, keyAddress: KEY }
    expect(signerFor(11155111, env)).toEqual({ address: CIRCLE, kind: 'circle' })
    for (const id of [998, 1328, 14601]) expect(signerFor(id, env)).toEqual({ address: KEY, kind: 'key' })
    // Another list of unsupported chains, as CIRCLE_SIGN_UNSUPPORTED_CHAINS sets it.
    expect(signerFor(84532, { ...env, unsupported: '84532' })).toEqual({ address: KEY, kind: 'key' })
    expect(signerFor(998, { ...env, unsupported: '84532' })).toEqual({ address: CIRCLE, kind: 'circle' })
  })
  it('circle mode without a key address: nothing to check on a chain Circle cannot sign', () => {
    expect(signerFor(998, { mode: 'circle', address: CIRCLE })).toBeNull()
  })
  it('key mode: the one address, on every chain', () => {
    expect(signerFor(11155111, { address: KEY })).toEqual({ address: KEY, kind: 'key' })
    expect(signerFor(998, { mode: 'key', address: KEY })).toEqual({ address: KEY, kind: 'key' })
  })
  it('nothing, or something that is not an address: null', () => {
    expect(signerFor(1, {})).toBeNull()
    expect(signerFor(1, { address: '0x123' })).toBeNull()
  })
})

describe('reading a balance', () => {
  it('formats wei as a short decimal', () => {
    expect(formatNative(0n)).toBe('0')
    expect(formatNative(E)).toBe('1')
    expect(formatNative(E * 152n + E * 4n / 10n)).toBe('152.4')
    expect(formatNative(12_345_678_900_000_000n)).toBe('0.0123')
    expect(formatNative(1_234_567_000_000_000n)).toBe('0.001234')
    expect(formatNative(1n)).toBe('<0.000001')
  })
  it('low under about $5, empty under about $1, by the chain\'s rough coin price', () => {
    // Sepolia ETH at 3000: 0.01 ETH ≈ $30, 0.001 ≈ $3, 0.0001 ≈ $0.30.
    expect(gasStatus(E / 100n, 3000)).toBe('ok')
    expect(gasStatus(E / 1000n, 3000)).toBe('low')
    expect(gasStatus(E / 10_000n, 3000)).toBe('empty')
    expect(gasStatus(0n, 3000)).toBe('empty')
    // Polygon Amoy POL at 0.5: 12 POL ≈ $6, 6 POL ≈ $3, 1 POL ≈ $0.5.
    expect(gasStatus(12n * E, 0.5)).toBe('ok')
    expect(gasStatus(6n * E, 0.5)).toBe('low')
    expect(gasStatus(1n * E, 0.5)).toBe('empty')
    expect(approxUsd(2n * E, 30)).toBe(60)
  })
})
