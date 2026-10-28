import { describe, it, expect, vi, beforeEach } from 'vitest'

// preparePayment() starts a send's preflight (pay-intent reservation, gas,
// balance) at PIN entry so the send itself only has to sign + broadcast.
// Guards: a matching preflight is reused (no second pay-intent call), and a
// preflight for different payment details is never used for this one.

const SENDER = '0x1111111111111111111111111111111111111111'
const RECIPIENT = '0x2222222222222222222222222222222222222222'
const OTHER = '0x3333333333333333333333333333333333333333'

const createPayIntent = vi.fn(async (_req: { recipientAddress: string; amountAtomic: string; callTarget?: string | null }) =>
  ({ success: true, attemptId: 'attempt-1', nonce: 7 }))
let receipt: () => Promise<{ status: string; blockNumber: bigint }> = async () => ({ status: 'success', blockNumber: 1n })
const sendTransaction = vi.fn(async (_args: unknown) =>
  '0xabc0000000000000000000000000000000000000000000000000000000000000')

// The wallet signer (src/wallet) - signs in the wallet frame in the app;
// here the spy records what gets signed.
const signer = { address: SENDER, signTransaction: async (args: unknown) => { await sendTransaction(args); return '0x02abc0' } } as any

vi.mock('./arc', async () => {
  const actual = await vi.importActual<typeof import('./arc')>('./arc')
  return { ...actual, arcRpcJson: async (body: { method: string }) => {
    if (body.method === 'eth_getBalance' && balanceRead === 'fails') throw new Error('timeout')
    if (body.method === 'eth_getBalance' && balanceRead === 'low') return { result: '0xde0b6b3a7640000' } // 1e18
    return { result: '0x3635c9adc5dea00000' } // 1000e18
  } }
})
let balanceRead: 'ok' | 'fails' | 'low' = 'ok'

vi.mock('./payIntentService', () => ({
  createPayIntent: (req: { recipientAddress: string; amountAtomic: string; callTarget?: string | null }) => createPayIntent(req),
  markPayAttemptSubmitted: () => Promise.resolve(),
}))

vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem')
  return {
    ...actual,
    createPublicClient: () => ({ estimateGas: async () => 21000n, getTransactionReceipt: () => receipt() }),
    createWalletClient: () => ({ sendTransaction: (args: unknown) => sendTransaction(args) }),
  }
})

import { preparePayment, sendUSDC } from './arcService'

describe('preparePayment', () => {
  beforeEach(() => { createPayIntent.mockClear(); sendTransaction.mockClear(); receipt = async () => ({ status: 'success', blockNumber: 1n }) })

  it('reuses a matching early preflight instead of creating a second intent', async () => {
    preparePayment({ token: 'USDC', from: SENDER, to: RECIPIENT, amount: 5, idempotencyKey: 'key-a' })

    const res = await sendUSDC({ signer, to: RECIPIENT, amount: 5, idempotencyKey: 'key-a' })

    expect(createPayIntent).toHaveBeenCalledTimes(1)
    expect(sendTransaction).toHaveBeenCalledTimes(1)
    expect((sendTransaction.mock.calls[0][0] as { nonce: number }).nonce).toBe(7)
    expect(res.txHash).toMatch(/^0x[0-9a-f]{64}$/) // keccak of the signed bytes, known before sending
  })

  it('ignores an early preflight made for different payment details', async () => {
    preparePayment({ token: 'USDC', from: SENDER, to: OTHER, amount: 5, idempotencyKey: 'key-b' })
    await sendUSDC({ signer, to: RECIPIENT, amount: 5, idempotencyKey: 'key-b' })

    expect(createPayIntent).toHaveBeenCalledTimes(2)
    expect(createPayIntent.mock.calls[1][0].recipientAddress).toBe(RECIPIENT)
  })

  it('falls back to a fresh preflight when none was prepared', async () => {
    await sendUSDC({ signer, to: RECIPIENT, amount: 2, idempotencyKey: 'key-c' })
    expect(createPayIntent).toHaveBeenCalledTimes(1)
    expect(sendTransaction).toHaveBeenCalledTimes(1)
  })
})

