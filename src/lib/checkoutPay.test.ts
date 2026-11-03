import { describe, it, expect, vi } from 'vitest'
import { decodeFunctionData, encodeAbiParameters, pad, type Hex } from 'viem'

// Order payments through MeshPortCheckout (contracts/MeshPortCheckout.sol):
// the app sends the full price to the contract with the merchant and order
// reference; merchant-pay reads the Paid event back (full price, real payer).
const CHECKOUT = '0x00000000000000000000000000000000000c0c0a'
vi.stubEnv('VITE_MESHPORT_CHECKOUT', CHECKOUT)
const { payTx } = await import('./arcService')
const { orderMemoId } = await import('./arcMemo')
const { checkoutPaid, CHECKOUT_PAID_TOPIC } = await import('../../supabase/functions/merchant-pay/checkout')

const MERCHANT = '0x1111111111111111111111111111111111111111' as Hex
const PAYER = '0x2222222222222222222222222222222222222222' as Hex
const ABI = [{ type: 'function', name: 'pay', stateMutability: 'payable', outputs: [], inputs: [{ name: 'merchant', type: 'address' }, { name: 'orderRef', type: 'bytes32' }] }] as const

describe('order payment through MeshPortCheckout', () => {
  it('an order: the full price to the contract, naming the merchant and the order; the intent names the contract', () => {
    const tx = payTx('USDC', MERCHANT, 25, { code: 'ABC123', label: 'Order #7' }) as any
    expect(tx.to).toBe(CHECKOUT)
    expect(tx.value).toBe(25n * 10n ** 18n)
    expect(tx.intentRecipient).toBe(CHECKOUT)
    expect(tx.callTarget).toBeNull()
    const { args } = decodeFunctionData({ abi: ABI, data: tx.data })
    expect(String(args[0]).toLowerCase()).toBe(MERCHANT.toLowerCase())
    expect(args[1]).toBe(orderMemoId('ABC123'))
  })

  it('no fee on plain Pay: without an order it is a normal send to the person', () => {
    const tx = payTx('USDC', MERCHANT, 25) as any
    expect(tx.to).toBe(MERCHANT)
    expect(tx.data).toBeUndefined()
  })

  it('merchant-pay reads the Paid event: the real payer, the order and the full price', () => {
    const receipt = { logs: [{
      address: CHECKOUT,
      topics: [CHECKOUT_PAID_TOPIC, pad(PAYER), pad(MERCHANT), orderMemoId('ABC123')],
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [25n * 10n ** 18n, 15n * 10n ** 16n]),
    }] }
    expect(checkoutPaid(receipt, MERCHANT, CHECKOUT)).toEqual({ payer: PAYER.toLowerCase(), orderRef: orderMemoId('ABC123'), price: 25, fee: 0.15 })
    expect(checkoutPaid(receipt, '0x3333333333333333333333333333333333333333', CHECKOUT)).toBeNull() // another merchant
    expect(checkoutPaid(receipt, MERCHANT, '0x00000000000000000000000000000000000000ff')).toBeNull() // not our contract
    expect(checkoutPaid(receipt, MERCHANT, '')).toBeNull() // not configured
  })
})
