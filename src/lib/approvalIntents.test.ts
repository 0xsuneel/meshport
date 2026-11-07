import { describe, it, expect } from 'vitest'
import { payIntent, transferIntent, swapIntent, bringIntent } from './approvalIntents'

describe('approval intents (docs/SECURE-APPROVALS.md)', () => {
  const BOB = '0x5555555555555555555555555555555555555555'
  it('a payment: the Arc token, the recipient, the amount in base units (Express rounding)', () => {
    expect(payIntent('USDC', BOB, 5.25)).toEqual({ kind: 'pay', token: '0x3600000000000000000000000000000000000000', to: BOB, amount: '5250000' })
    expect(payIntent('cirBTC', BOB, 0.0001)?.amount).toBe('10000')
    expect(payIntent('USDC', 'bob.arc', 1)).toBeUndefined()
    expect(payIntent('USDC', BOB, 0)).toBeUndefined()
  })
  it('a transfer: the CCTP domain of the chain and the recipient', () => {
    expect(transferIntent('Ethereum_Sepolia', BOB, 10)).toEqual({ kind: 'transfer', amount: '10000000', destinationDomain: 0, recipient: BOB })
    expect(transferIntent('Base_Sepolia', BOB, 1)?.destinationDomain).toBe(6)
    expect(transferIntent('Nowhere', BOB, 1)).toBeUndefined()
  })
  it('a swap and a Bring', () => {
    expect(swapIntent('EURC', 2)).toEqual({ kind: 'swap', tokenIn: '0x89b50855aa3be2f677cd6303cec089b5f319d72a', amount: '2000000' })
    expect(bringIntent('Base_Sepolia', 3)).toEqual({ kind: 'bring', chainId: 84532, amount: '3000000' })
    expect(bringIntent(null, 3)).toBeUndefined()
  })
})
