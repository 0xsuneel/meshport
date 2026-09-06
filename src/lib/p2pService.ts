// lib/p2pService.ts
//
// P2P Marketplace — TESTNET DEMO ONLY. See lib/p2pProviders.ts for the full
// explanation of what's real (testnet USDC transfers via EscrowProvider) vs
// simulated (every fiat/payment step, via PaymentProvider/FiatProvider).
// "Payment confirmed" is purely a status flag the buyer sets on the honor
// system, exactly as the demo spec requires.
//
// This file is the data/business-logic layer: offers, trades, chat,
// reputation, fraud protection, notifications, and admin actions. UI
// components (features/p2p/) call these functions and render results —
// they should never talk to Supabase or a provider directly.

import { supabase } from './supabase'
import { authHeaders, subscribeWithRetry } from './chatService'
import { escrowProvider, paymentProvider } from './p2pProviders'
import { CURRENCY_REGISTRY, currencySymbol, formatFiat, getCurrency, type CurrencyEntry } from './currencyRegistry'
import { saveActivity } from './ActivityService'
import {
  classifyStuckRelease, STUCK_RELEASE_GRACE_MS, parseActivationCutoff, isEligibleForReconcile,
  type StuckReleaseVerdict, type StuckReleaseProbe, type StuckReleaseDecision,
} from './stuckReleasePolicy'

const SUPA_URL = (import.meta.env.VITE_SUPABASE_URL as string) || ''

// Re-exported for backward compatibility with existing UI imports —
// CURRENCY_REGISTRY in currencyRegistry.ts is the actual source of truth now.
export { CURRENCY_REGISTRY as CURRENCIES, currencySymbol, formatFiat, getCurrency, type CurrencyEntry }

export const DEMO_PAYMENT_METHODS = [
  'Bank Transfer (Demo)', 'PayPal (Demo)', 'Cash App (Demo)', 'Venmo (Demo)',
  'Wise (Demo)', 'Zelle (Demo)', 'Revolut (Demo)', 'UPI (Demo)', 'Cash in Person (Demo)',
]

export const COUNTRY_REGIONS = [
  'Global', 'United States', 'United Kingdom', 'European Union', 'India', 'Pakistan',
  'United Arab Emirates', 'Saudi Arabia', 'Japan', 'China', 'Singapore', 'Australia',
  'Canada', 'Switzerland', 'Turkey', 'Brazil', 'Nigeria', 'South Africa',
  'Philippines', 'Malaysia', 'Thailand', 'Indonesia',
]

export type OfferType = 'buy' | 'sell'
export type OfferStatus = 'active' | 'paused' | 'completed' | 'cancelled'
export type TradeStatus = 'waiting_for_buyer' | 'payment_sent' | 'released' | 'completed' | 'cancelled' | 'expired'
export type MerchantFilter = 'all' | 'verified' | 'community'
export type DisputeStatus = 'none' | 'open' | 'resolved_buyer' | 'resolved_seller'

export interface P2POffer {
  id: string
  userId: string
  walletAddress: string
  offerType: OfferType
  currency: string
  pricePerUsdc: number
  minAmount: number
  maxAmount: number
  paymentMethods: string[]
  countryRegion: string
  terms?: string
  status: OfferStatus
  isVerifiedMerchant: boolean
  lockedByTradeId?: string
  offerExpiresAt?: string
  escrowDepositTxHash?: string
  escrowWithdrawTxHash?: string
  escrowBalance?: number
  createdAt: string
  updatedAt: string
  username?: string
  displayName?: string
  avatarUrl?: string
}

export interface P2PTrade {
  id: string
  offerId: string
  offerType: OfferType
  buyerId: string
  buyerWallet: string
  sellerId: string
  sellerWallet: string
  amountUsdc: number
  pricePerUsdc: number
  amountFiat: number
  currency: string
  paymentMethod: string
  status: TradeStatus
  expiresAt: string
  txHash?: string
  cancelReason?: string
  adminFrozen: boolean
  disputeStatus: DisputeStatus
  disputeReason?: string
  adminNote?: string
  createdAt: string
  paymentSentAt?: string
  releasedAt?: string
  completedAt?: string
}

export interface P2PMessage {
  id: string; tradeId: string; senderId: string; content: string; isSystem: boolean; createdAt: string
}

export interface UserReputation {
  totalTrades: number
  completionRate: number
  avgReleaseSeconds: number | null
  isVerifiedMerchant: boolean
  accountAgeDays: number
}

function offerFromRow(r: any): P2POffer {
  return {
    id: r.id, userId: r.user_id, walletAddress: r.wallet_address, offerType: r.offer_type,
    currency: r.currency, pricePerUsdc: parseFloat(r.price_per_usdc), minAmount: parseFloat(r.min_amount),
    maxAmount: parseFloat(r.max_amount), paymentMethods: r.payment_methods ?? [], countryRegion: r.country_region,
    terms: r.terms ?? undefined, status: r.status, isVerifiedMerchant: !!r.is_verified_merchant,
    lockedByTradeId: r.locked_by_trade_id ?? undefined, offerExpiresAt: r.offer_expires_at ?? undefined,
    escrowDepositTxHash: r.escrow_deposit_tx_hash ?? undefined, escrowWithdrawTxHash: r.escrow_withdraw_tx_hash ?? undefined,
    escrowBalance: r.escrow_balance != null ? parseFloat(r.escrow_balance) : undefined,
    createdAt: r.created_at, updatedAt: r.updated_at,
    username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url,
  }
}

function tradeFromRow(r: any): P2PTrade {
  return {
    id: r.id, offerId: r.offer_id, offerType: r.offer_type, buyerId: r.buyer_id, buyerWallet: r.buyer_wallet,
    sellerId: r.seller_id, sellerWallet: r.seller_wallet, amountUsdc: parseFloat(r.amount_usdc),
    pricePerUsdc: parseFloat(r.price_per_usdc), amountFiat: parseFloat(r.amount_fiat), currency: r.currency,
    paymentMethod: r.payment_method, status: r.status, expiresAt: r.expires_at, txHash: r.tx_hash ?? undefined,
    cancelReason: r.cancel_reason ?? undefined, adminFrozen: !!r.admin_frozen,
    disputeStatus: r.dispute_status ?? 'none', disputeReason: r.dispute_reason ?? undefined, adminNote: r.admin_note ?? undefined,
    createdAt: r.created_at, paymentSentAt: r.payment_sent_at ?? undefined,
    releasedAt: r.released_at ?? undefined, completedAt: r.completed_at ?? undefined,
  }
}

function messageFromRow(r: any): P2PMessage {
  return { id: r.id, tradeId: r.trade_id, senderId: r.sender_id, content: r.content, isSystem: r.is_system, createdAt: r.created_at }
}

/**
 * The single choke point for every P2P Activity write. Nothing in this file may
 * call saveActivity() with a p2p_* type directly — see the source assertion in
 * p2pService.backfill.test.ts, which fails the build if that rule is broken.
 *
 * ── Why a row without a tx hash must not exist ──────────────────────────────
 * A P2P activity row is a financial statement: "this much USDC moved, here."
 * Without a transaction hash there is nothing to verify it against, so it is
 * indistinguishable from a row describing money that never moved. That is not
 * hypothetical: one wallet accumulated 45 such rows, including a
 * "-100 USDC Sell Order Created" for an offer whose escrow was never funded —
 * getRemaining() returned 0 on BOTH deployed escrow contracts
 * (P2PEscrow 0xc44BcDa0…, P2PMeshportEscrow 0xe336E64c…) and no deposit
 * transaction for its offerKey exists on either.
 *
 * Hashless rows are also structurally undedupable. Every unique index on
 * `activity` is over (tx_hash, wallet_address), and Postgres treats NULLs as
 * distinct, so each hashless insert is an unguarded brand-new row. Six visits to
 * the Activity page produced six copies of the same event. Refusing to write
 * them is what makes the feed both verifiable AND idempotent.
 *
 * ── What this does NOT do ───────────────────────────────────────────────────
 * It never gates the P2P action itself. By the time any caller reaches here the
 * escrow deposit / withdrawal / release has already succeeded or already failed
 * on its own terms, and the offer/trade row has already been written. Skipping
 * the activity row changes only whether an unverifiable entry appears in the
 * feed — the offer is still created, the trade still completes, the funds still
 * move. p2p_offers and p2p_trades remain the source of truth for the event.
 *
 * Honor-system mode is the case that reaches here without a hash: with
 * VITE_P2P_ESCROW_CONTRACT unset, HonorSystemFallbackEscrowProvider returns
 * `{ success: true }` and no txHash for deposits, withdrawals and refunds (see
 * p2pProviders.ts), because nothing was actually locked on-chain.
 *
 * Returns true when a row was written (or was a benign duplicate), false when
 * the write was skipped for lack of proof, or failed after saveActivity's own
 * retries.
 */
export async function saveP2PActivity(
  params: Parameters<typeof saveActivity>[0],
): Promise<boolean> {
  if (!params.txHash) {
    console.warn(
      '[p2pService] P2P activity NOT recorded — no on-chain tx hash to verify it:',
      params.activityType,
      params.metadata?.kind ?? '',
      '— the P2P action itself was unaffected',
    )
    return false
  }
  return saveActivity(params).catch(() => false)
}

export async function isUserBanned(userId: string): Promise<boolean> {
  const res = await fetch(`${SUPA_URL}/rest/v1/p2p_banned_users?user_id=eq.${encodeURIComponent(userId)}&select=user_id`, { headers: await authHeaders() })
  if (!res.ok) return false
  const rows = await res.json()
  return rows.length > 0
}

/**
 * The P2P on/off kill switch admins can flip from P2PAdminPage — backed by
 * the same app_settings table (feature: 'p2p_enabled') every other feature
 * toggle in this app already uses (swap_enabled, chat_enabled, etc.), so it
 * gets Realtime sync across every connected client for free via
 * useSettingsStore, with no separate mechanism needed.
 *
 * Deliberately checked only in createOffer/createTrade — the entry points
 * for NEW P2P activity — and not in markPaymentSent/releaseTrade/
 * cancelTrade/openDispute. Disabling P2P should stop new trades from
 * starting, not strand people who already have money in an active trade
 * with no way to finish it out. (The route-level FeatureGate in App.tsx
 * follows the same split — see its comment there.)
 */
async function isP2PEnabled(): Promise<boolean> {
  const { useSettingsStore } = await import('../store/settingsStore')
  // Ensure settings have actually been loaded at least once — a fresh page
  // load might call this before AppLayout's own load() has resolved, and
  // isEnabled() would otherwise fall back to "true" for a row it hasn't
  // fetched yet, which happens to be safe here but would be a race either way.
  await useSettingsStore.getState().load()
  return useSettingsStore.getState().isEnabled('p2p_enabled')
}

