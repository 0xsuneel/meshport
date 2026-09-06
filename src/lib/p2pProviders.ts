// lib/p2pProviders.ts
//
// Every provider interface the P2P module depends on, all in one place, so
// it's unambiguous exactly what a real integration would need to implement
// later. No UI component in features/p2p/ should ever contain payment,
// escrow, FX, or fiat-processing logic directly — it calls one of these
// providers and renders the result. That's the actual mechanism behind
// "swap the provider, not the UI": every provider here is a plain object
// implementing an interface, exported as a single swappable const at the
// bottom of its section. Changing providers later means changing one line
// per section in this file — nothing in features/p2p/ needs to know.

import type { P2PTrade } from './p2pService'

// ── ExchangeRateProvider ─────────────────────────────────────────────────────
// Suggests a fair market price when a user is creating an offer — never
// used to silently override what a user actually typed. This is advisory
// data for the Create Offer screen's "suggested price" hint, not something
// that controls trade execution.
export interface ExchangeRateProvider {
  /** USDC is treated as 1:1 USD for rate-conversion purposes — same assumption every real USDC-based product makes. */
  getRate(currencyCode: string): Promise<number>
  getRates(currencyCodes: string[]): Promise<Record<string, number>>
}

// Static, illustrative-only rates — NOT live market data, and never
// presented as such anywhere in the UI (every screen using this labels the
// suggestion "Demo rate" or similar). Real integration later: implement
// this interface against a real FX API (exchangerate.host, Open Exchange
// Rates, etc.) and swap MOCK_EXCHANGE_RATE_PROVIDER below for it — nothing
// else in this codebase changes.
const MOCK_RATES: Record<string, number> = {
  USD: 1, EUR: 0.92, GBP: 0.79, INR: 83.2, PKR: 278.5, AED: 3.67, SAR: 3.75,
  JPY: 149.8, CNY: 7.24, SGD: 1.34, AUD: 1.52, CAD: 1.36, CHF: 0.88, TRY: 32.1,
  BRL: 5.02, NGN: 1550, ZAR: 18.7, PHP: 56.4, MYR: 4.68, THB: 35.9, IDR: 15750,
}

const MOCK_EXCHANGE_RATE_PROVIDER: ExchangeRateProvider = {
  async getRate(currencyCode) {
    // Tiny artificial delay so a "fetching rate…" state in the UI is
    // exercised the same way it would be against a real network call —
    // catches a component that forgot to handle the loading state, rather
    // than that bug only surfacing once a real, slower API is wired in.
    await new Promise(r => setTimeout(r, 150))
    return MOCK_RATES[currencyCode] ?? 1
  },
  async getRates(currencyCodes) {
    await new Promise(r => setTimeout(r, 150))
    const out: Record<string, number> = {}
    for (const code of currencyCodes) out[code] = MOCK_RATES[code] ?? 1
    return out
  },
}

export const exchangeRateProvider: ExchangeRateProvider = MOCK_EXCHANGE_RATE_PROVIDER

