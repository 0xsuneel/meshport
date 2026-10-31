import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { decodeFunctionData, encodeAbiParameters, parseAbi } from 'viem'

const rpc = vi.fn()
const send = vi.fn()
const iris = vi.fn()
vi.mock('./arc', () => ({ arcRpcJson: (...a: any[]) => rpc(...a) }))
vi.mock('./arcService', () => ({ relayArcSend: (...a: any[]) => send(...a), waitForConfirmation: async () => ({ state: 'pending' }) }))
vi.mock('./cctpTracker', async (orig) => ({ ...(await orig<any>()), fetchIrisMessage: (...a: any[]) => iris(...a) }))

import { fastCctpxTransfer, parseCctpxQuote, quoteMatches, CCTPX_SERVICE, type CctpxQuote } from './fastCctpx'
import { CCTPX_TOKEN_IDS } from './gaslessToken'

const ME = '0x1111111111111111111111111111111111111111'
const TO = '0x2222222222222222222222222222222222222222'
const EURC_ARC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a'
const MANAGER = '0x3333333333333333333333333333333333333333'
const account = { address: ME } as any
const H = (n: number) => ('0x' + n.toString(16).padStart(64, '0')) as `0x${string}`
const SERVICE = parseAbi([
  'function crossChainTransfer(bytes32,uint256,uint32,bytes,bytes32,uint32,(bytes,address),bool,bytes)',
  'function approve(address,uint256)',
])

function arc({ allowance = 0n, revert = false } = {}) {
  rpc.mockImplementation(async ({ method, params }: any) => {
    if (method === 'eth_getTransactionCount') return { result: '0x7' }
    if (method === 'eth_call' && params[0].to === CCTPX_SERVICE) return { result: encodeAbiParameters([{ type: 'address' }], [MANAGER]) }
    if (method === 'eth_call') return { result: encodeAbiParameters([{ type: 'uint256' }], [allowance]) }
    if (method === 'eth_estimateGas') { if (revert) throw { code: 3, message: 'execution reverted: quote expired' }; return { result: '0x30d40' } }
    if (method === 'eth_gasPrice') return { result: '0x4a817c800' }
    throw new Error('unexpected ' + method)
  })
}

const quote = (over: Partial<CctpxQuote> = {}): CctpxQuote => ({
  token: 'EURC', destination: 'Base_Sepolia', recipient: TO, amount: 5_000_000n,
  signedQuote: '0xabcd', nativeFee: 30_000_000_000_000_000n, finality: 1000, at: Date.now(), ...over,
})
const base = (o: Record<string, unknown> = {}) => ({
  account, token: 'EURC' as const, tokenAddress: EURC_ARC as `0x${string}`, destination: 'Base_Sepolia', recipient: TO,
  amount: 5_000_000n, quote: quote(), onStep: vi.fn(), pollMs: 1, ...o,
})

describe('fastCctpxTransfer (EURC / cirBTC straight to Circle)', () => {
  beforeEach(() => { rpc.mockReset(); send.mockReset(); iris.mockReset() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('approves the token manager for the exact amount, then crossChainTransfer with the fee as value', async () => {
    arc()
    send.mockImplementation(async (_a: any, tx: any) => ({ txHash: tx.to === EURC_ARC ? H(1) : H(2), state: 'success' }))
    iris.mockResolvedValueOnce({ status: 'complete', message: '0x01', attestation: '0x02' })
      .mockResolvedValue({ status: 'complete', message: '0x01', attestation: '0x02', forwardState: 'COMPLETE', forwardTxHash: H(3) })
    const onStep = vi.fn()
    const r = await fastCctpxTransfer(base({ onStep }))

    const [approve, transfer] = send.mock.calls.map(c => c[1])
    expect(approve).toMatchObject({ to: EURC_ARC, nonce: 7 })
    const a = decodeFunctionData({ abi: SERVICE, data: approve.data })
    expect(a.args).toEqual([MANAGER, 5_000_000n])
    expect(transfer).toMatchObject({ to: CCTPX_SERVICE, nonce: 8, value: 30_000_000_000_000_000n })
    const t = decodeFunctionData({ abi: SERVICE, data: transfer.data })
    expect(t.functionName).toBe('crossChainTransfer')
    expect(t.args![0]).toBe(CCTPX_TOKEN_IDS.EURC)
    expect(t.args![1]).toBe(5_000_000n)
    expect(t.args![2]).toBe(6) // Base
    expect(String(t.args![3]).toLowerCase()).toBe(TO) // 20-byte recipient
    expect(t.args![5]).toBe(1000)
    expect((t.args![6] as any)[1].toLowerCase()).toBe(ME) // refunds to the sender
    expect(onStep.mock.calls.map(c => c[0])).toEqual(['approve', 'burn', 'attestation', 'mint'])
    expect(r.steps.find(s => s.name === 'forward')?.txHash).toBe(H(3))
    expect(r.steps.find(s => s.name === 'transfer')?.txHash).toBe(H(2))
  })

  it('no approval when the allowance covers it', async () => {
    arc({ allowance: 10_000_000n })
    send.mockResolvedValue({ txHash: H(2), state: 'success' })
    iris.mockResolvedValue({ status: 'complete', message: '0x01', attestation: '0x02', forwardState: 'COMPLETE', forwardTxHash: H(3) })
    await fastCctpxTransfer(base())
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][1]).toMatchObject({ to: CCTPX_SERVICE, nonce: 7 })
  })

  it('a transfer that would revert is never sent', async () => {
    arc({ allowance: 10_000_000n, revert: true })
    await expect(fastCctpxTransfer(base())).rejects.toThrow(/quote expired/)
    expect(send).not.toHaveBeenCalled()
  })

  it('a stale or different Review quote is not used: a fresh one is asked for', async () => {
    arc({ allowance: 10_000_000n })
    send.mockResolvedValue({ txHash: H(2), state: 'success' })
    iris.mockResolvedValue({ status: 'complete', message: '0x01', attestation: '0x02', forwardState: 'COMPLETE', forwardTxHash: H(3) })
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ signedQuote: '0xbeef', feeTotalAmount: '7', feeToken: '0x0000000000000000000000000000000000000000' }) }))
    vi.stubGlobal('fetch', fetchMock)
    await fastCctpxTransfer(base({ quote: quote({ at: Date.now() - 60_000 }) }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const t = decodeFunctionData({ abi: SERVICE, data: send.mock.calls[0][1].data })
    expect((t.args![6] as any)[0]).toBe('0xbeef')
    expect(send.mock.calls[0][1].value).toBe(7n)
  })

  it("Circle couldn't deliver: settling (Recover), never 'failed'", async () => {
    arc({ allowance: 10_000_000n })
    send.mockResolvedValue({ txHash: H(2), state: 'success' })
    iris.mockResolvedValue({ status: 'complete', message: '0x01', attestation: '0x02', forwardState: 'FAILED' })
    await expect(fastCctpxTransfer(base())).rejects.toMatchObject({ reason: 'settling' })
  })
})