export async function createOffer(p: {
  userId: string; walletAddress: string; offerType: OfferType; currency: string
  pricePerUsdc: number; minAmount: number; maxAmount: number
  paymentMethods: string[]; countryRegion: string; terms?: string
  offerExpiresInHours?: number
}): Promise<{ offer: P2POffer | null; error?: string }> {
  if (await isUserBanned(p.userId)) return { offer: null, error: 'Your account is restricted from the P2P marketplace.' }
  if (!(await isP2PEnabled())) return { offer: null, error: 'P2P trading is currently disabled by an admin.' }

  const offerExpiresAt = p.offerExpiresInHours
    ? new Date(Date.now() + p.offerExpiresInHours * 3600 * 1000).toISOString()
    : null

  // Escrow only applies to SELL offers AT CREATION TIME — its creator is
  // the one who will eventually release USDC to a buyer, so THEY are the
  // one who needs to lock funds up front. A BUY offer's creator wants to
  // RECEIVE USDC; they hold none to escrow at offer-creation time —
  // whoever accepts a buy offer becomes the seller for THAT trade instead,
  // and deposits at acceptance time (see createTrade()'s
  // `escrowProvider.depositForTrade` call). So buy offers ARE escrow-
  // backed end-to-end — just not until someone actually accepts one, since
  // there's no seller (and no funds) to escrow before that happens.
  let escrowDepositTxHash: string | null = null
  let escrowBalance: number | null = null
  const offerId = crypto.randomUUID()

  if (p.offerType === 'sell') {
    const { escrowProvider } = await import('./p2pProviders')
    const depositResult = await escrowProvider.depositForOffer(offerId, p.maxAmount)
    if (!depositResult.success) {
      return { offer: null, error: `Escrow deposit failed: ${depositResult.message}` }
    }
    escrowDepositTxHash = depositResult.txHash ?? null
    // The deposit that just succeeded IS the offer's opening escrow
    // balance — no need for a live contract read here, it can only be
    // p.maxAmount (this is a fresh offerId, never deposited against
    // before this call).
    escrowBalance = p.maxAmount
  }

  const res = await fetch(`${SUPA_URL}/rest/v1/p2p_offers`, {
    method: 'POST',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({
      id: offerId, user_id: p.userId, wallet_address: p.walletAddress.toLowerCase(), offer_type: p.offerType,
      currency: p.currency, price_per_usdc: p.pricePerUsdc, min_amount: p.minAmount, max_amount: p.maxAmount,
      payment_methods: p.paymentMethods, country_region: p.countryRegion, terms: p.terms ?? null,
      offer_expires_at: offerExpiresAt, escrow_deposit_tx_hash: escrowDepositTxHash, escrow_balance: escrowBalance,
    }),
  })
  if (!res.ok) return { offer: null, error: 'Could not create offer — please try again.' }
  const rows = await res.json()
  const created = rows[0] ? offerFromRow(rows[0]) : null

  // Only for sell offers — a buy offer's creator hasn't escrowed anything
  // yet (see the comment above); logging this for buy offers would show a
  // "-" entry for money that hasn't actually moved.
  if (created && p.offerType === 'sell') {
    await saveP2PActivity({
      walletAddress: p.walletAddress, userId: p.userId, txHash: escrowDepositTxHash ?? undefined,
      activityType: 'p2p_sell_order', amount: p.maxAmount, status: 'completed',
      metadata: { offerId, kind: 'offer_created' },
    })
  }

  return { offer: created }
}

/**
 * Edit an existing offer's price, payment methods, and/or terms.
 *
 * Deliberately does NOT allow changing offerType, currency, minAmount, or
 * maxAmount here — offerType/currency are structural (changing them mid-
 * listing would be confusing for anyone who already saw the old version),
 * and maxAmount is governed by actual escrowed capacity, not just a number
 * a seller can freely edit (see topUpOfferEscrow below for the correct,
 * on-chain-backed way to raise it).
 *
 * Restricted to the offer's own owner (both the WHERE filter here AND
 * whatever RLS policy already exists on p2p_offers — this is defense in
 * depth, not the only check) and only while the offer is still 'active'
 * with no trade currently locking it — editing price/payment methods out
 * from under an in-progress trade would be actively harmful to whoever's
 * mid-trade against the old terms.
 */
export async function updateOfferDetails(
  offer: P2POffer,
  userId: string,
  updates: { pricePerUsdc?: number; paymentMethods?: string[]; terms?: string },
): Promise<{ success: boolean; message: string }> {
  if (offer.userId !== userId) return { success: false, message: 'You can only edit your own offers.' }
  if (offer.status !== 'active') return { success: false, message: 'Only active offers can be edited.' }
  if (offer.lockedByTradeId) return { success: false, message: 'This offer is locked by an active trade and can\u2019t be edited right now.' }

  const fields: Record<string, unknown> = {}
  if (updates.pricePerUsdc !== undefined) {
    if (!(updates.pricePerUsdc > 0)) return { success: false, message: 'Enter a valid price.' }
    fields.price_per_usdc = updates.pricePerUsdc
  }
  if (updates.paymentMethods !== undefined) {
    if (updates.paymentMethods.length === 0) return { success: false, message: 'Select at least one payment method.' }
    fields.payment_methods = updates.paymentMethods
  }
  if (updates.terms !== undefined) fields.terms = updates.terms || null
  if (Object.keys(fields).length === 0) return { success: true, message: 'Nothing to update.' }

  const res = await fetch(
    `${SUPA_URL}/rest/v1/p2p_offers?id=eq.${offer.id}&user_id=eq.${userId}&status=eq.active`,
    {
      method: 'PATCH',
      headers: { ...(await authHeaders()), 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify(fields),
    },
  )
  if (!res.ok) return { success: false, message: 'Could not update offer \u2014 please try again.' }
  const rows = await res.json()
  if (!Array.isArray(rows) || rows.length === 0) {
    return { success: false, message: 'This offer changed (no longer active, or no longer yours) and can\u2019t be edited right now.' }
  }
  return { success: true, message: 'Offer updated.' }
}

/**
 * Add more USDC to a SELL offer's escrow \u2014 a real on-chain deposit (see
 * P2PEscrow.sol's deposit(), which is additive: calling it again on the
 * same offerKey adds to `remaining` rather than replacing it), followed by
 * raising maxAmount by the same amount in the DB.
 *
 * Why maxAmount has to move too: offerRemainingAmount() (what buyers
 * actually see as available capacity) is computed purely as
 * `maxAmount - consumed`, with NO live read of escrow_balance. So topping
 * up on-chain alone would leave buyers unable to actually draw the newly
 * deposited capacity \u2014 maxAmount is the real ceiling, escrow_balance is
 * just a display mirror of it. Both have to move together or the top-up
 * would be invisible to the marketplace.
 *
 * BUY offers are explicitly rejected \u2014 their creator doesn't escrow
 * anything at offer-creation time in the first place (see createOffer's
 * own comment on this), so there's nothing here to top up; whoever
 * accepts a buy offer deposits at trade-acceptance time instead.
 */
export async function topUpOfferEscrow(
  offer: P2POffer,
  userId: string,
  additionalUsdc: number,
): Promise<{ success: boolean; message: string }> {
  if (offer.userId !== userId) return { success: false, message: 'You can only top up your own offers.' }
  if (offer.offerType !== 'sell') return { success: false, message: 'Only sell offers hold escrow that can be topped up.' }
  if (offer.status !== 'active') return { success: false, message: 'Only active offers can be topped up.' }
  if (!(additionalUsdc > 0)) return { success: false, message: 'Enter an amount greater than zero.' }

  const { escrowProvider } = await import('./p2pProviders')
  const depositResult = await escrowProvider.depositForOffer(offer.id, additionalUsdc)
  if (!depositResult.success) return { success: false, message: `Top-up failed: ${depositResult.message}` }

  const newMax = offer.maxAmount + additionalUsdc
  const newEscrowBalance = (offer.escrowBalance ?? offer.maxAmount) + additionalUsdc
  const res = await fetch(
    `${SUPA_URL}/rest/v1/p2p_offers?id=eq.${offer.id}&user_id=eq.${userId}`,
    {
      method: 'PATCH',
      headers: { ...(await authHeaders()), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ max_amount: newMax, escrow_balance: newEscrowBalance }),
    },
  )
  // The on-chain deposit already succeeded and is real money moved \u2014 even
  // if this DB sync call fails, don't report the top-up as failed (that
  // would be actively misleading: the funds ARE there on-chain). Surface
  // it as a success with a caveat instead; the balance will self-correct
  // next time anything re-reads the contract directly.
  if (!res.ok) {
    return { success: true, message: 'USDC deposited on-chain, but the listing may take a moment to reflect the new amount \u2014 refresh shortly.' }
  }

  await saveP2PActivity({
    walletAddress: offer.walletAddress, userId, txHash: depositResult.txHash,
    activityType: 'p2p_sell_order', amount: additionalUsdc, status: 'completed',
    metadata: { offerId: offer.id, kind: 'offer_topped_up' },
  })

  return { success: true, message: `Added ${additionalUsdc} USDC to your offer\u2019s escrow.` }
}

async function attachUserProfiles(offers: P2POffer[]): Promise<void> {
  const ids = [...new Set(offers.map(o => o.userId).filter(Boolean))]
  if (ids.length === 0) return
  try {
    const uRes = await fetch(`${SUPA_URL}/rest/v1/users?id=in.(${ids.join(',')})&select=id,username,display_name,avatar_url`, { headers: await authHeaders() })
    if (!uRes.ok) return
    const users: any[] = await uRes.json()
    const byId = new Map(users.map(u => [u.id, u]))
    for (const o of offers) {
      const u = byId.get(o.userId)
      if (u) { o.username = u.username; o.displayName = u.display_name; o.avatarUrl = u.avatar_url }
    }
  } catch { /* non-fatal */ }
}

export async function fetchOffers(filters: {
  offerType: OfferType; currency?: string; countryRegion?: string; paymentMethod?: string
  excludeUserId?: string; merchantFilter?: MerchantFilter; limit?: number
}): Promise<P2POffer[]> {
  let url = `${SUPA_URL}/rest/v1/p2p_offers?offer_type=eq.${filters.offerType}&status=eq.active&locked_by_trade_id=is.null&order=created_at.desc&limit=${filters.limit ?? 50}`
  if (filters.currency) url += `&currency=eq.${encodeURIComponent(filters.currency)}`
  if (filters.countryRegion && filters.countryRegion !== 'Global') url += `&country_region=eq.${encodeURIComponent(filters.countryRegion)}`
  if (filters.paymentMethod) url += `&payment_methods=cs.{${encodeURIComponent(filters.paymentMethod)}}`
  if (filters.excludeUserId) url += `&user_id=neq.${encodeURIComponent(filters.excludeUserId)}`
  if (filters.merchantFilter === 'verified') url += `&is_verified_merchant=eq.true`
  if (filters.merchantFilter === 'community') url += `&is_verified_merchant=eq.false`

  const res = await fetch(url, { headers: await authHeaders() })
  if (!res.ok) { console.error('[p2pService] fetchOffers failed:', await res.text()); return [] }
  const rows = await res.json()
  const offers = (rows as any[]).map(offerFromRow)
  await attachUserProfiles(offers)
  return offers
}

export async function fetchOfferById(offerId: string): Promise<P2POffer | null> {
  const res = await fetch(`${SUPA_URL}/rest/v1/p2p_offers?id=eq.${offerId}`, { headers: await authHeaders() })
  if (!res.ok) return null
  const rows = await res.json()
  if (!rows[0]) return null
  const offer = offerFromRow(rows[0])
  await attachUserProfiles([offer])
  return offer
}

export async function fetchMyOffers(userId: string): Promise<P2POffer[]> {
  const res = await fetch(`${SUPA_URL}/rest/v1/p2p_offers?user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc`, { headers: await authHeaders() })
  if (!res.ok) return []
  const rows = await res.json()
  return (rows as any[]).map(offerFromRow)
}

/**
 * Admin oversight view — every offer regardless of type/status, unlike
 * fetchOffers() (marketplace browse, active+unlocked only, single type at
 * a time) or fetchMyOffers() (one user's own offers only). Used by
 * P2PAdminPage.tsx's live Offers panel.
 */
export async function fetchAllOffersAdmin(limit = 200): Promise<P2POffer[]> {
  const res = await fetch(`${SUPA_URL}/rest/v1/p2p_offers?order=created_at.desc&limit=${limit}`, { headers: await authHeaders() })
  if (!res.ok) return []
  const rows = await res.json()
  const offers = (rows as any[]).map(offerFromRow)
  await attachUserProfiles(offers)
  return offers
}

/** Live updates for the admin Offers panel — new offers, cancellations, depletion (status flipping to 'completed'), all appear instantly. */
export function subscribeToAllOffers(onChange: (offer: P2POffer) => void): () => void {
  return subscribeWithRetry(supabase, 'p2p-admin-offers', channel =>
    channel.on('postgres_changes', { event: '*', schema: 'public', table: 'p2p_offers' },
      (payload: any) => onChange(offerFromRow(payload.new ?? payload.old))))
}

