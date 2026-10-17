// Business → Cash out to bank (INR).
//
// Built on MeshPort's P2P marketplace and its escrow contract - nothing new
// on-chain. The merchant sells USDC to a buyer's "buy" ad: createTrade
// locks the USDC in escrow (signed on this device), the buyer pays rupees to
// the merchant's saved UPI / bank account, and the merchant releases the
// USDC only after the rupees arrive (releaseTrade). Cancel and dispute use
// the same P2P rules.
import {
  fetchOffers, fetchOfferConsumedAmounts, offerRemainingAmount, createTrade, fetchMyTrades, fetchTrade,
  releaseTrade, cancelTrade, canCancelTrade, openDispute, fetchMyPaymentMethods, savePaymentMethod,
  fetchTradeMessages, sendTradeMessage, subscribeToTradeMessages, subscribeToTradeUpdates, fetchUserRating,
  paymentMethodSummary, type P2POffer, type P2PTrade, type P2PPaymentMethod, type P2PMessage,
} from '@/lib/p2pService'

export const CASH_OUT_CURRENCY = 'INR'

export type BuyerOffer = { offer: P2POffer; remaining: number; rating: { avg: number; count: number } }

/** Buyers of USDC for rupees, best price first, with what each can still take. */
export async function listBuyers(myUserId: string): Promise<BuyerOffer[]> {
  const offers = await fetchOffers({ offerType: 'buy', currency: CASH_OUT_CURRENCY, excludeUserId: myUserId, limit: 50 })
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
  fetchTradeMessages, sendTradeMessage, subscribeToTradeMessages, subscribeToTradeUpdates, paymentMethodSummary,
}
export type { P2PTrade, P2PPaymentMethod, P2PMessage }

export const inr = (n: number) => '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
