import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// An external-chain credit published by the indexer (chain_events INSERT, via
// Realtime) must end as a balance update every external-balance screen hears.
vi.mock('@/lib/supabase', () => ({ supabase: { channel: vi.fn(), removeChannel: vi.fn() } }))
const reads: Array<[string, number]> = []
let lastKnown: number | undefined
vi.mock('./externalBalanceReader', async (orig) => {
  const real: any = await orig()
  return {
    ...real,
    readChainUSDCBalance: vi.fn(async (chain: string) => { const r = reads.length > 1 ? reads.shift()! : reads[0]; return r[0] === chain ? r[1] : -1 }),
    lastKnownChainBalance: vi.fn(() => lastKnown),
    patchCachedChainBalance: vi.fn((_w: string, _c: string, b: number) => { lastKnown = b }),
  }
})

const WALLET = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'

beforeEach(() => {
  vi.useFakeTimers()
  ;(globalThis as any).window = new EventTarget()
  ;(globalThis as any).document ??= Object.assign(new EventTarget(), { visibilityState: 'visible', hidden: false })
  ;(globalThis as any).CustomEvent ??= class extends Event { detail: any; constructor(t: string, i: any) { super(t); this.detail = i?.detail } }
})
afterEach(() => { vi.useRealTimers(); delete (globalThis as any).window })

describe('shadowEventBus: external-chain credit', () => {
  it('a mint on ethereum-sepolia updates Ethereum_Sepolia, retrying past a lagging RPC', async () => {
    const { shadowEventBus } = await import('./shadowEventBus')
    const { EXTERNAL_BALANCE_EVENT } = await import('./BlockchainManager')
    const shown: Array<{ chainId: string; balance: number }> = []
    window.addEventListener(EXTERNAL_BALANCE_EVENT, (e: any) => shown.push(e.detail))
    lastKnown = 10
    // The RPC still answers the old balance twice, then the credit.
    reads.splice(0, reads.length, ['Ethereum_Sepolia', 10], ['Ethereum_Sepolia', 10], ['Ethereum_Sepolia', 19.99565])
    ;(shadowEventBus as any).ingest({
      id: 1, chain_id: 'ethereum-sepolia', event_type: 'transfer_detected', wallet_address: WALLET,
      tx_hash: '0x2020', block_number: 11962105, status: 'pending', created_at: new Date().toISOString(),
      metadata: { to: WALLET, from: '0x0000000000000000000000000000000000000000', amount: 9.99565, mint: true },
    })
    await vi.advanceTimersByTimeAsync(40_000)
    expect(shown.every(s => s.chainId === 'Ethereum_Sepolia')).toBe(true)
    expect(shown[shown.length - 1].balance).toBeCloseTo(19.99565)
  })
})
