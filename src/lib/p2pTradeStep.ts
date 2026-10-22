// lib/p2pTradeStep.ts
//
// Where a P2P trade is right now, for its Home card (OrderTicker): the card
// follows the trade step by step instead of repeating the notification that
// created it, and goes away once the trade is over.

export type TradeLive = { status: string; buyerId: string; sellerId: string; usdc: number; fiat: number; currency: string }

/** A trade's step right now, for its Home card: the title, the line under
 *  it and the card's look (`type` picks the icon and colour). null once the
 *  trade is over (the card hides) or for a state with nothing to do. */
export function tradeStepCard(t: TradeLive, me: string):
  { title: string; body: string; type: string } | null {
  const seller = t.sellerId === me
  const usdc = `${t.usdc.toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC`
  const fiat = t.fiat ? `${t.currency === 'INR' ? '₹' : ''}${t.fiat.toLocaleString('en-IN', { maximumFractionDigits: 2 })}${t.currency && t.currency !== 'INR' ? ` ${t.currency}` : ''}` : ''
  switch (t.status) {
    case 'awaiting_seller_confirmation':
      return seller ? { title: 'New order', body: `Confirm to sell ${usdc}`, type: 'buy_order_placed' }
        : { title: 'Order placed', body: 'Waiting for the seller to confirm', type: 'sell_order_placed' }
    case 'waiting_for_buyer':
      return seller ? { title: 'Order confirmed', body: `Waiting for the buyer to pay${fiat ? ` ${fiat}` : ''}`, type: 'seller_confirmed' }
        : { title: 'Pay now', body: `Send ${fiat || 'the payment'} to get ${usdc}`, type: 'seller_confirmed' }
    case 'payment_sent':
      return seller ? { title: 'Buyer marked paid', body: `Check your bank${fiat ? ` for ${fiat}` : ''} and release ${usdc}`, type: 'payment_marked_completed' }
        : { title: 'Payment marked', body: `Waiting for the seller to release ${usdc}`, type: 'payment_marked_completed' }
    default:
      return null
  }
}