/**
 * Live updates for "my trades" (marketplace History panel, My Trades list,
 * admin trades panel) — a payment marked sent, a release, a dispute, or a
 * brand-new trade against one of your offers should all appear instantly,
 * not just at the next full page load/reload.
 *
 * Postgres realtime's row filter only supports a single equality check, not
 * an OR across two columns — this trade could be *either* buyer_id or
 * seller_id for this user — so this opens two separate subscriptions (one
 * per side) and calls onChange for either. Both go through the same proven
 * subscribeWithRetry helper chat/P2P trade-detail already use, so this
 * survives a tab switch/network drop exactly the same way those do.
 */
export function subscribeToMyTrades(userId: string, onChange: (trade: P2PTrade) => void): () => void {
  const unsubBuyer = subscribeWithRetry(supabase, `p2p-my-trades-buyer-${userId}`, channel =>
    channel.on('postgres_changes', { event: '*', schema: 'public', table: 'p2p_trades', filter: `buyer_id=eq.${userId}` },
      (payload: any) => onChange(tradeFromRow(payload.new ?? payload.old))))
  const unsubSeller = subscribeWithRetry(supabase, `p2p-my-trades-seller-${userId}`, channel =>
    channel.on('postgres_changes', { event: '*', schema: 'public', table: 'p2p_trades', filter: `seller_id=eq.${userId}` },
      (payload: any) => onChange(tradeFromRow(payload.new ?? payload.old))))
  return () => { unsubBuyer(); unsubSeller() }
}

/**
 * How much of each offer's total capacity (maxAmount) has already been
 * consumed by trades that actually completed. This is the piece that was
 * missing entirely — an offer's min/max were only ever the ORIGINAL
 * limits set at creation, with nothing tracking how much had already been
 * bought/sold against it, so a $100 sell offer kept showing "$100
 * available" forever, even after $10 of it had already been sold.
 *
 * Deliberately does NOT touch p2p_offers.escrow_balance as the source of
 * truth — that field is only ever set for sell offers (at creation and at
 * cancellation), never updated per-trade, and buy offers don't have one at
 * all. Computing consumed amount directly from completed trades works
 * identically for both offer types and doesn't require a schema change.
 *
 * Only 'completed'/'released' trades count — a cancelled or expired trade
 * never actually transferred anything, so it doesn't reduce what's left.
 */
export async function fetchOfferConsumedAmounts(offerIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  const ids = [...new Set(offerIds)].filter(Boolean)
  if (ids.length === 0) return map
  try {
    const res = await fetch(
      `${SUPA_URL}/rest/v1/p2p_trades?offer_id=in.(${ids.join(',')})&status=in.(completed,released)&select=offer_id,amount_usdc`,
      { headers: await authHeaders() },
    )
    if (!res.ok) return map
    const rows: { offer_id: string; amount_usdc: number | string }[] = await res.json()
    for (const r of rows) {
      map.set(r.offer_id, (map.get(r.offer_id) ?? 0) + parseFloat(String(r.amount_usdc)))
    }
  } catch { /* non-fatal — callers fall back to showing the original maxAmount */ }
  return map
}

/** Remaining capacity for a single offer, given its already-consumed amount. Clamped at 0 — never negative even if something briefly over-consumed. */
export function offerRemainingAmount(offer: P2POffer, consumed: number): number {
  return Math.max(0, offer.maxAmount - consumed)
}

/**
 * Called right after a trade against this offer completes. If what's left
 * can no longer even satisfy the offer's own minimum trade size, there's no
 * point leaving it listed as 'active' — nobody could accept it anyway (the
 * remaining-capacity check in createTrade() would just reject them), so it
 * would otherwise sit in the marketplace forever showing a stale "Limit:
 * $X–$Y" that's no longer actually obtainable. Marking it 'completed' here
 * (an existing, valid OfferStatus) removes it from fetchOffers()'s
 * `status=eq.active` listing automatically — no separate cleanup job needed.
 */
async function retireOfferIfDepleted(offerId: string): Promise<void> {
  try {
    const offer = await fetchOfferById(offerId)
    if (!offer || offer.status !== 'active') return
    const consumed = (await fetchOfferConsumedAmounts([offerId])).get(offerId) ?? 0
    if (offerRemainingAmount(offer, consumed) < offer.minAmount) {
      await updateOfferStatus(offerId, 'completed')
    }
  } catch { /* non-fatal — worst case the offer just stays listed until the next trade attempt is rejected by the remaining-capacity check */ }
}

export async function updateOfferStatus(offerId: string, status: OfferStatus): Promise<void> {
  await fetch(`${SUPA_URL}/rest/v1/p2p_offers?id=eq.${offerId}`, {
    method: 'PATCH',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
  })
}

/**
 * The real function the "Cancel Offer" button should call — plain
 * updateOfferStatus() only flips the status flag; this ALSO reclaims any
 * USDC still sitting in escrow for a sell offer (via EscrowProvider's
 * withdrawRemaining, which calls the real contract when one is deployed).
 * A locked offer (mid-trade) can't be cancelled this way — that has to go
 * through cancelling the trade itself first, same as before.
 */
export async function cancelOfferAndWithdrawEscrow(offer: P2POffer, opts?: { adminTriggered?: boolean }): Promise<{ success: boolean; message: string }> {
  if (offer.lockedByTradeId) {
    return { success: false, message: 'This offer has an active trade — cancel that trade first.' }
  }
  if (offer.offerType === 'sell') {
    // withdrawRemaining is offer-keyed, not trade-keyed like every other
    // EscrowProvider method — called via the low-level contract module
    // directly here, same pattern depositForOffer already establishes for
    // offer-level (rather than trade-level) escrow operations.
    const { isEscrowContractDeployed, withdrawRemainingFromEscrow, isEscrowPaused } = await import('./p2pEscrowContract')
    if (isEscrowContractDeployed()) {
      if (await isEscrowPaused().catch(() => false)) {
        return { success: false, message: 'P2P escrow is currently paused by an admin. Please try again shortly.' }
      }
      try {
        const { useAuthStore } = await import('../store')
        const { privateKey } = useAuthStore.getState()
        if (!privateKey) return { success: false, message: "Couldn't access your wallet on this device to withdraw escrow." }
        // Matches contracts/P2PEscrow.sol's own authorization exactly:
        // withdrawRemaining requires msg.sender == e.seller || msg.sender
        // == admin — an admin-triggered cancellation signs with the
        // ADMIN's wallet, but the refunded USDC still always goes to the
        // original seller (the contract sends to `e.seller`, never to
        // whoever called the function), so this can never redirect funds.
        const txHash = await withdrawRemainingFromEscrow(privateKey, offer.id)
        await fetch(`${SUPA_URL}/rest/v1/p2p_offers?id=eq.${offer.id}`, {
          method: 'PATCH', headers: { ...(await authHeaders()), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ status: 'cancelled', escrow_withdraw_tx_hash: txHash, escrow_balance: 0, updated_at: new Date().toISOString() }),
        })
        // BUG FIX: previously logged `offer.escrowBalance` — the offer's
        // ORIGINAL deposit ceiling, only ever set at creation, never
        // updated per-trade (see fetchOfferConsumedAmounts/
        // offerRemainingAmount's own comments). For a partially-sold
        // offer, withdrawRemaining() only ever returns what's actually
        // still in escrow — maxAmount minus whatever already sold — so
        // logging escrowBalance overstated the refund by exactly however
        // much had already been sold before cancelling. The backfill sweep
        // further down this file already computes this correctly
        // (`refunded = maxAmount - soldAgainstOffer(...)`, with its own
        // comment on this exact trap); this live path just never matched
        // it. Same computation here, live, matching what the "Available:
        // X USDC left" label the seller saw right before cancelling
        // already showed.
        const consumedMap = await fetchOfferConsumedAmounts([offer.id])
        const actuallyRefunded = offerRemainingAmount(offer, consumedMap.get(offer.id) ?? 0)
        await saveP2PActivity({
          walletAddress: offer.walletAddress, userId: offer.userId, txHash,
          activityType: 'p2p_refund', amount: actuallyRefunded, status: 'completed',
          metadata: { offerId: offer.id, kind: opts?.adminTriggered ? 'admin_cancelled_offer' : 'offer_cancelled' },
        })
        return { success: true, message: opts?.adminTriggered ? 'Offer cancelled by admin — escrowed USDC returned to the seller.' : 'Offer cancelled and escrowed USDC returned to your wallet.' }
      } catch (e: any) {
        return { success: false, message: e?.message ?? 'Could not withdraw escrow — please try again.' }
      }
    }
  }
  await updateOfferStatus(offer.id, 'cancelled')
  return { success: true, message: opts?.adminTriggered ? 'Offer cancelled by admin.' : 'Offer cancelled.' }
}

/**
 * Admin-only variant — same underlying logic as cancelOfferAndWithdrawEscrow
 * (no separate implementation to keep in sync), just tagged for Activity/
 * audit purposes and exposed with an admin-specific name so
 * P2PAdminPage.tsx's intent is clear at the call site. There's no
 * ownership check to bypass here — cancelOfferAndWithdrawEscrow never
 * enforced "only the owner" itself (the regular My Offers UI is what
 * limits a normal user to their own offers); this function documents that
 * an admin calling it for someone else's offer is intentional.
 */
export async function adminCancelOffer(offer: P2POffer): Promise<{ success: boolean; message: string }> {
  return cancelOfferAndWithdrawEscrow(offer, { adminTriggered: true })
}

export async function expireStaleOffers(): Promise<void> {
  await fetch(`${SUPA_URL}/rest/v1/p2p_offers?status=eq.active&offer_expires_at=lt.${new Date().toISOString()}`, {
    method: 'PATCH',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ status: 'cancelled', updated_at: new Date().toISOString() }),
  }).catch(() => {})
}

/**
 * Safety net for a real gap in the offer-locking mechanism: if the request
 * that locks an offer is interrupted (network drop, browser closed) after
 * the lock succeeds but before the trade row is actually created, that
 * offer would stay locked forever with no trade to ever unlock it. This
 * releases any lock older than ORPHANED_LOCK_THRESHOLD_MS where no trade
 * with that id actually exists — a genuine, currently-active trade always
 * has a real row, so this only ever touches locks that were never backed
 * by one. Call alongside expireStaleOffers (same "check on read" shape).
 */
const ORPHANED_LOCK_THRESHOLD_MS = 3 * 60 * 1000

export async function releaseOrphanedLocks(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - ORPHANED_LOCK_THRESHOLD_MS).toISOString()
    const res = await fetch(
      `${SUPA_URL}/rest/v1/p2p_offers?locked_by_trade_id=not.is.null&locked_at=lt.${cutoff}&select=id,locked_by_trade_id`,
      { headers: await authHeaders() },
    )
    if (!res.ok) return
    const lockedOffers: Array<{ id: string; locked_by_trade_id: string }> = await res.json()
    if (lockedOffers.length === 0) return

    const tradeIds = lockedOffers.map(o => o.locked_by_trade_id)
    const tradesRes = await fetch(`${SUPA_URL}/rest/v1/p2p_trades?id=in.(${tradeIds.join(',')})&select=id`, { headers: await authHeaders() })
    const existingTradeIds = new Set((tradesRes.ok ? await tradesRes.json() : []).map((t: any) => t.id))

    const orphaned = lockedOffers.filter(o => !existingTradeIds.has(o.locked_by_trade_id))
    for (const o of orphaned) {
      await fetch(`${SUPA_URL}/rest/v1/p2p_offers?id=eq.${o.id}`, {
        method: 'PATCH', headers: { ...(await authHeaders()), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ locked_by_trade_id: null, locked_at: null }),
      }).catch(() => {})
    }
  } catch { /* best-effort cleanup — a failure here just means the next call retries it */ }
}

const TRADE_WINDOW_MINUTES = 15

