import { describe, it, expect, vi, beforeEach } from 'vitest'
import { keccak256 } from 'viem'

const rpc = vi.fn()
vi.mock('./arc', () => ({ arcRpcJson: (...a: any[]) => rpc(...a) }))
import { relayRawSend, sendThroughRelay } from './arcRelaySend'

const RAW = '0x02f86d8205d8'
const HASH = keccak256(RAW)

describe('relayRawSend (Circle SDK sends go out like Pay)', () => {
  beforeEach(() => { rpc.mockReset() })

  it('relays the signed bytes once and answers with the hash Arc will report', async () => {
    rpc.mockResolvedValue({ result: { hash: HASH, status: 'success' } })
    expect(await relayRawSend({ id: 9, method: 'eth_sendRawTransaction', params: [RAW] })).toEqual({ jsonrpc: '2.0', id: 9, result: HASH })
    expect(rpc.mock.calls[0][0]).toMatchObject({ method: 'meshport_sendRawTransactionAndWait', params: [RAW, HASH, 8000] })
  })

  it('every node rejected it: returns that rejection (nothing was sent)', async () => {
    rpc.mockImplementation(async () => { throw { code: -32003, message: 'nonce too low' } })
    const r = await relayRawSend({ id: 1, method: 'eth_sendRawTransaction', params: [RAW] })
    expect(r?.error?.message).toBe('nonce too low')
  })

  it('unclear (no node answered, lost answer, older server): the caller sends it directly', async () => {
    rpc.mockResolvedValueOnce({ result: { hash: HASH, status: 'pending', broadcast: 'unknown' } })
    expect(await relayRawSend({ id: 1, params: [RAW] })).toBeNull()
    rpc.mockRejectedValueOnce(new Error('network'))
    expect(await relayRawSend({ id: 1, params: [RAW] })).toBeNull()
  })
})

describe('sendThroughRelay', () => {
  beforeEach(() => { rpc.mockReset() })

  it('only sends change; reads go straight to the provider', async () => {
    const direct = vi.fn(async (p: any) => [{ jsonrpc: '2.0', id: p.id, result: '0x1' }])
    const provider = sendThroughRelay({ _send: direct })
    expect(await provider._send({ id: 1, method: 'eth_blockNumber', params: [] })).toEqual([{ jsonrpc: '2.0', id: 1, result: '0x1' }])
    expect(rpc).not.toHaveBeenCalled()

    rpc.mockResolvedValue({ result: { hash: HASH, status: 'success' } })
    expect(await provider._send({ id: 2, method: 'eth_sendRawTransaction', params: [RAW] })).toEqual([{ jsonrpc: '2.0', id: 2, result: HASH }])
    expect(direct).toHaveBeenCalledTimes(1)
  })

  it('falls back to the plain send when the relay is unclear', async () => {
    const direct = vi.fn(async (p: any) => [{ jsonrpc: '2.0', id: p.id, result: HASH }])
    const provider = sendThroughRelay({ _send: direct })
    rpc.mockImplementation(async () => { throw new Error('older server') })
    expect(await provider._send({ id: 3, method: 'eth_sendRawTransaction', params: [RAW] })).toEqual([{ jsonrpc: '2.0', id: 3, result: HASH }])
    expect(direct).toHaveBeenCalledTimes(1)
  })
})
