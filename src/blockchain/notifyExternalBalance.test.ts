import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

// The chain read is faked; everything else (cache patching, the event) is real.
const reads: number[] = []
let lastKnown: number | undefined
vi.mock('./externalBalanceReader', async (orig) => {
  const real: any = await orig()
  return {
    ...real,
    readChainUSDCBalance: vi.fn(async () => reads.length > 1 ? reads.shift()! : reads[0]),
    lastKnownChainBalance: vi.fn(() => lastKnown),
    patchCachedChainBalance: vi.fn((_w: string, _c: string, b: number) => { lastKnown = b }),
  }
})

const WALLET = '0x1111111111111111111111111111111111111111'
let shown: number[] = []

// BlockchainManager's first (cold) import takes seconds when the whole suite
// runs in parallel. Done inside the first test it ate that test's 5s budget,
// and the timed-out run kept pushing into `shown` during the next test - both
// failed in full runs, never alone. Load it once here, outside any budget.
beforeAll(async () => { await import('./BlockchainManager') }, 60_000)

beforeEach(() => {
  vi.useFakeTimers()
  shown = []
  const target = new EventTarget()
  ;(globalThis as any).window = target
  ;(globalThis as any).document ??= Object.assign(new EventTarget(), { visibilityState: 'visible', hidden: false })
  ;(globalThis as any).CustomEvent ??= class extends Event { detail: any; constructor(t: string, i: any) { super(t); this.detail = i?.detail } }
})
afterEach(() => { vi.useRealTimers(); delete (globalThis as any).window })

async function run(chain: string, spent: number | undefined, chainAnswers: number[], before: number | undefined) {
  const { notifyExternalBalanceChanged, EXTERNAL_BALANCE_EVENT } = await import('./BlockchainManager')
  window.addEventListener(EXTERNAL_BALANCE_EVENT, (e: any) => shown.push(e.detail.balance))
  reads.splice(0, reads.length, ...chainAnswers)
  lastKnown = before
  notifyExternalBalanceChanged(chain, WALLET, spent ? { spent } : {})
  await vi.advanceTimersByTimeAsync(40_000)
}

describe('notifyExternalBalanceChanged', () => {
  it('drops by the amount at once and keeps it while the RPC still shows the old balance', async () => {
    await run('Ethereum_Sepolia', 10, [23.85, 23.85, 23.85, 13.85], 23.85)
    // Instant drop, never back to the stale 23.85, then the chain's real figure.
    expect(shown[0]).toBeCloseTo(13.85)
    expect(shown).not.toContain(23.85)
    expect(shown[shown.length - 1]).toBeCloseTo(13.85)
  })

  it('subtracts only once when the same move is reported twice', async () => {
    const { notifyExternalBalanceChanged, EXTERNAL_BALANCE_EVENT } = await import('./BlockchainManager')
    window.addEventListener(EXTERNAL_BALANCE_EVENT, (e: any) => shown.push(e.detail.balance))
    reads.splice(0, reads.length, 50, 40)
    lastKnown = 50
    notifyExternalBalanceChanged('Base_Sepolia', WALLET, { spent: 10 })
    notifyExternalBalanceChanged('Base_Sepolia', WALLET, { spent: 10 })
    await vi.advanceTimersByTimeAsync(40_000)
    expect(Math.min(...shown)).toBeCloseTo(40)
  })

  it('after the last retry the chain answer wins', async () => {
    await run('Arbitrum_Sepolia', 5, [20], 20)
    expect(shown[shown.length - 1]).toBe(20)
  })

  it('without spent, keeps re-reading until an arrival shows up', async () => {
    await run('Avalanche_Fuji', undefined, [0, 0, 9.99], 0)
    expect(shown[shown.length - 1]).toBeCloseTo(9.99)
  })
})
