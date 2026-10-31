import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decodeFunctionData, encodeAbiParameters, parseAbi } from 'viem'

const rpc = vi.fn()
const send = vi.fn()
const iris = vi.fn()
const finish = vi.fn()
vi.mock('./arc', () => ({ arcRpcJson: (...a: any[]) => rpc(...a) }))
vi.mock('./arcService', () => ({ relayArcSend: (...a: any[]) => send(...a), waitForConfirmation: async () => ({ state: 'pending' }) }))
vi.mock('./cctpTracker', async (orig) => ({ ...(await orig<any>()), fetchIrisMessage: (...a: any[]) => iris(...a) }))
vi.mock('./cctpRecovery', () => ({ finishCctpMintViaRelayer: (...a: any[]) => finish(...a) }))

import { fastCctpTransfer, maxFeeFromIris, canFastCctp, TOKEN_MESSENGER_V2, ARC_USDC, FastCctpError } from './fastCctp'

const ME = '0x1111111111111111111111111111111111111111'
const TO = '0x2222222222222222222222222222222222222222'
const account = { address: ME } as any
const BURN_ABI = parseAbi([
  'function depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)',
  'function depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)',
])
const H = (n: number) => ('0x' + n.toString(16).padStart(64, '0')) as `0x${string}`

function arc({ allowance = 0n, nonce = 7, revert = false } = {}) {
  rpc.mockImplementation(async ({ method }: any) => {
    if (method === 'eth_getTransactionCount') return { result: '0x' + nonce.toString(16) }
    if (method === 'eth_call') return { result: encodeAbiParameters([{ type: 'uint256' }], [allowance]) }
    if (method === 'eth_estimateGas') { if (revert) throw { code: 3, message: 'execution reverted: insufficient balance' }; return { result: '0x186a0' } }
    throw new Error('unexpected ' + method)
  })
}

const base = (o: Partial<Parameters<typeof fastCctpTransfer>[0]> = {}) => ({
  account, destination: 'Base_Sepolia', recipient: TO, amount: '10.000000', maxFee: '0.100000',
  speed: 'FAST' as const, useForwarder: true, onStep: vi.fn(), pollMs: 1, ...o,
})