export async function createTrade(p: {
  offer: P2POffer; acceptingUserId: string; acceptingWallet: string; amountUsdc: number
}): Promise<{ trade: P2PTrade | null; error?: string }> {
  if (p.offer.userId === p.acceptingUserId) {
    return { trade: null, error: "You can't accept your own offer." }
  }
  if (await isUserBanned(p.acceptingUserId)) {
    return { trade: null, error: 'Your account is restricted from the P2P marketplace.' }
  }
  if (!(await isP2PEnabled())) {
    return { trade: null, error: 'P2P trading is currently disabled by an admin.' }
  }
  if (p.amountUsdc < p.offer.minAmount || p.amountUsdc > p.offer.maxAmount) {
    return { trade: null, error: `Amount must be between ${p.offer.minAmount} and ${p.offer.maxAmount} USDC.` }
  }

  // The check above only guards against the offer's ORIGINAL limits — it
  // says nothing about how much of that capacity is already spoken for by
  // trades that already completed. Re-check against what's actually left,
  // or this offer could be oversold: e.g. a $100 sell offer that already
  // sold $90 would otherwise still let someone accept another $100 trade
  // against it, well beyond what's actually escrowed.
  const consumedSoFar = (await fetchOfferConsumedAmounts([p.offer.id])).get(p.offer.id) ?? 0
  const remaining = offerRemainingAmount(p.offer, consumedSoFar)
  if (p.amountUsdc > remaining) {
    return { trade: null, error: `Only ${remaining} USDC left available on this offer.` }
  }

  const isOfferCreatorSeller = p.offer.offerType === 'sell'
  const buyerId      = isOfferCreatorSeller ? p.acceptingUserId : p.offer.userId
  const buyerWallet  = isOfferCreatorSeller ? p.acceptingWallet : p.offer.walletAddress
  const sellerId     = isOfferCreatorSeller ? p.offer.userId : p.acceptingUserId
  const sellerWallet = isOfferCreatorSeller ? p.offer.walletAddress : p.acceptingWallet
  const expiresAt = new Date(Date.now() + TRADE_WINDOW_MINUTES * 60 * 1000).toISOString()
  const amountFiat = Math.round(p.amountUsdc * p.offer.pricePerUsdc * 100) / 100

  // Real id generated up front — see the fix note below for why. The trade
  // row is created FIRST, using this id, so it genuinely exists in
  // p2p_trades by the time the offer's locked_by_trade_id (a real foreign
  // key into that table) ever gets set to it. No placeholder value is used
  // at any point.
  const tradeId = crypto.randomUUID()

  const res = await fetch(`${SUPA_URL}/rest/v1/p2p_trades`, {
    method: 'POST',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({
      id: tradeId, offer_id: p.offer.id, offer_type: p.offer.offerType, buyer_id: buyerId, buyer_wallet: buyerWallet.toLowerCase(),
      seller_id: sellerId, seller_wallet: sellerWallet.toLowerCase(), amount_usdc: p.amountUsdc,
      price_per_usdc: p.offer.pricePerUsdc, amount_fiat: amountFiat, currency: p.offer.currency,
      payment_method: p.offer.paymentMethods[0] ?? 'Bank Transfer (Demo)', expires_at: expiresAt,
    }),
  })
  if (!res.ok) {
    return { trade: null, error: 'Could not start trade — please try again.' }
  }
  const rows = await res.json()
  const trade = rows[0] ? tradeFromRow(rows[0]) : null
  if (!trade) return { trade: null, error: 'Could not start trade — please try again.' }

  // ── Fix note ──────────────────────────────────────────────────────────────
  // This USED to lock the offer BEFORE creating the trade, using the
  // offer's own id as a temporary placeholder value (since a real trade id
  // didn't exist yet) — but locked_by_trade_id has a real foreign-key
  // constraint into p2p_trades, and an offer's own id is never a row in
  // that table. Every single accept attempt was hitting this constraint
  // violation and failing, which the code then misread as "someone else
  // already locked it" — a completely wrong diagnosis for what was
  // actually a self-inflicted schema/code mismatch. Confirmed directly:
  // ran the exact conditional UPDATE against a genuinely unlocked offer
  // and it failed with "violates foreign key constraint
  // p2p_offers_locked_by_trade_id_fkey" — not a race with another buyer.
  // Creating the trade first (above) and locking with its REAL id here
  // fixes this at the root — no placeholder is ever needed.
  const lockRes = await fetch(`${SUPA_URL}/rest/v1/p2p_offers?id=eq.${p.offer.id}&locked_by_trade_id=is.null&status=eq.active`, {
    method: 'PATCH',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({ locked_by_trade_id: trade.id, locked_at: new Date().toISOString() }),
  })
  const lockedRows = lockRes.ok ? await lockRes.json() : []
  if (lockedRows.length === 0) {
    // A genuine race this time — some OTHER trade's real id already holds
    // the lock. Roll back the trade row this attempt created.
    await fetch(`${SUPA_URL}/rest/v1/p2p_trades?id=eq.${trade.id}`, { method: 'DELETE', headers: await authHeaders() }).catch(() => {})
    return { trade: null, error: 'This offer was just accepted by someone else or is no longer available.' }
  }

  // Buy-offer trades: the accepting user becomes the seller for THIS
  // trade and must deposit escrow now — the trade's own id already exists
  // at this point (needed to key the deposit), so if this fails, the
  // trade row itself gets deleted and the offer unlocked, same "cannot
  // exist without a successful deposit" guarantee sell offers get at
  // offer-creation time instead. Sell-offer trades skip this entirely —
  // that escrow was already deposited when the offer was created.
  if (p.offer.offerType === 'buy') {
    const depositResult = await escrowProvider.depositForTrade(trade.id, p.amountUsdc)
    if (!depositResult.success) {
      await fetch(`${SUPA_URL}/rest/v1/p2p_trades?id=eq.${trade.id}`, { method: 'DELETE', headers: await authHeaders() }).catch(() => {})
      await fetch(`${SUPA_URL}/rest/v1/p2p_offers?id=eq.${p.offer.id}`, {
        method: 'PATCH', headers: { ...(await authHeaders()), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ locked_by_trade_id: null }),
      }).catch(() => {})
      return { trade: null, error: `Escrow deposit failed: ${depositResult.message}` }
    }
    // Accepting a buy offer makes THIS user the seller for this specific
    // trade, and their USDC just got locked into escrow — same underlying
    // event (and same '-' sign) as creating a sell offer locks funds at
    // offer-creation time, just triggered at accept-time instead.
    await saveP2PActivity({
      walletAddress: sellerWallet, userId: sellerId, txHash: depositResult.txHash,
      activityType: 'p2p_sell_order', amount: p.amountUsdc, status: 'completed',
      metadata: { tradeId: trade.id, offerId: p.offer.id, kind: 'trade_accepted' },
    })
  }

  await escrowProvider.lockFunds(trade).catch(() => {})

  await sendTradeMessage(trade.id, 'system', `Trade started — ${currencySymbol(trade.currency)}${trade.amountFiat} for ${trade.amountUsdc} USDC. Payment window: ${TRADE_WINDOW_MINUTES} minutes.`, true)
  notifyP2P(sellerId, 'Offer Accepted', `A buyer accepted your offer for ${trade.amountUsdc} USDC.`)
  return { trade }
}

async function unlockOffer(offerId: string): Promise<boolean> {
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/p2p_offers?id=eq.${offerId}`, {
      method: 'PATCH', headers: { ...(await authHeaders()), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ locked_by_trade_id: null }),
    })
    // Same reasoning as updateTradeStatus: a swallowed failure here leaves the
    // offer permanently unusable, because locked_by_trade_id blocks every future
    // trade against it and nothing retries.
    if (!res.ok) {
      console.error('[p2pService] unlockOffer FAILED', res.status, offerId)
      return false
    }
    return true
  } catch (e: any) {
    console.error('[p2pService] unlockOffer threw', offerId, e?.message)
    return false
  }
}

export async function fetchTrade(tradeId: string): Promise<P2PTrade | null> {
  const res = await fetch(`${SUPA_URL}/rest/v1/p2p_trades?id=eq.${tradeId}`, { headers: await authHeaders() })
  if (!res.ok) return null
  const rows = await res.json()
  return rows[0] ? tradeFromRow(rows[0]) : null
}

export interface CounterpartyProfile { userId: string; username?: string; displayName?: string; walletAddress?: string }

/**
 * Batch-resolves display info for the "other side" of each trade in
 * `trades`, keyed by userId — used by the History page's Counterparty
 * column/search. Mirrors attachUserProfiles' single-query batching (one
 * `id=in.(...)` request instead of N), but returns a lookup map instead of
 * mutating the trades themselves, since a trade has two possible
 * counterparties (buyer or seller) depending on which one `myUserId` is.
 */
export async function fetchCounterpartyProfiles(trades: P2PTrade[], myUserId: string): Promise<Map<string, CounterpartyProfile>> {
  const ids = [...new Set(trades.map(t => (t.buyerId === myUserId ? t.sellerId : t.buyerId)).filter(Boolean))]
  const map = new Map<string, CounterpartyProfile>()
  if (ids.length === 0) return map
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/users?id=in.(${ids.join(',')})&select=id,username,display_name,wallet_address`, { headers: await authHeaders() })
    if (!res.ok) return map
    const rows: any[] = await res.json()
    for (const r of rows) {
      map.set(r.id, { userId: r.id, username: r.username, displayName: r.display_name, walletAddress: r.wallet_address })
    }
  } catch { /* non-fatal — History page falls back to showing the raw wallet address */ }
  return map
}

export async function fetchMyTrades(userId: string): Promise<P2PTrade[]> {
  const res = await fetch(
    `${SUPA_URL}/rest/v1/p2p_trades?or=(buyer_id.eq.${encodeURIComponent(userId)},seller_id.eq.${encodeURIComponent(userId)})&order=created_at.desc`,
    { headers: await authHeaders() },
  )
  if (!res.ok) return []
  const rows = await res.json()
  return (rows as any[]).map(tradeFromRow)
}

// ── P2P Activity backfill: idempotency machinery ─────────────────────────────
//
// Deliberately module-level rather than component-level. ActivityPage's effect
// fires on EVERY mount of that page — and twice per mount under
// React.StrictMode (see main.tsx) — so any guard living in component state or a
// ref is reset at exactly the moment it is needed. These two live as long as the
// JS context does; the localStorage latch outlives even that.
const _backfillInFlight = new Map<string, Promise<void>>()

// ── The localStorage latch is an OPTIMISATION, not the correctness mechanism ──
//
// Correctness comes from two things that do not depend on this latch at all:
//   1. every row this backfill emits carries a real tx_hash, so saveActivity's
//      on_conflict path plus activity_tx_hash_wallet_address_key make a repeat
//      write a no-op at the DATABASE level — the guard that provably works;
//   2. the fail-closed dedup read below.
// The latch only spares a device the redundant round-trips once the work is
// genuinely finished. It is therefore set ONLY when every write in a run
// succeeded — a run that wrote nothing because a write failed must be allowed to
// try again, otherwise a single 5xx would strand that wallet's history forever.
//
// Bump the version suffix if the emission rules change and a re-run is wanted.
// Keyed per wallet, since one device can hold several.
const backfillDoneKey = (wallet: string) => `meshport_p2p_backfill_v2_${wallet.toLowerCase()}`

function backfillAlreadyDone(wallet: string): boolean {
  try { return localStorage.getItem(backfillDoneKey(wallet)) === '1' } catch { return false }
}
function markBackfillDone(wallet: string): void {
  try { localStorage.setItem(backfillDoneKey(wallet), '1') } catch { /* private mode — in-flight guard still applies */ }
}

