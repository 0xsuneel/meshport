// Pay/Send through the server (relaySend): signed on the phone, sent and
// confirmed by /api/arc-rpc in one request; anything unclear falls back to
// sending directly, and "maybe sent" is pending - never failed.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { keccak256 } from 'viem'

const SIGNED = '0x02abc0'
const HASH = keccak256(SIGNED)
const marked: string[] = []
let relay: (body: any) => any = () => ({ result: { hash: HASH, status: 'success', blockNumber: '0x2a' } })
let direct: (body: any) => any = () => ({ result: HASH })
let receipt: () => Promise<any> = async () => ({ status: 'success', blockNumber: 7n })
const calls: string[] = []

vi.mock('viem/accounts', () => ({
  privateKeyToAccount: () => ({ address: '0x1111111111111111111111111111111111111111', signTransaction: async () => SIGNED }),
}))
vi.mock('./arc', async () => {
  const actual = await vi.importActual<typeof import('./arc')>('./arc')
  return {
    ...actual,
    arcRpcJson: async (body: any) => {
      calls.push(body.method)
      if (body.method === 'meshport_sendRawTransactionAndWait') return relay(body)
      if (body.method === 'eth_sendRawTransaction') return direct(body)
      return { result: '0x3635c9adc5dea00000' } // balance 1000
    },
  }
})
vi.mock('./payIntentService', () => ({
  createPayIntent: async () => ({ success: true, attemptId: 'a1', nonce: 3 }),
  markPayAttemptSubmitted: async (_id: string, h: string) => { marked.push(h) },
}))
vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem')
  return { ...actual, createPublicClient: () => ({ estimateGas: async () => 21000n, getTransactionReceipt: () => receipt() }) }
})

import { sendUSDC } from './arcService'
const send = (k: string) => sendUSDC({ privateKey: '0x' + '1'.repeat(64), to: '0x2222222222222222222222222222222222222222', amount: 1, idempotencyKey: k })
const throwRpc = (code: number, message: string) => { throw Object.assign({ code, message }) }

describe('relaySend (send through the server)', () => {
  beforeEach(() => {
    marked.length = 0; calls.length = 0
    relay = () => ({ result: { hash: HASH, status: 'success', blockNumber: '0x2a' } })
    direct = () => ({ result: HASH })
    receipt = async () => ({ status: 'success', blockNumber: 7n })
  })

  it('one request: the server sends and confirms; the hash is recorded', async () => {
    const r = await send('k1')
    expect(r).toMatchObject({ txHash: HASH, state: 'success', blockNumber: '42' })
    expect(marked).toEqual([HASH])
    expect(calls).not.toContain('eth_sendRawTransaction')
  })

  it('server says rejected: an error, nothing recorded as sent', async () => {
    relay = () => throwRpc(-32003, 'insufficient funds for gas')
    await expect(send('k2')).rejects.toThrow(/insufficient funds/)
    expect(marked).toEqual([])
  })

  it('older server / lost answer: sends directly instead, then confirms', async () => {
    relay = () => { throw new Error('Arc RPC 502') }
    const r = await send('k3')
    expect(calls).toContain('eth_sendRawTransaction')
    expect(r.state).toBe('success')
    expect(marked).toEqual([HASH])
  })

  it('direct send says "already known" (the first one did go out): treated as sent', async () => {
    relay = () => { throw new Error('timeout') }
    direct = () => throwRpc(-32000, 'already known')
    const r = await send('k4')
    expect(r.state).toBe('success')
    expect(marked).toEqual([HASH])
  })

  it('network down on both: pending with the known hash, never failed', async () => {
    relay = () => { throw new TypeError('fetch failed') }
    direct = () => { throw new TypeError('fetch failed') }
    const r = await send('k5')
    expect(r).toMatchObject({ txHash: HASH, state: 'pending' })
  })

  it('sent but no receipt yet: pending (not failed)', async () => {
    relay = () => ({ result: { hash: HASH, status: 'pending', broadcast: 'sent' } })
    receipt = async () => { throw new Error('not found') }
    const r = await send('k6')
    expect(r.state).toBe('pending')
    expect(marked).toEqual([HASH])
  })
})
