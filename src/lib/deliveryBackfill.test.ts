import { describe, it, expect, vi, beforeEach } from 'vitest'

const setDest = vi.fn(async (..._a: unknown[]) => {})
vi.mock('./ActivityService', () => ({ setActivityDestinationTx: (...a: unknown[]) => setDest(...a) }))

import { needsDeliveryHash, backfillDeliveryHash, deliveryLookedUp } from './deliveryBackfill'

const SEND = '0x' + 'ab'.repeat(32)
const MINT = '0x' + 'cd'.repeat(32)
const row = (over: Record<string, unknown> = {}) => ({
  txHash: SEND, sourceChain: 'Base_Sepolia', tokenSymbol: 'EURC', walletAddress: '0xme', completed: true, ...over,
})

describe('needsDeliveryHash', () => {
  it('a finished EURC / cirBTC bring with no delivery hash', () => {
    expect(needsDeliveryHash(row())).toBe(true)
    expect(needsDeliveryHash(row({ tokenSymbol: 'cirBTC' }))).toBe(true)
  })
  it('not USDC, not unfinished, not when one is on record, not an unknown chain or a bad hash', () => {
    expect(needsDeliveryHash(row({ tokenSymbol: 'USDC' }))).toBe(false)
    expect(needsDeliveryHash(row({ completed: false }))).toBe(false)
    expect(needsDeliveryHash(row({ destinationTxHash: MINT }))).toBe(false)
    expect(needsDeliveryHash(row({ sourceChain: 'Nowhere' }))).toBe(false)
    expect(needsDeliveryHash(row({ txHash: '0x123' }))).toBe(false)
  })
})

describe('backfillDeliveryHash', () => {
  beforeEach(() => { setDest.mockClear() })
  it('finds Circle\'s delivery tx once, saves it on the row and shares the lookup', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ messages: [{ status: 'complete', forwardState: 'COMPLETE', forwardTxHash: MINT }] }) }))
    vi.stubGlobal('fetch', fetchMock)
    const tx = '0x' + '11'.repeat(32)
    expect(deliveryLookedUp(tx)).toBe(false)
    const [a, b] = await Promise.all([backfillDeliveryHash(row({ txHash: tx })), backfillDeliveryHash(row({ txHash: tx }))])
    expect(a).toBe(MINT); expect(b).toBe(MINT)
    expect(setDest).toHaveBeenCalledTimes(1)
    expect(setDest).toHaveBeenCalledWith(tx, '0xme', MINT)
    expect(deliveryLookedUp(tx)).toBe(true)
    vi.unstubAllGlobals()
  })
  it('saves nothing when Circle has no answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ messages: [{ status: 'pending_confirmations' }] }) })))
    expect(await backfillDeliveryHash(row({ txHash: '0x' + '22'.repeat(32) }))).toBeNull()
    expect(setDest).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
  it('does nothing for a row that needs no hash', async () => {
    expect(await backfillDeliveryHash(row({ tokenSymbol: 'USDC' }))).toBeNull()
  })
})
