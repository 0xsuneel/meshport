import { describe, it, expect } from 'vitest'
import { tradeStepCard } from './p2pTradeStep'

const t = (status: string) => ({ status, buyerId: 'buyer', sellerId: 'seller', usdc: 10, fiat: 834, currency: 'INR' })

describe('tradeStepCard', () => {
  it('follows each step for the seller', () => {
    expect(tradeStepCard(t('awaiting_seller_confirmation'), 'seller')?.title).toBe('New order')
    expect(tradeStepCard(t('waiting_for_buyer'), 'seller')?.body).toBe('Waiting for the buyer to pay ₹834')
    expect(tradeStepCard(t('payment_sent'), 'seller')).toMatchObject({ title: 'Buyer marked paid', type: 'payment_marked_completed' })
  })
  it('follows each step for the buyer', () => {
    expect(tradeStepCard(t('awaiting_seller_confirmation'), 'buyer')?.body).toBe('Waiting for the seller to confirm')
    expect(tradeStepCard(t('waiting_for_buyer'), 'buyer')?.body).toBe('Send ₹834 to get 10 USDC')
    expect(tradeStepCard(t('payment_sent'), 'buyer')?.body).toBe('Waiting for the seller to release 10 USDC')
  })
  it('has no card once the trade is over', () => {
    for (const s of ['released', 'completed', 'cancelled', 'expired']) expect(tradeStepCard(t(s), 'buyer')).toBeNull()
  })
})

describe('tradeStepCard after a release that did not go through', () => {
  it('asks the seller to release again', () => {
    expect(tradeStepCard({ status: 'payment_sent', buyerId: 'b', sellerId: 's', usdc: 10, fiat: 950, currency: 'INR' }, 's', 'release_failed'))
      .toMatchObject({ title: "Release didn't go through", body: 'No USDC moved - release 10 USDC again' })
  })
})
