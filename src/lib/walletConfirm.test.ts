// The app and the wallet agree on what a confirmed payment is: the intent
// built for the wallet (payConfirmIntent) is what the wallet accepts
// (wallet-frame/src/intent.ts) and the transaction Pay signs carries its ticket.
import { describe, it, expect, vi } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

vi.mock('@/lib/accountLockRule', () => ({ assertAccountUnlocked: () => {} }))
vi.mock('./perfTrace', () => ({ span: () => () => 0, reportPayment: () => {} }))

const key = privateKeyToAccount(generatePrivateKey())
const seen: any[] = []
vi.mock('@/wallet/frameClient', () => ({
  callWallet: async (method: string, params: any) => {
    seen.push({ method, params })
    if (method === 'sign:transaction') return { serialized: await key.signTransaction(params.transaction) }
    throw new Error('unexpected ' + method)
  },
  WalletFrameError: class extends Error {},
  walletOrigin: () => 'http://localhost:5174',
}))

const { payConfirmIntent } = await import('./walletConfirm')
const { parseIntent, matchesIntent } = await import('../../wallet-frame/src/intent')
const { ARC_MEMO_CONTRACT } = await import('./arcMemo')
const to = privateKeyToAccount(generatePrivateKey()).address

describe('payConfirmIntent', () => {
  it('USDC, EURC, cirBTC and an order: the wallet accepts each and reads the same recipient', async () => {
    for (const [token, memo] of [['USDC', null], ['EURC', null], ['cirBTC', null], ['USDC', { code: 'ab12cd', label: 'Order #7' }]] as const) {
      const intent = await payConfirmIntent(token, to, 1.25, memo)
      expect(intent, token).not.toBeNull()
      expect(() => parseIntent(intent)).not.toThrow()
    }
    const order = (await payConfirmIntent('USDC', to, 1.25, { code: 'ab12cd', label: 'Order #7' }))!
    expect(order.to.toLowerCase()).toBe(ARC_MEMO_CONTRACT.toLowerCase())
    expect(await payConfirmIntent('USDC', 'ravi.arc', 1)).toBeNull()
    expect(await payConfirmIntent('USDC', to, 0)).toBeNull()
  }, 30_000) // loads arcService (slow under a parallel run)

  it('matches the transaction Pay signs (arcService signingTx shape)', async () => {
    const intent = parseIntent(await payConfirmIntent('USDC', to, 1.25))
    const { payTx } = await import('./arcService')
    const tx = payTx('USDC', to, 1.25)
    const signing = { type: 'eip1559', chainId: 5042002, to: tx.to, value: tx.value ?? 0n, data: tx.data, gas: 25_200n, nonce: 4, maxFeePerGas: 60_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }
    expect(matchesIntent(intent, signing)).toBe(true)
  })
})

describe('a confirmed transaction carries its ticket', () => {
  it('the bound transaction is sent with `confirmation`, once; others without', async () => {
    const { walletAccount, bindConfirmation } = await import('@/wallet/account')
    const account = walletAccount(key.address)
    const intent = (await payConfirmIntent('USDC', to, 2))!
    bindConfirmation(key.address, intent, '0xabc')
    const tx = { type: 'eip1559' as const, chainId: 5042002, to: intent.to as `0x${string}`, value: BigInt(intent.value), gas: 25_200n, nonce: 1, maxFeePerGas: 60_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }
    seen.length = 0
    await account.signTransaction(tx)
    await account.signTransaction(tx)
    await account.signTransaction({ ...tx, value: 1n })
    expect(seen.map(s => s.params.confirmation)).toEqual(['0xabc', undefined, undefined])
  })
})

describe('the wallet-confirmed token', () => {
  it('passes the passcode check only when this page issued it, and never reaches the frame as a passcode', async () => {
    const { issueWalletConfirmToken, isWalletConfirmToken } = await import('./walletConfirmToken')
    const { verifyPasscode, FRAME_PASSCODE } = await import('./security')
    const token = issueWalletConfirmToken('0x01')
    expect(isWalletConfirmToken(token)).toBe(true)
    expect(await verifyPasscode(token, FRAME_PASSCODE)).toBe(true)
    expect(await verifyPasscode('wallet-confirmed:0xforged', FRAME_PASSCODE)).toBe(false)
    expect(seen.some(s => s.method === 'approve')).toBe(false)
  })
})
