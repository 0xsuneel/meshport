// Business → Cash out to the business's bank or payout account, in its own
// currency (any the P2P market trades - lib/localCurrency picks the default
// from the phone's region; USD when unknown).
//
// Built on MeshPort's P2P marketplace and its escrow contract - nothing new
// on-chain. The merchant sells USDC to a buyer's "buy" ad: createTrade
// locks the USDC in escrow (signed on this device), the buyer pays the local
// money to the merchant's saved account (bank, SEPA, UPI, PayPal, Wise …),
// and the merchant releases the USDC only after it arrives (releaseTrade).
// Cancel and dispute use the same P2P rules.
import {
  fetchOffers, fetchOfferConsumedAmounts, offerRemainingAmount, createTrade, fetchMyTrades, fetchTrade,
  releaseTrade, cancelTrade, canCancelTrade, openDispute, fetchMyPaymentMethods, savePaymentMethod,
  fetchTradeMessages, sendTradeMessage, subscribeToTradeMessages, subscribeToTradeUpdates, fetchUserRating,
  paymentMethodSummary, fetchCounterpartyProfiles, type P2POffer, type P2PTrade, type P2PPaymentMethod, type P2PMessage,
} from '@/lib/p2pService'

import { formatFiat } from '@/lib/currencyRegistry'

export type BuyerOffer = { offer: P2POffer; remaining: number; rating: { avg: number; count: number } }

/** Buyers of USDC for `currency`, best price first, with what each can still take. */
export async function listBuyers(myUserId: string, currency: string): Promise<BuyerOffer[]> {
  const offers = await fetchOffers({ offerType: 'buy', currency, excludeUserId: myUserId, limit: 50 })
  if (!offers.length) return []
  const [consumed, ratings, blocked] = await Promise.all([
    fetchOfferConsumedAmounts(offers.map(o => o.id)),
    Promise.all(offers.map(o => fetchUserRating(o.userId).catch(() => ({ avg: 0, count: 0 })))),
    // The escrow releases to the buyer: one USDC refuses would fail the trade.
    import('./usdcBlocklist').then(m => m.blockedAmong(offers.map(o => o.walletAddress).filter(Boolean))).catch(() => new Set<string>()),
  ])
  return offers
    .map((offer, i) => ({ offer, remaining: offerRemainingAmount(offer, consumed.get(offer.id) ?? 0), rating: ratings[i] }))
    .filter(b => b.remaining >= b.offer.minAmount && !blocked.has(String(b.offer.walletAddress ?? '').toLowerCase()))
    .sort((a, b) => b.offer.pricePerUsdc - a.offer.pricePerUsdc)
}

/** The most this buyer can take from this merchant right now. */
export const buyerMax = (b: BuyerOffer) => Math.min(b.offer.maxAmount, b.remaining)

export async function startCashOut(p: { buyer: BuyerOffer; userId: string; wallet: string; amountUsdc: number; account: P2PPaymentMethod }): Promise<P2PTrade> {
  const { trade, error } = await createTrade({
    offer: p.buyer.offer, acceptingUserId: p.userId, acceptingWallet: p.wallet, amountUsdc: p.amountUsdc,
    paymentMethodId: p.account.id, paymentMethodName: p.account.method,
  })
  if (!trade) throw new Error(error || 'Could not start the cash out')
  return trade
}

/** This user's cash outs: trades where they sold USDC into a buy ad. */
export async function listCashOuts(userId: string): Promise<P2PTrade[]> {
  const trades = await fetchMyTrades(userId)
  return trades.filter(t => t.sellerId === userId && t.offerType === 'buy')
}

export {
  fetchTrade, releaseTrade, cancelTrade, canCancelTrade, openDispute, fetchMyPaymentMethods, savePaymentMethod,
  fetchTradeMessages, sendTradeMessage, subscribeToTradeMessages, subscribeToTradeUpdates, paymentMethodSummary, fetchCounterpartyProfiles,
}
export type { P2PTrade, P2PPaymentMethod, P2PMessage }

/** Local money, e.g. "£1,240.00", "₹41,700.00", "¥5,000". */
export const fiat = (n: number, currency: string) => formatFiat(n, currency)
