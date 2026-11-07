import 'fake-indexeddb/auto'
import { describe, it, expect, vi } from 'vitest'
import { encodeFunctionData, parseAbi } from 'viem'
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
const permit2Tx = { type: 'eip1559', chainId: 5042002, nonce: 0, to: '0x000000000022D473030F116dDEE9F6B43aC78BA3', value: 0n,
  data: encodeFunctionData({ abi: parseAbi(['function transferFrom((address from, address to, uint160 amount, address token)[] details)']), functionName: 'transferFrom',
    args: [[{ from: '0x1111111111111111111111111111111111111111', to: '0x9999999999999999999999999999999999999999', amount: 1n, token: '0x3600000000000000000000000000000000000000' }]] }),
  gas: 100000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }

const OWNER = '0x1111111111111111111111111111111111111111'
const PIN = '123456'
async function withPin() {
  const ask = await frame()
  if (!storage.getItem('mp.circle.passcode')) await ask('circle-passcode:set', { passcode: PIN })
  return ask
}

describe('Fast Pay session key kept across a restart', () => {
  it('kept: sealed in frame storage (never the raw key), reopened by a fresh frame, signs again', async () => {
    const ask = await withPin()
    const { result } = await ask('session:create', { keep: true, owner: OWNER })
    expect(result.kept).toBe(true)
    const saved = JSON.parse(storage.getItem('mp.fastpay.session.' + result.address.toLowerCase())!)
    expect(saved.owner).toBe(OWNER)
    expect(saved.sealed.startsWith('dv1:')).toBe(true)    // device-sealed
    expect(saved.sealed).not.toMatch(/[0-9a-f]{64}/i)      // no readable key in it
    await ask('fastpay:approve', { owner: OWNER, passcode: PIN })
    const before = (await ask('session:sign', { address: result.address, transaction: permit2Tx })).result.serialized

    const ask2 = await frame() // the app closed and reopened: a new frame, empty memory
    expect((await ask2('session:sign', { address: result.address, transaction: permit2Tx })).error.code).toBe('locked')
    expect((await ask2('session:restore', { address: result.address })).result).toEqual({ restored: true })
    // A fresh frame: the approval did not survive; the passcode is checked again.
    expect((await ask2('session:sign', { address: result.address, transaction: permit2Tx })).error.code).toBe('approval-required')
    await ask2('fastpay:approve', { owner: OWNER, passcode: PIN })
    const after = (await ask2('session:sign', { address: result.address, transaction: permit2Tx })).result.serialized
    expect(after).toBe(before) // the same key
  })

  it('a key kept before the passcode check existed (no owner) is not reopened, and is removed', async () => {
    const ask = await withPin()
    storage.setItem('mp.fastpay.session.0x3333333333333333333333333333333333333333', 'dv1:old')
    expect((await ask('session:restore', { address: '0x3333333333333333333333333333333333333333' })).result).toEqual({ restored: false })
    expect(storage.getItem('mp.fastpay.session.0x3333333333333333333333333333333333333333')).toBeNull()
  })

  it('lockout survives a reload: 5 wrong tries, then it waits', async () => {
    const ask = await withPin()
    const codes: string[] = []
    for (let i = 0; i < 5; i++) codes.push((await ask('fastpay:approve', { owner: OWNER, passcode: '000000' })).error.code)
    expect(codes).toEqual(['bad-passcode', 'bad-passcode', 'bad-passcode', 'bad-passcode', 'rate-limited'])
    const ask2 = await frame()
    expect((await ask2('fastpay:approve', { owner: OWNER, passcode: PIN })).error.code).toBe('rate-limited') // even the right one, for now
    storage.removeItem('mp.circle.lockout')
  })

  it('ended: removed from storage too - a restart cannot reopen it', async () => {
    const ask = await withPin()
    const { result } = await ask('session:create', { keep: true, owner: OWNER })
    await ask('session:end', { address: result.address })
    expect(storage.getItem('mp.fastpay.session.' + result.address.toLowerCase())).toBeNull()
    const ask2 = await frame()
    expect((await ask2('session:restore', { address: result.address })).result).toEqual({ restored: false })
  })

  it('not asked to keep: memory only', async () => {
    const ask = await withPin()
    const { result } = await ask('session:create', { owner: OWNER })
    expect(result.kept).toBe(false)
    const ask2 = await frame()
    expect((await ask2('session:restore', { address: result.address })).result).toEqual({ restored: false })
  })
})
