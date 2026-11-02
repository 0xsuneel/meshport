import { describe, it, expect, vi, beforeEach } from 'vitest'

// A Google / email (Circle) wallet's signing request is prepared while the PIN
// is typed (preparePayment → signer.prepareTransaction). It only helps if it is
// EXACTLY the transaction the send then signs - checked here - and it is only
// asked for a Circle wallet that is signed in and unlocked.

const SENDER = '0x1111111111111111111111111111111111111111'
const RECIPIENT = '0x2222222222222222222222222222222222222222'

const prepared: unknown[] = []
const signed: unknown[] = []
const circleSigner = {
  address: SENDER, circleWallet: true,
  prepareTransaction: (tx: unknown) => { prepared.push(tx) },
  signTransaction: async (tx: unknown) => { signed.push(tx); return '0x02abc0' },
} as any
const auth = { signer: circleSigner as any, walletSource: 'circle' as string, isLocked: false, walletAddress: SENDER }
vi.mock('@/store', () => ({ useAuthStore: { getState: () => auth } }))
vi.mock('@/wallet/circle', () => ({ isCircleAccount: (v: any) => v?.circleWallet === true }))
vi.mock('./payIntentService', () => ({
  createPayIntent: async () => ({ success: true, attemptId: 'attempt-1', nonce: 7 }),
  markPayAttemptSubmitted: () => Promise.resolve(),
}))
vi.mock('./arc', async () => {
  const actual = await vi.importActual<typeof import('./arc')>('./arc')
  return { ...actual, arcRpcJson: async (body: { method: string }) => {
    if (body.method === 'eth_gasPrice') return { result: '0x3b9aca00' } // 1 gwei
    if (body.method === 'meshport_sendRawTransactionAndWait') return { result: { hash: '0x' + 'ab'.repeat(32), status: 'success', blockNumber: '0x1' } }
    return { result: '0x3635c9adc5dea00000' }
  } }
})
vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem')
  return { ...actual, createPublicClient: () => ({ estimateGas: async () => 21000n, getGasPrice: async () => 1_000_000_000n, getTransactionReceipt: async () => ({ status: 'success', blockNumber: 1n }) }) }
})

const { preparePayment, sendUSDC, sendEURC } = await import('./arcService')
const settle = () => new Promise(r => setTimeout(r, 20))

describe('Circle wallet: the signing request prepared during the PIN', () => {
  beforeEach(() => { prepared.length = 0; signed.length = 0; Object.assign(auth, { signer: circleSigner, walletSource: 'circle', isLocked: false }) })

  it('USDC: the prepared transaction is exactly the one signed after the PIN', async () => {
    preparePayment({ token: 'USDC', from: SENDER, to: RECIPIENT, amount: 5, idempotencyKey: 'k-usdc' })
    await settle()
    expect(prepared.length).toBe(1)
    await sendUSDC({ signer: circleSigner, to: RECIPIENT, amount: 5, idempotencyKey: 'k-usdc' })
    expect(signed.length).toBe(1)
    expect(signed[0]).toEqual(prepared[0])
  })

  it('EURC: the same', async () => {
    preparePayment({ token: 'EURC', from: SENDER, to: RECIPIENT, amount: 3, idempotencyKey: 'k-eurc' })
    await settle()
    await sendEURC({ signer: circleSigner, to: RECIPIENT, amount: 3, idempotencyKey: 'k-eurc' })
    expect(prepared.length).toBe(1)
    expect(signed[0]).toEqual(prepared[0])
  })

  it('not asked for a private-key wallet, a locked app, or another account', async () => {
    auth.walletSource = 'create'
    preparePayment({ token: 'USDC', from: SENDER, to: RECIPIENT, amount: 1, idempotencyKey: 'k-1' })
    auth.walletSource = 'circle'; auth.isLocked = true
    preparePayment({ token: 'USDC', from: SENDER, to: RECIPIENT, amount: 1, idempotencyKey: 'k-2' })
    auth.isLocked = false; auth.signer = { ...circleSigner, address: '0x9999999999999999999999999999999999999999' }
    preparePayment({ token: 'USDC', from: SENDER, to: RECIPIENT, amount: 1, idempotencyKey: 'k-3' })
    await settle()
    expect(prepared).toEqual([])
  })
})
