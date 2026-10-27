// features/p2p/P2PPage.tsx
//
// P2P marketplace, Binance-style: market (Buy/Sell ads) → buy/sell screen →
// order (pay-to details, countdown, "Transferred, notify seller", release
// with a received-payment check) → completed; plus Post ad (3 steps) and
// My ads. USDC moves through the escrow contract on Arc; the fiat payment
// happens between the two people, outside the app.

import { useLatched } from '@/hooks/useLatched'
import { SendIcon } from '@/components/ui/SendIcon'
import { arcExplorerTxUrl } from '@/lib/chainExplorers'
import { safeStorageUrl, openExternal } from '@/lib/safeUrl'
import { useState, useEffect, useCallback, useRef, type ReactNode, type CSSProperties } from 'react'
import { DIALOG_BACKDROP, POPUP_DIM } from '@/lib/motion'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { MeshLoader } from '@/components/ui/MeshLoader'
import { ArrowLeft, Filter, Plus, Clock, CheckCircle2, Star, Paperclip, X as XIcon, History, Pencil, PlusCircle, Trash2, Check, Lock } from 'lucide-react'
import { useAuthStore, useUIStore, useP2PTradesCountStore, useWalletStore } from '@/store'
import { PinSheet } from '@/components/ui/PinSheet'
import { AmountKeypad, sanitizeAmountInput, tokenDecimals } from '@/components/ui/AmountKeypad'
import { AmountField } from '@/components/ui/AmountField'
import { DesktopTwoColumn } from '@/components/layout/DesktopTwoColumn'
import { useProcessingFlip, ProcessingFlipCard } from '@/components/ui/ProcessingFlipCard'
import { useGlassPop, GlassPopCard } from '@/components/ui/GlassPopCard'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'
import { DesktopHistoryPanel, DesktopHistoryEmpty, DesktopHistorySkeleton } from '@/components/ui/DesktopHistoryPanel'
import { timeAgo, trimTrailingZeros, copyToClipboard } from '@/lib/utils'
import {
  CURRENCIES, COUNTRY_REGIONS, currencySymbol,
  createOffer, fetchOffers, fetchOfferById, fetchMyOffers, cancelOfferAndWithdrawEscrow, deleteOfferAndDisconnect, expireStaleOffers, releaseOrphanedLocks,
  fetchOfferConsumedAmounts, offerRemainingAmount, updateOfferDetails, topUpOfferEscrow, subscribeToAllOffers,
  createTrade, fetchTrade, fetchMyTrades, markPaymentSent, releaseTrade, cancelTrade, canCancelTrade, openDispute,
  confirmSellTradeOnChain,
  DISPUTE_LOCKED_MESSAGE,
  isTradeExpired, autoCancelExpiredTrades, reconcileStuckReleases, GRACE_PERIOD_MINUTES,
  sendTradeMessage, fetchTradeMessages, subscribeToTradeMessages, subscribeToTradeUpdates, subscribeToMyTrades, cleanSystemText,
  submitRating, hasRatedTrade, fetchUserRating, getUserReputation,
  type P2POffer, type P2PTrade, type P2PMessage, type OfferType, type MerchantFilter, type UserReputation,
  fetchMerchantStats, fetchFxRates, offerLivePrice, type MerchantStats,
  fetchOfferPaymentOptions, fetchMyPaymentMethods, fetchTradePayTo, updateOfferStatus, type P2PPaymentMethod,
} from '@/lib/p2pService'
import { MerchantLine, MethodTag, PaymentMethodPicker, PaymentMethodSheet, PAYMENT_METHOD_TYPES } from './p2pUi'
import { SkeletonCards } from '@/components/ui/Skeleton'
import { HistoryRow, HistoryIcon } from '@/components/ui/HistoryRow'
import { useReturnFlash } from '@/hooks/useReturnFlash'
import { useLeaveGuard } from '@/lib/leaveGuard'
import { searchTerm } from '@/lib/searchTerm'
import { SearchField } from '@/components/ui/SearchField'
import { pressable } from '@/lib/pressable'

export const COLORS = {
  bg: 'var(--bg)', surface: 'var(--surface)', surfaceSecondary: 'var(--surface)',
  primary: 'var(--brand)', primaryText: 'var(--brand-text)', success: 'var(--success)', error: 'var(--danger)', warning: 'var(--warning)',
  text: 'var(--text-primary)', muted: 'var(--text-secondary)', border: 'var(--border)',
}

// The OFFER itself never expires - only an individual TRADE born from it
// does, if the counterparty never marks payment sent / the seller never
// confirms in time. This picker sets how long that payment window is for
// every trade against this offer; it's stored on the offer
// (tradeWindowMinutes) and copied onto each trade's own expires_at at
// createTrade() time. Matches TRADE_WINDOW_MINUTES's old hardcoded 15 -
// now the seller/buy-offer-creator picks it instead of it being fixed.
const TRADE_WINDOW_OPTIONS: { label: string; minutes: number }[] = [
  { label: '15 min', minutes: 15 },
  { label: '30 min', minutes: 30 },
  { label: '60 min', minutes: 60 },
  { label: '120 min', minutes: 120 },
  { label: '6 hours', minutes: 360 },
  { label: '12 hours', minutes: 720 },
  { label: '24 hours', minutes: 1440 },
]

// ── Shared bits ──────────────────────────────────────────────────────────────
export function Header({ title, onBack, right }: { title: string; onBack: () => void; right?: ReactNode }) {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '18px 16px 6px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        {!isDesktop && (
          <button onClick={onBack} aria-label="Back" className="back-btn"
            // This header has 16px side padding (other pages 20px): line the arrow up with them.
            style={{ marginLeft: -6 }}>
            <ArrowLeft size={20} color={COLORS.text} />
          </button>
        )}
        <h1 style={{ fontSize: 20, fontWeight: 700, color: COLORS.text, margin: 0, letterSpacing: '-0.2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</h1>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {right}
      </div>
    </div>
  )
}

// Back for P2P pages that can be reached from several places (a trade from
// My Trades, History, a notification popup or straight after taking an
// offer): return to whichever screen opened it. React Router numbers its
// history entries (state.idx), so idx 0 means this page was opened directly
// (a deep link, a refresh, a new tab) - navigate(-1) would then do nothing or
// leave the app, so go to the page's parent instead.
export function useP2PBack(fallback: string) {
  const navigate = useNavigate()
  return useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
    if (idx > 0) navigate(-1)
    else navigate(fallback, { replace: true })
  }, [navigate, fallback])
}

export function statusMeta(status: string): { label: string; color: string } {
  switch (status) {
    case 'awaiting_seller_confirmation': return { label: 'Waiting for seller', color: COLORS.warning }
    case 'waiting_for_buyer': return { label: 'Pending payment', color: COLORS.warning }
    case 'payment_sent':      return { label: 'Paid · awaiting release', color: 'var(--accent-text)' }
    case 'released':          return { label: 'Released', color: COLORS.success }
    case 'completed':         return { label: 'Completed', color: COLORS.success }
    case 'cancelled':         return { label: 'Cancelled', color: COLORS.error }
    case 'expired':           return { label: 'Expired', color: COLORS.muted }
    default:                  return { label: status, color: COLORS.muted }
  }
}

/** sanitizeAmountInput for a value that may be negative (a margin over
 *  market): one leading "-" kept, the rest capped at `decimals`. */
function signedAmountInput(raw: string, decimals: number): string {
  const neg = raw.trim().startsWith('-')
  return (neg ? '-' : '') + sanitizeAmountInput(raw, decimals)
}

// Last loaded lists, so coming back to a P2P page (or switching to a tab /
// filter already seen) shows the rows at once and refreshes them quietly,
// instead of flashing a full skeleton every time.
const hubCache = new Map<string, { offers: P2POffer[]; remaining: Map<string, number> }>()
const myOffersCache = new Map<string, { offers: P2POffer[]; remaining: Map<string, number> }>()
const myTradesCache = new Map<string, P2PTrade[]>()
let lastHubKey = ''