// ── EscrowProvider ───────────────────────────────────────────────────────────
// Distinct from PaymentProvider below on purpose: PaymentProvider is about
// the FIAT side (did the buyer pay — always fake here, no real fiat exists
// to check). EscrowProvider is about the USDC side — holding it during a
// trade and releasing it to the buyer once the seller confirms. Splitting
// these matters because a real integration would very plausibly replace
// them independently: a real FX/payment API is one project, an actual
// escrow smart contract is a completely separate one, and they'd land at
// different times.
//
// ── Update: now backed by a real deployed contract (contracts/P2PEscrow.sol) ──
// Every completed trade is escrow-backed now, not just sell-offer ones:
//
//   SELL offers  — escrow deposited ONCE at offer creation (depositForOffer),
//                  keyed by the offer's own id. One running balance a trade
//                  draws a partial amount from; cancelling a single trade
//                  correctly leaves that capacity for the next trade against
//                  the same offer (refund() is a genuine no-op here).
//
//   BUY offers   — the offer's CREATOR wants to receive USDC; they hold none
//                  to escrow up front. Whoever ACCEPTS a buy offer becomes
//                  the seller for that specific trade, and THEY deposit —
//                  at trade-acceptance time (depositForTrade), keyed by the
//                  TRADE's own id, since a different seller accepts the same
//                  buy offer each time. Cancelling here genuinely does need
//                  to move funds — refund() actually withdraws the deposit
//                  back to whichever seller made it, since there's no
//                  "next trade" sharing this specific escrow bucket.
//
// Same deployed contract handles both — release()/refund() below check
// trade.offerType to decide which bucket key and which behavior applies.
export interface EscrowProvider {
  /**
   * Seller deposits USDC for their SELL offer, up front. Called from
   * createOffer() in p2pService.ts BEFORE the offer row is ever inserted —
   * if this fails, no offer gets created at all.
   */
  depositForOffer(offerId: string, amountUsdc: number): Promise<{ success: boolean; txHash?: string; message: string }>
  /**
   * The seller-for-this-trade deposits USDC for a BUY offer's trade, at
   * acceptance time. Called from createTrade() in p2pService.ts BEFORE the
   * trade row is ever inserted — if this fails, no trade gets created,
   * exactly the same "cannot exist without a successful deposit" guarantee
   * sell offers already have, just at a different point in the flow.
   */
  depositForTrade(tradeId: string, amountUsdc: number): Promise<{ success: boolean; txHash?: string; message: string }>
  /**
   * Called when a trade starts. Funds are already locked by this point
   * either way (offer-deposit for sell, trade-deposit for buy, both
   * already done before the trade row exists) — genuinely nothing further
   * to do here for either case.
   */
  lockFunds(trade: P2PTrade): Promise<{ success: boolean; message: string }>
  /** Called when the seller releases. Routes to the correct escrow bucket based on trade.offerType — see file header. */
  release(trade: P2PTrade): Promise<{ success: boolean; txHash?: string; message: string }>
  /**
   * Called when a single TRADE is cancelled/expires. For a SELL-offer
   * trade: correctly a no-op (funds stay in the offer's shared bucket for
   * the next trade). For a BUY-offer trade: actually withdraws the
   * trade-specific deposit back to the seller who made it, since nothing
   * else will ever draw from that specific bucket again.
   */
  refund(trade: P2PTrade): Promise<{ success: boolean; txHash?: string; message: string }>
}

const RealContractEscrowProvider: EscrowProvider = {
  async depositForOffer(offerId, amountUsdc) {
    try {
      const { useAuthStore } = await import('../store')
      const { privateKey } = useAuthStore.getState()
      if (!privateKey) return { success: false, message: "Couldn't access your wallet on this device to deposit escrow." }
      const { depositToEscrow } = await import('./p2pEscrowContract')
      const txHash = await depositToEscrow(privateKey, offerId, amountUsdc)
      return { success: true, txHash, message: 'Escrow deposit confirmed on-chain.' }
    } catch (e: any) {
      return { success: false, message: e?.message ?? 'Escrow deposit failed — please try again.' }
    }
  },
  async depositForTrade(tradeId, amountUsdc) {
    try {
      const { useAuthStore } = await import('../store')
      const { privateKey } = useAuthStore.getState()
      if (!privateKey) return { success: false, message: "Couldn't access your wallet on this device to deposit escrow." }
      const { depositForTrade } = await import('./p2pEscrowContract')
      const txHash = await depositForTrade(privateKey, tradeId, amountUsdc)
      return { success: true, txHash, message: 'Escrow deposit confirmed on-chain.' }
    } catch (e: any) {
      return { success: false, message: e?.message ?? 'Escrow deposit failed — please try again.' }
    }
  },
  async lockFunds(_trade) {
    return { success: true, message: 'Funds already held in escrow contract.' }
  },
  async release(trade) {
    try {
      const { useAuthStore } = await import('../store')
      const { privateKey } = useAuthStore.getState()
      if (!privateKey) return { success: false, message: "Couldn't access your wallet on this device to release funds." }
      if (trade.offerType === 'buy') {
        const { releaseTradeKeyedEscrow } = await import('./p2pEscrowContract')
        const txHash = await releaseTradeKeyedEscrow(privateKey, trade.id, trade.buyerWallet, trade.amountUsdc)
        return { success: true, txHash, message: 'USDC released from escrow to buyer.' }
      }
      const { releaseFromEscrow } = await import('./p2pEscrowContract')
      const txHash = await releaseFromEscrow(privateKey, trade.offerId, trade.id, trade.buyerWallet, trade.amountUsdc)
      return { success: true, txHash, message: 'USDC released from escrow to buyer.' }
    } catch (e: any) {
      return { success: false, message: e?.message ?? 'Release failed — please try again.' }
    }
  },
  async refund(trade) {
    if (trade.offerType !== 'buy') {
      // Sell-offer trade — correctly a no-op, see interface doc comment.
      return { success: true, message: 'Trade cancelled — funds remain in escrow for the next trade against this offer.' }
    }
    // Buy-offer trade — the seller-for-this-trade's deposit genuinely needs
    // to move back to them; nothing else will ever draw from this specific
    // trade-keyed bucket.
    try {
      const { useAuthStore } = await import('../store')
      const { privateKey } = useAuthStore.getState()
      // Whoever is cancelling might be the buyer OR the seller (both sides
      // can cancel — see P2PPage.tsx's handleCancel) — but only the actual
      // depositor's wallet can call withdrawRemaining on their own bucket
      // (the contract checks msg.sender == seller || admin). If the buyer
      // is the one cancelling, THIS DEVICE's key won't be the depositor's,
      // so the call would revert — that's correct/expected; a from-a-
      // different-account refund attempt should fail here, not silently
      // succeed. The seller (or an admin) refunding is the actual path
      // this needs to work reliably.
      if (!privateKey) return { success: false, message: "Couldn't access a wallet on this device to process the refund." }
      const { refundTradeKeyedEscrow } = await import('./p2pEscrowContract')
      const txHash = await refundTradeKeyedEscrow(privateKey, trade.id)
      return { success: true, txHash, message: 'Escrowed USDC refunded to the seller.' }
    } catch (e: any) {
      // Genuinely non-fatal from the caller's point of view — cancelTrade()
      // in p2pService.ts still marks the trade cancelled either way; a
      // refund that can't complete right now (e.g. this device belongs to
      // the buyer, not the depositing seller) just means the seller
      // reclaims it later some other way, not that cancellation itself
      // should fail.
      return { success: false, message: e?.message ?? 'Refund could not be processed automatically — the seller may need to reclaim escrowed funds separately.' }
    }
  },
}