describe('Circle quote checks', () => {
  it('accepts only a native-fee quote with real bytes and an integer fee', () => {
    expect(parseCctpxQuote({ signedQuote: '0xab', feeTotalAmount: '12', feeToken: '0x0000000000000000000000000000000000000000' })).toEqual({ signedQuote: '0xab', nativeFee: 12n })
    expect(() => parseCctpxQuote({ signedQuote: '0xab', feeTotalAmount: '12', feeToken: '0x1111111111111111111111111111111111111111' })).toThrow(/fee token/)
    expect(() => parseCctpxQuote({ signedQuote: '0xa', feeTotalAmount: '12' })).toThrow()
    expect(() => parseCctpxQuote({ signedQuote: '0xab', feeTotalAmount: '-1' })).toThrow()
  })
  it('a quote is reused only fresh and for exactly this transfer', () => {
    const q = quote()
    const want = { token: 'EURC' as const, destination: 'Base_Sepolia', recipient: TO, amount: 5_000_000n }
    expect(quoteMatches(q, want)).toBe(true)
    expect(quoteMatches(q, { ...want, amount: 5_000_001n })).toBe(false)
    expect(quoteMatches(q, { ...want, recipient: ME })).toBe(false)
    expect(quoteMatches(quote({ at: Date.now() - 30_000 }), want)).toBe(false)
  })
})

describe('delivery read from the destination chain (Iris lags it)', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  it("Circle's mint has a successful receipt on the destination: delivered", async () => {
    const { deliveredOnChain } = await import('./fastCctp')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ result: { status: '0x1' } }) })))
    expect(await deliveredOnChain({ status: 'complete', forwardState: 'SENT', forwardTxHash: H(9) }, 'Ethereum_Sepolia')).toBe(true)
  })
  it('not mined yet, reverted, no hash, or failed: not delivered', async () => {
    const { deliveredOnChain } = await import('./fastCctp')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ result: null }) })))
    expect(await deliveredOnChain({ forwardState: 'SENT', forwardTxHash: H(9) }, 'Ethereum_Sepolia')).toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ result: { status: '0x0' } }) })))
    expect(await deliveredOnChain({ forwardState: 'SENT', forwardTxHash: H(9) }, 'Ethereum_Sepolia')).toBe(false)
    expect(await deliveredOnChain({ forwardState: 'PENDING' }, 'Ethereum_Sepolia')).toBe(false)
    expect(await deliveredOnChain({ forwardState: 'FAILED', forwardTxHash: H(9) }, 'Ethereum_Sepolia')).toBe(false)
  })
  it('the transfer finishes on the chain receipt before Iris says COMPLETE', async () => {
    arc({ allowance: 10_000_000n })
    send.mockResolvedValue({ txHash: H(2), state: 'success' })
    iris.mockResolvedValue({ status: 'complete', message: '0x01', attestation: '0x02', forwardState: 'SENT', forwardTxHash: H(3) })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ result: { status: '0x1' } }) })))
    const onStep = vi.fn()
    const r = await fastCctpxTransfer(base({ onStep, destination: 'Ethereum_Sepolia', quote: quote({ destination: 'Ethereum_Sepolia' }) }))
    expect(r.steps.find(s => s.name === 'forward')?.txHash).toBe(H(3))
    expect(onStep.mock.calls.map(c => c[0])).toEqual(['approve', 'burn', 'attestation', 'mint'])
  })
})
