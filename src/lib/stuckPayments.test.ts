import { describe, it, expect, vi, beforeEach } from 'vitest'

const sent: { method: string; params: any[] }[] = []
let landed = new Set<string>()
vi.mock('./arc', () => ({
  arcRpcJson: async (body: { method: string; params: any[] }) => {
    sent.push(body)
    if (body.method === 'eth_estimateGas') return { result: '0x5208' }
    if (body.method === 'eth_getTransactionReceipt') return { result: landed.has(body.params[0]) ? { status: '0x1' } : null }
    return { result: { status: 'pending' } }
  },
}))
vi.mock('./arcService', () => ({ ARC_CHAIN_INLINE: { id: 5042002 } }))

import { keccak256 } from 'viem'
import { cancelStuckPayments } from './stuckPayments'

const self = '0x1111111111111111111111111111111111111111'
const signedNonces: number[] = []
const account = {
  address: self,
  signTransaction: async (tx: any) => {
    signedNonces.push(tx.nonce)
    expect(tx.to).toBe(self)
    expect(tx.value).toBe(0n)
    return `0x${tx.nonce.toString(16).padStart(4, '0')}` as `0x${string}`
  },
} as any
const stuck = { chainNonce: 10, stuck: [11, 12, 13, 14].map(nonce => ({ nonce, txHash: `0xpay${nonce}` })) }
const relayed = () => sent.filter(s => s.method === 'meshport_sendRawTransactionAndWait').map(s => s.params[0] as string)

describe('cancelStuckPayments', () => {
  beforeEach(() => { sent.length = 0; signedNonces.length = 0; landed = new Set() })

  it('signs a 0 USDC self-transfer for the gap and every queued nonce', async () => {
    for (let n = 10; n <= 14; n++) landed.add(keccak256(`0x${n.toString(16).padStart(4, '0')}`))
    const out = await cancelStuckPayments(account, stuck)
    expect(signedNonces).toEqual([10, 11, 12, 13, 14])
    expect(out).toEqual({ 11: 'cancelled', 12: 'cancelled', 13: 'cancelled', 14: 'cancelled' })
  })

  it('the missing nonce is sent last - only after every replacement', async () => {
    for (let n = 10; n <= 14; n++) landed.add(keccak256(`0x${n.toString(16).padStart(4, '0')}`))
    await cancelStuckPayments(account, stuck)
    const order = relayed()
    expect(order[order.length - 1]).toBe('0x000a')
    expect(order.filter(r => r === '0x000a')).toHaveLength(1)
    expect(order.slice(0, -1).every(r => r !== '0x000a')).toBe(true)
  })

  it('says so when a payment went through instead', async () => {
    for (let n = 10; n <= 13; n++) landed.add(keccak256(`0x${n.toString(16).padStart(4, '0')}`))
    landed.add('0xpay14')
    const out = await cancelStuckPayments(account, stuck)
    expect(out[14]).toBe('ran')
    expect(out[11]).toBe('cancelled')
  })
})
