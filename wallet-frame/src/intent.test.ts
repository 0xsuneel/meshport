// What the wallet shows for a payment comes from the transaction itself -
// built here with the app's own encoders (lib/arcMemo, the ERC-20 transfer).
import { describe, it, expect } from 'vitest'
import { encodeFunctionData, erc20Abi, parseUnits } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { parseIntent, describeIntent, matchesIntent, MAX_CONFIRM_FEE } from './intent'
import { ARC_MEMO_CONTRACT, memoTransferData, checkoutPayData } from '@/lib/arcMemo'

const ARC = 5042002
const merchant = privateKeyToAccount(generatePrivateKey()).address
const EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a'
const CHECKOUT = '0x1111111111111111111111111111111111111111'
const intent = (o: Record<string, unknown>) => parseIntent({ chainId: ARC, value: '0', data: '0x', maxFee: '50000000000000000', ...o })

describe('describeIntent', () => {
  it('a plain USDC send: amount from the value (18 decimals), recipient from `to`', () => {
    const v = describeIntent(intent({ to: merchant, value: '12340000000000000000' }))
    expect(v).toMatchObject({ action: 'Send', amount: '12.34', token: 'USDC', to: merchant, warnings: [] })
    expect(v.rows).toEqual([{ label: 'Network fee', value: 'at most 0.05 USDC' }])
  })

  it('an EURC transfer: the recipient and amount inside the call, not the token contract', () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [merchant, parseUnits('7.5', 6)] })
    expect(describeIntent(intent({ to: EURC, data }))).toMatchObject({ action: 'Send', amount: '7.5', token: 'EURC', to: merchant, warnings: [] })
  })

  it('an order through the Memo contract: the merchant, amount and order number', () => {
    const data = memoTransferData(merchant, 19.99, { code: 'ab12cd', label: 'Order #1042' })
    const v = describeIntent(intent({ to: ARC_MEMO_CONTRACT, data }))
    expect(v).toMatchObject({ action: 'Pay order', amount: '19.99', token: 'USDC', to: merchant, warnings: [] })
    expect(v.rows[0]).toEqual({ label: 'Order', value: 'Order #1042' })
  })

  it('an order through MeshPortCheckout: named only when it is the known contract', () => {
    const data = checkoutPayData(merchant, { code: 'ab12cd' })
    const known = describeIntent(intent({ to: CHECKOUT, data, value: '5000000000000000000' }), { checkout: CHECKOUT })
    expect(known).toMatchObject({ action: 'Pay order', amount: '5', to: merchant, warnings: [] })
    expect(describeIntent(intent({ to: CHECKOUT, data, value: '5000000000000000000' })).warnings).toHaveLength(1)
  })

  it('anything else is a contract call with a warning, never a friendly summary', () => {
    const v = describeIntent(intent({ to: merchant, data: '0xdeadbeef' }))
    expect(v.action).toBe('Contract call')
    expect(v.warnings).toHaveLength(1)
    const approve = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [merchant, 10n ** 30n] })
    expect(describeIntent(intent({ to: EURC, data: approve })).action).toBe('Contract call')
  })
})

describe('parseIntent', () => {
  it('Arc only, a real address, a fee limit of at most 0.1 USDC', () => {
    expect(() => intent({ to: merchant, chainId: 1 })).toThrow()
    expect(() => intent({ to: 'ravi.arc' })).toThrow()
    expect(() => intent({ to: merchant, maxFee: String(MAX_CONFIRM_FEE + 1n) })).toThrow()
    expect(() => intent({ to: merchant, value: '-1' })).toThrow()
    expect(() => intent({ to: merchant, data: '0xzz' })).toThrow()
  })
})

describe('matchesIntent', () => {
  const i = intent({ to: merchant, value: '1000000000000000000' })
  const tx = { type: 'eip1559', chainId: ARC, nonce: 3, to: merchant.toLowerCase(), value: 10n ** 18n, gas: 25_200n, maxFeePerGas: 60_000_000_000n }
  it('nonce and gas are free; chain, recipient, value and data are not; the fee is capped', () => {
    expect(matchesIntent(i, tx)).toBe(true)
    expect(matchesIntent(i, { ...tx, nonce: 99 })).toBe(true)
    expect(matchesIntent(i, { ...tx, chainId: 1 })).toBe(false)
    expect(matchesIntent(i, { ...tx, value: 10n ** 18n + 1n })).toBe(false)
    expect(matchesIntent(i, { ...tx, data: '0x00' })).toBe(false)
    expect(matchesIntent(i, { ...tx, gas: 10n ** 9n })).toBe(false)
    expect(matchesIntent(i, { ...tx, authorizationList: [] })).toBe(false)
    expect(matchesIntent(i, { ...tx, type: 'eip7702' })).toBe(false)
  })
})