describe('send confirmation state', () => {
  const send = (key: string) => sendUSDC({ signer, to: RECIPIENT, amount: 1, idempotencyKey: key })

  it('is success only once the receipt confirms', async () => {
    receipt = async () => ({ status: 'success', blockNumber: 9n })
    const res = await send('state-ok')
    expect(res.state).toBe('success')
    expect(res.blockNumber).toBe('9')
  })

  it('is failed when the transaction reverted on-chain', async () => {
    receipt = async () => ({ status: 'reverted', blockNumber: 9n })
    expect((await send('state-reverted')).state).toBe('failed')
  })

  it('is pending (never failed) when no receipt arrives in time', async () => {
    receipt = async () => { throw new Error('TransactionReceiptNotFoundError') }
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    try {
      const p = send('state-timeout')
      await vi.advanceTimersByTimeAsync(11_000)
      expect((await p).state).toBe('pending')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('order payment memo', () => {
  beforeEach(() => { createPayIntent.mockClear(); sendTransaction.mockClear(); receipt = async () => ({ status: 'success', blockNumber: 1n }) })

  it('order payment: the early preflight and the send both go through the Memo contract', async () => {
    const memo = { code: 'd73a434b15', label: 'ORD-00094' }
    preparePayment({ token: 'USDC', from: SENDER, to: RECIPIENT, amount: 10, idempotencyKey: 'key-m', memo })
    await sendUSDC({ signer, to: RECIPIENT, amount: 10, idempotencyKey: 'key-m', memo })

    expect(createPayIntent).toHaveBeenCalledTimes(1)
    expect(createPayIntent.mock.calls[0][0].callTarget).toBe('0x5294E9927c3306DcBaDb03fe70b92e01cCede505')
    expect(createPayIntent.mock.calls[0][0].amountAtomic).toBe('10000000000000000000')
    const signed = sendTransaction.mock.calls[0][0] as { to: string; value: bigint; data: string }
    expect(signed.to).toBe('0x5294E9927c3306DcBaDb03fe70b92e01cCede505')
    expect(signed.value).toBe(0n)
    expect(signed.data).toContain('6437336134333462313500000000000000000000000000000000000000000000') // memoId = order code
  })

  it('an early preflight without the memo is not reused for an order payment', async () => {
    preparePayment({ token: 'USDC', from: SENDER, to: RECIPIENT, amount: 10, idempotencyKey: 'key-n' })
    await sendUSDC({ signer, to: RECIPIENT, amount: 10, idempotencyKey: 'key-n', memo: { code: 'abc', label: 'ORD-1' } })
    expect(createPayIntent).toHaveBeenCalledTimes(2)
    expect(createPayIntent.mock.calls[1][0].callTarget).toBe('0x5294E9927c3306DcBaDb03fe70b92e01cCede505')
  })
})

describe('balance check before sending', () => {
  beforeEach(() => { sendTransaction.mockClear(); balanceRead = 'ok' })

  it('a balance read that fails does not stop the payment as "not enough balance"', async () => {
    balanceRead = 'fails'
    const res = await sendUSDC({ signer, to: RECIPIENT, amount: 1, idempotencyKey: 'bal-fails' })
    expect(sendTransaction).toHaveBeenCalledTimes(1)
    expect(res.state).toBe('success')
  })

  it('a balance that really is too small still stops it', async () => {
    balanceRead = 'low'
    await expect(sendUSDC({ signer, to: RECIPIENT, amount: 5, idempotencyKey: 'bal-low' })).rejects.toThrow(/Insufficient USDC/)
    expect(sendTransaction).not.toHaveBeenCalled()
  })
})