/**
 * One-time catch-up: creates Activity-feed entries for P2P events that already
 * happened BEFORE this Activity-logging feature existed, so history that
 * predates the feature is not invisible forever.
 *
 * ── The duplication bug this replaces ──────────────────────────────────────
 * The previous version claimed to be "safe to call on every visit" because it
 * read this wallet's existing p2p_* rows and skipped anything already covered
 * by (type, tradeId/offerId). In production that guard did not hold: one wallet
 * accumulated 72 p2p rows over ~6 Activity visits, including SIX copies each of
 * the same offer's sell_order and refund. Three compounding causes:
 *
 *   1. The dedup read FAILED OPEN — `existingRes.ok ? json : []`. Any non-2xx,
 *      or an RLS policy returning nothing, produced an empty "covered" set,
 *      which reads identically to "this wallet has no P2P history yet" and
 *      re-inserted the entire back catalogue.
 *   2. No mutual exclusion. The function is async with awaits between the read
 *      and the writes, so two overlapping runs (StrictMode's double effect, or
 *      two quick navigations) both snapshot `covered` before either writes.
 *   3. Nothing downstream could catch it. Rows with a NULL tx_hash bypass
 *      saveActivity's on_conflict path, and `activity_tx_hash_wallet_address_key`
 *      is a plain UNIQUE (tx_hash, wallet_address) — Postgres treats NULLs as
 *      distinct, so every hashless row is an unguarded fresh INSERT.
 *
 * The tell is in the data: all 27 rows that DID carry a tx_hash are unique,
 * because for those saveActivity sends on_conflict + ignore-duplicates and the
 * constraint arbitrates. Only the 45 hashless rows duplicated. The database
 * guard worked; the client guard did not.
 *
 * ── The invariant that fixes it ────────────────────────────────────────────
 * This function now emits a row ONLY when the offer/trade tables prove an
 * on-chain transaction happened, and it stamps that hash on the row. Every row
 * it writes therefore carries a tx_hash, which makes the DB constraint — the
 * guard that demonstrably works — the backstop. Duplication stops being a thing
 * this code can do, whether or not the read above it succeeds.
 *
 * That deliberately drops two emissions the old version made:
 *   • trade-level 'trade_accepted' / 'trade_cancelled' rows, which hardcoded
 *     `txHash: undefined`. The seller's trade-level escrow hash is not stored on
 *     the trade row (`t.tx_hash` is the RELEASE hash), so these can never be
 *     proven from the tables and were pure workflow markers rendered as ± USDC.
 *   • offers with no escrow_deposit_tx_hash. In honor-system mode
 *     (VITE_P2P_ESCROW_CONTRACT unset, see HonorSystemFallbackEscrowProvider)
 *     no deposit occurs and no funds are ever locked, so "-N USDC Sell Order
 *     Created" describes money that never moved.
 *
 * escrow_balance is deliberately NOT consulted: that column was added
 * 2026-07-30 with no backfill, so it is NULL for every older offer and cannot
 * serve as historical ground truth. Refund amounts are derived from the offer
 * and trade rows instead.
 */
export async function backfillP2PActivity(userId: string, walletAddress: string): Promise<void> {
  const wallet = (walletAddress || '').toLowerCase()
  if (!userId || !wallet) return

  // GUARD 1 — a completed backfill never runs again on this device.
  if (backfillAlreadyDone(wallet)) return

  // GUARD 2 — concurrent callers share one run instead of racing it. Returning
  // the SAME promise means StrictMode's second invocation awaits the first
  // rather than starting a second pass over the same offers.
  const inFlight = _backfillInFlight.get(wallet)
  if (inFlight) return inFlight

  const run = runP2PBackfill(userId, wallet).finally(() => { _backfillInFlight.delete(wallet) })
  _backfillInFlight.set(wallet, run)
  return run
}

async function runP2PBackfill(userId: string, wallet: string): Promise<void> {
  try {
    const [trades, offers] = await Promise.all([fetchMyTrades(userId), fetchMyOffers(userId)])
    if (trades.length === 0 && offers.length === 0) { markBackfillDone(wallet); return }

    const existingRes = await fetch(
      `${SUPA_URL}/rest/v1/activity?wallet_address=eq.${encodeURIComponent(wallet)}&activity_type=in.(p2p_sell_order,p2p_refund,p2p_purchase)&select=activity_type,metadata`,
      { headers: await authHeaders() },
    )
    // FAIL CLOSED. An unreadable dedup set is indistinguishable from an empty
    // one, and guessing "empty" is what duplicated the back catalogue six times.
    // Bail without latching, so a genuine transient failure retries next visit.
    if (!existingRes.ok) {
      console.warn('[p2pService] P2P backfill skipped — could not read existing activity:', existingRes.status)
      return
    }
    let existingRows: { activity_type: string; metadata: any }[]
    try {
      existingRows = await existingRes.json()
    } catch {
      console.warn('[p2pService] P2P backfill skipped — existing activity response was unparseable')
      return
    }
    if (!Array.isArray(existingRows)) return

    // A row we cannot key contributes nothing — previously such a row produced
    // the key "<type>:" and could mark an unrelated event as covered.
    const refOf = (m: any): string => m?.tradeId || m?.offerId || ''
    const covered = new Set(
      existingRows
        .filter(r => refOf(r.metadata))
        .map(r => `${r.activity_type}:${refOf(r.metadata)}`),
    )
    // An unkeyable candidate is treated as already-covered, i.e. skipped: better
    // to miss one backfill row than to write one that can never be deduped.
    const already = (type: string, refId: string) => !refId || covered.has(`${type}:${refId}`)

    // How much of a given offer actually sold, from the trade table (the source
    // of truth) rather than the escrow_balance snapshot column.
    const soldAgainstOffer = (offerId: string) => trades
      .filter(t => t.offerId === offerId && (t.status === 'completed' || t.status === 'released'))
      .reduce((sum, t) => sum + (t.amountUsdc || 0), 0)

    // Every write goes through saveP2PActivity — the same choke point the live
    // paths use, so the "no hash, no row" invariant holds identically here. The
    // gates below already require the proving hash, so a false return means a
    // genuine write failure, not a skip; one is enough to withhold the latch.
    let everyWriteSucceeded = true
    const emit = async (params: Parameters<typeof saveActivity>[0]): Promise<void> => {
      const ok = await saveP2PActivity(params)
      if (!ok) {
        everyWriteSucceeded = false
        console.warn('[p2pService] P2P backfill write failed, will retry next visit:', params.activityType)
      }
    }

    for (const o of offers) {
      if (o.offerType !== 'sell') continue

      // Only record a lock we can prove: the deposit hash IS the proof.
      if (o.escrowDepositTxHash && !already('p2p_sell_order', o.id)) {
        await emit({
          walletAddress: o.walletAddress, userId: o.userId, txHash: o.escrowDepositTxHash,
          activityType: 'p2p_sell_order', amount: o.maxAmount, status: 'completed',
          metadata: { offerId: o.id, kind: 'offer_created', backfilled: true },
        })
      }

      // A refund row must describe funds that actually came back. Requires the
      // withdrawal hash, and an amount that is still escrowed after subtracting
      // whatever genuinely sold — never the bare offer ceiling, which overstates
      // any partially-filled offer.
      if (o.status === 'cancelled' && o.escrowWithdrawTxHash && !already('p2p_refund', o.id)) {
        const refunded = Math.max(0, (o.maxAmount || 0) - soldAgainstOffer(o.id))
        if (refunded > 0) {
          await emit({
            walletAddress: o.walletAddress, userId: o.userId, txHash: o.escrowWithdrawTxHash,
            activityType: 'p2p_refund', amount: refunded, status: 'completed',
            metadata: { offerId: o.id, kind: 'offer_cancelled', backfilled: true },
          })
        }
      }
    }

    for (const t of trades) {
      const isBuyer   = t.buyerId === userId
      const completed = t.status === 'completed' || t.status === 'released'
      // t.txHash is the release transaction — the buyer genuinely received USDC,
      // and it is recorded on the trade row, so this one IS provable.
      if (isBuyer && completed && t.txHash && !already('p2p_purchase', t.id)) {
        await emit({
          walletAddress: t.buyerWallet, userId: t.buyerId, txHash: t.txHash,
          activityType: 'p2p_purchase', amount: t.amountUsdc, status: 'completed',
          metadata: { tradeId: t.id, offerId: t.offerId, backfilled: true },
        })
      }
    }

    // Latch ONLY on a fully clean run. A partial run leaves the latch unset so
    // the next visit retries the shortfall; retrying is safe because every row
    // carries a tx_hash and the DB constraint absorbs the repeat.
    if (everyWriteSucceeded) markBackfillDone(wallet)
  } catch (e: any) {
    console.warn('[p2pService] backfillP2PActivity failed:', e?.message)
  }
}

/**
 * Reports whether the write actually landed.
 *
 * BUG THIS FIXES: this used to be `await fetch(...)` with no result check and a
 * `Promise<void>` return. `await fetch` resolves for ANY status, so a 4xx/5xx —
 * RLS rejection, expired token, PostgREST error — was silently discarded. That
 * mattered most for the one call that matters most: releaseTrade's compensating
 * revert. When it failed, the trade stayed claimed as 'released' with no funds
 * sent, the offer stayed locked by locked_by_trade_id, and nothing anywhere
 * noticed. Two production trades ended up in exactly that state.
 *
 * Compare updateTradeStatusIf below, which always checked res.ok — the claim was
 * verified, the release of that claim was not.
 */