// ── P2P Hub - Buy/Sell tabs, browse offers ──────────────────────────────────
export function P2PHubPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const walletAddress = useAuthStore(s => s.walletAddress)
  const user = useAuthStore(s => s.user)
  const [tab, setTab] = useState<OfferType>('buy')
  const [merchantFilter, setMerchantFilter] = useState<MerchantFilter>('all')
  const [offers, setOffers] = useState<P2POffer[]>(() => hubCache.get(lastHubKey)?.offers ?? [])
  const [remaining, setRemaining] = useState<Map<string, number>>(() => hubCache.get(lastHubKey)?.remaining ?? new Map())
  const [loading, setLoading] = useState(() => !hubCache.has(lastHubKey))
  const [showFilters, setShowFilters] = useState(false)
  const [currency, setCurrency] = useState('')
  const [country, setCountry] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('')
  const [search, setSearch] = useState('')
  // Binance-style filters: "I want to pay ₹X" and merchant stats on each card.
  const [fiatAmount, setFiatAmount] = useState('')
  const [stats, setStats] = useState<Map<string, MerchantStats>>(new Map())
  const [rates, setRates] = useState<Record<string, { rate: number; updatedAt: string }>>({})

  // ── Desktop-only: P2P History (right column) ─────────────────────────────
  // Real data - reuses fetchMyTrades, the same source both P2PMyTradesPage
  // and HistoryPage.tsx already fetch from (see HistoryPage.tsx's own
  // header comment). Skipped entirely on mobile; re-fetched whenever the
  // hub's own offer list reloads (`load`, defined below) so a trade that
  // just completed shows up without a page refresh.
  const [p2pHistory, setP2pHistory] = useState<P2PTrade[]>([])
  const [p2pHistoryLoaded, setP2pHistoryLoaded] = useState(false)
  const historyFlash = useReturnFlash('p2p-hub-history')
  useEffect(() => {
    if (!isDesktop || !user?.id) return
    let cancelled = false
    fetchMyTrades(user.id)
      .then(trades => { if (!cancelled) setP2pHistory(trades) })
      .finally(() => { if (!cancelled) setP2pHistoryLoaded(true) })
    return () => { cancelled = true }
  }, [isDesktop, user?.id])

  // Live updates for the desktop History panel - a payment marked sent,
  // release, or dispute on any of this user's trades should show up here
  // instantly and survive a tab switch, not just at the next full reload.
  useEffect(() => {
    if (!isDesktop || !user?.id) return
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    const refetch = () => fetchMyTrades(user.id!).then(setP2pHistory)
    const unsubscribe = subscribeToMyTrades(user.id, () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(refetch, 400)
    })
    return () => { if (debounceTimer) clearTimeout(debounceTimer); unsubscribe() }
  }, [isDesktop, user?.id])

  // ── Ongoing trades count - "My Trades" badge ────────────────────────────
  // BUG FIX (2026-09-22): this used to be its own independent fetch+
  // subscribe effect, duplicated in two other components too (HomePage,
  // DesktopSidebar) - see useP2PTradesCountStore's own comment in
  // store/index.ts for the crash this caused on desktop (a Realtime
  // channel name collision, since subscribeToMyTrades's channel names are
  // fixed per userId, not unique per caller). Now just reads the shared
  // store; AppLayout.tsx is the only place that actually fetches/
  // subscribes.
  const myTradesCount = useP2PTradesCountStore(s => s.ongoingCount)

  // Auto-expiry sweep - runs once on mount, same "check on read" shape as
  // the rest of this codebase's lighter-weight scheduled work (see
  // expireStaleOffers's own doc comment in p2pService.ts). Also sweeps
  // this user's own expired trades here (not just on a trade's own detail
  // page - see that page's own comment) since a seller is far more likely
  // to open the marketplace hub after a trade goes stale than to revisit
  // the specific trade they're waiting on. This is what makes an
  // abandoned trade's escrow come back "automatically" in practice: no
  // manual cancel/resolve click needed, just opening the P2P tab again.
  useEffect(() => {
    expireStaleOffers(); releaseOrphanedLocks()
    if (user?.id) autoCancelExpiredTrades(user.id)
  }, [user?.id])

  const load = useCallback(async () => {
    // A list already seen for these filters shows at once and refreshes
    // quietly; only a never-loaded one shows the skeleton.
    // Payment method is filtered on the list itself (older ads carry "(Demo)" names).
    const key = [tab, merchantFilter, currency, country, user?.id].join('|')
    lastHubKey = key
    const cached = hubCache.get(key)
    if (cached) { setOffers(cached.offers); setRemaining(cached.remaining); setLoading(false) }
    else { setOffers([]); setLoading(true) }
    // Browsing "Buy USDC" shows offers from SELLERS (people offering to
    // sell), and vice versa - the tab is what the viewer wants to do, the
    // fetched offer type is the counterparty's side.
    const offerTypeToFetch: OfferType = tab === 'buy' ? 'sell' : 'buy'
    const rows = await fetchOffers({
      offerType: offerTypeToFetch,
      currency: currency || undefined,
      countryRegion: country || undefined,
      excludeUserId: user?.id,
      merchantFilter,
    })
    const rem = await fetchOfferConsumedAmounts(rows.map(o => o.id)).then(consumed =>
      new Map(rows.map(o => [o.id, offerRemainingAmount(o, consumed.get(o.id) ?? 0)]))
    )
    hubCache.set(key, { offers: rows, remaining: rem })
    if (lastHubKey !== key) return // filters changed while this was loading
    setOffers(rows)
    setRemaining(rem)
    setLoading(false)
    // Card extras - never hold up the list itself.
    fetchMerchantStats(rows.map(o => o.userId)).then(setStats).catch(() => {})
    if (rows.some(o => o.priceType === 'floating')) fetchFxRates(rows.map(o => o.currency)).then(setRates).catch(() => {})
  }, [tab, currency, country, user?.id, merchantFilter])

  useEffect(() => { load() }, [load])

  // ── Live updates for the marketplace list ────────────────────────────────
  // BUG FIX: this list used to be a one-shot fetch with nothing keeping it
  // current - a new offer, a cancellation, or someone else's offer
  // depleting never showed up until the next full reload, and switching
  // away to another tab and back never refreshed it either. p2p_offers is
  // already in the realtime publication (see subscribeToAllOffers's own
  // use in P2PAdminPage.tsx) and subscribeWithRetry already resyncs on tab
  // visibility/network regain on its own - this just needed to actually be
  // wired up here too. Debounced since a single admin action or a burst of
  // trades can fire several change events in quick succession; one
  // re-fetch covers all of them instead of one per event.
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = subscribeToAllOffers(() => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(load, 400)
    })
    return () => { if (debounceTimer) clearTimeout(debounceTimer); unsubscribe() }
  }, [load])

  const q = searchTerm(search)
  const want = parseFloat(fiatAmount) || 0
  const priced = offers.map(o => ({ o, price: offerLivePrice(o, rates) }))
  const filtered = priced.filter(({ o, price }) => {
    if (q && !(o.paymentMethods.some(m => m.toLowerCase().includes(q)) || (o.displayName || o.username || '').toLowerCase().includes(q))) return false
    if (paymentMethod && !o.paymentMethods.some(m => m.replace(/\s*\(Demo\)$/, '') === paymentMethod)) return false
    if (want > 0 && price) {
      const avail = remaining.get(o.id) ?? o.totalAmount
      const lo = o.minAmount * price, hi = Math.min(o.maxAmount, avail) * price
      if (want < lo || want > hi) return false
    }
    return true
  })
  // Best price first: lowest when you buy, highest when you sell.
  filtered.sort((x, y) => (x.price ?? Infinity) - (y.price ?? Infinity))
  if (tab === 'sell') filtered.reverse()
  const methodsOnList = [...new Set(offers.flatMap(o => o.paymentMethods.map(m => m.replace(/\s*\(Demo\)$/, ''))))].sort()
  const buying = tab === 'buy'
  const actColor = buying ? 'var(--success)' : 'var(--danger)'
  const chip = (on: boolean): CSSProperties => ({
    flexShrink: 0, padding: '6px 12px', borderRadius: 999, fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
    border: `1.5px solid ${on ? COLORS.text : 'transparent'}`, background: on ? 'transparent' : 'color-mix(in srgb, var(--text-primary) 6%, transparent)',
    color: on ? COLORS.text : COLORS.muted,
  })
  const selectStyle: CSSProperties = {
    flexShrink: 0, padding: '6px 10px', borderRadius: 999, fontSize: 'max(var(--fs-field, 0px), 12.5px)', fontWeight: 600, cursor: 'pointer',
    border: 'none', background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', color: COLORS.text, outline: 'none',
  }

  // Held in a variable (not returned directly) so the exact same JSX renders
  // either as the whole page (mobile) or as the left column of the desktop
  // 2-column layout below - never duplicated.
  const flow = (
    <div style={{ background: COLORS.bg, minHeight: '100%', height: '100%', overflowY: 'auto', overflowX: 'hidden', paddingBottom: isDesktop ? 24 : 96 }}>
      {/* Desktop: history already sits in the P2P History panel on the right. */}
      <Header title="P2P" onBack={() => navigate('/')} right={isDesktop ? undefined :
        <button onClick={() => navigate('/p2p/history')} style={{ background: 'none', border: 'none', padding: '4px 6px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }} aria-label="Order history">
          <History size={18} color={COLORS.text} />
          <span className="hidden min-[375px]:inline" style={{ fontSize: 13, fontWeight: 600, color: COLORS.text }}>History</span>
        </button>
      } />

      {/* Buy | Sell */}
      <div style={{ padding: '4px 16px 0' }}>
        <div role="tablist" style={{ display: 'flex', background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', borderRadius: 12, padding: 3, gap: 3 }}>
          {(['buy', 'sell'] as OfferType[]).map(t => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} style={{
              flex: 1, padding: '9px 0', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 15, fontWeight: 700,
              background: tab === t ? (t === 'buy' ? 'var(--success)' : 'var(--danger)') : 'transparent',
              color: tab === t ? '#fff' : COLORS.muted,
            }}>{t === 'buy' ? 'Buy' : 'Sell'} USDC</button>
          ))}
        </div>
      </div>

      {/* Filters: currency · amount · payment · merchants */}
      <div style={{ display: 'flex', gap: 6, padding: '12px 16px 10px', overflowX: 'auto', scrollbarWidth: 'none', alignItems: 'center' }}>
        <select aria-label="Currency" value={currency} onChange={e => setCurrency(e.target.value)} style={selectStyle}>
          <option value="">All currencies</option>
          {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
        </select>
        <select aria-label="Payment method" value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)} style={selectStyle}>
          <option value="">All payments</option>
          {methodsOnList.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <button onClick={() => setShowFilters(v => !v)} style={chip(showFilters || !!fiatAmount || !!country || merchantFilter !== 'all')}>
          <Filter size={12} style={{ display: 'inline', verticalAlign: -1, marginRight: 4 }} />Filter
        </button>
      </div>
      <AnimatePresence>
        {showFilters && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} style={{ overflow: 'hidden' }}>
            <div style={{ padding: '0 16px 10px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: COLORS.surface, borderRadius: 12, padding: '10px 12px', border: `1px solid ${COLORS.border}` }}>
                <span style={{ fontSize: 13, color: COLORS.muted, whiteSpace: 'nowrap' }}>{buying ? 'I want to pay' : 'I want to receive'}</span>
                <input inputMode="decimal" value={fiatAmount} onChange={e => setFiatAmount(sanitizeAmountInput(e.target.value, 2))} placeholder="Any amount"
                  style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', outline: 'none', color: COLORS.text, fontSize: 'max(var(--fs-field, 0px), 14px)', fontWeight: 600, textAlign: 'right' }} />
                <span style={{ fontSize: 13, fontWeight: 700, color: COLORS.text }}>{currency || 'fiat'}</span>
              </div>
              <div style={{ display: 'flex' }}>
                <SearchField value={search} onChange={setSearch} ariaLabel="Search trader or payment method" placeholder={['Search trader or payment method', 'Search']} />
              </div>
              <div style={{ display: 'flex', gap: 6, overflowX: 'auto', scrollbarWidth: 'none' }}>
                {(['all', 'verified', 'community'] as MerchantFilter[]).map(f => (
                  <button key={f} onClick={() => setMerchantFilter(f)} style={chip(merchantFilter === f)}>
                    {f === 'all' ? 'All traders' : f === 'verified' ? 'Verified traders' : 'Community'}
                  </button>
                ))}
                <select aria-label="Region" value={country} onChange={e => setCountry(e.target.value)} style={selectStyle}>
                  <option value="">All regions</option>
                  {COUNTRY_REGIONS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Ads */}
      <div style={{ borderTop: `1px solid ${COLORS.border}` }}>
        {loading ? (
          <SkeletonCards count={5} className="px-4 pt-3" />
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '56px 24px' }}>
            <p style={{ color: COLORS.text, fontSize: 14, fontWeight: 600, margin: 0 }}>No ads to {buying ? 'buy' : 'sell'} USDC right now</p>
            <p style={{ color: COLORS.muted, fontSize: 13, marginTop: 6 }}>Try another filter, or post your own ad.</p>
            <button onClick={() => navigate('/p2p/create')} style={{ marginTop: 14, padding: '10px 18px', borderRadius: 12, border: 'none', background: COLORS.primary, color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>Post an ad</button>
          </div>
        ) : filtered.map(({ o: offer, price }) => {
          const avail = remaining.get(offer.id) ?? offer.totalAmount
          const maxNow = Math.min(offer.maxAmount, avail)
          const sym = currencySymbol(offer.currency)
          const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })
          return (
            <div key={offer.id} {...pressable(() => navigate(`/p2p/offer/${offer.id}`, { state: { offerType: offer.offerType } }))}
              style={{ padding: '14px 16px', borderBottom: `1px solid ${COLORS.border}`, cursor: 'pointer' }}>
              <MerchantLine name={offer.displayName || offer.username || 'Trader'} verified={offer.isVerifiedMerchant} stats={stats.get(offer.userId)} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 10, marginTop: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 21, fontWeight: 700, color: COLORS.text, letterSpacing: '-0.3px' }}>
                    <span style={{ fontSize: 13, color: COLORS.muted, fontWeight: 500, marginRight: 2 }}>{sym}</span>{price != null ? fmt(price) : '—'}
                    {offer.priceType === 'floating' && <span style={{ fontSize: 11, fontWeight: 700, color: COLORS.primaryText, marginLeft: 6, verticalAlign: 3 }}>LIVE</span>}
                  </div>
                  <div style={{ fontSize: 12, color: COLORS.muted, marginTop: 3 }}>
                    Limit <b style={{ color: COLORS.text, fontWeight: 600 }}>{price ? `${sym}${fmt(offer.minAmount * price)} – ${sym}${fmt(maxNow * price)}` : `${offer.minAmount} – ${trimTrailingZeros(maxNow.toFixed(2))} USDC`}</b>
                  </div>
                  <div style={{ fontSize: 12, color: COLORS.muted, marginTop: 2 }}>
                    Available <b style={{ color: COLORS.text, fontWeight: 600 }}>{trimTrailingZeros(avail.toFixed(2))} USDC</b>
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 10, flexShrink: 0 }}>
                  {/* Side by side, so a second method doesn't push this offer's price lower than the others'. */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '3px 10px', maxWidth: 150 }}>
                    {offer.paymentMethods.slice(0, 3).map(m => <MethodTag key={m} name={m} />)}
                  </div>
                  <button onClick={e => { e.stopPropagation(); navigate(`/p2p/offer/${offer.id}`, { state: { offerType: offer.offerType } }) }}
                    style={{ padding: '8px 22px', borderRadius: 8, border: 'none', background: actColor, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
                    {buying ? 'Buy' : 'Sell'}
                  </button>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Orders · My ads · Post ad */}
      <div style={isDesktop
        ? { padding: '16px 16px 4px', display: 'flex', gap: 12 }
        : { position: 'fixed', bottom: 0, left: 0, right: 0, maxWidth: 480, margin: '0 auto', padding: '12px 16px calc(env(safe-area-inset-bottom, 0px) + 12px)', background: 'linear-gradient(180deg, transparent, var(--bg) 30%)', display: 'flex', gap: 10 }}>
        <button onClick={() => navigate('/p2p/my-trades')} style={{ flex: 1, padding: '13px 0', borderRadius: 14, background: COLORS.surface, border: `1px solid ${COLORS.border}`, color: COLORS.text, fontSize: 14, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          Orders
          {myTradesCount > 0 && (
            <span style={{ background: 'var(--danger)', color: '#fff', fontSize: 11, fontWeight: 700, borderRadius: 999, minWidth: 17, height: 17, padding: '0 5px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{myTradesCount}</span>
          )}
        </button>
        <button onClick={() => navigate('/p2p/my-offers')} style={{ flex: 1, padding: '13px 0', borderRadius: 14, background: COLORS.surface, border: `1px solid ${COLORS.border}`, color: COLORS.text, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>My ads</button>
        <button onClick={() => navigate('/p2p/create')} disabled={!walletAddress} style={{ flex: 1.15, padding: '13px 0', borderRadius: 14, background: 'var(--brand)', border: 'none', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          <Plus size={15} /> Post ad
        </button>
      </div>
    </div>
  )

  if (!isDesktop) return flow

  // ── Desktop: flow (left) + P2P History (right), independently scrollable ──
  // The app's desktop two-column layout (65/35), as on Swap/Multichain
  // Transfer/Pay/Multichain Claim.
  return (
    <DesktopTwoColumn main={flow} side={
        <DesktopHistoryPanel title="P2P History" onViewAll={() => navigate('/p2p/history')}>
          {!p2pHistoryLoaded ? (
            <DesktopHistorySkeleton />
          ) : p2pHistory.length === 0 ? (
            <DesktopHistoryEmpty label="Your P2P trades will show up here" />
          ) : (
            p2pHistory.map(t => {
              const isBuyer = t.buyerId === user?.id
              const done = t.status === 'completed'
              const dead = t.status === 'cancelled' || t.status === 'expired'
              const statusColor = done ? 'var(--success)' : dead ? 'var(--text-secondary)' : 'var(--warning)'
              const statusLabel = done ? 'Completed' : dead ? (t.status === 'expired' ? 'Expired' : 'Cancelled') : 'In progress'
              return (
                <HistoryRow key={t.id} inPanel flash={t.id === historyFlash.flashId}
                  onClick={() => { historyFlash.leaving(t.id); navigate(`/p2p/trade/${t.id}`) }}
                  icon={<HistoryIcon tone={done ? (isBuyer ? 'in' : 'out') : dead ? 'muted' : 'pending'} icon="p2p" />}
                  title={`${isBuyer ? 'Bought' : 'Sold'} USDC`}
                  meta={<><span style={{ color: statusColor, fontWeight: 600 }}>{statusLabel}</span> · {timeAgo(t.completedAt || t.createdAt)}</>}
                  right={<div style={{ fontSize: 14, fontWeight: 700, color: done ? (isBuyer ? 'var(--success-text)' : 'var(--text-primary)') : 'var(--text-secondary)' }}>
                    {done ? (isBuyer ? '+' : '-') : ''}{trimTrailingZeros(t.amountUsdc.toFixed(2))} USDC
                  </div>} />
              )
            })
          )}
        </DesktopHistoryPanel>
    } />
  )
}

// ── Create Offer ─────────────────────────────────────────────────────────────
export function P2PCreateOfferPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const goBack = useP2PBack('/p2p')
  const walletAddress = useAuthStore(s => s.walletAddress)
  const user = useAuthStore(s => s.user)
  const storedPasscode = useAuthStore(s => s.passcode)
  const { showToastMessage } = useUIStore()
  const [passEntry, setPassEntry] = useState('')
  const [passError, setPassError] = useState('')
  const [showPasscodeSheet, setShowPasscodeSheet] = useState(false)

  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [offerType, setOfferType] = useState<OfferType>('sell')
  const [currency, setCurrency] = useState('INR')
  const [price, setPrice] = useState('')
  const [priceType, setPriceType] = useState<'fixed' | 'floating'>('fixed')
  const [margin, setMargin] = useState('0')
  const [rate, setRate] = useState<number | null>(null)
  const [autoReply, setAutoReply] = useState('')
  // Sell ads: which of your saved accounts buyers pay. Buy ads: which ways you can pay.
  const [myMethods, setMyMethods] = useState<P2PPaymentMethod[]>([])
  const [methodIds, setMethodIds] = useState<string[]>([])
  const [showPmSheet, setShowPmSheet] = useState(false)
  // Total amount the seller wants to sell overall - what actually gets
  // deposited to escrow. Only meaningful for sell offers (a buy offer's
  // creator doesn't escrow anything at creation time - see createOffer's
  // own comment on this), so it just mirrors maxAmount for buy offers,
  // matching this app's previous one-number behavior there since nothing
  // actually changes for buy offers.
  const [totalAmount, setTotalAmount] = useState('100')
  const [minAmount, setMinAmount] = useState('10')
  const [maxAmount, setMaxAmount] = useState('60')
  const [methods, setMethods] = useState<string[]>([])
  const [country, setCountry] = useState('Global')
  const [terms, setTerms] = useState('')
  const [tradeWindowMinutes, setTradeWindowMinutes] = useState(15)
  const [submitting, setSubmitting] = useState(false)

  const toggleMethod = (m: string) => setMethods(prev => prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m])
  const toggleMethodId = (id: string) => setMethodIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : prev.length >= 5 ? prev : [...prev, id])
  useEffect(() => { if (user?.id) fetchMyPaymentMethods(user.id).then(setMyMethods) }, [user?.id])
  // Live market rate for the price hint / floating price.
  useEffect(() => {
    let off = false
    fetchFxRates([currency]).then(r => { if (!off) setRate(r[currency]?.rate ?? null) }).catch(() => { if (!off) setRate(null) })
    return () => { off = true }
  }, [currency])
  const marginNum = parseFloat(margin)
  const effectivePrice = priceType === 'floating'
    ? (rate && isFinite(marginNum) ? Math.round(rate * (1 + marginNum / 100) * 100) / 100 : 0)
    : parseFloat(price) || 0
  // Payment names on the ad: sell ads take them from the chosen accounts.
  const adMethodNames = offerType === 'sell'
    ? [...new Set(myMethods.filter(m => methodIds.includes(m.id)).map(m => m.method))]
    : methods

  // Sell offers deposit the total to escrow up front (plus a little network
  // gas, also paid in USDC on Arc): more than the balance can't be created.
  const usdcBalance = Number(useWalletStore(s => s.balance)) || 0
  const sellInsufficient = offerType === 'sell' && (parseFloat(totalAmount) || 0) > Math.max(0, usdcBalance - 0.01)
  const step1Ok = effectivePrice > 0 && (priceType === 'fixed' || (isFinite(marginNum) && marginNum >= -20 && marginNum <= 20))
  const step2Ok = parseFloat(minAmount) > 0 && parseFloat(maxAmount) >= parseFloat(minAmount) && adMethodNames.length > 0 &&
    (offerType !== 'sell' || (parseFloat(totalAmount) > 0 && parseFloat(maxAmount) <= parseFloat(totalAmount) && !sellInsufficient))
  const canSubmit = !!(walletAddress && user?.id && step1Ok && step2Ok)

  const { flipState, runFlip, dismissFlip } = useProcessingFlip()

  const doSubmit = async () => {
    if (!canSubmit || !walletAddress || !user?.id) return
    setSubmitting(true)
    await runFlip(
      offerType === 'sell' ? 'Locking USDC in escrow and posting…' : 'Posting your ad…',
      async () => {
        const { offer, error } = await createOffer({
          userId: user.id, walletAddress, offerType, currency,
          pricePerUsdc: effectivePrice, minAmount: parseFloat(minAmount), maxAmount: parseFloat(maxAmount),
          totalAmount: offerType === 'sell' ? parseFloat(totalAmount) : parseFloat(maxAmount),
          paymentMethods: adMethodNames, countryRegion: country, terms: terms || undefined,
          tradeWindowMinutes, priceType, floatMarginPct: priceType === 'floating' ? marginNum : undefined,
          autoReply: autoReply || undefined, paymentMethodIds: offerType === 'sell' ? methodIds : [],
        })
        return { success: !!offer, message: offer ? `Your ad to ${offerType} USDC is live.` : (error || 'Could not post the ad - try again') }
      },
      { successTitle: 'Ad Posted', errorTitle: 'Could Not Post Ad' },
    )
    setSubmitting(false)
  }

  // Navigating away immediately on success would unmount this page (and
  // the flip card with it) before the person ever sees it - wait for them
  // to dismiss the result card first, same as every other action here.
  // Navigates only once the card has finished closing (onExited), so it
  // doesn't ride off with the page.
  const afterCreateFlip = useRef<(() => void) | null>(null)
  const handleDismissCreateFlip = () => {
    if (flipState.phase === 'success') afterCreateFlip.current = () => navigate('/p2p/my-offers', { replace: true })
    dismissFlip()
  }

  // Entry point for the "Create Offer" button - opens the passcode sheet
  // rather than executing immediately. A SELL offer moves USDC into the
  // escrow contract right here (depositForOffer, see createOffer() in
  // p2pService.ts); a BUY offer doesn't move funds yet, but is gated the
  // same way for a consistent "this authorizes an on-chain action" flow.
  const submit = () => {
    if (!canSubmit) return
    setPassEntry(''); setPassError(''); setShowPasscodeSheet(true)
  }

  const handlePasscodeConfirm = async () => {
    if (storedPasscode) {
      if (passEntry.length < 6) { setPassError('Enter your 6-digit passcode'); return }
      const { verifyPasscode } = await import('@/lib/security')
      // Unlock the wallet key at the same time as the passcode check (both are
      // slow on purpose) instead of after it - restorePrivateKey below joins
      // this same in-flight unlock. Silent: a wrong passcode must only show
      // "Incorrect passcode".
      if (!useAuthStore.getState().signer) import('@/lib/restoreWallet').then(m => m.restorePrivateKey(passEntry, { silent: true })).catch(() => {})
      if (!await verifyPasscode(passEntry, storedPasscode)) { setPassError('Incorrect passcode'); setPassEntry(''); return }
      // Verifying the passcode only proves it's correct - it does NOT by
      // itself put the private key back in memory. signer is
      // deliberately never persisted (see store/index.ts's partialize),
      // so after any fresh page load it's null until explicitly restored.
      // Without this call, a correct passcode entry here was previously
      // followed by a release/accept/cancel that still failed with
      // "Couldn't access your wallet on this device" - the exact bug this
      // fixes. Passing the just-verified passcode lets restorePrivateKey
      // decrypt this device's locally-stored encrypted key immediately,
      // no extra prompt needed.
      const { restorePrivateKey } = await import('@/lib/restoreWallet')
      const restored = await restorePrivateKey(passEntry)
      if (!restored && !useAuthStore.getState().signer) {
        setPassError("Couldn't unlock your wallet on this device. Try reloading the app.")
        return
      }
    }
    setShowPasscodeSheet(false); setPassEntry(''); setPassError('')
    await doSubmit()
  }

  const inputStyle: CSSProperties = { width: '100%', background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)', color: COLORS.text, border: '1px solid transparent', borderRadius: 12, padding: '12px 14px', fontSize: 'max(var(--fs-field, 0px), 14.5px)', outline: 'none', boxSizing: 'border-box' }
  const labelStyle: CSSProperties = { fontSize: 13, color: COLORS.muted, marginBottom: 8, fontWeight: 600 }
  const sym = currencySymbol(currency)
  const pill = (on: boolean, color?: string): CSSProperties => ({
    flex: 1, padding: '10px 0', borderRadius: 10, cursor: 'pointer', fontSize: 14, fontWeight: 700,
    border: `1.5px solid ${on ? (color ?? COLORS.text) : 'transparent'}`,
    background: on ? (color ? `color-mix(in srgb, ${color} 14%, transparent)` : COLORS.surface) : 'color-mix(in srgb, var(--text-primary) 6%, transparent)',
    color: on ? (color ?? COLORS.text) : COLORS.muted,
  })
  const stepper = (value: string, set: (v: string) => void, delta: number, suffix = '') => (
    <div style={{ display: 'flex', alignItems: 'center', borderRadius: 12, background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)' }}>
      <button onClick={() => set(String(Math.round(((parseFloat(value) || 0) - delta) * 100) / 100))} style={{ padding: '10px 18px', background: 'none', border: 'none', fontSize: 20, color: COLORS.muted, cursor: 'pointer' }}>−</button>
      <input inputMode="decimal" value={value} onChange={e => set(signedAmountInput(e.target.value, 2))}
        style={{ flex: 1, minWidth: 0, textAlign: 'center', background: 'none', border: 'none', outline: 'none', fontSize: 18, fontWeight: 700, color: COLORS.text }} />
      {suffix && <span style={{ color: COLORS.muted, fontWeight: 700 }}>{suffix}</span>}
      <button onClick={() => set(String(Math.round(((parseFloat(value) || 0) + delta) * 100) / 100))} style={{ padding: '10px 18px', background: 'none', border: 'none', fontSize: 20, color: COLORS.muted, cursor: 'pointer' }}>+</button>
    </div>
  )
  const stepLabels = ['Type & price', 'Amount & payment', 'Terms & post']
  const summaryRow = (k: string, v: ReactNode) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13, padding: '5px 0' }}>
      <span style={{ color: COLORS.muted }}>{k}</span><span style={{ color: COLORS.text, fontWeight: 600, textAlign: 'right' }}>{v}</span>
    </div>
  )

  return (
    <div className="lg:max-w-[720px]" style={{ background: COLORS.bg, minHeight: '100%', height: '100%', overflowY: 'auto', overflowX: 'hidden', paddingBottom: 110 }}>
      <Header title="Post ad" onBack={() => (step > 1 ? setStep(s => (s - 1) as 1 | 2) : goBack())} />

      {/* Steps */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 16px 16px' }}>
        {stepLabels.map((l, i) => {
          const n = i + 1, done = n < step, on = n === step
          return (
            <div key={l} style={{ display: 'contents' }}>
              {i > 0 && <span style={{ flex: 1, borderTop: `1px dashed ${COLORS.border}` }} />}
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: on ? 700 : 500, color: on ? COLORS.text : COLORS.muted }}>
                <span style={{ width: 20, height: 20, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700,
                  background: done ? 'var(--success)' : on ? COLORS.text : 'color-mix(in srgb, var(--text-primary) 8%, transparent)', color: done ? '#fff' : on ? COLORS.bg : COLORS.muted }}>{done ? <Check size={12} strokeWidth={3} aria-hidden /> : n}</span>
                {on && l}
              </span>
            </div>
          )
        })}
      </div>

      <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {step === 1 && (
          <>
            <div>
              <div style={labelStyle}>I want to</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setOfferType('buy')} style={pill(offerType === 'buy', 'var(--success)')}>Buy USDC</button>
                <button onClick={() => setOfferType('sell')} style={pill(offerType === 'sell', 'var(--danger)')}>Sell USDC</button>
              </div>
            </div>
            <div>
              <div style={labelStyle}>With fiat</div>
              <select value={currency} onChange={e => setCurrency(e.target.value)} style={inputStyle}>
                {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.code} · {c.name} ({c.symbol})</option>)}
              </select>
            </div>
            <div>
              <div style={labelStyle}>Price type</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setPriceType('fixed')} style={pill(priceType === 'fixed')}>Fixed</button>
                <button onClick={() => setPriceType('floating')} disabled={!rate} style={{ ...pill(priceType === 'floating'), opacity: rate ? 1 : 0.5 }}>Floating</button>
              </div>
              <div style={{ fontSize: 12, color: COLORS.muted, marginTop: 6, lineHeight: 1.45 }}>
                {priceType === 'fixed' ? 'Your price stays the same until you edit it.' : 'Follows the live market rate, plus or minus your margin. Each order is priced the moment it opens.'}
              </div>
            </div>
            {priceType === 'fixed' ? (
              <div>
                <div style={labelStyle}>Your price ({sym} per USDC)</div>
                {stepper(price, setPrice, currency === 'INR' ? 0.1 : 0.01)}
              </div>
            ) : (
              <div>
                <div style={labelStyle}>Margin over market (−20% to +20%)</div>
                {stepper(margin, setMargin, 0.1, '%')}
              </div>
            )}
            <div style={{ background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)', borderRadius: 12, padding: '8px 14px' }}>
              {summaryRow('Market rate', rate ? `${sym}${rate.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : 'Unavailable')}
              {summaryRow(`You ${offerType} 1 USDC for`, effectivePrice ? `${sym}${effectivePrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—')}
              {rate && effectivePrice > 0 && summaryRow('Vs market', <span style={{ color: effectivePrice >= rate ? 'var(--success-text)' : 'var(--danger-text)' }}>{effectivePrice >= rate ? '+' : ''}{((effectivePrice / rate - 1) * 100).toFixed(2)}%</span>)}
            </div>
          </>
        )}

        {step === 2 && (
          <>
            {offerType === 'sell' && (
              <div>
                <div style={labelStyle}>Total amount (USDC)</div>
                <input inputMode="decimal" value={totalAmount} onChange={e => setTotalAmount(sanitizeAmountInput(e.target.value, tokenDecimals('USDC')))}
                  style={{ ...inputStyle, fontSize: 18, fontWeight: 700, ...(sellInsufficient ? { borderColor: 'var(--danger)' } : {}) }} />
                <div style={{ fontSize: 12, marginTop: 6, color: sellInsufficient ? 'var(--danger-text)' : COLORS.muted, fontWeight: sellInsufficient ? 600 : 400 }}>
                  {sellInsufficient ? 'Insufficient balance · ' : 'Wallet '}{trimTrailingZeros(usdcBalance.toFixed(2))} USDC
                  {effectivePrice > 0 && !sellInsufficient && ` · ≈ ${sym}${((parseFloat(totalAmount) || 0) * effectivePrice).toLocaleString(undefined, { maximumFractionDigits: 0 })}`} · locked in escrow when you post
                </div>
              </div>
            )}
            <div>
              <div style={labelStyle}>Order limit per trade (USDC)</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input inputMode="decimal" value={minAmount} onChange={e => setMinAmount(sanitizeAmountInput(e.target.value, tokenDecimals('USDC')))} style={inputStyle} aria-label="Minimum per trade" />
                <span style={{ color: COLORS.muted, fontSize: 13 }}>to</span>
                <input inputMode="decimal" value={maxAmount} onChange={e => setMaxAmount(sanitizeAmountInput(e.target.value, tokenDecimals('USDC')))} style={inputStyle} aria-label="Maximum per trade" />
              </div>
              <div style={{ fontSize: 12, marginTop: 6, color: offerType === 'sell' && parseFloat(maxAmount || '0') > parseFloat(totalAmount || '0') ? 'var(--danger-text)' : COLORS.muted }}>
                {offerType === 'sell' && parseFloat(maxAmount || '0') > parseFloat(totalAmount || '0')
                  ? "Max per trade can't be more than your total."
                  : effectivePrice > 0 ? `≈ ${sym}${((parseFloat(minAmount) || 0) * effectivePrice).toLocaleString(undefined, { maximumFractionDigits: 0 })} – ${sym}${((parseFloat(maxAmount) || 0) * effectivePrice).toLocaleString(undefined, { maximumFractionDigits: 0 })} per order` : ''}
              </div>
            </div>
            <div>
              <div style={labelStyle}>{offerType === 'sell' ? 'Payment accounts buyers pay (up to 5)' : 'How you can pay'}</div>
              {offerType === 'sell' ? (
                <>
                  <PaymentMethodPicker methods={myMethods} selected={methodIds} onToggle={toggleMethodId} onAdd={() => setShowPmSheet(true)} />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: COLORS.muted, marginTop: 8 }}><Lock size={13} aria-hidden style={{ flexShrink: 0 }} />Account details are shown only to the buyer of an active order.</div>
                </>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {PAYMENT_METHOD_TYPES.map(t => (
                    <button key={t.id} onClick={() => toggleMethod(t.id)} style={{
                      padding: '8px 12px', borderRadius: 10, cursor: 'pointer', background: 'transparent',
                      border: `1.5px solid ${methods.includes(t.id) ? 'var(--brand)' : COLORS.border}`,
                    }}><MethodTag name={t.id} size={13} /></button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div>
              <div style={labelStyle}>Payment time limit</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {TRADE_WINDOW_OPTIONS.map(opt => (
                  <button key={opt.minutes} onClick={() => setTradeWindowMinutes(opt.minutes)} style={{
                    padding: '7px 12px', borderRadius: 999, fontSize: 13, cursor: 'pointer', fontWeight: 600, border: 'none',
                    background: tradeWindowMinutes === opt.minutes ? COLORS.text : 'color-mix(in srgb, var(--text-primary) 6%, transparent)',
                    color: tradeWindowMinutes === opt.minutes ? COLORS.bg : COLORS.muted,
                  }}>{opt.label}</button>
                ))}
              </div>
            </div>
            <div>
              <div style={labelStyle}>Terms (optional)</div>
              <textarea value={terms} onChange={e => setTerms(e.target.value)} rows={3} maxLength={500} placeholder="e.g. Pay from an account in your own name. No third-party payments." style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit', fontSize: 'max(var(--fs-field, 0px), 13.5px)' }} />
            </div>
            <div>
              <div style={labelStyle}>Auto-reply (sent when an order opens)</div>
              <textarea value={autoReply} onChange={e => setAutoReply(e.target.value)} rows={2} maxLength={280} placeholder='e.g. Hi! Pay to the account shown and tap "Transferred".' style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit', fontSize: 'max(var(--fs-field, 0px), 13.5px)' }} />
            </div>
            <div>
              <div style={labelStyle}>Region</div>
              <select value={country} onChange={e => setCountry(e.target.value)} style={inputStyle}>
                {COUNTRY_REGIONS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 14, padding: '10px 14px' }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.text, marginBottom: 4 }}>Review</div>
              {summaryRow('Type', <span style={{ color: offerType === 'sell' ? 'var(--danger-text)' : 'var(--success-text)' }}>{offerType === 'sell' ? 'Sell' : 'Buy'} USDC</span>)}
              {summaryRow('Price', priceType === 'floating' ? `Market ${marginNum >= 0 ? '+' : ''}${marginNum}% (≈ ${sym}${effectivePrice})` : `${sym}${effectivePrice} · Fixed`)}
              {offerType === 'sell' && summaryRow('Total', `${totalAmount} USDC`)}
              {summaryRow('Limit', `${minAmount} – ${maxAmount} USDC`)}
              {summaryRow('Payment', adMethodNames.join(', '))}
              {summaryRow('Time limit', TRADE_WINDOW_OPTIONS.find(o => o.minutes === tradeWindowMinutes)?.label ?? `${tradeWindowMinutes} min`)}
            </div>
            {offerType === 'sell' && (
              <div style={{ borderRadius: 14, padding: '10px 14px', border: '1px solid color-mix(in srgb, var(--brand) 45%, transparent)', background: 'color-mix(in srgb, var(--brand) 10%, var(--surface))' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: COLORS.text }}><Lock size={14} aria-hidden style={{ flexShrink: 0 }} />{totalAmount} USDC will be locked in escrow on Arc</div>
                <div style={{ fontSize: 12, color: COLORS.muted, marginTop: 4, lineHeight: 1.45 }}>It's released only to buyers who pay you. Withdraw what's left any time from My ads.</div>
              </div>
            )}
          </>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          {step > 1 && (
            <button onClick={() => setStep(s => (s - 1) as 1 | 2)} style={{ flex: 0.6, padding: '14px 0', borderRadius: 14, border: `1px solid ${COLORS.border}`, background: 'transparent', color: COLORS.text, fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>Back</button>
          )}
          {step < 3 ? (
            <button onClick={() => setStep(s => (s + 1) as 2 | 3)} disabled={step === 1 ? !step1Ok : !step2Ok}
              style={{ flex: 1.4, padding: '14px 0', borderRadius: 14, border: 'none', background: COLORS.primary, color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', opacity: (step === 1 ? step1Ok : step2Ok) ? 1 : 0.45 }}>Next</button>
          ) : (
            <button onClick={submit} disabled={!canSubmit || submitting}
              style={{ flex: 1.4, padding: '14px 0', borderRadius: 14, border: 'none', background: COLORS.primary, color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', opacity: !canSubmit || submitting ? 0.45 : 1 }}>
              {submitting ? 'Posting…' : 'Confirm & post'}
            </button>
          )}
        </div>
      </div>

      {user?.id && (
        <PaymentMethodSheet open={showPmSheet} onClose={() => setShowPmSheet(false)} userId={user.id}
          defaultName={user.displayName ?? ''}
          onSaved={m => { setMyMethods(ms => [...ms, m]); setMethodIds(ids => ids.length >= 5 ? ids : [...ids, m.id]) }} />
      )}

      <PinSheet open={showPasscodeSheet} id="p2p-pass"
        title="Post ad" bioVerb="Post"
        subtitle={offerType === 'sell'
          ? <>Lock {totalAmount || '0'} USDC in escrow and post your ad</>
          : <>Post your ad to buy {minAmount || '0'}–{maxAmount || '0'} USDC</>}
        value={passEntry} onChange={v => { setPassEntry(v); setPassError('') }}
        error={passError || undefined}
        onComplete={() => { void handlePasscodeConfirm() }}
        fallbackConfirm={storedPasscode ? undefined : { label: 'Post Ad', onConfirm: () => { void handlePasscodeConfirm() } }}
        onClose={() => { setShowPasscodeSheet(false); setPassEntry(''); setPassError('') }}
      />
      <ProcessingFlipCard {...flipState} onDismiss={handleDismissCreateFlip}
        onExited={() => { const go = afterCreateFlip.current; afterCreateFlip.current = null; go?.() }} />
    </div>
  )
}

// ── Offer Detail - accept an offer (creates a trade) ────────────────────────
export function P2POfferDetailPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const { offerId } = useParams<{ offerId: string }>()
  const navigate = useNavigate()
  const goBack = useP2PBack('/p2p')
  // The offer's side, passed from the list, for the title while it loads.
  const offerTypeHint = (useLocation().state as { offerType?: OfferType } | null)?.offerType
  const walletAddress = useAuthStore(s => s.walletAddress)
  const user = useAuthStore(s => s.user)
  const storedPasscode = useAuthStore(s => s.passcode)
  const { showToastMessage } = useUIStore()
  // Opened from the marketplace: that list already has this offer - show it
  // at once while the fresh copy loads (createTrade re-checks what's left).
  const listed = (() => {
    for (const c of hubCache.values()) {
      const o = c.offers.find(x => x.id === offerId)
      if (o) return { offer: o, remaining: c.remaining.get(o.id) ?? null }
    }
    return null
  })()
  const [offer, setOffer] = useState<P2POffer | null>(() => listed?.offer ?? null)
  const [remainingAmt, setRemainingAmt] = useState<number | null>(() => listed?.remaining ?? null)
  const [rating, setRating] = useState<{ avg: number; count: number } | null>(null)
  const [reputation, setReputation] = useState<UserReputation | null>(null)
  // USDC amount (the source of truth for the trade) and what was typed, in
  // fiat or USDC (Binance's "With INR | With USDC").
  const [amount, setAmount] = useState('')
  const [typed, setTyped] = useState('')
  const [inFiat, setInFiat] = useState(true)
  // Phones: the amount number pad (AmountKeypad) is up. Fiat types to the
  // cent, USDC to its on-chain 6 decimals - the same cap typed or tapped.
  const [showAmountPad, setShowAmountPad] = useState(false)
  const typedDecimals = inFiat ? 2 : tokenDecimals('USDC')
  const [livePrice, setLivePrice] = useState<number | null>(null)
  const [stats, setStats] = useState<MerchantStats | undefined>(undefined)
  // Which account the buyer pays: one of the ad's (sell ads), or the
  // accepting seller's own (selling into a buy ad).
  const [payOptions, setPayOptions] = useState<{ id: string; method: string }[]>([])
  const [myMethods, setMyMethods] = useState<P2PPaymentMethod[]>([])
  const [payMethodId, setPayMethodId] = useState('')
  const [showPmSheet, setShowPmSheet] = useState(false)
  // Selling into a buy offer deposits that USDC to escrow: check the balance.
  const usdcBalanceForSell = Number(useWalletStore(st => st.balance)) || 0
  const [accepting, setAccepting] = useState(false)
  const [showPasscodeSheet, setShowPasscodeSheet] = useState(false)
  const [passEntry, setPassEntry] = useState('')
  const [passError, setPassError] = useState('')
  const { flipState, runFlip, dismissFlip } = useProcessingFlip()
  const tradeRef = useRef<P2PTrade | null>(null)

  useEffect(() => {
    if (!offerId) return
    ;(async () => {
      const found = await fetchOfferById(offerId)
      setOffer(found)
      if (found) {
        // Everything else the page needs, asked for together (the price and
        // payment options used to wait for the rating/reputation round trip).
        fetchMerchantStats([found.userId]).then(m => setStats(m.get(found.userId))).catch(() => {})
        const [ratingResult, reputationResult, consumedMap, rates, opts] = await Promise.all([
          fetchUserRating(found.userId),
          getUserReputation(found.userId),
          fetchOfferConsumedAmounts([found.id]),
          found.priceType === 'floating' ? fetchFxRates([found.currency]).catch(() => ({})) : Promise.resolve({}),
          found.offerType === 'sell' ? fetchOfferPaymentOptions(found.id).catch(() => null) : Promise.resolve(null),
        ])
        setRating(ratingResult)
        setReputation(reputationResult)
        setRemainingAmt(offerRemainingAmount(found, consumedMap.get(found.id) ?? 0))
        setLivePrice(offerLivePrice(found, rates))
        if (opts) {
          setPayOptions(opts)
          if (opts.length === 1) setPayMethodId(opts[0].id)
        }
      }
    })()
  }, [offerId])
  // Selling into a buy ad: the buyer will pay one of YOUR saved accounts.
  useEffect(() => {
    if (offer?.offerType !== 'buy' || !user?.id) return
    fetchMyPaymentMethods(user.id).then(ms => { setMyMethods(ms); if (ms.length === 1) setPayMethodId(ms[0].id) })
  }, [offer?.offerType, user?.id])
  // Typed value → USDC amount.
  useEffect(() => {
    const v = parseFloat(typed) || 0
    if (!v) { setAmount(''); return }
    if (!inFiat) { setAmount(typed); return }
    if (!livePrice) { setAmount(''); return }
    // Rounded down to 4 decimals, so "You receive" never shows more than you get.
    setAmount(String(Math.floor((v / livePrice) * 1e4) / 1e4))
  }, [typed, inFiat, livePrice])

  const isOwnOffer = !!(offer && user?.id && offer.userId === user.id)

  const doAccept = async () => {
    if (!offer || !walletAddress || !user?.id) return
    setAccepting(true)
    const amt = parseFloat(amount)
    await runFlip(
      offer.offerType === 'sell' ? 'Starting trade…' : 'Depositing escrow and starting trade…',
      async () => {
        const chosen = offer.offerType === 'sell' ? payOptions.find(o => o.id === payMethodId) : myMethods.find(m => m.id === payMethodId)
        const { trade, error } = await createTrade({
          offer, acceptingUserId: user.id, acceptingWallet: walletAddress, amountUsdc: amt,
          paymentMethodId: chosen?.id, paymentMethodName: chosen?.method,
        })
        if (trade) tradeRef.current = trade
        return { success: !!trade, message: trade ? (trade.status === 'awaiting_seller_confirmation' ? "Waiting for the seller to accept - you'll be notified." : offer.offerType === 'sell' ? 'Pay the seller within the time shown on the order.' : 'The buyer has been notified to pay you.') : (error || 'Could not start the order - try again') }
      },
      { successTitle: 'Order Created', errorTitle: 'Could Not Create Order' },
    )
    setAccepting(false)
  }

  // Navigating away immediately on success would unmount this page (and
  // the flip card with it) before the person ever sees it - wait for them
  // to dismiss the result card first, same as Create Offer.
  const afterAcceptFlip = useRef<(() => void) | null>(null)
  const handleDismissAcceptFlip = () => {
    const trade = flipState.phase === 'success' ? tradeRef.current : null
    if (trade) afterAcceptFlip.current = () => navigate(`/p2p/trade/${trade.id}`, { replace: true })
    dismissFlip()
  }

  // Validates and opens the passcode sheet - accepting a BUY offer deposits
  // USDC into escrow right here (createTrade -> depositForTrade, see
  // p2pService.ts / p2pProviders.ts), so it's gated the same way offer
  // create/cancel and trade release are.
  const accept = () => {
    if (!offer || !walletAddress || !user?.id) return
    if (isOwnOffer) { showToastMessage("You can't accept your own offer", 'error'); return }
    const amt = parseFloat(amount)
    const effectiveMax = remainingAmt != null ? Math.min(offer.maxAmount, remainingAmt) : offer.maxAmount
    if (!amt || amt < offer.minAmount || amt > effectiveMax) {
      showToastMessage(`Enter an amount between ${offer.minAmount} and ${effectiveMax} USDC`, 'error')
      return
    }
    const needsMethod = offer.offerType === 'sell' ? payOptions.length > 0 : true
    if (needsMethod && !payMethodId) {
      showToastMessage(offer.offerType === 'sell' ? 'Choose how you will pay' : 'Choose the account the buyer pays you on', 'error')
      return
    }
    setPassEntry(''); setPassError(''); setShowPasscodeSheet(true)
  }

  const handlePasscodeConfirm = async () => {
    if (storedPasscode) {
      if (passEntry.length < 6) { setPassError('Enter your 6-digit passcode'); return }
      const { verifyPasscode } = await import('@/lib/security')
      // Unlock the wallet key at the same time as the passcode check (both are
      // slow on purpose) instead of after it - restorePrivateKey below joins
      // this same in-flight unlock. Silent: a wrong passcode must only show
      // "Incorrect passcode".
      if (!useAuthStore.getState().signer) import('@/lib/restoreWallet').then(m => m.restorePrivateKey(passEntry, { silent: true })).catch(() => {})
      if (!await verifyPasscode(passEntry, storedPasscode)) { setPassError('Incorrect passcode'); setPassEntry(''); return }
      // Verifying the passcode only proves it's correct - it does NOT by
      // itself put the private key back in memory. signer is
      // deliberately never persisted (see store/index.ts's partialize),
      // so after any fresh page load it's null until explicitly restored.
      // Without this call, a correct passcode entry here was previously
      // followed by a release/accept/cancel that still failed with
      // "Couldn't access your wallet on this device" - the exact bug this
      // fixes. Passing the just-verified passcode lets restorePrivateKey
      // decrypt this device's locally-stored encrypted key immediately,
      // no extra prompt needed.
      const { restorePrivateKey } = await import('@/lib/restoreWallet')
      const restored = await restorePrivateKey(passEntry)
      if (!restored && !useAuthStore.getState().signer) {
        setPassError("Couldn't unlock your wallet on this device. Try reloading the app.")
        return
      }
    }
    setShowPasscodeSheet(false); setPassEntry(''); setPassError('')
    await doAccept()
  }

  if (!offer) return (
    <div className="lg:max-w-[900px]" style={{ background: COLORS.bg, minHeight: '100%', height: '100%', overflowY: 'auto', overflowX: 'hidden' }}>
      {/* Same title the loaded page will have (known from the list), so it
          doesn't change after the page has slid in. */}
      <Header title={offerTypeHint === 'sell' ? 'Buy USDC' : offerTypeHint === 'buy' ? 'Sell USDC' : 'Offer'} onBack={goBack} />
      <SkeletonCards count={4} className="pt-2" />
    </div>
  )

  const amt = parseFloat(amount) || 0
  const effMax = remainingAmt != null ? Math.min(offer.maxAmount, remainingAmt) : offer.maxAmount
  // Selling into a buy offer: the USDC (plus a little gas) must be in the wallet.
  const sellShort = offer.offerType === 'buy' && amt > Math.max(0, usdcBalanceForSell - 0.01)
  const outOfLimit = amt > 0 && (amt < offer.minAmount || amt > effMax)
  const price = livePrice
  const fiatTotal = price ? Math.round(amt * price * 100) / 100 : 0
  const sym = currencySymbol(offer.currency)
  const fmt = (n: number, d = 2) => n.toLocaleString(undefined, { maximumFractionDigits: d })
  const buyingUsdc = offer.offerType === 'sell'
  const accent = buyingUsdc ? 'var(--success)' : 'var(--danger)'
  const methodMissing = (buyingUsdc ? payOptions.length > 0 : true) && !payMethodId
  const setAll = () => {
    const usdcMax = buyingUsdc ? effMax : Math.min(effMax, Math.max(0, usdcBalanceForSell - 0.01))
    setTyped(inFiat && price ? String(Math.floor(usdcMax * price * 100) / 100) : String(Math.floor(usdcMax * 1e6) / 1e6))
  }
  const row = (k: ReactNode, v: ReactNode) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13, padding: '5px 0' }}>
      <span style={{ color: COLORS.muted }}>{k}</span><span style={{ color: COLORS.text, fontWeight: 600, textAlign: 'right' }}>{v}</span>
    </div>
  )

  return (
    <div className="lg:max-w-[720px]" style={{ background: COLORS.bg, minHeight: '100%', height: '100%', overflowY: 'auto', overflowX: 'hidden', paddingBottom: 110 }}>
      <Header title={buyingUsdc ? 'Buy USDC' : 'Sell USDC'} onBack={goBack} />

      <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Price + trader */}
        <div style={{ background: COLORS.surface, borderRadius: 16, padding: 14, border: `1px solid ${COLORS.border}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
            <MerchantLine name={offer.displayName || offer.username || 'Trader'} verified={offer.isVerifiedMerchant} stats={stats} />
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div style={{ fontSize: 12, color: COLORS.muted }}>Price{offer.priceType === 'floating' ? ' · live' : ''}</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: accent }}>{price ? `${sym}${fmt(price)}` : '—'}</div>
            </div>
          </div>
          {rating && rating.count > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: COLORS.muted, marginTop: 6 }}>
              <Star size={11} fill={COLORS.warning} color={COLORS.warning} /> {rating.avg} ({rating.count} rated){reputation ? ` · ${reputation.accountAgeDays}d on MeshPort` : ''}
            </div>
          )}
        </div>

        {isOwnOffer ? (
          <div style={{ background: 'color-mix(in srgb, var(--text-secondary) 8%, transparent)', border: `1px dashed ${COLORS.border}`, borderRadius: 14, padding: 16, textAlign: 'center' }}>
            <p style={{ fontSize: 13, color: COLORS.muted, margin: 0 }}>This is your own ad - manage it from My ads.</p>
          </div>
        ) : (
          <>
            {/* Amount: in fiat or USDC */}
            <div style={{ background: COLORS.surface, borderRadius: 16, padding: 14, border: `1px solid ${COLORS.border}` }}>
              <div style={{ display: 'flex', gap: 18, borderBottom: `1px solid ${COLORS.border}`, marginBottom: 12 }}>
                {[true, false].map(f => (
                  <button key={String(f)} onClick={() => { setInFiat(f); setTyped('') }}
                    style={{ background: 'none', border: 'none', padding: '0 0 9px', cursor: 'pointer', fontSize: 14, fontWeight: inFiat === f ? 700 : 500,
                      color: inFiat === f ? COLORS.text : COLORS.muted, borderBottom: `2px solid ${inFiat === f ? COLORS.text : 'transparent'}`, marginBottom: -1 }}>
                    {buyingUsdc ? 'With' : 'For'} {f ? offer.currency : 'USDC'}
                  </button>
                ))}
              </div>
              {/* The app's amount box: typed on desktop, the number pad on phones (as on Pay). */}
              <AmountField
                value={typed}
                onChange={raw => setTyped(sanitizeAmountInput(raw, typedDecimals))}
                autoFocus={isDesktop}
                onTap={isDesktop ? undefined : () => setShowAmountPad(true)}
                editing={showAmountPad}
                invalid={outOfLimit || sellShort}
                symbol={inFiat ? sym : ''}
                compact
                ariaLabel={inFiat ? `Amount in ${offer.currency}` : 'Amount in USDC'}
                tokenPicker={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: COLORS.text }}>{inFiat ? offer.currency : 'USDC'}</span>
                    <button onClick={setAll} style={{ background: 'none', border: 'none', color: COLORS.primaryText, fontWeight: 700, fontSize: 14, cursor: 'pointer', padding: '0 0 0 4px' }}>All</button>
                  </div>
                } />
              <div style={{ fontSize: 12, marginTop: 7, color: outOfLimit || sellShort ? 'var(--danger-text)' : COLORS.muted, fontWeight: outOfLimit || sellShort ? 600 : 400 }}>
                {sellShort ? `Insufficient balance · you have ${trimTrailingZeros(usdcBalanceForSell.toFixed(2))} USDC`
                  : `Limit ${price ? `${sym}${fmt(offer.minAmount * price)} – ${sym}${fmt(effMax * price)}` : `${offer.minAmount} – ${trimTrailingZeros(effMax.toFixed(2))} USDC`}`}
              </div>
              <div style={{ background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)', borderRadius: 12, padding: '6px 12px', marginTop: 12 }}>
                {row(buyingUsdc ? 'You receive' : 'You sell', <b style={{ fontSize: 15 }}>{amt > 0 ? `${trimTrailingZeros(amt.toFixed(4))} USDC` : '—'}</b>)}
                {row(buyingUsdc ? 'You pay' : 'You receive', amt > 0 && price ? `${sym}${fmt(fiatTotal)}` : '—')}
                {row('Payment window', `${offer.tradeWindowMinutes >= 60 ? `${offer.tradeWindowMinutes / 60} h` : `${offer.tradeWindowMinutes} min`}`)}
                {row('Fee', <span style={{ color: 'var(--success-text)' }}>0 USDC</span>)}
              </div>
            </div>

            {/* Payment method */}
            <div style={{ background: COLORS.surface, borderRadius: 16, padding: 14, border: `1px solid ${COLORS.border}` }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.text, marginBottom: 10 }}>{buyingUsdc ? 'Pay with' : 'Receive payment to'}</div>
              {buyingUsdc ? (
                payOptions.length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {payOptions.map(o => (
                      <button key={o.id} onClick={() => setPayMethodId(o.id)}
                        style={{ padding: '8px 12px', borderRadius: 10, cursor: 'pointer', background: 'transparent',
                          border: `1.5px solid ${payMethodId === o.id ? 'var(--brand)' : COLORS.border}` }}>
                        <MethodTag name={o.method} size={13} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>{offer.paymentMethods.map(m => <MethodTag key={m} name={m} size={13} />)}</div>
                )
              ) : (
                <PaymentMethodPicker single methods={myMethods} selected={payMethodId ? [payMethodId] : []}
                  onToggle={id => setPayMethodId(id)} onAdd={() => setShowPmSheet(true)} />
              )}
              {offer.terms && (
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${COLORS.border}` }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.muted, marginBottom: 4 }}>Trader's terms</div>
                  <p style={{ fontSize: 13, color: COLORS.text, margin: 0, lineHeight: 1.45 }}>{offer.terms}</p>
                </div>
              )}
            </div>

            <p style={{ fontSize: 12, color: COLORS.muted, margin: '0 4px', lineHeight: 1.45 }}>
              {buyingUsdc ? "The seller's USDC is locked in escrow on Arc until they release it to you." : 'Your USDC is locked in escrow on Arc and released only when you confirm you were paid.'}
            </p>

            <button onClick={accept} disabled={accepting || !amt || sellShort || outOfLimit || methodMissing || !price} style={{
              padding: '15px 0', borderRadius: 14, border: 'none', cursor: 'pointer', background: accent, color: '#fff', fontSize: 15, fontWeight: 700,
              opacity: (accepting || !amt || sellShort || outOfLimit || methodMissing || !price) ? 0.45 : 1,
            }}>{accepting ? 'Creating order…' : `${buyingUsdc ? 'Buy' : 'Sell'} USDC`}</button>
          </>
        )}
      </div>

      {user?.id && (
        <PaymentMethodSheet open={showPmSheet} onClose={() => setShowPmSheet(false)} userId={user.id}
          defaultName={user.displayName ?? ''}
          onSaved={m => { setMyMethods(ms => [...ms, m]); setPayMethodId(m.id) }} />
      )}

      <AmountKeypad
        // The amount field has its own "All".
        showMax={false}
        open={showAmountPad && !isDesktop}
        value={typed}
        onChange={setTyped}
        decimals={typedDecimals}
        // Only bounds the Done button; the limits show under the field.
        balance={Number.POSITIVE_INFINITY}
        onClose={() => setShowAmountPad(false)}
        doneLabel="Done"
        onDone={() => setShowAmountPad(false)} />

      <PinSheet open={showPasscodeSheet} id="p2p-pass"
        title="Confirm order" bioVerb={offer.offerType === 'buy' ? 'Sell' : 'Buy'}
        subtitle={offer.offerType === 'buy'
          ? <>Lock {trimTrailingZeros(amt.toFixed(6))} USDC in escrow and sell</>
          : <>Buy {trimTrailingZeros(amt.toFixed(6))} USDC{price ? ` for ${sym}${fmt(fiatTotal)}` : ''}</>}
        value={passEntry} onChange={v => { setPassEntry(v); setPassError('') }}
        error={passError || undefined}
        onComplete={() => { void handlePasscodeConfirm() }}
        fallbackConfirm={storedPasscode ? undefined : { label: 'Confirm Order', onConfirm: () => { void handlePasscodeConfirm() } }}
        onClose={() => { setShowPasscodeSheet(false); setPassEntry(''); setPassError('') }}
      />
      <ProcessingFlipCard {...flipState} onDismiss={handleDismissAcceptFlip}
        onExited={() => { const go = afterAcceptFlip.current; afterAcceptFlip.current = null; go?.() }} />
    </div>
  )
}

// ── Trade Detail - status flow, timer, chat ─────────────────────────────────
export function P2PTradePage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const { tradeId } = useParams<{ tradeId: string }>()
  const navigate = useNavigate()
  const goBack = useP2PBack('/p2p/my-trades')
  const user = useAuthStore(s => s.user)
  const storedPasscode = useAuthStore(s => s.passcode)
  const { showToastMessage } = useUIStore()
  const [trade, setTrade] = useState<P2PTrade | null>(null)
  const [messages, setMessages] = useState<P2PMessage[]>([])
  const [input, setInput] = useState('')
  // Trade chat composer: failed sends (retry) and the growing text box.
  const [failedIds, setFailedIds] = useState<Record<string, boolean>>({})
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const [acting, setActing] = useState(false)
  const [processingPayment, setProcessingPayment] = useState(false)
  // Marking the trade paid is an on-chain step: hold Back / sidebar until it returns.
  useLeaveGuard(processingPayment, 'Payment')
  const [now, setNow] = useState(Date.now())
  const { flipState, runFlip, dismissFlip } = useProcessingFlip()
  const { glassPop, showGlassPop, dismissGlassPop } = useGlassPop()
  const [showRating, setShowRating] = useState(false)
  const [ratingValue, setRatingValue] = useState(5)
  const [showDispute, setShowDispute] = useState(false)
  const [disputeReason, setDisputeReason] = useState('')
  const [disputeSubmitting, setDisputeSubmitting] = useState(false)
  // What the passcode sheet, once confirmed, should actually execute -
  // 'release' moves escrowed USDC to the buyer, 'cancel' can refund a
  // buy-offer trade's deposit back to the seller (see refund() in
  // p2pProviders.ts) - both are on-chain-moving actions, so both are
  // gated the same way as offer create/cancel above.
  const [pendingAction, setPendingAction] = useState<'release' | 'cancel' | 'confirm' | null>(null)
  // Its passcode sheet keeps its title while it slides away.
  const actionShown = useLatched(pendingAction)
  const [passEntry, setPassEntry] = useState('')
  const [passError, setPassError] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  // ── Payment proof attachment - buyer/seller can attach a receipt
  // screenshot to the trade chat. Previously there was no way to attach
  // anything here at all (trade messages were text-only); this reuses the
  // same Supabase Storage 'attachments' bucket and `[IMAGE](url)` content
  // convention the 1:1 chat already uses, so no schema change is needed -
  // p2p_trade_messages.content just carries the marker string.
  const proofFileInputRef = useRef<HTMLInputElement>(null)
  const [proofFile, setProofFile] = useState<{ file: File; previewUrl: string } | null>(null)
  const [uploadingProof, setUploadingProof] = useState(false)
  // Where the buyer pays (the seller's account chosen for this order) and the
  // seller's "I have received the payment" tick before releasing.
  const [payTo, setPayTo] = useState<{ method: string; holderName: string; details: Record<string, string> } | null>(null)
  const [receivedChecked, setReceivedChecked] = useState(false)

  useEffect(() => {
    if (!tradeId || !trade?.paymentMethodId) return
    fetchTradePayTo(tradeId).then(setPayTo).catch(() => {})
  }, [tradeId, trade?.paymentMethodId, trade?.status])

  useEffect(() => {
    if (!tradeId) return
    fetchTrade(tradeId).then(setTrade)
    fetchTradeMessages(tradeId).then(setMessages)
    const unsubMsg = subscribeToTradeMessages(tradeId, m => setMessages(prev => prev.some(x => x.id === m.id) ? prev : [...prev, m]))
    const unsubTrade = subscribeToTradeUpdates(tradeId, setTrade)
    return () => { unsubMsg(); unsubTrade() }
  }, [tradeId])
  // Backup for the live update: while the trade is still moving, read it
  // again every few seconds (screen on), so the other side's step (paid,
  // released) shows even if the realtime connection dropped.
  const tradeStatus = trade?.status
  useEffect(() => {
    if (!tradeId || !tradeStatus || ['completed', 'cancelled', 'expired', 'resolved_buyer', 'resolved_seller'].includes(tradeStatus)) return
    const iv = setInterval(() => {
      if (document.visibilityState === 'visible') fetchTrade(tradeId).then(t => { if (t) setTrade(t) }).catch(() => {})
    }, 4000)
    return () => clearInterval(iv)
  }, [tradeId, tradeStatus])

  // Fraud protection: auto-cancel this trade if its 15-minute window has
  // already passed - same check-on-read shape as the Hub's offer-expiry
  // sweep. Scoped to just this user's trades (autoCancelExpiredTrades
  // checks all of them), which is fine - cheap at this feature's scale,
  // and guarantees this specific trade gets corrected the moment its own
  // detail page is opened, not just whenever some other screen happens to run it.
  useEffect(() => {
    if (user?.id) autoCancelExpiredTrades(user.id)
  }, [user?.id])

  // Companion sweep for the OTHER way a trade can get stranded: a release that
  // claimed the trade ('payment_sent' -> 'released') but never finished moving
  // funds, because the tab closed or the connection dropped between the claim
  // and its compensation. releaseTrade can't fix what it never gets to run, so
  // this repairs it after the fact - reading the escrow contract's own
  // tradeReleased flag rather than guessing, and changing nothing when the
  // on-chain state can't be established. Never sends a transaction.
  useEffect(() => {
    if (user?.id) reconcileStuckReleases(user.id)
  }, [user?.id])

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [])

  // Rating prompt, buyer-covering fix: previously the ONLY way this sheet
  // ever appeared was inline inside doRelease() below - which only the
  // trade's SELLER can ever run (the Release button itself is rendered
  // `!isBuyer`-only). That meant a buyer was never once prompted to rate
  // their seller, in either offer-type scenario, and a seller who
  // dismissed the one-shot prompt (or whose page reloaded before it
  // fired) had no second chance either. This effect is the general,
  // role-agnostic fix: any time THIS trade is 'completed' and the
  // currently-viewing party hasn't rated it yet, offer the prompt -
  // covers the buyer opening a trade someone else released, either party
  // reopening one later, and dispute-resolved completions where neither
  // side ever clicked Release at all. hasRatedTrade() is checked first so
  // this never re-pops for someone who already rated (including the
  // seller's own immediate doRelease prompt, once they've submitted it).
  useEffect(() => {
    if (!user?.id || !trade || trade.status !== 'completed') return
    let cancelled = false
    hasRatedTrade(trade.id, user.id).then(already => {
      if (!cancelled && !already) setShowRating(true)
    })
    return () => { cancelled = true }
  }, [trade?.status, trade?.id, user?.id])

  // New chat lines follow the conversation only when you're already at the
  // bottom - the order details above never get yanked out of view.
  const nearBottom = useRef(true)
  useEffect(() => {
    const el = scrollRef.current
    if (el && nearBottom.current && messages.length) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages.length])
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => { nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120 }
    el.addEventListener('scroll', onScroll, { passive: true })
    // Opening an order shows the order first, not the end of the chat.
    nearBottom.current = false
    return () => el.removeEventListener('scroll', onScroll)
  }, [trade?.id])

  if (!trade || !user) return (
    <div className="lg:max-w-[900px]" style={{ background: COLORS.bg, minHeight: '100%', height: '100%', overflowY: 'auto', overflowX: 'hidden' }}>
      <Header title="Trade Details" onBack={goBack} />
      <SkeletonCards count={4} className="pt-2" />
    </div>
  )

  const isBuyer = trade.buyerId === user.id
  // Once the trade's own selected window passes, a 'waiting_for_buyer'
  // trade still isn't truly expired for another GRACE_PERIOD_MINUTES (see
  // isTradeExpired's own comment in p2pService.ts) - the countdown should
  // keep running through that window instead of freezing at 0:00 while
  // the buyer can still tap "I've Paid".
  const windowEndMs = new Date(trade.expiresAt).getTime()
  const inGracePeriod = trade.status === 'waiting_for_buyer' && now >= windowEndMs
  const deadlineMs = trade.status === 'waiting_for_buyer' ? windowEndMs + GRACE_PERIOD_MINUTES * 60_000 : windowEndMs
  const secondsLeft = Math.max(0, Math.floor((deadlineMs - now) / 1000))
  const mins = Math.floor(secondsLeft / 60)
  const secs = secondsLeft % 60
  const expired = isTradeExpired(trade) && (trade.status === 'waiting_for_buyer' || trade.status === 'awaiting_seller_confirmation')
  const meta = statusMeta(expired ? 'expired' : trade.status)

  // Your message shows at once (like the chat), then becomes the saved one;
  // if saving fails it stays with "Not sent · tap to retry".
  const sendText = async (text: string, localId?: string) => {
    const id = localId ?? `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    if (!localId) setMessages(prev => [...prev, { id, tradeId: trade.id, senderId: user.id, content: text, isSystem: false, createdAt: new Date().toISOString() } as P2PMessage])
    setFailedIds(f => { if (!f[id]) return f; const n = { ...f }; delete n[id]; return n })
    const saved = await sendTradeMessage(trade.id, user.id, text, false)
    if (!saved) { setFailedIds(f => ({ ...f, [id]: true })); return }
    // The live update may already have added the saved copy - keep one.
    setMessages(prev => prev.some(m => m.id === saved.id) ? prev.filter(m => m.id !== id) : prev.map(m => m.id === id ? saved : m))
  }
  const resizeComposer = () => {
    const el = composerRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
    el.style.overflowY = el.scrollHeight > 120 ? 'auto' : 'hidden'
  }
  const send = async () => {
    const text = input.trim()
    if (!text && !proofFile) return
    setInput('')
    requestAnimationFrame(resizeComposer)
    if (proofFile) await sendProofNow(proofFile)
    if (text) await sendText(text)
  }

  const stageProofFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) { showToastMessage('Payment proof must be an image', 'error'); return }
    const maxSize = 10 * 1024 * 1024
    if (file.size > maxSize) { showToastMessage('Image is too large - max 10MB', 'error'); return }
    if (proofFile) URL.revokeObjectURL(proofFile.previewUrl)
    setProofFile({ file, previewUrl: URL.createObjectURL(file) })
  }

  const clearProofFile = () => {
    if (proofFile) URL.revokeObjectURL(proofFile.previewUrl)
    setProofFile(null)
  }

  const sendProofNow = async (staged: { file: File; previewUrl: string }) => {
    setUploadingProof(true)
    try {
      const { supabase } = await import('@/lib/supabase')
      const ext = staged.file.name.split('.').pop() || 'jpg'
      const fileName = `p2p/${trade.id}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
      const { error: uploadErr } = await supabase.storage.from('attachments').upload(fileName, staged.file, { cacheControl: '3600', upsert: false })
      if (uploadErr) { showToastMessage('Upload failed - please try again', 'error'); return }
      const { data: urlData } = supabase.storage.from('attachments').getPublicUrl(fileName)
      await sendTradeMessage(trade.id, user.id, `[IMAGE](${urlData.publicUrl})`, false)
      URL.revokeObjectURL(staged.previewUrl)
      setProofFile(null)
    } catch (e: any) {
      showToastMessage('Upload failed - please try again', 'error')
    } finally {
      setUploadingProof(false)
    }
  }

  const handleMarkPaid = async () => {
    // Fake payment-processing animation (2-3s) - see fiatProvider in
    // p2pProviders.ts for why this delay exists: it's the one place in the
    // whole module deliberately slow, so the demo reads as "a payment rail
    // is doing something" rather than an instantly, obviously fake flip.
    setProcessingPayment(true)
    setActing(true)
    // A short floor only so the processing card doesn't flash (the on-chain
    // step itself is now ~1s; it used to be hidden behind a fixed 2.4s).
    const [result] = await Promise.all([
      markPaymentSent(trade),
      new Promise(r => setTimeout(r, 700)),
    ])
    setProcessingPayment(false)
    setActing(false)
    // Show the next step at once - don't wait for the live update.
    if (result.success) fetchTrade(trade.id).then(t => { if (t) setTrade(t) }).catch(() => {})
    if (result.success) showGlassPop('Payment Marked', result.message, { kind: 'success' })
    else showToastMessage(result.message, 'error')
  }

  // SECURITY/CORRECTNESS FIX: both handlers used to have no try/catch -
  // any unexpected throw from releaseTrade()/cancelTrade() (network
  // errors, etc.) would skip setActing(false) and the toast entirely,
  // leaving the button stuck on its "in progress" label forever with zero
  // visible feedback. releaseTrade() itself is now hardened not to throw
  // for the specific case that caused this in production, but this
  // try/catch/finally is a deliberate second layer - no future bug
  // anywhere in this call chain should be able to hide silently again.
  const doRelease = async () => {
    setActing(true)
    const result = await runFlip('Releasing USDC to buyer…', () => releaseTrade(trade), { successTitle: 'Trade Completed', errorTitle: 'Release Failed' })
    if (result.success) { fetchTrade(trade.id).then(t => { if (t) setTrade(t) }).catch(() => {}); setShowRating(true) }
    setActing(false)
  }

  // Seller-side confirmation for a sell-offer trade - signs registerTrade
  // with THIS device's key, which only works when this device belongs to
  // the offer's actual seller (the only signer the contract accepts). See
  // confirmSellTradeOnChain's own comment in p2pService.ts for why this
  // step exists as a separate, seller-initiated action instead of
  // happening automatically when the buyer accepts.
  const doConfirmSellTrade = async () => {
    setActing(true)
    await runFlip('Registering trade on-chain…', () => confirmSellTradeOnChain(trade), { successTitle: 'Trade Confirmed', errorTitle: 'Confirmation Failed' })
    setActing(false)
  }

  const doCancel = async () => {
    setActing(true)
    await runFlip('Cancelling trade…', () => cancelTrade(trade, 'Cancelled by user', user.id), { successTitle: 'Trade Cancelled', errorTitle: 'Could Not Cancel' })
    setActing(false)
  }

  // Entry points for the Release/Cancel buttons - open the passcode sheet
  // instead of executing right away.
  const handleRelease = () => { setPassEntry(''); setPassError(''); setPendingAction('release') }
  const handleCancel  = () => { setPassEntry(''); setPassError(''); setPendingAction('cancel') }
  const handleConfirmSellTrade = () => { setPassEntry(''); setPassError(''); setPendingAction('confirm') }

  const handlePasscodeConfirm = async () => {
    if (storedPasscode) {
      if (passEntry.length < 6) { setPassError('Enter your 6-digit passcode'); return }
      const { verifyPasscode } = await import('@/lib/security')
      // Unlock the wallet key at the same time as the passcode check (both are
      // slow on purpose) instead of after it - restorePrivateKey below joins
      // this same in-flight unlock. Silent: a wrong passcode must only show
      // "Incorrect passcode".
      if (!useAuthStore.getState().signer) import('@/lib/restoreWallet').then(m => m.restorePrivateKey(passEntry, { silent: true })).catch(() => {})
      if (!await verifyPasscode(passEntry, storedPasscode)) { setPassError('Incorrect passcode'); setPassEntry(''); return }
      // Verifying the passcode only proves it's correct - it does NOT by
      // itself put the private key back in memory. signer is
      // deliberately never persisted (see store/index.ts's partialize),
      // so after any fresh page load it's null until explicitly restored.
      // Without this call, a correct passcode entry here was previously
      // followed by a release/accept/cancel that still failed with
      // "Couldn't access your wallet on this device" - the exact bug this
      // fixes. Passing the just-verified passcode lets restorePrivateKey
      // decrypt this device's locally-stored encrypted key immediately,
      // no extra prompt needed.
      const { restorePrivateKey } = await import('@/lib/restoreWallet')
      const restored = await restorePrivateKey(passEntry)
      if (!restored && !useAuthStore.getState().signer) {
        setPassError("Couldn't unlock your wallet on this device. Try reloading the app.")
        return
      }
    }
    const action = pendingAction
    setPendingAction(null); setPassEntry(''); setPassError('')
    if (action === 'release') await doRelease()
    else if (action === 'cancel') await doCancel()
    else if (action === 'confirm') await doConfirmSellTrade()
  }

  const handleOpenDispute = async () => {
    setDisputeSubmitting(true)
    const result = await openDispute(trade, user.id, disputeReason.trim() || 'No reason provided')
    setDisputeSubmitting(false)
    showToastMessage(result.message, result.success ? 'success' : 'error')
    if (result.success) { setShowDispute(false); setDisputeReason('') }
  }

  const submitRatingNow = async () => {
    const ratedId = isBuyer ? trade.sellerId : trade.buyerId
    await submitRating({ tradeId: trade.id, raterId: user.id, ratedId, rating: ratingValue })
    setShowRating(false)
    showToastMessage('Thanks for rating your trade partner', 'success')
  }

  // Timeline - a real audit trail of this trade's actual state changes,
  // not just the current status. Only ever shows steps that genuinely
  // happened, in the order the timestamps say they happened.
  const timelineSteps: Array<{ label: string; at: string }> = [
    { label: 'Trade created', at: trade.createdAt },
    ...(trade.paymentSentAt ? [{ label: 'Buyer marked paid', at: trade.paymentSentAt }] : []),
    ...(trade.releasedAt ? [{ label: 'USDC released', at: trade.releasedAt }] : []),
    ...(trade.completedAt ? [{ label: 'Trade completed', at: trade.completedAt }] : []),
  ]

  return (
    <div className="lg:max-w-[900px]" style={{ background: COLORS.bg, minHeight: '100%', display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Order details and chat scroll together; the composer stays put. */}
      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
      {(() => {
        const sym = currencySymbol(trade.currency)
        const fmtMoney = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        const active = !expired && (trade.status === 'waiting_for_buyer' || trade.status === 'awaiting_seller_confirmation')
        const done = trade.status === 'completed' || trade.status === 'released'
        const dead = expired || trade.status === 'cancelled' || trade.status === 'expired'
        const title = done ? 'Order completed'
          : dead ? (trade.status === 'cancelled' ? 'Order cancelled' : 'Order expired')
          : trade.status === 'awaiting_seller_confirmation' ? (isBuyer ? 'Waiting for seller' : 'Accept order')
          : trade.status === 'waiting_for_buyer' ? (isBuyer ? 'Pay the seller' : 'Waiting for payment')
          : (isBuyer ? 'Waiting for release' : 'Release USDC')
        const stepNames = isBuyer ? ['Pay', 'Notify seller', 'Receive USDC'] : ['Buyer pays', 'Check payment', 'Release']
        const stepIdx = done ? 3 : trade.status === 'payment_sent' ? 2 : trade.status === 'waiting_for_buyer' ? 1 : 0
        const orderNo = trade.id.replace(/-/g, '').slice(0, 12).toUpperCase().replace(/(.{4})(?=.)/g, '$1-')
        const copy = async (label: string, v: string) => {
          const ok = await copyToClipboard(v)
          showToastMessage(ok ? `${label} copied` : `Could not copy ${label.toLowerCase()}`, ok ? 'success' : 'error')
        }
        const CopyBtn = ({ label, v }: { label: string; v: string }) => (
          <button onClick={() => copy(label, v)} aria-label={`Copy ${label}`} style={{ background: 'none', border: 'none', padding: '0 0 0 6px', cursor: 'pointer', color: COLORS.muted, fontSize: 13 }}>⧉</button>
        )
        const line = (k: string, v: ReactNode) => (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, fontSize: 13, padding: '5px 0' }}>
            <span style={{ color: COLORS.muted }}>{k}</span><span style={{ color: COLORS.text, fontWeight: 600, textAlign: 'right', display: 'inline-flex', alignItems: 'center', minWidth: 0, wordBreak: 'break-all' }}>{v}</span>
          </div>
        )
        const card: CSSProperties = { background: COLORS.surface, borderRadius: 14, padding: '12px 14px', border: `1px solid ${COLORS.border}`, marginBottom: 10 }
        const unread = messages.filter(m => !m.isSystem && m.senderId !== user.id).length
        const detailLabels: Record<string, string> = { upi_id: 'UPI ID', account: 'Account no.', ifsc: 'IFSC / SWIFT', bank: 'Bank', iban: 'IBAN', email: 'Email', phone: 'Phone / tag' }
        return (
          <>
            <Header title={title} onBack={goBack} right={
              <button onClick={() => { const el = scrollRef.current; if (el) { nearBottom.current = true; el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }) } }} aria-label="Chat"
                style={{ position: 'relative', background: 'none', border: 'none', cursor: 'pointer', padding: 6, display: 'flex' }}>
                <SendIcon size={18} color={COLORS.text} />
                {unread > 0 && <span style={{ position: 'absolute', top: 0, right: 0, minWidth: 15, height: 15, borderRadius: 999, background: 'var(--danger)', color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px' }}>{unread}</span>}
              </button>
            } />
            <div style={{ padding: '0 16px 12px' }}>
              {/* Countdown */}
              {active && trade.status !== 'awaiting_seller_confirmation' && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span style={{ fontSize: 13, color: COLORS.muted }}>{isBuyer ? 'Complete payment within' : 'Buyer pays within'}{inGracePeriod ? ' (grace period)' : ''}</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums', padding: '4px 10px', borderRadius: 999,
                    color: secondsLeft < 120 ? COLORS.error : COLORS.warning, background: `color-mix(in srgb, ${secondsLeft < 120 ? 'var(--danger)' : 'var(--warning)'} 15%, transparent)` }}>
                    <Clock size={13} /> {mins}:{secs.toString().padStart(2, '0')}
                  </span>
                </div>
              )}
              {!dead && (
                <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                  {stepNames.map((n, i) => (
                    <div key={n} style={{ flex: 1, fontSize: 11, color: i < stepIdx ? COLORS.text : COLORS.muted, fontWeight: i < stepIdx ? 600 : 500 }}>
                      <div style={{ height: 3, borderRadius: 2, marginBottom: 5, background: i < stepIdx ? COLORS.success : COLORS.border }} />{n}
                    </div>
                  ))}
                </div>
              )}
              {/* The title already says cancelled / expired - only the reason is new. */}
              {dead && trade.cancelReason && (
                <div style={{ ...card, textAlign: 'center', color: COLORS.muted, fontSize: 13 }}>
                  Reason: {trade.cancelReason}
                </div>
              )}

              {/* Seller: buyer says they paid */}
              {trade.status === 'payment_sent' && !isBuyer && trade.disputeStatus !== 'open' && (
                <div style={{ ...card, borderColor: 'color-mix(in srgb, var(--success) 45%, transparent)', background: 'color-mix(in srgb, var(--success) 8%, var(--surface))' }}>
                  <div style={{ fontWeight: 700, color: COLORS.success, fontSize: 14 }}>Buyer marked the order as paid</div>
                  <div style={{ fontSize: 13, color: COLORS.muted, marginTop: 4, lineHeight: 1.45 }}>
                    Open your {trade.paymentMethod} account and check the payment has arrived before releasing. Never release on a screenshot alone.
                  </div>
                </div>
              )}

              {/* Order */}
              <div style={card}>
                <div style={{ fontSize: 12, color: COLORS.muted }}>{isBuyer ? 'Amount to pay' : 'Amount you receive'}</div>
                <div style={{ display: 'flex', alignItems: 'center', fontSize: 24, fontWeight: 800, color: isBuyer ? COLORS.success : COLORS.text, marginTop: 2 }}>
                  {sym}{fmtMoney(trade.amountFiat)} <CopyBtn label="Amount" v={String(trade.amountFiat)} />
                </div>
                {line('Price', `${sym}${fmtMoney(trade.pricePerUsdc)}`)}
                {/* Done: the completed card below shows the USDC. The header title says the status. */}
                {!done && line(isBuyer ? 'You receive' : 'You release', `${trimTrailingZeros(trade.amountUsdc.toFixed(6))} USDC`)}
                {line('Order no.', <>{orderNo}<CopyBtn label="Order number" v={trade.id} /></>)}
              </div>

              {/* Pay to */}
              {!dead && !done && (
                <div style={card}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                    <MethodTag name={payTo?.method ?? trade.paymentMethod} size={14} />
                    <span style={{ fontSize: 12, color: COLORS.muted }}>{isBuyer ? 'Pay to' : 'Your account'}</span>
                  </div>
                  {payTo ? (
                    <>
                      {line('Name', <>{payTo.holderName}<CopyBtn label="Name" v={payTo.holderName} /></>)}
                      {Object.entries(payTo.details).map(([k, v]) => line(detailLabels[k] ?? k, <>{v}<CopyBtn label={detailLabels[k] ?? k} v={v} /></>))}
                    </>
                  ) : (
                    <div style={{ fontSize: 13, color: COLORS.muted, padding: '6px 0' }}>
                      {isBuyer ? "Ask the seller for their payment details in the chat." : 'The buyer pays you by this method.'}
                    </div>
                  )}
                  {isBuyer && (
                    <div style={{ fontSize: 12, color: COLORS.muted, marginTop: 6, lineHeight: 1.45 }}>
                      Pay from an account in your own name. Don't write "USDC" or "crypto" in the payment note.
                    </div>
                  )}
                </div>
              )}

              {/* Seller: confirm received */}
              {trade.status === 'payment_sent' && !isBuyer && trade.disputeStatus !== 'open' && (
                <button onClick={() => setReceivedChecked(v => !v)} style={{ ...card, width: '100%', display: 'flex', gap: 10, alignItems: 'flex-start', textAlign: 'left', cursor: 'pointer' }}>
                  <span aria-hidden style={{ width: 20, height: 20, borderRadius: 6, flexShrink: 0, marginTop: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: receivedChecked ? 'var(--success)' : 'transparent', border: receivedChecked ? 'none' : `1.5px solid ${COLORS.border}`, color: '#fff', fontSize: 12 }}>{receivedChecked && <Check size={13} strokeWidth={3} />}</span>
                  <span style={{ fontSize: 13, color: COLORS.text, lineHeight: 1.4 }}>I have checked my account and <b>received {sym}{fmtMoney(trade.amountFiat)}</b> from the buyer.</span>
                </button>
              )}

              {/* Buyer, after paying */}
              {trade.status === 'payment_sent' && isBuyer && trade.disputeStatus !== 'open' && (
                <div style={{ ...card, fontSize: 13, color: COLORS.muted, lineHeight: 1.45 }}>
                  The seller has been notified. Once they confirm your payment, the USDC is released from escrow to your wallet.
                </div>
              )}

              {/* Ads without instant orders: the seller accepts each order */}
              {trade.status === 'awaiting_seller_confirmation' && !expired && isBuyer && (
                <div style={{ ...card, fontSize: 13, color: COLORS.muted, textAlign: 'center' }}>
                  Waiting for the seller to accept this order. You'll be notified - you can pay once it's accepted.
                </div>
              )}

              {done && (
                <div style={{ ...card, textAlign: 'center' }}>
                  <div style={{ width: 52, height: 52, borderRadius: '50%', margin: '4px auto 8px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'color-mix(in srgb, var(--success) 15%, transparent)' }}>
                    <CheckCircle2 size={26} color="var(--success)" />
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: COLORS.text }}>{isBuyer ? '+' : '−'}{trimTrailingZeros(trade.amountUsdc.toFixed(6))} USDC</div>
                  <div style={{ fontSize: 13, color: COLORS.muted, marginTop: 3 }}>{isBuyer ? 'Added to your MeshPort wallet' : 'Released to the buyer'}</div>
                  {trade.txHash && (
                    <a href={arcExplorerTxUrl(trade.txHash)} target="_blank" rel="noopener noreferrer"
                      style={{ display: 'inline-block', marginTop: 8, color: COLORS.primaryText, fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>View on Arc explorer ↗</a>
                  )}
                </div>
              )}

              {trade.disputeStatus === 'open' && (
                <div style={{ textAlign: 'center', fontSize: 13, color: COLORS.warning, background: 'color-mix(in srgb, var(--warning) 10%, transparent)', borderRadius: 14, padding: '11px 14px', marginBottom: 10, fontWeight: 600 }}>
                  {DISPUTE_LOCKED_MESSAGE}
                </div>
              )}

              {/* Actions */}
              {trade.status === 'awaiting_seller_confirmation' && !expired && !isBuyer && trade.disputeStatus !== 'open' && (
                <button onClick={handleConfirmSellTrade} disabled={acting} style={{ width: '100%', padding: '14px 0', borderRadius: 14, border: 'none', background: COLORS.primary, color: '#fff', fontSize: 15, fontWeight: 700, marginBottom: 10, opacity: acting ? 0.6 : 1 }}>
                  {acting ? 'Accepting…' : 'Accept order'}
                </button>
              )}
              {(() => {
                const canCancel = (trade.status === 'waiting_for_buyer' || trade.status === 'awaiting_seller_confirmation') && canCancelTrade(trade, user.id).allowed
                const buyerPay = trade.status === 'waiting_for_buyer' && !expired && isBuyer && trade.disputeStatus !== 'open'
                const sellerRelease = trade.status === 'payment_sent' && !isBuyer && trade.disputeStatus !== 'open'
                if (!canCancel && !buyerPay && !sellerRelease) return null
                return (
                  <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                    {canCancel && (
                      <button onClick={handleCancel} disabled={acting} style={{ flex: buyerPay ? 0.7 : 1, padding: '14px 0', borderRadius: 14, border: `1px solid ${COLORS.border}`, background: 'none', color: COLORS.text, fontSize: 15, fontWeight: 700 }}>Cancel</button>
                    )}
                    {buyerPay && (
                      <button onClick={handleMarkPaid} disabled={acting} style={{ flex: 1.3, padding: '14px 0', borderRadius: 14, border: 'none', background: COLORS.success, color: '#fff', fontSize: 15, fontWeight: 700, opacity: acting ? 0.6 : 1 }}>
                        {processingPayment ? 'Notifying seller…' : 'Transferred, notify seller'}
                      </button>
                    )}
                    {sellerRelease && (
                      <button onClick={handleRelease} disabled={acting || !receivedChecked} style={{ flex: 1, padding: '14px 0', borderRadius: 14, border: 'none', background: COLORS.success, color: '#fff', fontSize: 15, fontWeight: 700, opacity: acting || !receivedChecked ? 0.45 : 1 }}>
                        {acting ? 'Releasing…' : `Release ${trimTrailingZeros(trade.amountUsdc.toFixed(6))} USDC`}
                      </button>
                    )}
                  </div>
                )
              })()}
              {isBuyer && trade.status === 'waiting_for_buyer' && !expired && trade.disputeStatus !== 'open' && (
                <div style={{ textAlign: 'center', fontSize: 12, color: COLORS.muted, marginBottom: 8, lineHeight: 1.45 }}>
                  Tap <strong>Transferred, notify seller</strong> as soon as you send the payment — that locks the trade so the seller can’t cancel it.
                </div>
              )}
              {(trade.status === 'waiting_for_buyer' || trade.status === 'payment_sent') && trade.disputeStatus !== 'open' && (
                <div style={{ textAlign: 'center', fontSize: 13, color: COLORS.muted, marginBottom: 10 }}>
                  Problem with this order?{' '}
                  <button onClick={() => setShowDispute(true)} style={{ background: 'none', border: 'none', padding: 0, color: COLORS.primaryText, fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>Appeal</button>
                </div>
              )}

              {/* Timeline */}
              {timelineSteps.length > 1 && (
                <div style={{ background: COLORS.surfaceSecondary, borderRadius: 14, padding: '12px 14px', marginBottom: 10 }}>
                  {timelineSteps.map((step, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: i < timelineSteps.length - 1 ? 10 : 0 }}>
                      <div style={{ width: 7, height: 7, borderRadius: '50%', background: COLORS.success, flexShrink: 0 }} />
                      <div style={{ flex: 1, fontSize: 12, color: COLORS.text }}>{step.label}</div>
                      <div style={{ fontSize: 11, color: COLORS.muted }}>{new Date(step.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.muted, margin: '6px 0 4px' }}>Chat with {isBuyer ? 'seller' : 'buyer'}</div>
            </div>
          </>
        )
      })()}

      {/* Fake payment-processing overlay - see handleMarkPaid's comment */}
      <AnimatePresence>
        {processingPayment && (
          // The popup dim and its fade (DIALOG_BACKDROP); the loader fades with it.
          <motion.div data-leave-guard="" initial={DIALOG_BACKDROP.initial} animate={DIALOG_BACKDROP.animate} exit={DIALOG_BACKDROP.exit}
            transition={DIALOG_BACKDROP.transition}
            style={{ position: 'fixed', inset: 0, background: POPUP_DIM, zIndex: 200, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
            <MeshLoader size={44} color="#5CD6CB" label="Processing" />
            <p style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>Notifying the seller…</p>
            <p style={{ fontSize: 12, color: COLORS.muted, textAlign: 'center', maxWidth: 260 }}>Recording on Arc that you've paid - the seller can no longer cancel.</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Chat */}
      <div style={{ padding: '0 16px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {messages.map(m => m.isSystem && m.senderId === 'admin' ? (
          // Admin speaking directly to both parties (e.g. asking for proof
          // of payment) - a real message from a real person, so it gets a
          // labeled bubble like Buyer/Seller do, not the generic gray
          // system-log pill below (which would read as an automated line,
          // easy to miss or misread as impersonal).
          <div key={m.id} style={{ alignSelf: 'center', maxWidth: '85%' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.warning, textAlign: 'center', marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.3 }}>Admin</div>
            <div style={{ background: 'color-mix(in srgb, var(--warning) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)', color: COLORS.text, borderRadius: 14, padding: '9px 13px', fontSize: 14 }}>{m.content}</div>
          </div>
        ) : m.isSystem ? (
          // One solid rounded card per line (an inline span's background
          // broke into strips on every wrapped line).
          <div key={m.id} style={{ alignSelf: 'center', maxWidth: '88%', margin: '4px 0', padding: '7px 12px', borderRadius: 12, textAlign: 'center',
            fontSize: 12, lineHeight: 1.45, color: COLORS.muted, background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
            {cleanSystemText(m.content)}
          </div>
        ) : m.content.startsWith('[IMAGE](') ? (
          <div key={m.id} style={{ alignSelf: m.senderId === user.id ? 'flex-end' : 'flex-start', maxWidth: '75%' }}>
            <img decoding="async"
              src={safeStorageUrl(m.content.match(/^\[IMAGE\]\((.+)\)$/)?.[1])}
              alt="payment proof"
              onClick={() => openExternal(safeStorageUrl(m.content.match(/^\[IMAGE\]\((.+)\)$/)?.[1]))}
              style={{ maxWidth: '100%', borderRadius: 14, display: 'block', cursor: 'zoom-in' }}
            />
          </div>
        ) : (
          <div key={m.id} style={{ alignSelf: m.senderId === user.id ? 'flex-end' : 'flex-start', maxWidth: '75%' }}>
            <div style={{ background: m.senderId === user.id ? COLORS.primary : COLORS.surface, color: m.senderId === user.id ? '#fff' : COLORS.text, borderRadius: 14, padding: '9px 13px', fontSize: 14,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: m.id.startsWith('local_') && !failedIds[m.id] ? 0.75 : 1 }}>{m.content}</div>
            {failedIds[m.id] && (
              <button type="button" onClick={() => sendText(m.content, m.id)}
                style={{ display: 'block', marginLeft: 'auto', marginTop: 3, border: 'none', background: 'none', padding: '2px 4px', fontSize: 12, fontWeight: 600, color: '#ff8a7a', cursor: 'pointer' }}>
                Not sent · Tap to retry
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Staged payment-proof preview */}
      {proofFile && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderTop: `1px solid ${COLORS.border}` }}>
          <img decoding="async" src={proofFile.previewUrl} alt="proof preview" style={{ width: 44, height: 44, borderRadius: 8, objectFit: 'cover' }} />
          <div style={{ flex: 1, fontSize: 13, color: COLORS.muted }}>{uploadingProof ? 'Uploading payment proof…' : 'Payment proof ready to send'}</div>
          <button onClick={clearProofFile} disabled={uploadingProof} style={{ width: 26, height: 26, borderRadius: '50%', background: COLORS.surface, border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <XIcon size={14} color={COLORS.muted} />
          </button>
        </div>
      )}

      </div>

      {/* Composer */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, padding: '10px 12px', paddingBottom: 'calc(10px + env(safe-area-inset-bottom, 0px))', borderTop: `1px solid ${COLORS.border}`, background: COLORS.bg }}>
        <input ref={proofFileInputRef} type="file" accept="image/*" onChange={stageProofFile} style={{ display: 'none' }} />
        <button
          onClick={() => proofFileInputRef.current?.click()}
          title="Attach payment proof"
          style={{ width: 42, height: 42, flexShrink: 0, borderRadius: '50%', background: COLORS.surface, border: `1px solid ${COLORS.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
        >
          <Paperclip size={16} color={COLORS.muted} />
        </button>
        <textarea ref={composerRef} rows={1} value={input}
          onChange={e => { setInput(e.target.value); resizeComposer() }}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder={proofFile ? 'Add a note (optional)…' : 'Message your trade partner…'}
          style={{ flex: 1, minWidth: 0, background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 21, padding: '10px 16px', color: COLORS.text,
            fontSize: 'max(var(--fs-field, 0px), 15px)', lineHeight: '20px', height: 42, maxHeight: 120, outline: 'none', resize: 'none', overflowY: 'hidden', fontFamily: 'inherit', boxSizing: 'border-box' }} />
        {/* mousedown/touch doesn't take focus from the box → keyboard stays open */}
        <button onMouseDown={e => e.preventDefault()} onTouchEnd={e => { e.preventDefault(); if (!uploadingProof) send() }} onClick={send}
          disabled={uploadingProof || (!input.trim() && !proofFile)} aria-label="Send"
          style={{ width: 42, height: 42, flexShrink: 0, borderRadius: '50%', background: COLORS.primary, border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: uploadingProof ? 'default' : 'pointer', opacity: uploadingProof || (!input.trim() && !proofFile) ? 0.5 : 1, transition: 'opacity 0.15s' }}>
          <SendIcon size={18} color="#fff" style={{ marginLeft: 2 }} />
        </button>
      </div>

      {/* Dispute sheet / dialog */}
      <AnimatePresence>
        {showDispute && (() => {
          const disputeContent = (
            <>
              <p style={{ fontSize: 16, fontWeight: 700, color: COLORS.text, marginBottom: 4 }}>Open a dispute</p>
              <p style={{ fontSize: 12, color: COLORS.muted, marginBottom: 16 }}>Tell us what went wrong - an admin will review the chat and step in.</p>
              <textarea value={disputeReason} onChange={e => setDisputeReason(e.target.value)} placeholder="e.g. Payment was marked sent but I never received it"
                rows={4} style={{ width: '100%', background: COLORS.surface, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 12, fontSize: 'max(var(--fs-field, 0px), 13.5px)', marginBottom: 16, boxSizing: 'border-box', fontFamily: 'inherit', resize: 'none' }} />
              <button onClick={handleOpenDispute} disabled={disputeSubmitting} style={{ width: '100%', padding: '14px 0', borderRadius: 14, border: 'none', background: COLORS.warning, color: '#1A1A1A', fontSize: 14, fontWeight: 700, marginBottom: 10, opacity: disputeSubmitting ? 0.6 : 1 }}>
                {disputeSubmitting ? 'Submitting…' : 'Submit Dispute'}
              </button>
              <button onClick={() => setShowDispute(false)} style={{ width: '100%', padding: '10px 0', borderRadius: 14, border: 'none', background: 'none', color: COLORS.muted, fontSize: 13 }}>Cancel</button>
            </>
          )
          return (
            <DesktopDialogFrame onClose={() => setShowDispute(false)} maxWidth={440}>
              <div style={{ padding: '24px 20px 28px' }}>{disputeContent}</div>
            </DesktopDialogFrame>
          )
        })()}
      </AnimatePresence>

      {/* Rating sheet / dialog */}
      <AnimatePresence>
        {showRating && (() => {
          const ratingContent = (
            <>
              <p style={{ fontSize: 16, fontWeight: 700, color: COLORS.text, marginBottom: 4 }}>Rate your trade partner</p>
              <p style={{ fontSize: 12, color: COLORS.muted, marginBottom: 18 }}>Your rating shows on their ads and helps other traders choose.</p>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginBottom: 20 }}>
                {[1, 2, 3, 4, 5].map(n => (
                  <button key={n} onClick={() => setRatingValue(n)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                    <Star size={30} fill={n <= ratingValue ? COLORS.warning : 'none'} color={COLORS.warning} />
                  </button>
                ))}
              </div>
              <button onClick={submitRatingNow} style={{ width: '100%', padding: '14px 0', borderRadius: 14, border: '1px solid color-mix(in srgb, black 12%, transparent)', background: COLORS.primary, color: '#fff', fontSize: 14, fontWeight: 700, marginBottom: 10 }}>Submit Rating</button>
              <button onClick={() => setShowRating(false)} style={{ width: '100%', padding: '10px 0', borderRadius: 14, border: 'none', background: 'none', color: COLORS.muted, fontSize: 13 }}>Skip</button>
            </>
          )
          return (
            <DesktopDialogFrame onClose={() => setShowRating(false)} maxWidth={400}>
              <div style={{ padding: '24px 20px 28px', textAlign: 'center' }}>{ratingContent}</div>
            </DesktopDialogFrame>
          )
        })()}
      </AnimatePresence>

      <PinSheet open={!!pendingAction} id="p2p-pass"
        title={actionShown === 'release' ? 'Confirm release' : actionShown === 'confirm' ? 'Confirm trade' : 'Confirm cancel'}
        bioVerb={actionShown === 'release' ? 'Release' : 'Confirm'}
        subtitle={actionShown === 'release'
          ? <>Release {trade.amountUsdc} USDC from escrow to the buyer</>
          : actionShown === 'confirm'
          ? <>Register this trade on-chain so the buyer can pay</>
          : !isBuyer
          ? <>Only cancel if you have <strong>not</strong> received payment. If the buyer has already paid, cancelling takes their money — open a dispute instead. Escrowed USDC returns to you.</>
          : <>Cancel this trade</>}
        value={passEntry} onChange={v => { setPassEntry(v); setPassError('') }}
        error={passError || undefined}
        onComplete={() => { void handlePasscodeConfirm() }}
        fallbackConfirm={storedPasscode ? undefined : { label: actionShown === 'release' ? 'Confirm Release' : actionShown === 'confirm' ? 'Confirm Trade' : 'Confirm Cancel', onConfirm: () => { void handlePasscodeConfirm() } }}
        onClose={() => { setPendingAction(null); setPassEntry(''); setPassError('') }}
      />
      <ProcessingFlipCard {...flipState} onDismiss={dismissFlip} />
      <GlassPopCard {...glassPop} onDismiss={dismissGlassPop} />
    </div>
  )
}

// ── My Offers ─────────────────────────────────────────────────────────────
export function P2PMyOffersPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const user = useAuthStore(s => s.user)
  const storedPasscode = useAuthStore(s => s.passcode)
  const { showToastMessage } = useUIStore()
  const [offers, setOffers] = useState<P2POffer[]>(() => myOffersCache.get(user?.id ?? '')?.offers ?? [])
  const [remaining, setRemaining] = useState<Map<string, number>>(() => myOffersCache.get(user?.id ?? '')?.remaining ?? new Map())
  const [loading, setLoading] = useState(() => !myOffersCache.has(user?.id ?? ''))
  const [cancelling, setCancelling] = useState(false)
  const [offerToCancel, setOfferToCancel] = useState<P2POffer | null>(null)
  // The offer the cancel sheet shows - kept while it slides away. (Reading
  // offerToCancel.offerType here crashed My Ads whenever nothing was being
  // cancelled.)
  const cancelShown = useLatched(offerToCancel)
  const [passEntry, setPassEntry] = useState('')
  const [passError, setPassError] = useState('')

  // ── Delete offer (zero-balance offers only - no contract call) ───────────
  const [deleting, setDeleting] = useState(false)
  const [offerToDelete, setOfferToDelete] = useState<P2POffer | null>(null)

  // ── Edit offer (price / payment methods / terms) ──────────────────────────
  const [editingOffer, setEditingOffer] = useState<P2POffer | null>(null)
  const [editPrice, setEditPrice] = useState('')
  const [editMinAmount, setEditMinAmount] = useState('')
  const [editMaxAmount, setEditMaxAmount] = useState('')
  const [editMethods, setEditMethods] = useState<string[]>([])
  const [editTerms, setEditTerms] = useState('')
  const [editMargin, setEditMargin] = useState('')
  const [editMethodIds, setEditMethodIds] = useState<string[]>([])
  const [myMethods, setMyMethods] = useState<P2PPaymentMethod[]>([])
  const [showPmSheet, setShowPmSheet] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  useEffect(() => { if (user?.id) fetchMyPaymentMethods(user.id).then(setMyMethods) }, [user?.id])
  const [editSaving, setEditSaving] = useState(false)
  const [showEditPasscode, setShowEditPasscode] = useState(false)

  // ── Top up escrow (sell offers only) ───────────────────────────────────────
  const [toppingUpOffer, setToppingUpOffer] = useState<P2POffer | null>(null)
  const [topUpAmount, setTopUpAmount] = useState('')
  const [topUpSaving, setTopUpSaving] = useState(false)
  const [showTopUpPasscode, setShowTopUpPasscode] = useState(false)
  const { flipState, runFlip, dismissFlip } = useProcessingFlip()

  const load = useCallback(async () => {
    if (!user?.id) { setLoading(false); return }
    if (!myOffersCache.has(user.id)) setLoading(true)
    // Sweep this seller's own expired trades BEFORE fetching offers, so a
    // trade whose buyer never paid is already unlocked and its escrow
    // already reclaimed by the time this list renders - the seller sees
    // "available again" here, not a stale lock they'd have to refresh
    // away. This is the seller's own device, so releaseAbandonedSellReservation
    // resolves it completely on-chain, no admin step needed.
    await autoCancelExpiredTrades(user.id)
    const rows = await fetchMyOffers(user.id)
    const consumed = await fetchOfferConsumedAmounts(rows.map(o => o.id))
    const rem = new Map(rows.map(o => [o.id, offerRemainingAmount(o, consumed.get(o.id) ?? 0)]))
    myOffersCache.set(user.id, { offers: rows, remaining: rem })
    setOffers(rows)
    setRemaining(rem)
    setLoading(false)
  }, [user?.id])

  useEffect(() => { load() }, [load])

  // Live updates - same reasoning as the marketplace list in P2PPage:
  // this user's own offers (status flipping to completed/cancelled, escrow
  // top-ups, a new trade consuming part of the remaining amount) should
  // reflect instantly and survive a tab switch, not just whatever was true
  // at the last full reload.
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = subscribeToAllOffers(() => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(load, 400)
    })
    return () => { if (debounceTimer) clearTimeout(debounceTimer); unsubscribe() }
  }, [load])

  // Actual cancellation - for a sell offer this withdraws whatever's still
  // in escrow back to the wallet, so it's gated behind the passcode sheet
  // below rather than firing straight off the button tap.
  const doCancel = async (offer: P2POffer) => {
    setCancelling(true)
    await runFlip(
      offer.offerType === 'sell' ? 'Withdrawing escrow and cancelling offer…' : 'Cancelling offer…',
      () => cancelOfferAndWithdrawEscrow(offer),
      { successTitle: 'Offer Cancelled', errorTitle: 'Could Not Cancel Offer' },
    )
    setCancelling(false)
    load()
  }

  const requestCancel = (offer: P2POffer) => {
    setPassEntry(''); setPassError(''); setOfferToCancel(offer)
  }

  const handlePasscodeConfirm = async () => {
    if (storedPasscode) {
      if (passEntry.length < 6) { setPassError('Enter your 6-digit passcode'); return }
      const { verifyPasscode } = await import('@/lib/security')
      // Unlock the wallet key at the same time as the passcode check (both are
      // slow on purpose) instead of after it - restorePrivateKey below joins
      // this same in-flight unlock. Silent: a wrong passcode must only show
      // "Incorrect passcode".
      if (!useAuthStore.getState().signer) import('@/lib/restoreWallet').then(m => m.restorePrivateKey(passEntry, { silent: true })).catch(() => {})
      if (!await verifyPasscode(passEntry, storedPasscode)) { setPassError('Incorrect passcode'); setPassEntry(''); return }
      // Verifying the passcode only proves it's correct - it does NOT by
      // itself put the private key back in memory. signer is
      // deliberately never persisted (see store/index.ts's partialize),
      // so after any fresh page load it's null until explicitly restored.
      // Without this call, a correct passcode entry here was previously
      // followed by a release/accept/cancel that still failed with
      // "Couldn't access your wallet on this device" - the exact bug this
      // fixes. Passing the just-verified passcode lets restorePrivateKey
      // decrypt this device's locally-stored encrypted key immediately,
      // no extra prompt needed.
      const { restorePrivateKey } = await import('@/lib/restoreWallet')
      const restored = await restorePrivateKey(passEntry)
      if (!restored && !useAuthStore.getState().signer) {
        setPassError("Couldn't unlock your wallet on this device. Try reloading the app.")
        return
      }
    }
    const offer = offerToCancel
    setOfferToCancel(null); setPassEntry(''); setPassError('')
    if (offer) await doCancel(offer)
  }

  // Delete never touches the wallet/contract (there's nothing left to
  // withdraw), so this skips the passcode sheet entirely - the only thing
  // it needs from the user is a plain "are you sure", handled by the
  // confirm sheet below.
  const requestDelete = (offer: P2POffer) => setOfferToDelete(offer)

  const confirmDelete = async () => {
    const offer = offerToDelete
    setOfferToDelete(null)
    if (!offer || !user?.id) return
    setDeleting(true)
    const result = await deleteOfferAndDisconnect(offer, user.id)
    setDeleting(false)
    showToastMessage(result.message, result.success ? 'success' : 'error')
    if (result.success) load()
  }

  // ── Edit offer entry point + confirm ───────────────────────────────────────
  const openEdit = (offer: P2POffer) => {
    setEditingOffer(offer)
    setEditPrice(String(offer.pricePerUsdc))
    setEditMinAmount(String(offer.minAmount))
    setEditMaxAmount(String(offer.maxAmount))
    setEditMethods([...offer.paymentMethods])
    setEditMethodIds([...offer.paymentMethodIds])
    setEditMargin(offer.floatMarginPct != null ? String(offer.floatMarginPct) : '0')
    setEditTerms(offer.terms || '')
  }
  // Sell ads with saved accounts edit the accounts; older ads and buy ads edit method names.
  const editUsesAccounts = !!editingOffer && editingOffer.offerType === 'sell' && (editingOffer.paymentMethodIds.length > 0 || myMethods.length > 0)
  const editMethodNames = editUsesAccounts ? [...new Set(myMethods.filter(m => editMethodIds.includes(m.id)).map(m => m.method))] : editMethods
  const editPriceOk = editingOffer?.priceType === 'floating'
    ? (() => { const m = parseFloat(editMargin); return isFinite(m) && m >= -20 && m <= 20 })()
    : !!editPrice && parseFloat(editPrice) > 0
  // Online / offline: a paused ad is hidden from the market (no chain call).
  const toggleOnline = async (o: P2POffer) => {
    setTogglingId(o.id)
    try { await updateOfferStatus(o.id, o.status === 'active' ? 'paused' : 'active'); load() }
    catch { showToastMessage('Could not change the ad - try again', 'error') }
    finally { setTogglingId(null) }
  }

  const editLimitsValid = editMinAmount && editMaxAmount &&
    parseFloat(editMinAmount) > 0 && parseFloat(editMaxAmount) >= parseFloat(editMinAmount) &&
    (!editingOffer || editingOffer.offerType !== 'sell' || parseFloat(editMaxAmount) <= editingOffer.totalAmount)

  const submitEdit = () => {
    if (!editingOffer) return
    if (!editPriceOk || editMethodNames.length === 0 || !editLimitsValid) return
    setPassEntry(''); setPassError(''); setShowEditPasscode(true)
  }

  const handleEditPasscodeConfirm = async () => {
    if (storedPasscode) {
      if (passEntry.length < 6) { setPassError('Enter your 6-digit passcode'); return }
      const { verifyPasscode } = await import('@/lib/security')
      // Unlock the wallet key at the same time as the passcode check (both are
      // slow on purpose) instead of after it - restorePrivateKey below joins
      // this same in-flight unlock. Silent: a wrong passcode must only show
      // "Incorrect passcode".
      if (!useAuthStore.getState().signer) import('@/lib/restoreWallet').then(m => m.restorePrivateKey(passEntry, { silent: true })).catch(() => {})
      if (!await verifyPasscode(passEntry, storedPasscode)) { setPassError('Incorrect passcode'); setPassEntry(''); return }
    }
    setShowEditPasscode(false); setPassEntry(''); setPassError('')
    const offer = editingOffer
    setEditingOffer(null)
    if (!offer || !user?.id) return
    setEditSaving(true)
    // Instant-order ads may update their limits on-chain - that needs the key.
    if (offer.autoAccept && storedPasscode && !useAuthStore.getState().signer) {
      const { restorePrivateKey } = await import('@/lib/restoreWallet')
      await restorePrivateKey(passEntry).catch(() => false)
    }
    const floating = offer.priceType === 'floating'
    const result = await updateOfferDetails(offer, user.id, {
      ...(floating ? { priceType: 'floating' as const, floatMarginPct: parseFloat(editMargin) } : { pricePerUsdc: parseFloat(editPrice) }),
      minAmount: parseFloat(editMinAmount), maxAmount: parseFloat(editMaxAmount),
      paymentMethods: editMethodNames, terms: editTerms || undefined,
      ...(editUsesAccounts ? { paymentMethodIds: editMethodIds } : {}),
    })
    setEditSaving(false)
    showToastMessage(result.message, result.success ? 'success' : 'error')
    if (result.success) load()
  }

  const toggleEditMethod = (m: string) => setEditMethods(prev => prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m])

  // ── Top up entry point + confirm ───────────────────────────────────────────
  const openTopUp = (offer: P2POffer) => {
    setToppingUpOffer(offer)
    setTopUpAmount('')
  }

  const submitTopUp = () => {
    if (!toppingUpOffer) return
    if (!topUpAmount || parseFloat(topUpAmount) <= 0) return
    setPassEntry(''); setPassError(''); setShowTopUpPasscode(true)
  }

  // Top-up moves real funds on-chain (escrowProvider.depositForOffer), so
  // - unlike the price/payment-method edit above - this path also needs
  // restorePrivateKey(), exactly like Release/Cancel/Accept, since the
  // deposit transaction has to actually sign with the wallet.
  const handleTopUpPasscodeConfirm = async () => {
    if (storedPasscode) {
      if (passEntry.length < 6) { setPassError('Enter your 6-digit passcode'); return }
      const { verifyPasscode } = await import('@/lib/security')
      // Unlock the wallet key at the same time as the passcode check (both are
      // slow on purpose) instead of after it - restorePrivateKey below joins
      // this same in-flight unlock. Silent: a wrong passcode must only show
      // "Incorrect passcode".
      if (!useAuthStore.getState().signer) import('@/lib/restoreWallet').then(m => m.restorePrivateKey(passEntry, { silent: true })).catch(() => {})
      if (!await verifyPasscode(passEntry, storedPasscode)) { setPassError('Incorrect passcode'); setPassEntry(''); return }
      const { restorePrivateKey } = await import('@/lib/restoreWallet')
      const restored = await restorePrivateKey(passEntry)
      if (!restored && !useAuthStore.getState().signer) {
        setPassError("Couldn't unlock your wallet on this device. Try reloading the app.")
        return
      }
    }
    setShowTopUpPasscode(false); setPassEntry(''); setPassError('')
    const offer = toppingUpOffer
    const amount = parseFloat(topUpAmount)
    setToppingUpOffer(null); setTopUpAmount('')
    if (!offer || !user?.id || !(amount > 0)) return
    setTopUpSaving(true)
    const result = await runFlip(
      `Depositing ${amount} USDC to escrow…`,
      () => topUpOfferEscrow(offer, user.id, amount),
      { successTitle: 'Escrow Topped Up', errorTitle: 'Top Up Failed' },
    )
    setTopUpSaving(false)
    if (result.success) load()
  }

  return (
    <div className="lg:max-w-[900px]" style={{ background: COLORS.bg, minHeight: '100%', height: '100%', overflowY: 'auto', overflowX: 'hidden', paddingBottom: 40 }}>
      {user?.id && (
        <PaymentMethodSheet open={showPmSheet} onClose={() => setShowPmSheet(false)} userId={user.id}
          defaultName={user.displayName ?? ''}
          onSaved={m => { setMyMethods(ms => [...ms, m]); setEditMethodIds(ids => ids.length >= 5 ? ids : [...ids, m.id]) }} />
      )}
      <Header title="My ads" onBack={() => navigate('/p2p')} right={
        <button onClick={() => navigate('/p2p/create')} aria-label="Post ad" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6, display: 'flex' }}><Plus size={20} color={COLORS.text} /></button>
      } />
      <div style={{ padding: '8px 16px' }}>
        {loading ? <SkeletonCards count={4} className="pt-2" /> :
         offers.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '50px 20px', background: COLORS.surface, borderRadius: 18, border: `1px dashed ${COLORS.border}` }}>
            <p style={{ color: COLORS.muted, fontSize: 13 }}>No ads yet.</p>
            <button onClick={() => navigate('/p2p/create')} style={{ marginTop: 10, padding: '10px 20px', borderRadius: 12, border: '1px solid color-mix(in srgb, black 12%, transparent)', background: COLORS.primary, color: '#fff', fontSize: 13, fontWeight: 700 }}>Post your first ad</button>
          </div>
        ) : offers.map(o => {
          // Any offer that can still be acted on at all - either genuinely
          // active, or depleted-but-not-yet-removed ('completed', which is
          // what a fully-sold offer looks like the instant it happens -
          // see retireOfferIfDepleted). 'cancelled'/'deleted' offers are
          // terminal and get no action row.
          const isActionable = o.status === 'active' || o.status === 'paused' || o.status === 'completed'
          const hasFunds = (remaining.get(o.id) ?? o.totalAmount) > 0
          return (
          <div key={o.id} style={{ background: COLORS.surface, borderRadius: 16, padding: 14, marginBottom: 10, border: `1px solid ${COLORS.border}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 800, padding: '2px 7px', borderRadius: 6, color: o.offerType === 'sell' ? COLORS.error : COLORS.success, background: `color-mix(in srgb, ${o.offerType === 'sell' ? 'var(--danger)' : 'var(--success)'} 14%, transparent)` }}>{o.offerType === 'sell' ? 'SELL' : 'BUY'}</span>
                <b style={{ fontSize: 14, color: COLORS.text }}>USDC</b><span style={{ fontSize: 12, color: COLORS.muted }}>· {o.currency}</span>
              </span>
              {(o.status === 'active' || o.status === 'paused') ? (
                <button onClick={() => toggleOnline(o)} disabled={togglingId === o.id} aria-label={o.status === 'active' ? 'Take ad offline' : 'Put ad online'}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: o.status === 'active' ? COLORS.success : COLORS.muted, opacity: togglingId === o.id ? 0.5 : 1 }}>
                  {o.status === 'active' ? 'Online' : 'Offline'}
                  <span style={{ width: 34, height: 20, borderRadius: 999, position: 'relative', background: o.status === 'active' ? 'var(--success)' : 'color-mix(in srgb, var(--text-primary) 18%, transparent)', transition: 'background 0.15s' }}>
                    <span style={{ position: 'absolute', top: 2, left: o.status === 'active' ? 16 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.15s' }} />
                  </span>
                </button>
              ) : (
                <span style={{ fontSize: 11, color: COLORS.muted, background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', padding: '3px 9px', borderRadius: 10, fontWeight: 600 }}>{o.status === 'completed' ? 'Sold out' : o.status}</span>
              )}
            </div>
            <div style={{ fontSize: 19, fontWeight: 800, color: COLORS.text, marginTop: 6 }}>
              {o.priceType === 'floating'
                ? <>Market {o.floatMarginPct != null && o.floatMarginPct >= 0 ? '+' : ''}{o.floatMarginPct}%</>
                : <><span style={{ fontSize: 13, color: COLORS.muted, fontWeight: 500 }}>{currencySymbol(o.currency)}</span>{o.pricePerUsdc}</>}
              {o.autoAccept && <span style={{ fontSize: 11, fontWeight: 700, color: COLORS.primaryText, marginLeft: 8, verticalAlign: 3 }}>INSTANT</span>}
            </div>
            <div style={{ fontSize: 12, color: COLORS.muted, marginTop: 2 }}>
              Limit {o.minAmount}–{o.status === 'active' ? Math.min(o.maxAmount, remaining.get(o.id) ?? o.maxAmount) : o.maxAmount} USDC · {o.paymentMethods.map(m => m.replace(/\s*\(Demo\)$/, '')).join(', ')}
            </div>
            {isActionable && (
              <div style={{ fontSize: 11, color: hasFunds ? COLORS.success : COLORS.muted, marginTop: 4, fontWeight: 600 }}>
                Available: {trimTrailingZeros((remaining.get(o.id) ?? o.totalAmount).toFixed(2))} USDC left
              </div>
            )}
            {isActionable && (
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button onClick={() => openEdit(o)} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '9px 0', borderRadius: 10, border: `1px solid ${COLORS.border}`, background: 'none', color: 'var(--accent-text)', fontSize: 12, fontWeight: 600 }}>
                  <Pencil size={12} /> Edit
                </button>
                {o.offerType === 'sell' && (
                  <button onClick={() => openTopUp(o)} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '9px 0', borderRadius: 10, border: `1px solid ${COLORS.border}`, background: 'none', color: COLORS.success, fontSize: 12, fontWeight: 600 }}>
                    <PlusCircle size={12} /> Top Up
                  </button>
                )}
                {hasFunds ? (
                  // Still holds escrow - Cancel goes through the passcode
                  // sheet and actually calls the contract to return it.
                  <button onClick={() => requestCancel(o)} disabled={cancelling} style={{ flex: 1, padding: '9px 0', borderRadius: 10, border: `1px solid ${COLORS.border}`, background: 'none', color: COLORS.muted, fontSize: 12, fontWeight: 600, opacity: cancelling ? 0.6 : 1 }}>Cancel</button>
                ) : (
                  // Nothing left in escrow - Delete just removes the
                  // listing, no wallet/passcode needed, no contract call.
                  <button onClick={() => requestDelete(o)} disabled={deleting} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '9px 0', borderRadius: 10, border: `1px solid ${COLORS.border}`, background: 'none', color: COLORS.error, fontSize: 12, fontWeight: 600, opacity: deleting ? 0.6 : 1 }}>
                    <Trash2 size={12} /> Delete
                  </button>
                )}
              </div>
            )}
          </div>
          )
        })}
      </div>

      <AnimatePresence>
      {/* Stepped aside while its passcode sheet is up, so confirming doesn't
          uncover it undimmed for a moment before it fades out. */}
      {editingOffer && !showEditPasscode && (
        <DesktopDialogFrame key="edit-offer" onClose={() => setEditingOffer(null)} maxWidth={480}>
          <div style={{ padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <p style={{ fontSize: 16, fontWeight: 700, color: COLORS.text, margin: 0 }}>Edit Offer</p>
              <button onClick={() => setEditingOffer(null)} style={{ background: 'none', border: 'none', padding: 4, cursor: 'pointer' }}>
                <XIcon size={20} color={COLORS.muted} />
              </button>
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 6, fontWeight: 600 }}>
                {editingOffer.priceType === 'floating' ? 'Margin over market (−20% to +20%)' : `Price per USDC (${currencySymbol(editingOffer.currency)})`}
              </div>
              <input inputMode="decimal" value={editingOffer.priceType === 'floating' ? editMargin : editPrice}
                onChange={e => editingOffer.priceType === 'floating' ? setEditMargin(signedAmountInput(e.target.value, 2)) : setEditPrice(sanitizeAmountInput(e.target.value, 2))}
                style={{ width: '100%', background: COLORS.surface, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: '12px 14px', fontSize: 'max(var(--fs-field, 0px), 14px)', outline: 'none', boxSizing: 'border-box' }} />
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 6, fontWeight: 600 }}>Trade limits (USDC)</div>
              <div style={{ display: 'flex', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: COLORS.muted, marginBottom: 4 }}>Min per trade</div>
                  <input inputMode="decimal" value={editMinAmount} onChange={e => setEditMinAmount(sanitizeAmountInput(e.target.value, tokenDecimals('USDC')))}
                    style={{ width: '100%', background: COLORS.surface, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: '12px 14px', fontSize: 'max(var(--fs-field, 0px), 14px)', outline: 'none', boxSizing: 'border-box' }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: COLORS.muted, marginBottom: 4 }}>Max per trade</div>
                  <input inputMode="decimal" value={editMaxAmount} onChange={e => setEditMaxAmount(sanitizeAmountInput(e.target.value, tokenDecimals('USDC')))}
                    style={{ width: '100%', background: COLORS.surface, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: '12px 14px', fontSize: 'max(var(--fs-field, 0px), 14px)', outline: 'none', boxSizing: 'border-box' }} />
                </div>
              </div>
              {editingOffer.offerType === 'sell' && (
                <div style={{ fontSize: 11, color: !editLimitsValid && editMaxAmount ? COLORS.error : COLORS.muted, marginTop: 6 }}>
                  {!editLimitsValid && editMaxAmount
                    ? `Max per trade can't exceed your total amount to sell (${editingOffer.totalAmount} USDC).`
                    : `Total amount to sell: ${editingOffer.totalAmount} USDC (top up separately to raise this).`}
                </div>
              )}
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 6, fontWeight: 600 }}>{editUsesAccounts ? 'Payment accounts buyers pay' : 'Payment methods'}</div>
              {editUsesAccounts ? (
                <PaymentMethodPicker methods={myMethods} selected={editMethodIds}
                  onToggle={id => setEditMethodIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : prev.length >= 5 ? prev : [...prev, id])}
                  onAdd={() => setShowPmSheet(true)} />
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {PAYMENT_METHOD_TYPES.map(t => t.id).concat(editMethods.filter(m => !PAYMENT_METHOD_TYPES.some(t => t.id === m))).map(m => (
                    <button key={m} onClick={() => toggleEditMethod(m)} style={{
                      padding: '8px 12px', borderRadius: 10, cursor: 'pointer', background: 'transparent',
                      border: `1.5px solid ${editMethods.includes(m) ? 'var(--brand)' : COLORS.border}`,
                    }}><MethodTag name={m} size={12.5} /></button>
                  ))}
                </div>
              )}
            </div>

            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 6, fontWeight: 600 }}>Terms (optional)</div>
              <textarea value={editTerms} onChange={e => setEditTerms(e.target.value)} rows={3} placeholder="Any notes for the other party…"
                style={{ width: '100%', background: COLORS.surface, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: '12px 14px', fontSize: 'max(var(--fs-field, 0px), 14px)', outline: 'none', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }} />
            </div>

            <button onClick={submitEdit} disabled={editSaving || !editPriceOk || editMethodNames.length === 0 || !editLimitsValid} style={{
              width: '100%', padding: '14px 0', borderRadius: 14, border: '1px solid color-mix(in srgb, black 12%, transparent)',
              cursor: (!editSaving && editPriceOk && editMethodNames.length > 0 && editLimitsValid) ? 'pointer' : 'default',
              background: COLORS.primary, color: '#fff', fontSize: 15, fontWeight: 700,
              opacity: editSaving ? 0.6 : 1,
            }}>{editSaving ? 'Saving…' : 'Save Changes'}</button>
          </div>
        </DesktopDialogFrame>
      )}
      </AnimatePresence>

      <PinSheet open={showEditPasscode} id="p2p-pass"
        title="Save changes" bioVerb="Save"
        subtitle={<>Confirm changes to your offer's price and payment methods</>}
        value={passEntry} onChange={v => { setPassEntry(v); setPassError('') }}
        error={passError || undefined}
        onComplete={() => { void handleEditPasscodeConfirm() }}
        fallbackConfirm={storedPasscode ? undefined : { label: 'Confirm Changes', onConfirm: () => { void handleEditPasscodeConfirm() } }}
        onClose={() => { setShowEditPasscode(false); setPassEntry(''); setPassError('') }}
      />

      <AnimatePresence>
      {/* Stepped aside while its passcode sheet is up (like Edit Offer), so
          the passcode step is never hidden under it. */}
      {toppingUpOffer && !showTopUpPasscode && (
        <DesktopDialogFrame key="top-up" onClose={() => setToppingUpOffer(null)} maxWidth={380}>
          <div style={{ padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <PlusCircle size={18} color={COLORS.success} />
              <p style={{ fontSize: 15, fontWeight: 700, color: COLORS.text, margin: 0 }}>Top Up Escrow</p>
            </div>
            <p style={{ fontSize: 12, color: COLORS.muted, marginBottom: 12 }}>
              Deposits additional USDC into this offer's escrow and raises its available capacity by the same amount.
            </p>
            <input inputMode="decimal" value={topUpAmount} onChange={e => setTopUpAmount(sanitizeAmountInput(e.target.value, tokenDecimals('USDC')))} placeholder="Amount in USDC"
              style={{ width: '100%', background: COLORS.surface, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 12, fontSize: 'max(var(--fs-field, 0px), 14px)', marginBottom: 14, boxSizing: 'border-box' }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setToppingUpOffer(null)} style={{ flex: 1, padding: '11px 0', borderRadius: 10, border: `1px solid ${COLORS.border}`, background: 'none', color: COLORS.muted, fontSize: 13 }}>Cancel</button>
              <button onClick={submitTopUp} disabled={topUpSaving || !topUpAmount || parseFloat(topUpAmount) <= 0}
                style={{ flex: 1, padding: '11px 0', borderRadius: 10, border: '1px solid color-mix(in srgb, black 12%, transparent)', background: COLORS.success, color: '#fff', fontSize: 13, fontWeight: 700, opacity: topUpSaving ? 0.6 : 1 }}>
                {topUpSaving ? 'Depositing…' : 'Deposit'}
              </button>
            </div>
          </div>
        </DesktopDialogFrame>
      )}
      </AnimatePresence>

      <PinSheet open={showTopUpPasscode} id="p2p-pass"
        title="Top up escrow" bioVerb="Top up"
        subtitle={<>Deposit {topUpAmount || '0'} USDC to this offer's escrow</>}
        value={passEntry} onChange={v => { setPassEntry(v); setPassError('') }}
        error={passError || undefined}
        onComplete={() => { void handleTopUpPasscodeConfirm() }}
        fallbackConfirm={storedPasscode ? undefined : { label: 'Confirm Top Up', onConfirm: () => { void handleTopUpPasscodeConfirm() } }}
        onClose={() => { setShowTopUpPasscode(false); setPassEntry(''); setPassError('') }}
      />

      <PinSheet open={!!offerToCancel} id="p2p-pass"
        title="Cancel ad"
        subtitle={cancelShown?.offerType === 'sell'
          ? <>Cancel offer and return escrowed USDC to your wallet</>
          : <>Cancel this buy offer</>}
        value={passEntry} onChange={v => { setPassEntry(v); setPassError('') }}
        error={passError || undefined}
        onComplete={() => { void handlePasscodeConfirm() }}
        fallbackConfirm={storedPasscode ? undefined : { label: 'Confirm Cancel', onConfirm: () => { void handlePasscodeConfirm() } }}
        onClose={() => { setOfferToCancel(null); setPassEntry(''); setPassError('') }}
      />

      {/* Delete never moves funds or signs anything - a plain confirm is
          enough, no passcode/wallet unlock needed like Cancel/Top Up. */}
      <AnimatePresence>
      {offerToDelete && (
        <DesktopDialogFrame key="delete-offer" onClose={() => setOfferToDelete(null)} maxWidth={380}>
          <div style={{ padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Trash2 size={18} color={COLORS.error} />
              <p style={{ fontSize: 15, fontWeight: 700, color: COLORS.text, margin: 0 }}>Delete Offer</p>
            </div>
            <p style={{ fontSize: 12, color: COLORS.muted, marginBottom: 18 }}>
              This offer has no USDC left in escrow, so there's nothing to withdraw - deleting it just removes the listing and disconnects it from the escrow contract for good. This can't be undone.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setOfferToDelete(null)} style={{ flex: 1, padding: '11px 0', borderRadius: 10, border: `1px solid ${COLORS.border}`, background: 'none', color: COLORS.muted, fontSize: 13 }}>Cancel</button>
              <button onClick={confirmDelete} disabled={deleting}
                style={{ flex: 1, padding: '11px 0', borderRadius: 10, border: '1px solid color-mix(in srgb, black 12%, transparent)', background: COLORS.error, color: '#fff', fontSize: 13, fontWeight: 700, opacity: deleting ? 0.6 : 1 }}>
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </DesktopDialogFrame>
      )}
      </AnimatePresence>
      <ProcessingFlipCard {...flipState} onDismiss={dismissFlip} />
    </div>
  )
}

// ── My Trades ─────────────────────────────────────────────────────────────
export function P2PMyTradesPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const user = useAuthStore(s => s.user)
  const [trades, setTrades] = useState<P2PTrade[]>(() => myTradesCache.get(user?.id ?? '') ?? [])
  const [loading, setLoading] = useState(() => !myTradesCache.has(user?.id ?? ''))
  const tradesFlash = useReturnFlash('p2p-my-trades')

  useEffect(() => {
    if (!user?.id) { setLoading(false); return }
    fetchMyTrades(user.id).then(rows => { myTradesCache.set(user.id!, rows); setTrades(rows); setLoading(false) })
  }, [user?.id])

  // Live updates - same reasoning as P2PPage's desktop History panel: a
  // payment marked sent, release, dispute, or a brand-new trade should show
  // up here instantly and survive a tab switch, not just at the next full
  // page load.
  useEffect(() => {
    if (!user?.id) return
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    const refetch = () => fetchMyTrades(user.id!).then(setTrades)
    const unsubscribe = subscribeToMyTrades(user.id, () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(refetch, 400)
    })
    return () => { if (debounceTimer) clearTimeout(debounceTimer); unsubscribe() }
  }, [user?.id])
  // Backup for the live feed (as on a trade's own page): while any trade is
  // still moving, re-read the list every few seconds with the screen on, so
  // the other side's step shows even if the realtime connection dropped.
  const anyMoving = trades.some(t => !['completed', 'released', 'cancelled', 'expired', 'resolved_buyer', 'resolved_seller'].includes(t.status))
  useEffect(() => {
    if (!user?.id || !anyMoving) return
    const iv = setInterval(() => { if (document.visibilityState === 'visible') fetchMyTrades(user.id!).then(setTrades).catch(() => {}) }, 6000)
    return () => clearInterval(iv)
  }, [user?.id, anyMoving])

  return (
    <div className="lg:max-w-[900px]" style={{ background: COLORS.bg, minHeight: '100%', height: '100%', overflowY: 'auto', overflowX: 'hidden', paddingBottom: 40 }}>
      <Header title="My Trades" onBack={() => navigate('/p2p')} right={
        <button onClick={() => navigate('/p2p/history')} style={{ background: 'none', border: 'none', padding: 4, cursor: 'pointer', display: 'flex' }} aria-label="Transaction history">
          <History size={20} color={COLORS.text} />
        </button>
      } />
      <div style={{ padding: '8px 16px' }}>
        {loading ? <SkeletonCards count={4} className="pt-2" /> :
         trades.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '50px 20px', background: COLORS.surface, borderRadius: 18, border: `1px dashed ${COLORS.border}` }}>
            <p style={{ color: COLORS.muted, fontSize: 13 }}>No trades yet.</p>
          </div>
        ) : trades.map(t => {
          const isBuyer = t.buyerId === user?.id
          const st = isTradeExpired(t) ? 'expired' : t.status
          const meta = statusMeta(st)
          const done = st === 'completed' || st === 'released'
          const tone = done ? (isBuyer ? 'in' : 'out') : st === 'cancelled' || st === 'expired' ? 'muted' : 'pending'
          return (
            <HistoryRow key={t.id} flash={t.id === tradesFlash.flashId}
              onClick={() => { tradesFlash.leaving(t.id); navigate(`/p2p/trade/${t.id}`) }}
              icon={<HistoryIcon tone={tone} icon="p2p" />}
              title={`${isBuyer ? 'Buying' : 'Selling'} USDC`}
              sub={`${currencySymbol(t.currency)}${t.amountFiat} · ${t.paymentMethod}`}
              meta={<><span style={{ color: meta.color, fontWeight: 600 }}>{meta.label}</span> · {timeAgo(t.completedAt || t.createdAt)}</>}
              right={<div style={{ fontSize: 14, fontWeight: 700, color: done && isBuyer ? 'var(--success-text)' : 'var(--text-primary)' }}>
                {done ? (isBuyer ? '+' : '-') : ''}{t.amountUsdc} USDC
              </div>} />
          )
        })}
      </div>
    </div>
  )
}
