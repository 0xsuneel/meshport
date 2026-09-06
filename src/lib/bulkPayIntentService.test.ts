// src/lib/bulkPayIntentService.test.ts
//
// Regression tests for the BulkPay transaction_intent client
// (docs/BULKPAY_TRANSACTION_INTENT_IMPLEMENTATION.md Phase 3). Mocks
// ./supabase (supabase.functions.invoke + ensureAnonSession), matching
// this repo's existing vitest convention.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const invokeMock = vi.fn()
const ensureAnonSessionMock = vi.fn(async () => {})

vi.mock('./supabase', () => ({
  supabase: { functions: { invoke: invokeMock } },
  ensureAnonSession: ensureAnonSessionMock,
}))

const { createBulkPayIntent, markBulkPayAttemptSubmitted } = await import('./bulkPayIntentService')

const PARAMS = {
  walletAddress: '0x05d00ab75bcbe15450143f810cd5e5164ee126e0',
  idempotencyKey: 'idem-key-1',
  chainId: 'arc',
  amountAtomic: '24000000000000000000',
  decimals: 18,
  isNative: true,
  tokenAddress: null,
  tokenSymbol: 'USDC',
  recipientCount: 2,
  purpose: 'Payroll',
}

beforeEach(() => {
  invokeMock.mockReset()
  ensureAnonSessionMock.mockClear()
})

describe('createBulkPayIntent', () => {
  it('1/2. normal request: server nonce flows through to the caller unchanged', async () => {
    invokeMock.mockResolvedValueOnce({ data: { success: true, outcome: 'created', intentId: 'intent-1', attemptId: 'attempt-1', nonce: 42 }, error: null })
    const result = await createBulkPayIntent(PARAMS)
    expect(result.success).toBe(true)
    expect(result.nonce).toBe(42)
    expect(result.attemptId).toBe('attempt-1')
    expect(ensureAnonSessionMock).toHaveBeenCalled()
  })

  it('3. calls the bulkpay-intent function with exactly the request params as the body — no client-side nonce field ever sent', async () => {
    invokeMock.mockResolvedValueOnce({ data: { success: true, intentId: 'i', attemptId: 'a', nonce: 1 }, error: null })
    await createBulkPayIntent(PARAMS)
    expect(invokeMock).toHaveBeenCalledWith('bulkpay-intent', { body: PARAMS })
    const sentBody = invokeMock.mock.calls[0][1].body
    expect('nonce' in sentBody).toBe(false)
  })

  it('6. duplicate idempotency key surfaces the SAME intent/attempt (idempotent_replay passthrough), not an error', async () => {
    invokeMock.mockResolvedValueOnce({ data: { success: true, outcome: 'idempotent_replay', intentId: 'intent-1', attemptId: 'attempt-1' }, error: null })
    const result = await createBulkPayIntent(PARAMS)
    expect(result.success).toBe(true)
    expect(result.intentId).toBe('intent-1')
  })

  it('surfaces a server-reported error without throwing', async () => {
    invokeMock.mockResolvedValueOnce({ data: { success: false, error: 'amountAtomic must be positive' }, error: null })
    const result = await createBulkPayIntent(PARAMS)
    expect(result.success).toBe(false)
    expect(result.error).toBe('amountAtomic must be positive')
  })

  it('surfaces a network/invoke-level error without throwing', async () => {
    invokeMock.mockResolvedValueOnce({ data: null, error: { message: 'network error' } })
    const result = await createBulkPayIntent(PARAMS)
    expect(result.success).toBe(false)
    expect(result.error).toBe('network error')
  })

  it('an unexpected throw from invoke() itself is caught, never propagates', async () => {
    invokeMock.mockRejectedValueOnce(new Error('boom'))
    const result = await createBulkPayIntent(PARAMS)
    expect(result.success).toBe(false)
  })
})

describe('markBulkPayAttemptSubmitted (7. tx_hash persistence before receipt wait)', () => {
  it('sends action=markSubmitted with the attemptId and txHash', async () => {
    invokeMock.mockResolvedValueOnce({ data: { success: true }, error: null })
    const result = await markBulkPayAttemptSubmitted('attempt-1', '0xRealTxHash')
    expect(result.success).toBe(true)
    expect(invokeMock).toHaveBeenCalledWith('bulkpay-intent', { body: { action: 'markSubmitted', attemptId: 'attempt-1', txHash: '0xRealTxHash' } })
  })

  it('never throws, even on failure — safe to call fire-and-forget from the broadcast flow', async () => {
    invokeMock.mockRejectedValueOnce(new Error('network blip'))
    const result = await markBulkPayAttemptSubmitted('attempt-1', '0xRealTxHash')
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })
})