// Fallback used only if VITE_P2P_ESCROW_CONTRACT isn't configured — the
// previous honor-system behavior, kept as a working fallback rather than
// breaking the app outright if the contract hasn't been deployed yet, but
// EVERY message here says so explicitly. Nothing silently pretends to be
// real escrow when it isn't.
const HonorSystemFallbackEscrowProvider: EscrowProvider = {
  async depositForOffer(_offerId, _amountUsdc) {
    return { success: true, message: 'Escrow contract not configured — offer created without an on-chain deposit (honor system).' }
  },
  async depositForTrade(_tradeId, _amountUsdc) {
    return { success: true, message: 'Escrow contract not configured — trade created without an on-chain deposit (honor system).' }
  },
  async lockFunds(_trade) {
    return { success: true, message: 'Funds reserved (no escrow contract configured — not actually locked on-chain).' }
  },
  async release(trade) {
    try {
      const { sendUSDC } = await import('./arcService')
      const { useAuthStore } = await import('../store')
      const { privateKey } = useAuthStore.getState()
      if (!privateKey) return { success: false, message: "Couldn't access your wallet on this device to release funds." }
      const result = await sendUSDC({ privateKey, to: trade.buyerWallet, amount: trade.amountUsdc })
      return { success: true, txHash: result.txHash, message: 'USDC sent directly to buyer (no escrow contract configured).' }
    } catch (e: any) {
      return { success: false, message: e?.message ?? 'Release failed — please try again.' }
    }
  },
  async refund(_trade) {
    return { success: true, message: 'Trade cancelled — no escrow contract configured, nothing was held.' }
  },
}

// ─────────────────────────────────────────────────────────────────────────
// isEscrowPaused() safely returns false if no contract is configured (see
// its own doc comment in p2pEscrowContract.ts), so this guard is always
// safe to call — it's a genuine no-op in honor-system mode, and a real
// on-chain check when a contract is deployed.
//
// THE BUG THIS FIXES: every deposit/release/refund call used to go
// straight to isEscrowContractDeployed() ? Real : HonorSystemFallback with
// no pause check anywhere in between. For the real contract, pausing still
// "worked" in the sense that the on-chain transaction itself would revert
// (deposit/release/withdrawRemaining are all `whenNotPaused` in
// contracts/P2PEscrow.sol) — but only AFTER a signed transaction was sent,
// producing a raw contract-revert error rather than a clean message, and
// only for the real-contract path. In honor-system mode (no contract
// deployed), "Emergency Pause Escrow" did *nothing at all* — the honor
// system doesn't touch the chain, so it never had any way to know it was
// supposed to stop. This guard fixes both: same clean, immediate rejection
// message either way, and honor-system mode now actually respects the
// pause switch for the first time.
async function assertNotPaused(): Promise<{ success: false; message: string } | null> {
  const { isEscrowPaused } = await import('./p2pEscrowContract')
  if (await isEscrowPaused().catch(() => false)) {
    return { success: false, message: 'P2P escrow is currently paused by an admin. Please try again shortly.' }
  }
  return null
}