async function updateTradeStatus(tradeId: string, fields: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/p2p_trades?id=eq.${tradeId}`, {
      method: 'PATCH',
      headers: { ...(await authHeaders()), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify(fields),
    })
    if (!res.ok) {
      console.error('[p2pService] updateTradeStatus FAILED', res.status, tradeId, Object.keys(fields).join(','))
      return false
    }
    return true
  } catch (e: any) {
    console.error('[p2pService] updateTradeStatus threw', tradeId, e?.message)
    return false
  }
}

/**
 * Same as updateTradeStatus, but only applies if the row's current status
 * is still one of `allowedStatuses` at write time — a conditional PATCH
 * (PostgREST turns the extra query filter into a WHERE clause) so a status
 * change that lands between our last read and this write (e.g. the buyer
 * marks paid a moment after we loaded the trade) can't be silently
 * clobbered. Returns whether the row actually matched and updated.
 */
async function updateTradeStatusIf(tradeId: string, allowedStatuses: TradeStatus[], fields: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`${SUPA_URL}/rest/v1/p2p_trades?id=eq.${tradeId}&status=in.(${allowedStatuses.join(',')})`, {
    method: 'PATCH',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify(fields),
  })
  if (!res.ok) return false
  const rows = await res.json()
  return Array.isArray(rows) && rows.length > 0
}

export const CANCEL_BLOCKED_MESSAGE =
  'This trade can no longer be cancelled because the counterparty has already fulfilled their obligation. Please complete the trade or open a dispute.'

// Exact copy the UI shows anywhere a disputed trade blocks an action —
// keep this the single source of truth so every surface (cancel, pay,
// release, the trade-detail lock banner) says the same thing.
export const DISPUTE_LOCKED_MESSAGE =
  'This trade is currently under dispute and is locked until an administrator resolves it.'

/**
 * Same idea as updateTradeStatusIf, generalized to any column — used to
 * atomically CLAIM a transition before doing anything irreversible (moving
 * funds, flipping a dispute's resolution) so a second concurrent call
 * (double-click, retried request, a second open tab) sees the row no
 * longer matches its precondition and safely no-ops instead of repeating
 * the side effect. This is the actual fix for the double-release bug:
 * previously releaseTrade()/adminResolveDispute() called escrowProvider
 * FIRST and only updated the row afterwards, so nothing stopped two
 * near-simultaneous calls from both passing their (stale) precondition
 * check and both calling escrowProvider.release().
 */
async function updateTradeIf(tradeId: string, column: string, value: string, fields: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`${SUPA_URL}/rest/v1/p2p_trades?id=eq.${tradeId}&${column}=eq.${encodeURIComponent(value)}`, {
    method: 'PATCH',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify(fields),
  })
  if (!res.ok) return false
  const rows = await res.json()
  return Array.isArray(rows) && rows.length > 0
}

/**
 * Single source of truth for "can this trade still be cancelled" — the
 * Cancel button's visibility, cancelTrade() itself, and adminCancelTrade()
 * all defer to this instead of each re-deriving the rule independently.
 * The DB trigger added alongside this fix (see
 * supabase/migrations/20260729120000_p2p_trade_cancellation_guard.sql)
 * mirrors the same logic as a hard backstop for any write that doesn't go
 * through this module at all (a direct REST call, another client, etc.).
 *
 * Sell-offer trades: the seller's escrow was deposited back at OFFER
 * creation time, before this trade ever existed — so on its own it doesn't
 * block anyone. The buyer's "I've Paid" tap is what fulfills THEIR
 * obligation; once that lands (status -> payment_sent) neither side can
 * cancel anymore, matching the spec: "Once payment_sent, the seller can no
 * longer cancel."
 *
 * Buy-offer trades: accepting a buy offer deposits the seller's escrow
 * synchronously inside createTrade() (see the `if (p.offer.offerType ===
 * 'buy')` block above) — there is no possible state where a buy-offer
 * trade exists in the database and the seller hasn't already fulfilled
 * that obligation. So per spec ("After the seller has fulfilled their
 * obligation, the buyer can no longer cancel"), the buyer is blocked from
 * the moment the trade exists, not just after payment_sent.
 */
export function canCancelTrade(trade: P2PTrade, actorId: string): { allowed: boolean; reason: string } {
  if (trade.status !== 'waiting_for_buyer' && trade.status !== 'payment_sent') {
    return { allowed: false, reason: 'This trade is no longer active.' }
  }
  const isBuyer = actorId === trade.buyerId
  const isSeller = actorId === trade.sellerId
  if (!isBuyer && !isSeller) {
    return { allowed: false, reason: 'You are not a party to this trade.' }
  }
  // Disputed trades are locked to both parties, full stop — only an admin
  // can move them from here (see adminResolveDispute / the DB-level
  // p2p_enforce_dispute_lock trigger, which is the real backstop for this).
  if (trade.disputeStatus === 'open') {
    return { allowed: false, reason: DISPUTE_LOCKED_MESSAGE }
  }
  if (trade.adminFrozen) {
    return { allowed: false, reason: 'This trade is under admin review — only support can resolve it now.' }
  }
  // The buyer already fulfilled their own obligation (payment sent) —
  // from here the trade must be released or disputed, never cancelled.
  if (trade.status === 'payment_sent') {
    return { allowed: false, reason: CANCEL_BLOCKED_MESSAGE }
  }
  // Buy-offer trades: seller's obligation (escrow deposit) is already done
  // by the time the trade exists, so the buyer can never cancel it.
  if (isBuyer && trade.offerType === 'buy') {
    return { allowed: false, reason: CANCEL_BLOCKED_MESSAGE }
  }
  return { allowed: true, reason: '' }
}

export async function cancelTrade(trade: P2PTrade, reason: string, actorId: string): Promise<{ success: boolean; message: string }> {
  const check = canCancelTrade(trade, actorId)
  if (!check.allowed) return { success: false, message: check.reason }

  const updated = await updateTradeStatusIf(trade.id, ['waiting_for_buyer', 'payment_sent'], { status: 'cancelled', cancel_reason: reason })
  if (!updated) {
    // Status moved out from under us (e.g. buyer just marked paid) — the
    // conditional PATCH only fails this way when the row is no longer in
    // a cancellable state.
    return { success: false, message: CANCEL_BLOCKED_MESSAGE }
  }
  await unlockOffer(trade.offerId)
  const refundResult = await escrowProvider.refund(trade).catch(() => null)
  // Only a buy-offer trade actually moves funds here — see refund()'s own
  // doc comment in p2pProviders.ts: a sell-offer trade's refund is a
  // correct no-op (escrow lives at the offer level, already accounted for
  // as a '-' at offer-creation time, and stays put for the next trade
  // against that same offer).
  if (refundResult?.success && trade.offerType === 'buy') {
    await saveP2PActivity({
      walletAddress: trade.sellerWallet, userId: trade.sellerId, txHash: refundResult.txHash,
      activityType: 'p2p_refund', amount: trade.amountUsdc, status: 'completed',
      metadata: { tradeId: trade.id, kind: 'trade_cancelled' },
    })
  }
  await sendTradeMessage(trade.id, 'system', `Trade cancelled — ${reason}`, true)
  return { success: true, message: 'Trade cancelled.' }
}

/**
 * Lets either party flag a trade for admin review instead of cancelling —
 * the escape hatch the spec requires to stay available for the whole
 * lifetime of an active trade, including once cancellation is no longer
 * possible (e.g. seller claiming payment was never actually received).
 * Freezes the trade so release/pay actions pause until an admin resolves
 * it via adminResolveDispute.
 */
export async function openDispute(trade: P2PTrade, actorId: string, reason: string): Promise<{ success: boolean; message: string }> {
  if (actorId !== trade.buyerId && actorId !== trade.sellerId) {
    return { success: false, message: 'You are not a party to this trade.' }
  }
  if (trade.status !== 'waiting_for_buyer' && trade.status !== 'payment_sent') {
    return { success: false, message: 'This trade is no longer active.' }
  }
  if (trade.disputeStatus === 'open') {
    return { success: false, message: DISPUTE_LOCKED_MESSAGE }
  }
  await updateTradeStatus(trade.id, { dispute_status: 'open', dispute_reason: reason, admin_frozen: true })
  // Best-effort on-chain freeze, in addition to the DB flag above. The DB
  // flag + the p2p_enforce_dispute_lock trigger are what actually gate
  // every UI/API path in THIS app — but the contract's own tradeFrozen
  // check is what stops release() from succeeding if someone calls it
  // directly against the contract, bypassing this app entirely. Genuinely
  // non-fatal if it can't go through right now (no escrow contract
  // configured, this device has no signing key, network hiccup) — the DB
  // lock still holds for every normal path; an admin can freeze on-chain
  // separately from the admin console if this attempt didn't land.
  await freezeTradeOnChainBestEffort(trade.id)
  await sendTradeMessage(trade.id, 'system', `Dispute opened: ${reason}`, true)
  const otherPartyId = actorId === trade.buyerId ? trade.sellerId : trade.buyerId
  notifyP2P(otherPartyId, 'Dispute Opened', 'A dispute was opened on your trade — our team will review it shortly.')
  return { success: true, message: 'Dispute opened. Our team will review and reach out.' }
}

/**
 * Shared best-effort wrapper for calling the contract's freezeTrade —
 * used by both openDispute (a party opens a dispute) and adminFreezeTrade
 * (an admin manually freezes from the console). Always signs with
 * whatever wallet is active on THIS device (see p2pEscrowContract.ts) —
 * never a backend-held key. If the signer isn't the contract's configured
 * admin address, the on-chain call reverts and this just logs it; the
 * app-level DB lock (which every UI path actually enforces) is unaffected.
 */
async function freezeTradeOnChainBestEffort(tradeId: string): Promise<void> {
  try {
    const { isEscrowContractDeployed, freezeTradeOnChain } = await import('./p2pEscrowContract')
    if (!isEscrowContractDeployed()) return
    const { useAuthStore } = await import('../store')
    const { privateKey } = useAuthStore.getState()
    if (!privateKey) return
    await freezeTradeOnChain(privateKey, tradeId)
  } catch (e) {
    console.error('[p2pService] on-chain freezeTrade failed (non-fatal, DB lock still applies):', e)
  }
}

async function unfreezeTradeOnChainBestEffort(tradeId: string): Promise<void> {
  try {
    const { isEscrowContractDeployed, unfreezeTradeOnChain } = await import('./p2pEscrowContract')
    if (!isEscrowContractDeployed()) return
    const { useAuthStore } = await import('../store')
    const { privateKey } = useAuthStore.getState()
    if (!privateKey) return
    await unfreezeTradeOnChain(privateKey, tradeId)
  } catch (e) {
    console.error('[p2pService] on-chain unfreezeTrade failed (non-fatal):', e)
  }
}

// Timeout expiry is deliberately scoped to 'waiting_for_buyer' only — the
// same window canCancelTrade() treats as still-cancellable. It is not a
// party unilaterally cancelling; it's the system resolving a trade where
// the buyer never fulfilled THEIR obligation (payment) within the window,
// refunding the seller's escrow. It can never fire on a payment_sent trade
// (buyer already fulfilled their side) or a buy-offer trade past creation
// in a way that harms the seller — the seller's escrow is what gets
// returned to them, never taken from them.
export async function autoCancelExpiredTrades(userId: string): Promise<void> {
  const trades = await fetchMyTrades(userId)
  const expired = trades.filter(t => t.status === 'waiting_for_buyer' && new Date(t.expiresAt).getTime() < Date.now())
  for (const t of expired) {
    await updateTradeStatus(t.id, { status: 'expired' })
    await unlockOffer(t.offerId)
    const refundResult = await escrowProvider.refund(t).catch(() => null)
    if (refundResult?.success && t.offerType === 'buy') {
      await saveP2PActivity({
        walletAddress: t.sellerWallet, userId: t.sellerId, txHash: refundResult.txHash,
        activityType: 'p2p_refund', amount: t.amountUsdc, status: 'completed',
        metadata: { tradeId: t.id, kind: 'trade_expired' },
      })
    }
    await sendTradeMessage(t.id, 'system', 'Trade expired — payment window closed.', true)
    notifyP2P(t.buyerId, 'Trade Expired', 'Your payment window closed before payment was marked sent.')
    notifyP2P(t.sellerId, 'Trade Expired', 'The buyer\u2019s payment window closed. Your offer is available again.')
  }
}

export function isTradeExpired(trade: P2PTrade): boolean {
  return trade.status === 'waiting_for_buyer' && new Date(trade.expiresAt).getTime() < Date.now()
}

// ── Stuck-release reconciliation ─────────────────────────────────────────────
//
// A release is a two-part operation: claim the trade ('payment_sent' →
// 'released'), then move funds on-chain. releaseTrade now compensates on every
// failure path it can see, but it cannot compensate for what it never gets to
// run — a closed tab, a killed process, or a lost connection between the claim
// and the revert. That window is small but real, and two production trades fell
// into it: status 'released', released_at NULL, completed_at NULL, tx_hash NULL,
// and the offer left locked by locked_by_trade_id forever.
//
// A completed release always writes released_at and completed_at alongside
// status='completed', so `status='released' AND released_at IS NULL` is an
// unambiguous signature for the stuck state. This pass finds those and repairs
// them using the CONTRACT as the source of truth, never an inference.

// The repair policy itself lives in stuckReleasePolicy.ts — pure, dependency
// free, and shared by name with the scheduled server-side reconciler
// (supabase/functions/p2p-release-reconcile), whose mirror copy is held to this
// one by stuckReleasePolicy.parity.test.ts. Re-exported from the single import at
// the top of this file so existing callers and tests keep importing these from
// p2pService unchanged, without naming the module twice.
export { classifyStuckRelease, STUCK_RELEASE_GRACE_MS, parseActivationCutoff, isEligibleForReconcile }
export type { StuckReleaseVerdict, StuckReleaseProbe, StuckReleaseDecision }

export interface StuckReleaseOutcome {
  tradeId: string
  amountUsdc: number
  verdict: StuckReleaseVerdict
  reason: string
  applied: boolean
}

/** A trade is only considered stuck once this long has passed since the claim. */

/**
 * Finds this user's stuck releases and repairs the ones that can be repaired
 * safely. Follows the same shape as autoCancelExpiredTrades — a per-user sweep,
 * scoped to trades the caller is party to, safe to run on page mount.
 *
 * This is the FALLBACK path. It only runs while a user has the P2P page open, so
 * it cannot be relied on (a seller who never returns leaves a buyer waiting
 * indefinitely) — supabase/functions/p2p-release-reconcile is the reliable one.
 * Both are gated by the same fail-closed activation boundary, so neither can
 * sweep historical trades that predate activation.
 *
 * Never sends a transaction and never moves funds.
 */
export async function reconcileStuckReleases(
  userId: string,
  opts?: { graceMs?: number; cutoffIso?: string; skipTradeIds?: string[] },
): Promise<StuckReleaseOutcome[]> {
  const graceMs = opts?.graceMs ?? STUCK_RELEASE_GRACE_MS
  // Unset => dormant. Deliberately fail-closed: the client sweep must not sweep
  // history just because someone opened the P2P page.
  const cutoffMs = parseActivationCutoff(
    opts?.cutoffIso ?? (import.meta.env.VITE_P2P_RECONCILE_AFTER as string | undefined),
  )
  const skipTradeIds = opts?.skipTradeIds ?? []
  const outcomes: StuckReleaseOutcome[] = []
  if (cutoffMs === null) return outcomes   // nothing configured, nothing to do

  try {
    const trades = await fetchMyTrades(userId)
    const nowMs = Date.now()
    // The stuck signature: claimed as released, but the release never finished.
    const stuck = trades.filter(t =>
      t.status === 'released' && !t.releasedAt && !t.completedAt &&
      isEligibleForReconcile({
        tradeId: t.id, createdAtIso: t.createdAt, cutoffMs, graceMs, nowMs, skipTradeIds,
      }).eligible)
    if (stuck.length === 0) return outcomes

    const { probeTradeReleasedOnChain, probeEscrowRemaining } = await import('./p2pEscrowContract')

    for (const t of stuck) {
      // Buy-offer trades escrow into a TRADE-keyed bucket; sell-offer trades
      // draw from the OFFER's pool. Probe whichever one actually holds funds.
      const escrowKeyId = t.offerType === 'buy' ? t.id : t.offerId
      const [onChainReleased, escrowRemaining] = await Promise.all([
        probeTradeReleasedOnChain(t.id),
        probeEscrowRemaining(escrowKeyId),
      ])
      const offer = await fetchOfferById(t.offerId).catch(() => null)
      const everDeposited = t.offerType === 'buy'
        ? Boolean(t.txHash)                       // trade-level deposit hash, if it was ever stored
        : Boolean(offer?.escrowDepositTxHash)

      const { verdict, reason } = classifyStuckRelease({
        onChainReleased, escrowRemaining, everDeposited, amountUsdc: t.amountUsdc,
      })

      let applied = false
      if (verdict === 'finalize') {
        const now = new Date().toISOString()
        // tx_hash is deliberately left as-is: we know the release happened but
        // not which transaction did it, and inventing one would be worse than
        // leaving it blank. saveP2PActivity would refuse a hashless row anyway.
        applied = await updateTradeStatus(t.id, { status: 'completed', released_at: now, completed_at: now })
        if (applied) await unlockOffer(t.offerId)
      } else if (verdict === 'restore') {
        applied = await updateTradeStatus(t.id, { status: 'payment_sent' })
        // The offer stays locked on purpose — the trade is live again.
      } else if (verdict === 'cancel') {
        applied = await updateTradeStatus(t.id, {
          status: 'cancelled',
          cancel_reason: 'Escrow was never funded — release could not be completed',
        })
        if (applied) await unlockOffer(t.offerId)
      }
      // 'investigate' applies nothing, by design.

      if (verdict !== 'investigate') {
        console.warn('[p2pService] reconcileStuckReleases:', t.id, verdict, applied ? 'applied' : 'FAILED TO APPLY', '—', reason)
      } else {
        console.warn('[p2pService] reconcileStuckReleases:', t.id, 'INVESTIGATE —', reason)
      }
      outcomes.push({ tradeId: t.id, amountUsdc: t.amountUsdc, verdict, reason, applied })
    }
  } catch (e: any) {
    console.warn('[p2pService] reconcileStuckReleases failed:', e?.message)
  }
  return outcomes
}

export async function markPaymentSent(trade: P2PTrade): Promise<{ success: boolean; message: string }> {
  if (trade.disputeStatus === 'open') return { success: false, message: DISPUTE_LOCKED_MESSAGE }
  if (trade.adminFrozen) return { success: false, message: 'This trade has been frozen by an admin.' }
  if (trade.status !== 'waiting_for_buyer') {
    return { success: false, message: 'Payment has already been marked for this trade.' }
  }

  const result = await paymentProvider.confirmPayment(trade)
  if (!result.success) return result

  // Claim the transition atomically — only succeeds if the row is still
  // 'waiting_for_buyer' at write time, so a double-tap on "I've Paid" (or
  // any other concurrent call) can only ever mark payment once. The DB
  // trigger added in 20260729140000 additionally blocks this entirely once
  // a dispute is open, regardless of what this JS check saw.
  const claimed = await updateTradeStatusIf(trade.id, ['waiting_for_buyer'], { status: 'payment_sent', payment_sent_at: new Date().toISOString() })
  if (!claimed) {
    return { success: false, message: 'Payment has already been marked for this trade.' }
  }
  await sendTradeMessage(trade.id, 'system', result.message, true)
  notifyP2P(trade.sellerId, 'Buyer Marked Paid', `Buyer marked payment sent for ${trade.amountUsdc} USDC. Review and release when ready.`)
  return result
}

export async function releaseTrade(trade: P2PTrade): Promise<{ success: boolean; message: string }> {
  if (trade.disputeStatus === 'open') return { success: false, message: DISPUTE_LOCKED_MESSAGE }
  if (trade.adminFrozen) return { success: false, message: 'This trade has been frozen by an admin.' }

  // Claim the release BEFORE touching escrow at all. Previously
  // escrowProvider.release() ran first and the status only got updated
  // afterwards — nothing stopped a double-click, a retried network
  // request, or two open tabs on the same trade from each seeing
  // status === 'payment_sent', each calling escrowProvider.release(), and
  // USDC actually moving twice. This conditional PATCH only succeeds for
  // the ONE caller that wins the race (status still 'payment_sent' at
  // write time); every other concurrent caller gets `claimed === false`
  // and returns immediately, before escrowProvider is ever touched again.
  const claimed = await updateTradeStatusIf(trade.id, ['payment_sent'], { status: 'released' })
  if (!claimed) {
    return { success: false, message: 'This trade has already been released or is no longer awaiting release.' }
  }

  // Everything from here on is inside the claim window: the trade now says
  // 'released' while no funds have moved yet. Any exit path that leaves it that
  // way permanently is the bug that stranded two production trades, so the whole
  // window is wrapped — a throw must not be able to skip the compensation.
  let result: { success: boolean; txHash?: string; message: string }
  try {
    result = await escrowProvider.release(trade)
  } catch (e: any) {
    // escrowProvider.release is written to catch internally and return
    // {success:false}, but it is not the only thing that can throw here (a
    // dynamic import, a wallet-store read). Previously a throw propagated
    // straight out of this function and the revert below never ran.
    console.error('[p2pService] releaseTrade: escrow release threw', trade.id, e?.message)
    result = { success: false, message: e?.message ?? 'Release failed unexpectedly — please try again.' }
  }

  if (result.success) {
    const now = new Date().toISOString()
    const finalized = await updateTradeStatus(trade.id, { status: 'completed', released_at: now, completed_at: now, tx_hash: result.txHash ?? null })
    if (!finalized) {
      // The USDC HAS moved on-chain but the row could not be finalized. Do NOT
      // revert the claim — that would invite a second release of the same funds.
      // Leave it claimed and let reconcileStuckReleases finalize it: the
      // contract's own tradeReleased flag will prove the release happened.
      console.error('[p2pService] releaseTrade: on-chain release SUCCEEDED but finalize failed — reconciler will repair', trade.id, result.txHash)
    }
    await unlockOffer(trade.offerId)
    await retireOfferIfDepleted(trade.offerId)
    await sendTradeMessage(trade.id, 'system', `USDC released${result.txHash ? ` — tx ${result.txHash.slice(0, 10)}...` : ''}. Trade complete.`, true)
    notifyP2P(trade.buyerId, 'Funds Released', `The seller released ${trade.amountUsdc} USDC to your wallet.`)
    await saveP2PActivity({
      walletAddress: trade.buyerWallet, userId: trade.buyerId, txHash: result.txHash,
      activityType: 'p2p_purchase', amount: trade.amountUsdc, status: 'completed',
      metadata: { tradeId: trade.id, offerId: trade.offerId },
    })
  } else {
    // The claim succeeded but no funds moved — release the claim so the seller
    // can retry. If even THIS write fails the trade is stuck; say so plainly
    // rather than reporting a bare failure, and let the reconciler pick it up.
    const reverted = await updateTradeStatus(trade.id, { status: 'payment_sent' })
    if (!reverted) {
      console.error('[p2pService] releaseTrade: revert FAILED — trade left claimed, reconciler will repair', trade.id)
      return {
        success: false,
        message: `${result.message} The trade could not be returned to its previous state automatically; it will be repaired shortly.`,
      }
    }
  }
  return result
}

export async function sendTradeMessage(tradeId: string, senderId: string, content: string, isSystem = false): Promise<void> {
  await fetch(`${SUPA_URL}/rest/v1/p2p_trade_messages`, {
    method: 'POST',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ trade_id: tradeId, sender_id: senderId, content, is_system: isSystem }),
  })
}

export async function fetchTradeMessages(tradeId: string): Promise<P2PMessage[]> {
  const res = await fetch(`${SUPA_URL}/rest/v1/p2p_trade_messages?trade_id=eq.${tradeId}&order=created_at.asc`, { headers: await authHeaders() })
  if (!res.ok) return []
  const rows = await res.json()
  return (rows as any[]).map(messageFromRow)
}

export function subscribeToTradeMessages(tradeId: string, onMessage: (m: P2PMessage) => void): () => void {
  return subscribeWithRetry(supabase, `p2p-trade-${tradeId}`, channel =>
    channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'p2p_trade_messages', filter: `trade_id=eq.${tradeId}` },
      (payload: any) => onMessage(messageFromRow(payload.new))))
}

export function subscribeToTradeUpdates(tradeId: string, onUpdate: (t: P2PTrade) => void): () => void {
  return subscribeWithRetry(supabase, `p2p-trade-status-${tradeId}`, channel =>
    channel.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'p2p_trades', filter: `id=eq.${tradeId}` },
      (payload: any) => onUpdate(tradeFromRow(payload.new))))
}

export async function submitRating(p: { tradeId: string; raterId: string; ratedId: string; rating: number; comment?: string }): Promise<void> {
  await fetch(`${SUPA_URL}/rest/v1/p2p_ratings`, {
    method: 'POST',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json', 'Prefer': 'return=minimal,resolution=ignore-duplicates' },
    body: JSON.stringify({ trade_id: p.tradeId, rater_id: p.raterId, rated_id: p.ratedId, rating: p.rating, comment: p.comment ?? null }),
  })
}

export async function fetchUserRating(userId: string): Promise<{ avg: number; count: number }> {
  const res = await fetch(`${SUPA_URL}/rest/v1/p2p_ratings?rated_id=eq.${encodeURIComponent(userId)}&select=rating`, { headers: await authHeaders() })
  if (!res.ok) return { avg: 0, count: 0 }
  const rows: Array<{ rating: number }> = await res.json()
  if (rows.length === 0) return { avg: 0, count: 0 }
  const avg = rows.reduce((s, r) => s + r.rating, 0) / rows.length
  return { avg: Math.round(avg * 10) / 10, count: rows.length }
}

export async function getUserReputation(userId: string): Promise<UserReputation> {
  const [tradesRes, userRes, offersRes] = await Promise.all([
    fetch(`${SUPA_URL}/rest/v1/p2p_trades?or=(buyer_id.eq.${encodeURIComponent(userId)},seller_id.eq.${encodeURIComponent(userId)})&select=status,seller_id,payment_sent_at,released_at`, { headers: await authHeaders() }),
    fetch(`${SUPA_URL}/rest/v1/users?id=eq.${encodeURIComponent(userId)}&select=created_at`, { headers: await authHeaders() }),
    fetch(`${SUPA_URL}/rest/v1/p2p_offers?user_id=eq.${encodeURIComponent(userId)}&is_verified_merchant=eq.true&select=id&limit=1`, { headers: await authHeaders() }),
  ])
  const trades: any[] = tradesRes.ok ? await tradesRes.json() : []
  const users: any[] = userRes.ok ? await userRes.json() : []
  const merchantOffers: any[] = offersRes.ok ? await offersRes.json() : []

  const totalTrades = trades.length
  const completed = trades.filter(t => t.status === 'completed').length
  const completionRate = totalTrades > 0 ? Math.round((completed / totalTrades) * 100) : 0

  const releaseTimes = trades
    .filter(t => t.seller_id === userId && t.payment_sent_at && t.released_at)
    .map(t => (new Date(t.released_at).getTime() - new Date(t.payment_sent_at).getTime()) / 1000)
  const avgReleaseSeconds = releaseTimes.length > 0 ? Math.round(releaseTimes.reduce((s, v) => s + v, 0) / releaseTimes.length) : null

  const accountAgeDays = users[0]?.created_at
    ? Math.floor((Date.now() - new Date(users[0].created_at).getTime()) / 86400000)
    : 0

  return {
    totalTrades, completionRate, avgReleaseSeconds,
    isVerifiedMerchant: merchantOffers.length > 0,
    accountAgeDays,
  }
}

export function formatReleaseTime(seconds: number | null): string {
  if (seconds === null) return 'No data yet'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${Math.round(seconds / 3600)}h`
}

