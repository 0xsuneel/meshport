import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── A Gateway retry refused because the first mint already landed ──────────
describe('gatewaySpecAlreadyMinted', () => {
  it('Circle refuses a transfer spec that was already minted: it arrived', async () => {
    const { gatewaySpecAlreadyMinted } = await import('./ubClaim')
    expect(gatewaySpecAlreadyMinted(new Error('Mint failure: … Cause: Simulation failed on Ethereum Sepolia: TransferSpecHashUsed(0xab…)'))).toBe(true)
    expect(gatewaySpecAlreadyMinted({ message: 'Mint failure', cause: { message: 'execution reverted: TransferSpecHashUsed' } })).toBe(true)
  })
  it('any other failure is still a failure', async () => {
    const { gatewaySpecAlreadyMinted } = await import('./ubClaim')
    expect(gatewaySpecAlreadyMinted(new Error('Simulation failed on Ethereum Sepolia: TransferPayloadExpired'))).toBe(false)
    expect(gatewaySpecAlreadyMinted(null)).toBe(false)
  })
})

// ── The relayed mint's receipt: a failing RPC is "not yet", never an error ──
const sends: Array<ReturnType<typeof vi.fn>> = []
vi.mock('ethers', () => {
  class JsonRpcProvider {
    pollingInterval = 4000
    _send: any
    constructor() {
      const fn = vi.fn()
      sends.push(fn)
      this._send = fn
    }
  }
  const Transaction = { from: () => ({ to: '0x0022222abe238cc2c7bb1f21003f0a260052475b', data: '0x9fb01cc5' + '00'.repeat(4), hash: '0x' + 'k'.padStart(64, '0').replace('k', 'a') }) }
  return { JsonRpcProvider, Transaction }
})
vi.mock('./chainRpcs', () => ({ RPC_BY_CHAIN_NAME: { 'Ethereum Sepolia': ['https://a', 'https://b'] } }))
vi.mock('./supabase', () => ({ authApiHeaders: async () => ({}) }))

describe('relayedProviderFor - receipt of a relayed mint', () => {
  beforeEach(() => { sends.length = 0 })

  it('first RPC errors, the second has the receipt: the kit sees it', async () => {
    const RELAYED = '0x' + 'b'.repeat(64)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ txHash: RELAYED }) })))
    const { relayedProviderFor } = await import('./relayedProvider')
    const p = await relayedProviderFor({ name: 'Ethereum Sepolia', chainId: 11155111 })
    const [a, b] = sends
    const [sent] = await p._send({ id: 1, method: 'eth_sendRawTransaction', params: ['0x02'] })
    const kitHash = sent.result
    a.mockRejectedValue(new Error('rate limited'))
    b.mockResolvedValue([{ result: { status: '0x1', transactionHash: RELAYED, logs: [] } }])
    const [r] = await p._send({ id: 2, method: 'eth_getTransactionReceipt', params: [kitHash] })
    expect(r.error).toBeUndefined()
    expect(r.result).toMatchObject({ status: '0x1', transactionHash: kitHash })

    // Every RPC failing is "not mined yet" (null), so the kit keeps polling.
    b.mockRejectedValue(new Error('down'))
    const [r2] = await p._send({ id: 3, method: 'eth_getTransactionReceipt', params: [kitHash] })
    expect(r2.error).toBeUndefined()
    expect(r2.result).toBeNull()
    vi.unstubAllGlobals()
  })
})