export const escrowProvider: EscrowProvider = {
  async depositForOffer(offerId, amountUsdc) {
    const blocked = await assertNotPaused(); if (blocked) return blocked
    const { isEscrowContractDeployed } = await import('./p2pEscrowContract')
    return (isEscrowContractDeployed() ? RealContractEscrowProvider : HonorSystemFallbackEscrowProvider).depositForOffer(offerId, amountUsdc)
  },
  async depositForTrade(tradeId, amountUsdc) {
    const blocked = await assertNotPaused(); if (blocked) return blocked
    const { isEscrowContractDeployed } = await import('./p2pEscrowContract')
    return (isEscrowContractDeployed() ? RealContractEscrowProvider : HonorSystemFallbackEscrowProvider).depositForTrade(tradeId, amountUsdc)
  },
  async lockFunds(trade) {
    // Not gated — this is only ever a DB-level "reserved" message in both
    // providers, never a real fund movement, so there's nothing for a
    // pause to actually protect against here.
    const { isEscrowContractDeployed } = await import('./p2pEscrowContract')
    return (isEscrowContractDeployed() ? RealContractEscrowProvider : HonorSystemFallbackEscrowProvider).lockFunds(trade)
  },
  async release(trade) {
    const blocked = await assertNotPaused(); if (blocked) return blocked
    const { isEscrowContractDeployed } = await import('./p2pEscrowContract')
    return (isEscrowContractDeployed() ? RealContractEscrowProvider : HonorSystemFallbackEscrowProvider).release(trade)
  },
  async refund(trade) {
    // Matches contracts/P2PEscrow.sol exactly — withdrawRemaining is also
    // `whenNotPaused` on-chain, so refunds are blocked during a pause too,
    // not just deposits/releases.
    const blocked = await assertNotPaused(); if (blocked) return blocked
    const { isEscrowContractDeployed } = await import('./p2pEscrowContract')
    return (isEscrowContractDeployed() ? RealContractEscrowProvider : HonorSystemFallbackEscrowProvider).refund(trade)
  },
}

// ── PaymentProvider ──────────────────────────────────────────────────────────
// The FIAT confirmation side specifically — "did the buyer actually pay."
export interface PaymentProvider {
  confirmPayment(trade: P2PTrade): Promise<{ success: boolean; message: string }>
}

const DemoPaymentProvider: PaymentProvider = {
  async confirmPayment(_trade) {
    // No real payment gateway exists to call here — intentionally the
    // entire implementation for the demo. A real provider would call out
    // to whatever confirms actual fiat receipt (a bank webhook, a payment
    // processor's API) before returning success.
    return { success: true, message: 'Demo payment completed. No real money has been transferred.' }
  },
}

export const paymentProvider: PaymentProvider = DemoPaymentProvider

// ── FiatProvider ─────────────────────────────────────────────────────────────
// Separate from PaymentProvider on purpose: PaymentProvider answers "did
// this specific trade's payment happen" (a yes/no per trade). FiatProvider
// is the lower-level thing a real PaymentProvider implementation would
// itself be built on — actually moving money via a specific rail (a bank
// transfer API, a card processor, a specific regional payment method).
// Kept as its own interface so a real integration has an obvious seam:
// implement FiatProvider for each real payment method Merchant Mode
// eventually needs to support, without needing to touch PaymentProvider's
// per-trade confirmation logic at all.
export interface FiatProvider {
  name: string
  processPayment(params: { amount: number; currency: string; method: string }): Promise<{ success: boolean; reference?: string; message: string }>
}

const DemoFiatProvider: FiatProvider = {
  name: 'Demo Fiat Rail',
  async processPayment({ amount, currency, method }) {
    // Deliberately slow enough to be visibly a "processing" state in the
    // UI (see the processing animation on the trade screen) — this is the
    // one place in the whole module that intentionally takes a few
    // seconds, specifically to make the demo experience read as "a real
    // payment rail is doing something" rather than an instant, obviously
    // fake flip. No real money moves regardless of how long this takes.
    await new Promise(r => setTimeout(r, 2200))
    return { success: true, reference: `DEMO-${Date.now().toString(36).toUpperCase()}`, message: `Simulated ${method} payment of ${amount} ${currency} processed.` }
  },
}

export const fiatProvider: FiatProvider = DemoFiatProvider