describe('fastCctpTransfer', () => {
  beforeEach(() => { rpc.mockReset(); send.mockReset(); iris.mockReset(); finish.mockReset() })

  it('approves the exact amount, burns with the forward hook, and reports the forwarder mint', async () => {
    arc()
    send.mockImplementation(async (_a: any, tx: any) => ({ txHash: tx.to === ARC_USDC ? H(1) : H(2), state: 'success' }))
    iris.mockResolvedValueOnce(null).mockResolvedValueOnce({ status: 'complete', message: '0xab', attestation: '0xcd' })
      .mockResolvedValue({ status: 'complete', message: '0xab', attestation: '0xcd', forwardState: 'COMPLETE', forwardTxHash: H(3) })
    const onStep = vi.fn()
    const r = await fastCctpTransfer(base({ onStep }))

    expect(send).toHaveBeenCalledTimes(2)
    const [approveTx, burnTx] = send.mock.calls.map(c => c[1])
    expect(approveTx).toMatchObject({ to: ARC_USDC, nonce: 7, gas: 130_000n })
    expect(burnTx).toMatchObject({ to: TOKEN_MESSENGER_V2, nonce: 8 })
    const burn = decodeFunctionData({ abi: BURN_ABI, data: burnTx.data })
    expect(burn.functionName).toBe('depositForBurnWithHook')
    expect(burn.args![0]).toBe(10_000_000n)       // amount
    expect(burn.args![1]).toBe(6)                 // Base domain
    expect(String(burn.args![2]).toLowerCase()).toBe('0x' + '0'.repeat(24) + TO.slice(2))
    expect(burn.args![5]).toBe(100_000n)          // maxFee
    expect(burn.args![6]).toBe(1000)              // fast finality
    expect(onStep.mock.calls.map(c => c[0])).toEqual(['approve', 'burn', 'attestation', 'mint'])
    expect(r.steps.find(s => s.name === 'mint')?.txHash).toBe(H(3))
    expect(finish).not.toHaveBeenCalled()
  })

  it('skips the approval when the allowance covers it; relayer mints without a forwarder', async () => {
    arc({ allowance: 50_000_000n })
    send.mockResolvedValue({ txHash: H(2), state: 'success' })
    iris.mockResolvedValue({ status: 'complete', message: '0xab', attestation: '0xcd' })
    finish.mockResolvedValue({ mintTxHash: H(9) })
    const r = await fastCctpTransfer(base({ destination: 'Ethereum_Sepolia', useForwarder: false }))
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][1]).toMatchObject({ to: TOKEN_MESSENGER_V2, nonce: 7 })
    expect(decodeFunctionData({ abi: BURN_ABI, data: send.mock.calls[0][1].data }).functionName).toBe('depositForBurn')
    expect(finish.mock.calls[0][0]).toMatchObject({ destinationChain: 'Ethereum_Sepolia', burnTxHash: H(2) })
    expect(r.steps.find(s => s.name === 'mint')?.txHash).toBe(H(9))
  })

  it('a burn that would revert is never sent', async () => {
    arc({ allowance: 50_000_000n, revert: true })
    await expect(fastCctpTransfer(base())).rejects.toThrow(/insufficient balance/)
    expect(send).not.toHaveBeenCalled()
  })

  it('a reverted burn is "nothing sent", not "settling"', async () => {
    arc({ allowance: 50_000_000n })
    send.mockResolvedValue({ txHash: H(2), state: 'failed' })
    const onBurnSent = vi.fn()
    await expect(fastCctpTransfer(base({ onBurnSent }))).rejects.toMatchObject({ kind: 'not_sent' })
    expect(onBurnSent).not.toHaveBeenCalled()
  })

  it('a burn still confirming hands its hash over (the transfer may settle on its own)', async () => {
    arc({ allowance: 50_000_000n })
    send.mockResolvedValue({ txHash: H(2), state: 'pending' })
    const onBurnSent = vi.fn()
    await expect(fastCctpTransfer(base({ onBurnSent }))).rejects.toBeInstanceOf(FastCctpError)
    expect(onBurnSent).toHaveBeenCalledWith(H(2))
  })

  it('refuses a fee cap at or above the amount', async () => {
    await expect(fastCctpTransfer(base({ amount: '1.000000', maxFee: '1.000000' }))).rejects.toThrow(/too small/)
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('maxFeeFromIris', () => {
  const rows = [
    { finalityThreshold: 1000, minimumFee: 1.3, forwardFee: { low: 50_000, med: 60_000, high: 80_000 } },
    { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 50_000, med: 60_000, high: 80_000 } },
  ]
  it('fast + forwarder: protocol bps plus the high forward fee, with headroom', () => {
    // 100 USDC * 1.3 bps = 13_000 units; + 80_000 = 93_000; * 1.2 + 1_000
    expect(maxFeeFromIris(rows, 100_000_000n, { fast: true, forward: true, l1: false })).toBe(112_600n)
    expect(maxFeeFromIris(rows, 100_000_000n, { fast: true, forward: true, l1: true })).toBe(140_500n)
  })
  it('slow, relayer mint: only the (zero) protocol fee', () => {
    expect(maxFeeFromIris(rows, 100_000_000n, { fast: false, forward: false, l1: false })).toBe(1_000n)
  })
  it('no usable row: null (caller falls back to the SDK estimate)', () => {
    expect(maxFeeFromIris([], 1n, { fast: true, forward: false, l1: false })).toBeNull()
    expect(maxFeeFromIris([{ finalityThreshold: 1000, minimumFee: 1 }], 1n, { fast: true, forward: true, l1: false })).toBeNull()
  })
})

describe('canFastCctp', () => {
  it('EVM CCTP destinations only', () => {
    expect(canFastCctp('Ethereum_Sepolia')).toBe(true)
    expect(canFastCctp('Polygon_Amoy_Testnet')).toBe(true)
    expect(canFastCctp('Solana_Devnet')).toBe(false)
    expect(canFastCctp('Arc_Testnet')).toBe(false)
    expect(canFastCctp('Nowhere')).toBe(false)
  })
})

describe('Review fees (no SDK)', () => {
  const rows = [
    { finalityThreshold: 1000, minimumFee: 1.3, forwardFee: { low: 50_000, med: 60_000, high: 80_000 } },
    { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 50_000, med: 60_000, high: 80_000 } },
  ]
  it('expected fees: protocol bps of the amount plus the typical forwarder fee', async () => {
    const { expectedFeesFromIris } = await import('./fastCctp')
    expect(expectedFeesFromIris(rows, 100, { fast: true, forward: true })).toEqual({ bridgeFee: 0.013, forwarderFee: 0.06 })
    expect(expectedFeesFromIris(rows, 100, { fast: false, forward: false })).toEqual({ bridgeFee: 0, forwarderFee: 0 })
  })

  it('fastCctpFees: Circle table + Arc gas price + allowance, in parallel', async () => {
    const { fastCctpFees } = await import('./fastCctp')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => rows })))
    rpc.mockReset()
    rpc.mockImplementation(async ({ method }: any) => {
      if (method === 'eth_gasPrice') return { result: '0x' + (20_000_000_000n).toString(16) } // 20 gwei
      if (method === 'eth_call') return { result: encodeAbiParameters([{ type: 'uint256' }], [0n]) }
      throw new Error(method)
    })
    const f = await fastCctpFees({ destination: 'Arbitrum_Sepolia', amount: 100, fast: true, forward: true, owner: ME })
    expect(f?.bridgeFee).toBe(0.013)
    expect(f?.forwarderFee).toBe(0.06)
    expect(f?.networkFee).toBeCloseTo(260_000 * 20e9 / 1e18) // approve + burn
    vi.unstubAllGlobals()
  })

  it('anything unreadable: null, so the caller uses the SDK', async () => {
    const { fastCctpFees } = await import('./fastCctp')
    expect(await fastCctpFees({ destination: 'Solana_Devnet', amount: 1, fast: true, forward: true, owner: ME })).toBeNull()
  })
})
