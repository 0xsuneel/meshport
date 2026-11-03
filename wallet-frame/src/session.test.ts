import 'fake-indexeddb/auto'
import { describe, it, expect, vi } from 'vitest'
import { WALLET_MESSAGE_TAG, WALLET_PROTOCOL_VERSION } from '@/wallet/protocol'

// Fast Pay session keys kept across app restarts: sealed to this device with
// the frame's non-extractable device key (IndexedDB), reopened after a frame
// reload, gone after session:end. The key itself is never readable outside.
const listeners: Array<(e: any) => unknown> = []
const parent = { postMessage: vi.fn() }
vi.stubGlobal('window', { addEventListener: (_t: string, f: any) => listeners.push(f), parent })
class MemStorage {
  m = new Map<string, string>()
  get length() { return this.m.size }
  key(i: number) { return [...this.m.keys()][i] ?? null }
  getItem(k: string) { return this.m.get(k) ?? null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
}
const storage = new MemStorage()
vi.stubGlobal('localStorage', storage)
vi.stubGlobal('sessionStorage', new MemStorage())

async function frame() {
  vi.resetModules()
  listeners.length = 0
  await import('./main')
  const onMessage = listeners[0]
  return async (method: string, params: unknown) => {
    parent.postMessage.mockClear()
    const id = Math.random().toString(36).slice(2)
    await onMessage({ origin: 'http://localhost:5173', source: parent, data: { tag: WALLET_MESSAGE_TAG, v: WALLET_PROTOCOL_VERSION, id, method, params } })
    return parent.postMessage.mock.calls.find(c => c[0]?.id === id)![0]
  }
}
const permit2Tx = { type: 'eip1559', chainId: 5042002, nonce: 0, to: '0x000000000022D473030F116dDEE9F6B43aC78BA3', value: 0n, data: '0x0d58b1db' + '00'.repeat(32), gas: 100000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }

describe('Fast Pay session key kept across a restart', () => {
  it('kept: sealed in frame storage (never the raw key), reopened by a fresh frame, signs again', async () => {
    const ask = await frame()
    const { result } = await ask('session:create', { keep: true })
    expect(result.kept).toBe(true)
    const stored = storage.getItem('mp.fastpay.session.' + result.address.toLowerCase())!
    expect(stored.startsWith('dv1:')).toBe(true)          // device-sealed
    expect(stored).not.toMatch(/[0-9a-f]{64}/i)            // no readable key in it
    const before = (await ask('session:sign', { address: result.address, transaction: permit2Tx })).result.serialized

    const ask2 = await frame() // the app closed and reopened: a new frame, empty memory
    expect((await ask2('session:sign', { address: result.address, transaction: permit2Tx })).error.code).toBe('locked')
    expect((await ask2('session:restore', { address: result.address })).result).toEqual({ restored: true })
    const after = (await ask2('session:sign', { address: result.address, transaction: permit2Tx })).result.serialized
    expect(after).toBe(before) // the same key
  })

  it('ended: removed from storage too - a restart cannot reopen it', async () => {
    const ask = await frame()
    const { result } = await ask('session:create', { keep: true })
    await ask('session:end', { address: result.address })
    expect(storage.getItem('mp.fastpay.session.' + result.address.toLowerCase())).toBeNull()
    const ask2 = await frame()
    expect((await ask2('session:restore', { address: result.address })).result).toEqual({ restored: false })
  })

  it('not asked to keep: memory only', async () => {
    const ask = await frame()
    const { result } = await ask('session:create', {})
    expect(result.kept).toBe(false)
    const ask2 = await frame()
    expect((await ask2('session:restore', { address: result.address })).result).toEqual({ restored: false })
  })
})
