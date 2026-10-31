import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const rpc = vi.fn()
vi.mock('./arc', () => ({ arcRpcJson: (...a: any[]) => rpc(...a) }))
import { messageNonce, mintedOnArc } from './cctpTracker'

const NONCE = 'ab'.repeat(32)
// version 1, source domain 0, destination 26, nonce, then the rest of the message.
const MSG = '0x' + '00000001' + '00000000' + '0000001a' + NONCE + 'ff'.repeat(40)
const BURN = '0x' + '1'.repeat(64)

describe('messageNonce', () => {
  it('reads the bytes32 nonce after the three header words', () => {
    expect(messageNonce(MSG)).toBe('0x' + NONCE)
  })
  it('no nonce yet (zero, as emitted at burn) or no message', () => {
    expect(messageNonce('0x' + '0'.repeat(24) + '0'.repeat(64) + 'ff')).toBeNull()
    expect(messageNonce(null)).toBeNull()
    expect(messageNonce('0x1234')).toBeNull()
  })
})

describe('mintedOnArc', () => {
  const iris = (m: any) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ messages: [m] }) })))
  beforeEach(() => { rpc.mockReset() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('attested: asks Arc whether the nonce is used', async () => {
    iris({ status: 'complete', message: MSG, attestation: '0xcd', forwardState: 'PENDING' })
    rpc.mockResolvedValue({ result: '0x' + '0'.repeat(63) + '1' })
    expect(await mintedOnArc('Ethereum_Sepolia', BURN)).toBe(true)
    expect(rpc.mock.calls[0][0].params[0].data).toBe('0xfeb61724' + NONCE)
    rpc.mockResolvedValue({ result: '0x' + '0'.repeat(64) })
    expect(await mintedOnArc('Ethereum_Sepolia', BURN)).toBe(false)
  })
  it('not attested yet: never asks Arc', async () => {
    iris({ status: 'pending_confirmations', message: MSG, attestation: 'PENDING' })
    expect(await mintedOnArc('Ethereum_Sepolia', BURN)).toBe(false)
    expect(rpc).not.toHaveBeenCalled()
  })
  it('Iris already reports the forwarder mint', async () => {
    iris({ status: 'complete', message: MSG, attestation: '0xcd', forwardState: 'COMPLETE', forwardTxHash: BURN })
    expect(await mintedOnArc('Ethereum_Sepolia', BURN)).toBe(true)
  })
  it('an Arc RPC failure is "not yet", not an error', async () => {
    iris({ status: 'complete', message: MSG, attestation: '0xcd' })
    rpc.mockRejectedValue(new Error('down'))
    expect(await mintedOnArc('Ethereum_Sepolia', BURN)).toBe(false)
  })
})