// Superseded by the server-side p2p_notify_trade_event trigger (see
// supabase/migrations/20260730160000_p2p_notifications_system.sql) +
// lib/p2pNotifications.ts, which insert/deliver these same events for BOTH
// parties, cross-device, including while offline. This function only ever
// fired for the CURRENT browser session, and only when that session's
// logged-in user happened to equal the target userId — which in real
// two-different-people trading is never true, so it was already a no-op in
// production. Left in place (harmless) rather than ripped out mid-file;
// new call sites should not be added here.
function notifyP2P(userId: string, title: string, body: string): void {
  import('../store').then(({ useNotificationStore, useAuthStore }) => {
    if (useAuthStore.getState().user?.id !== userId) return
    useNotificationStore.getState().addNotification({ type: 'payment_received', title, body, isRead: false })
  }).catch(() => {})
}

export async function adminFetchAllActiveTrades(): Promise<P2PTrade[]> {
  const res = await fetch(
    `${SUPA_URL}/rest/v1/p2p_trades?status=in.(waiting_for_buyer,payment_sent)&order=created_at.desc&limit=200`,
    { headers: await authHeaders() },
  )
  if (!res.ok) return []
  const rows = await res.json()
  return (rows as any[]).map(tradeFromRow)
}

/** Live updates for the admin Trades panel — mirrors subscribeToAllOffers's own reasoning; no per-user filter, since this view is every active trade regardless of who's on it. */
export function subscribeToAllTrades(onChange: (trade: P2PTrade) => void): () => void {
  return subscribeWithRetry(supabase, 'p2p-admin-trades', channel =>
    channel.on('postgres_changes', { event: '*', schema: 'public', table: 'p2p_trades' },
      (payload: any) => onChange(tradeFromRow(payload.new ?? payload.old))))
}

