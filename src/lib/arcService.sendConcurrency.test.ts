import { describe, it, expect, vi, beforeEach } from 'vitest'

// Regression guard for "facing slow payments happening": sendUSDC/sendEURC
// used to run three independent pre-broadcast network round trips strictly
// sequentially — balance check, server-side pay-intent/nonce reservation,
// and gas estimate — none of which depends on another's result. This test
// proves they now run concurrently (Promise.all), not sequentially, by
// recording the order in which each mocked call STARTS vs FINISHES: with
// real concurrency all three starts land before any finish (each mock
// resolves after its own artificial delay); a regression back to sequential
// awaits would interleave start/finish pairs one at a time instead.

const timeline: string[] = []

// BUG FIX: this originally used real setTimeout delays (ms) racing against
// vitest's default 5000ms per-test timeout. That's fine in isolation, but
// under this suite's full run (24 files, ~90s+ just to collect) worker CPU
// contention was enough to blow through 5000ms on a test that should take
// ~30ms, and the test that "timed out" left its real timers still pending
// -- they fired minutes later, DURING subsequent tests, pushing stray
// entries into this same module-level `timeline` array and cascading three
// unrelated-looking failures from one slow machine tick. Ticks of chained
// microtasks give the exact same "these resolve in a known relative order"
// property with zero wall-clock dependency -- deterministic regardless of
// how loaded the machine running the suite is.
function delayed<T>(label: string, ticks: number, value: T): Promise<T> {
  timeline.push(`start:${label}`)
  let p: Promise<unknown> = Promise.resolve()
  for (let i = 0; i < ticks; i++) p = p.then(() => undefined)
  return p.then(() => {
    timeline.push(`end:${label}`)
    return value
  })
}

vi.mock('viem/accounts', () => ({
  privateKeyToAccount: () => ({ address: '0x1111111111111111111111111111111111111111' }),
}))

vi.mock('./arc', async () => {
  const actual = await vi.importActual<typeof import('./arc')>('./arc')
  return {
    ...actual,
    arcRpcJson: (_body: unknown, _timeout?: number) =>
      // Backs getUSDCBalance — the most ticks, so if the code were
      // sequential and balance ran first, everything else would visibly
      // wait behind it.
      delayed('balance', 3, { result: '0x3635c9adc5dea00000' }), // 1000e18
  }
})

vi.mock('./payIntentService', () => ({
  createPayIntent: (_req: unknown) =>
    delayed('intent', 2, { success: true, attemptId: 'attempt-1', nonce: 7 }),
  markPayAttemptSubmitted: () => Promise.resolve(),
}))

vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem')
  return {
    ...actual,
    createPublicClient: () => ({
      estimateGas: (_args: unknown) => delayed('gas', 1, 21000n),
      waitForTransactionReceipt: () =>
        Promise.resolve({ status: 'success', blockNumber: 42n }),
    }),
    createWalletClient: () => ({
      sendTransaction: (_args: unknown) =>
        Promise.resolve('0xabc0000000000000000000000000000000000000000000000000000000000000'),
    }),
  }
})

// Static, one-time import -- see the comment on `delayed` above for why:
// a fresh `vi.resetModules()` + dynamic `await import('./arcService')` per
// test forces a full re-transform of the real (unmocked) arcService module
// graph every time, which is the actual expensive part under full-suite
// worker contention, not anything about the artificial delays themselves.
// None of these functions carry test-order-sensitive module-level state, so
// importing once and resetting only `timeline` per test is both correct and
// far cheaper.
import { sendUSDC, sendEURC, sendCirBTC } from './arcService'
import * as payIntentService from './payIntentService'

beforeEach(() => {
  timeline.length = 0
})

describe('sendUSDC / sendEURC pre-broadcast concurrency', () => {
  it('sendUSDC starts balance/intent/gas together instead of one after another', async () => {
    await sendUSDC({ privateKey: '0x' + '11'.repeat(32), to: '0x2222222222222222222222222222222222222222', amount: 1 })

    const starts = timeline.filter(e => e.startsWith('start:'))
    const firstEnd = timeline.findIndex(e => e.startsWith('end:'))
    // All three calls must have been kicked off before any of them finishes —
    // that's only possible if they were launched concurrently (Promise.all),
    // not one at a time.
    expect(starts).toEqual(['start:balance', 'start:intent', 'start:gas'])
    expect(firstEnd).toBe(3) // the 4th timeline entry — after all 3 starts
  })

  it('sendEURC starts intent/gas together instead of one after another', async () => {
    await sendEURC({ privateKey: '0x' + '11'.repeat(32), to: '0x2222222222222222222222222222222222222222', amount: 1 })

    const starts = timeline.filter(e => e.startsWith('start:') && e !== 'start:balance')
    const firstEnd = timeline.findIndex(e => e.startsWith('end:'))
    expect(starts).toEqual(['start:intent', 'start:gas'])
    expect(firstEnd).toBe(2)
  })
})

// Regression guard for "enable cirbtc for pay send and chatpay, work like
// others usdc and eurc": sendCirBTC did not exist at all -- PaySendPage's
// send-routing ternary checked for `arcMod.sendCirBTC`, found it undefined,
// and silently fell through to sendUSDC, so a cirBTC send actually
// broadcast a native USDC transfer (wrong asset, wrong decimals) while the
// Activity row still said 'cirBTC'.
describe('sendCirBTC', () => {
  it('exists and shares the same concurrent pre-broadcast pattern as sendEURC', async () => {
    expect(typeof sendCirBTC).toBe('function')

    await sendCirBTC({ privateKey: '0x' + '11'.repeat(32), to: '0x2222222222222222222222222222222222222222', amount: 1 })

    const starts = timeline.filter(e => e.startsWith('start:') && e !== 'start:balance')
    const firstEnd = timeline.findIndex(e => e.startsWith('end:'))
    expect(starts).toEqual(['start:intent', 'start:gas'])
    expect(firstEnd).toBe(2)
  })

  it('encodes the amount at 8 decimals (cirBTC), not 6 (EURC) -- a decimals mix-up would send 100x or 0.01x the intended amount', async () => {
    let capturedAmountAtomic: string | undefined
    // Swap in a spy for this one test to capture what sendCirBTC actually
    // reports as the atomic amount, instead of just timing.
    const spy = vi.spyOn(payIntentService, 'createPayIntent').mockImplementation(async (req: any) => {
      capturedAmountAtomic = req.amountAtomic
      return { success: true, attemptId: 'attempt-1', nonce: 7 } as any
    })

    await sendCirBTC({ privateKey: '0x' + '11'.repeat(32), to: '0x2222222222222222222222222222222222222222', amount: 0.00025 })

    expect(capturedAmountAtomic).toBe('25000') // 0.00025 * 1e8
    spy.mockRestore()
  })
})
