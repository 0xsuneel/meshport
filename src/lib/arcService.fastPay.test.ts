import { describe, it, expect, vi, beforeEach } from 'vitest'

// sendUSDC / preparePayment with Fast Pay (lib/fastPay.ts): a covered payment
// goes through the session - no pay-intent reservation, no Circle signature;
// everything else takes the normal path, unchanged.

const SENDER = '0x1111111111111111111111111111111111111111'
const RECIPIENT = '0x2222222222222222222222222222222222222222'

let covers = true
let notSent = false
const fastSends: any[] = []
class FastPayNotSent extends Error {}
vi.mock('./fastPay', () => ({
  FastPayNotSent,
  fastPayCovers: () => covers,
  sendFastPay: async (p: any) => {
    if (notSent) throw new FastPayNotSent('refused')
    fastSends.push(p)
    return { txHash: '0x' + 'cd'.repeat(32), state: 'success', blockNumber: '5' }
  },
}))
const createPayIntent = vi.fn(async (_r?: unknown) => ({ success: true, attemptId: 'a1', nonce: 3 }))
vi.mock('./payIntentService', () => ({ createPayIntent: (r: any) => createPayIntent(r), markPayAttemptSubmitted: () => Promise.resolve() }))
const signed: unknown[] = []
const signer = { address: SENDER, signTransaction: async (tx: unknown) => { signed.push(tx); return '0x02abc0' } } as any
vi.mock('./arc', async () => {
  const actual = await vi.importActual<typeof import('./arc')>('./arc')
  return { ...actual, arcRpcJson: async (body: { method: string }) => {
    if (body.method === 'meshport_sendRawTransactionAndWait') return { result: { hash: '0x' + 'ab'.repeat(32), status: 'success', blockNumber: '0x1' } }
    if (body.method === 'eth_gasPrice') return { result: '0x3b9aca00' }
    return { result: '0x3635c9adc5dea00000' }
  } }
})
vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem')
  return { ...actual, createPublicClient: () => ({ estimateGas: async () => 21000n, getGasPrice: async () => 1_000_000_000n, getTransactionReceipt: async () => ({ status: 'success', blockNumber: 1n }) }) }
})

const { sendUSDC, preparePayment } = await import('./arcService')

describe('Pay with Fast Pay', () => {
  beforeEach(() => { covers = true; notSent = false; fastSends.length = 0; signed.length = 0; createPayIntent.mockClear() })

  it('covered: sent through the session - no pay-intent, no wallet signature', async () => {
    const res = await sendUSDC({ signer, to: RECIPIENT, amount: 5, idempotencyKey: 'k1' })
    expect(fastSends).toEqual([{ owner: SENDER, to: RECIPIENT, amount: 5, idempotencyKey: 'k1' }])
    expect(createPayIntent).not.toHaveBeenCalled()
    expect(signed).toEqual([])
    expect(res).toMatchObject({ state: 'success', senderAddress: SENDER, recipientAddress: RECIPIENT })
  })

  it('an order payment (memo) always takes the normal path', async () => {
    await sendUSDC({ signer, to: RECIPIENT, amount: 5, idempotencyKey: 'k2', memo: { code: 'ORD1' } as any })
    expect(fastSends).toEqual([])
    expect(createPayIntent).toHaveBeenCalledTimes(1)
  })

  it('not covered (over the limit, no session): the normal path', async () => {
    covers = false
    await sendUSDC({ signer, to: RECIPIENT, amount: 500, idempotencyKey: 'k3' })
    expect(fastSends).toEqual([])
    expect(signed.length).toBe(1)
  })

  it('Fast Pay refused before sending anything: paid the normal way instead', async () => {
    notSent = true
    const res = await sendUSDC({ signer, to: RECIPIENT, amount: 5, idempotencyKey: 'k4' })
    expect(signed.length).toBe(1)
    expect(res.state).toBe('success')
  })

  it('preparePayment reserves nothing for a covered payment', async () => {
    preparePayment({ token: 'USDC', from: SENDER, to: RECIPIENT, amount: 5, idempotencyKey: 'k5' })
    await new Promise(r => setTimeout(r, 20))
    expect(createPayIntent).not.toHaveBeenCalled()
  })
})
