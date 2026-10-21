import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const answers: Array<Record<string, number>> = []
vi.mock('./BlockchainManager', () => ({
  EXTERNAL_BALANCE_EVENT: 'meshport:external-balance',
  EXTERNAL_LIVE_POLL_MS: 30_000,
  refreshScope: vi.fn(),
  readExternalBalances: vi.fn(async () => {
    const m = answers.length > 1 ? answers.shift()! : answers[0]
    return { chains: Object.entries(m).map(([chainId, balance]) => ({ chainId, balance })), total: 0 }
  }),
}))

const WALLET = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
let doc: EventTarget & { visibilityState: string }

beforeEach(() => {
  vi.useFakeTimers()
  ;(globalThis as any).window = new EventTarget()
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  ;(globalThis as any).document = doc
  ;(globalThis as any).CustomEvent ??= class extends Event { detail: any; constructor(t: string, i: any) { super(t); this.detail = i?.detail } }
})
afterEach(() => { vi.useRealTimers(); delete (globalThis as any).window; delete (globalThis as any).document })

describe('externalLiveWatch', () => {
  it('announces a credit that landed while the app was in the background, once back', async () => {
    const { startExternalLiveWatch } = await import('./externalLiveWatch')
    const shown: any[] = []
    window.addEventListener('meshport:external-balance', (e: any) => shown.push(e.detail))
    answers.splice(0, answers.length, { Ethereum_Sepolia: 10, Base_Sepolia: 5 }, { Ethereum_Sepolia: 19.99, Base_Sepolia: 5 })
    const stop = startExternalLiveWatch(WALLET, () => ({ settings: {} as any, loaded: true }))
    await vi.advanceTimersByTimeAsync(0)
    expect(shown).toEqual([]) // the first read only seeds the baseline

    doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(10_000)
    doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(shown).toEqual([{ chainId: 'Ethereum_Sepolia', balance: 19.99 }])
    stop()
  })

  it('does not read while hidden', async () => {
    const { startExternalLiveWatch } = await import('./externalLiveWatch')
    const { readExternalBalances } = await import('./BlockchainManager')
    answers.splice(0, answers.length, { Ethereum_Sepolia: 1 })
    doc.visibilityState = 'hidden'
    const before = (readExternalBalances as any).mock.calls.length
    const stop = startExternalLiveWatch(WALLET, () => ({ settings: {} as any, loaded: true }))
    await vi.advanceTimersByTimeAsync(120_000)
    expect((readExternalBalances as any).mock.calls.length).toBe(before)
    stop()
  })
})
