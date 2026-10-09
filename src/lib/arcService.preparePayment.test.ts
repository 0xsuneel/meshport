import { describe, it, expect, vi, beforeEach } from 'vitest'

// preparePayment() starts a send's preflight (pay-intent reservation, gas,
// balance) at PIN entry so the send itself only has to sign + broadcast.
// Guards: a matching preflight is reused (no second pay-intent call), and a
// preflight for different payment details is never used for this one.

const SENDER = '0x1111111111111111111111111111111111111111'
const RECIPIENT = '0x2222222222222222222222222222222222222222'
const OTHER = '0x3333333333333333333333333333333333333333'

const createPayIntent = vi.fn(async (_req: { recipientAddress: string; amountAtomic: string }) =>
  ({ success: true, attemptId: 'attempt-1', nonce: 7 }))
let receipt: () => Promise<{ status: string; blockNumber: bigint }> = async () => ({ status: 'success', blockNumber: 1n })
const sendTransaction = vi.fn(async (_args: unknown) =>
  '0xabc0000000000000000000000000000000000000000000000000000000000000')

vi.mock('viem/accounts', () => ({
  // Signing is local now (relaySend): the spy records what gets signed.
  privateKeyToAccount: () => ({ address: SENDER, signTransaction: async (args: unknown) => { await sendTransaction(args); return '0x02abc0' } }),
}))

vi.mock('./arc', async () => {
  const actual = await vi.importActual<typeof import('./arc')>('./arc')
  return { ...actual, arcRpcJson: async () => ({ result: '0x3635c9adc5dea00000' }) } // 1000e18
})

vi.mock('./payIntentService', () => ({
  createPayIntent: (req: { recipientAddress: string; amountAtomic: string }) => createPayIntent(req),
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

    const res = await sendUSDC({ privateKey: '0x' + '1'.repeat(64), to: RECIPIENT, amount: 5, idempotencyKey: 'key-a' })

    expect(createPayIntent).toHaveBeenCalledTimes(1)
    expect(sendTransaction).toHaveBeenCalledTimes(1)
    expect((sendTransaction.mock.calls[0][0] as { nonce: number }).nonce).toBe(7)
    expect(res.txHash).toMatch(/^0x[0-9a-f]{64}$/) // keccak of the signed bytes, known before sending
  })

  it('ignores an early preflight made for different payment details', async () => {
    preparePayment({ token: 'USDC', from: SENDER, to: OTHER, amount: 5, idempotencyKey: 'key-b' })
    await sendUSDC({ privateKey: '0x' + '1'.repeat(64), to: RECIPIENT, amount: 5, idempotencyKey: 'key-b' })

    expect(createPayIntent).toHaveBeenCalledTimes(2)
    expect(createPayIntent.mock.calls[1][0].recipientAddress).toBe(RECIPIENT)
  })

  it('falls back to a fresh preflight when none was prepared', async () => {
    await sendUSDC({ privateKey: '0x' + '1'.repeat(64), to: RECIPIENT, amount: 2, idempotencyKey: 'key-c' })
    expect(createPayIntent).toHaveBeenCalledTimes(1)
    expect(sendTransaction).toHaveBeenCalledTimes(1)
  })
})

describe('send confirmation state', () => {
  const send = (key: string) => sendUSDC({ privateKey: '0x' + '1'.repeat(64), to: RECIPIENT, amount: 1, idempotencyKey: key })

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