export async function adminFreezeTrade(tradeId: string, frozen: boolean): Promise<void> {
  await updateTradeStatus(tradeId, { admin_frozen: frozen })
  // Mirror onto the contract itself — see freezeTradeOnChainBestEffort's
  // doc comment for why this matters even though the DB flag alone
  // already gates every UI/API path in this app.
  if (frozen) await freezeTradeOnChainBestEffort(tradeId)
  else await unfreezeTradeOnChainBestEffort(tradeId)
}

/**
 * Admin override for the manual "Cancel Trade" console action. Subject to
 * the same counterparty-fulfilled protection as everyone else UNLESS the
 * trade is already flagged for review (frozen, or has an open dispute) —
 * that's the signal an admin is actively investigating rather than
 * short-circuiting a trade the counterparty already did their part on.
 * To force-cancel a fulfilled trade, freeze it first (Freeze button) or
 * open/await a dispute, then cancel — same two-step pattern as any other
 * admin override in this codebase. Dispute-driven cancellations should
 * normally go through adminResolveDispute instead, which records the
 * resolution properly.
 */
export async function adminCancelTrade(trade: P2PTrade, note: string): Promise<{ success: boolean; message: string }> {
  const counterpartyFulfilled = trade.status === 'payment_sent' || trade.offerType === 'buy'
  if (counterpartyFulfilled && !trade.adminFrozen && trade.disputeStatus !== 'open') {
    return { success: false, message: 'Freeze this trade or open a dispute before cancelling — the counterparty has already fulfilled their obligation.' }
  }
  // Same double-fire guard as everywhere else that touches escrow: claim
  // the cancellation atomically first so two overlapping calls (double
  // click, retried request) can't both pass and both trigger
  // escrowProvider.refund().
  const claimed = await updateTradeStatusIf(trade.id, [trade.status], { status: 'cancelled', cancel_reason: 'Cancelled by admin', admin_note: note })
  if (!claimed) {
    return { success: false, message: 'This trade has already moved past a cancellable state.' }
  }
  await unlockOffer(trade.offerId)
  const refundResult = await escrowProvider.refund(trade).catch(() => null)
  if (refundResult?.success && trade.offerType === 'buy') {
    await saveP2PActivity({
      walletAddress: trade.sellerWallet, userId: trade.sellerId, txHash: refundResult.txHash,
      activityType: 'p2p_refund', amount: trade.amountUsdc, status: 'completed',
      metadata: { tradeId: trade.id, kind: 'admin_cancelled' },
    })
  }
  await sendTradeMessage(trade.id, 'system', 'Trade cancelled by admin.', true)
  return { success: true, message: 'Trade cancelled.' }
}

export async function adminResolveDispute(trade: P2PTrade, resolution: 'resolved_buyer' | 'resolved_seller', note: string): Promise<{ success: boolean; message: string }> {
  // Same double-fire hazard as releaseTrade(): claim the resolution
  // atomically — only succeeds while dispute_status is still 'open' at
  // write time — BEFORE calling escrowProvider. Without this, a
  // double-click on "Favor Buyer (Release)"/"Favor Seller" (or a retried
  // request) could each pass a stale check and each move funds. This claim
  // is also the actual mechanism behind "only an admin may resolve a
  // dispute": once it succeeds, dispute_status is no longer 'open', so the
  // DB-level p2p_enforce_dispute_lock trigger closes the window immediately
  // — there is no gap where a second resolution (by this admin or anyone
  // else) can slip through.
  const claimed = await updateTradeIf(trade.id, 'dispute_status', 'open', { dispute_status: resolution, admin_note: note, admin_frozen: false })
  if (!claimed) {
    return { success: false, message: 'This dispute has already been resolved.' }
  }

  if (resolution === 'resolved_buyer') {
    // Unfreeze on-chain BEFORE releasing — release() itself checks
    // tradeFrozen and would revert otherwise, since dispute-open already
    // froze this trade on-chain (see freezeTradeOnChainBestEffort).
    await unfreezeTradeOnChainBestEffort(trade.id)
    const result = await escrowProvider.release(trade)
    if (result.success) {
      await updateTradeStatus(trade.id, { status: 'completed', released_at: new Date().toISOString(), completed_at: new Date().toISOString(), tx_hash: result.txHash ?? null })
      await unlockOffer(trade.offerId)
      await retireOfferIfDepleted(trade.offerId)
      await saveP2PActivity({
        walletAddress: trade.buyerWallet, userId: trade.buyerId, txHash: result.txHash,
        activityType: 'p2p_purchase', amount: trade.amountUsdc, status: 'completed',
        metadata: { tradeId: trade.id, offerId: trade.offerId, kind: 'dispute_resolved_buyer' },
      })
    } else {
      // Escrow release failed after we already claimed the resolution —
      // reopen the dispute (re-frozen) so an admin can retry, rather than
      // leaving the trade permanently stuck "resolved" with no funds ever
      // actually sent to the buyer.
      await updateTradeStatus(trade.id, { dispute_status: 'open', admin_frozen: true })
      await freezeTradeOnChainBestEffort(trade.id)
      await sendTradeMessage(trade.id, 'system', `Dispute resolution failed — release did not complete: ${result.message}`, true)
      return { success: false, message: result.message }
    }
  } else {
    await unfreezeTradeOnChainBestEffort(trade.id)
    await updateTradeStatus(trade.id, { status: 'cancelled', cancel_reason: 'Dispute resolved in seller\u2019s favor' })
    await unlockOffer(trade.offerId)
    const refundResult = await escrowProvider.refund(trade).catch(() => null)
    if (refundResult?.success && trade.offerType === 'buy') {
      await saveP2PActivity({
        walletAddress: trade.sellerWallet, userId: trade.sellerId, txHash: refundResult.txHash,
        activityType: 'p2p_refund', amount: trade.amountUsdc, status: 'completed',
        metadata: { tradeId: trade.id, kind: 'dispute_resolved_seller' },
      })
    }
  }
  await sendTradeMessage(trade.id, 'system', `Dispute resolved by admin: ${note}`, true)
  return { success: true, message: 'Dispute resolved.' }
}

/**
 * Emergency stop for the whole escrow contract — blocks new deposits,
 * releases, and withdrawals contract-wide until unpaused. Signs with
 * whatever wallet is active on this device (the admin's own on-device
 * key, via useAuthStore) — the contract reverts if that isn't its
 * configured admin address, so this can never be used to force a pause
 * with anyone else's funds or authority.
 */
export async function adminPauseEscrow(): Promise<{ success: boolean; message: string }> {
  try {
    const { isEscrowContractDeployed, pauseEscrow } = await import('./p2pEscrowContract')
    if (!isEscrowContractDeployed()) return { success: false, message: 'No escrow contract configured.' }
    const { useAuthStore } = await import('../store')
    const { privateKey } = useAuthStore.getState()
    if (!privateKey) return { success: false, message: "Couldn't access your wallet on this device." }
    await pauseEscrow(privateKey)
    return { success: true, message: 'Escrow contract paused — deposits, releases, and withdrawals are blocked until unpaused.' }
  } catch (e: any) {
    return { success: false, message: e?.message ?? 'Could not pause the escrow contract.' }
  }
}

export async function adminUnpauseEscrow(): Promise<{ success: boolean; message: string }> {
  try {
    const { isEscrowContractDeployed, unpauseEscrow } = await import('./p2pEscrowContract')
    if (!isEscrowContractDeployed()) return { success: false, message: 'No escrow contract configured.' }
    const { useAuthStore } = await import('../store')
    const { privateKey } = useAuthStore.getState()
    if (!privateKey) return { success: false, message: "Couldn't access your wallet on this device." }
    await unpauseEscrow(privateKey)
    return { success: true, message: 'Escrow contract unpaused.' }
  } catch (e: any) {
    return { success: false, message: e?.message ?? 'Could not unpause the escrow contract.' }
  }
}

export async function adminFetchEscrowPaused(): Promise<boolean> {
  try {
    const { isEscrowPaused } = await import('./p2pEscrowContract')
    return await isEscrowPaused()
  } catch {
    return false
  }
}

/**
 * Surfaces the contract's actual authorized admin wallet so P2PAdminPage.tsx
 * can warn directly if the currently logged-in admin's own wallet doesn't
 * match it — release()/pause()/unpause() all require msg.sender===admin
 * on-chain, so a mismatch here means those actions will never work no
 * matter how many times they're retried, regardless of whether this
 * device's wallet is unlocked.
 */
export async function adminFetchEscrowAdminAddress(): Promise<string | null> {
  try {
    const { getEscrowAdminAddress } = await import('./p2pEscrowContract')
    return await getEscrowAdminAddress()
  } catch {
    return null
  }
}

/**
 * P2PMeshportEscrow only — whether the given wallet currently has
 * PAUSER-level access (pause/unpause, freeze/unfreeze), separate from
 * full fund-moving ADMIN access. Always false against the old
 * single-admin P2PEscrow contract (no such concept there), which is the
 * correct fallback — P2PAdminPage.tsx falls back to the plain admin-match
 * check in that case.
 */
export async function adminFetchIsPauser(walletAddress: string): Promise<boolean> {
  try {
    const { checkIsPauser } = await import('./p2pEscrowContract')
    return await checkIsPauser(walletAddress)
  } catch {
    return false
  }
}

export async function adminBanUser(userId: string, reason: string, bannedBy: string): Promise<void> {
  await fetch(`${SUPA_URL}/rest/v1/p2p_banned_users`, {
    method: 'POST',
    headers: { ...(await authHeaders()), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ user_id: userId, reason, banned_by: bannedBy }),
  })
}

export async function adminUnbanUser(userId: string): Promise<void> {
  await fetch(`${SUPA_URL}/rest/v1/p2p_banned_users?user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'DELETE', headers: await authHeaders(),
  })
}
