// features/p2p/P2PPage.tsx
//
// P2P Marketplace — TESTNET DEMO. See lib/p2pService.ts for the full
// explanation of what's real (testnet USDC transfers) vs simulated (every
// fiat/payment step). Every screen in this file surfaces that distinction
// clearly — the DemoBadge/DemoBanner components below, not just a one-time
// disclaimer buried somewhere.

import { useState, useEffect, useCallback, useRef, type ReactNode, type CSSProperties } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ArrowLeft, ShieldAlert, ShieldCheck, TrendingUp, TrendingDown, Search, Filter, Plus,
  Clock, CheckCircle2, Star, Send, Paperclip, X as XIcon, Scale, History, Pencil, PlusCircle,
} from 'lucide-react'
import { useAuthStore, useUIStore } from '@/store'
import { PinKeypad } from '@/components/ui/PinKeypad'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'
import { DesktopTransactionAuthDialog } from '@/components/ui/DesktopTransactionAuthDialog'
import { DesktopHistoryPanel, DesktopHistoryEmpty, DesktopHistorySkeleton } from '@/components/ui/DesktopHistoryPanel'
import { timeAgo, trimTrailingZeros } from '@/lib/utils'
import {
  CURRENCIES, DEMO_PAYMENT_METHODS, COUNTRY_REGIONS, currencySymbol, formatReleaseTime,
  createOffer, fetchOffers, fetchOfferById, fetchMyOffers, cancelOfferAndWithdrawEscrow, expireStaleOffers, releaseOrphanedLocks,
  fetchOfferConsumedAmounts, offerRemainingAmount, updateOfferDetails, topUpOfferEscrow, subscribeToAllOffers,
  createTrade, fetchTrade, fetchMyTrades, markPaymentSent, releaseTrade, cancelTrade, canCancelTrade, openDispute,
  DISPUTE_LOCKED_MESSAGE,
  isTradeExpired, autoCancelExpiredTrades, reconcileStuckReleases,
  sendTradeMessage, fetchTradeMessages, subscribeToTradeMessages, subscribeToTradeUpdates, subscribeToMyTrades,
  submitRating, fetchUserRating, getUserReputation,
  type P2POffer, type P2PTrade, type P2PMessage, type OfferType, type MerchantFilter, type UserReputation,
} from '@/lib/p2pService'

export const COLORS = {
  bg: 'var(--bg)', surface: 'var(--surface)', surfaceSecondary: 'var(--surface)',
  primary: 'var(--brand)', success: 'var(--success)', error: 'var(--danger)', warning: 'var(--warning)',
  text: 'var(--text-primary)', muted: 'var(--text-secondary)', border: 'var(--border)',
}

// ── Shared bits ──────────────────────────────────────────────────────────────
// Replaces the old "TESTNET DEMO" text pill in the header — same warning
// icon, but just the icon (native title attribute carries the full
// disclaimer as a hover tooltip) instead of a wide always-on label, so it
// doesn't compete with the page title for space.
function DemoIcon() {
  return (
    <div
      title="No real fiat payments are processed. All currencies and payment methods are for demonstration purposes only."
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, flexShrink: 0,
        background: 'color-mix(in srgb, var(--warning) 12%, transparent)',
        border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)', borderRadius: '50%',
        cursor: 'help',
      }}
    >
      <ShieldAlert size={14} color={COLORS.warning} />
    </div>
  )
}

function DemoBanner() {
  return (
    <div style={{
      margin: '0 16px 14px', background: 'color-mix(in srgb, var(--warning) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 20%, transparent)',
      borderRadius: 14, padding: '10px 14px', display: 'flex', gap: 8, alignItems: 'flex-start',
    }}>
      <ShieldAlert size={15} color={COLORS.warning} style={{ flexShrink: 0, marginTop: 1 }} />
      <p style={{ fontSize: 11.5, color: COLORS.warning, lineHeight: 1.4, margin: 0 }}>
        No real fiat payments are processed. All currencies and payment methods are for demonstration purposes only.
      </p>
    </div>
  )
}

export function Header({ title, onBack, right, hideDemoIconOnMobile }: { title: string; onBack: () => void; right?: ReactNode; hideDemoIconOnMobile?: boolean }) {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 16px 6px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {!isDesktop && (
          <button onClick={onBack} style={{ background: 'none', border: 'none', padding: 4, cursor: 'pointer' }}>
            <ArrowLeft size={22} color={COLORS.text} />
          </button>
        )}
        <h1 style={{ fontSize: 20, fontWeight: 700, color: COLORS.text, margin: 0, letterSpacing: '-0.2px' }}>{title}</h1>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {right}
        {!(hideDemoIconOnMobile && !isDesktop) && <DemoIcon />}
      </div>
    </div>
  )
}

export function statusMeta(status: string): { label: string; color: string } {
  switch (status) {
    case 'waiting_for_buyer': return { label: 'Waiting for Buyer', color: COLORS.warning }
    case 'payment_sent':      return { label: 'Payment Sent (Demo)', color: 'var(--accent-text)' }
    case 'released':          return { label: 'Released', color: COLORS.success }
    case 'completed':         return { label: 'Completed', color: COLORS.success }
    case 'cancelled':         return { label: 'Cancelled', color: COLORS.error }
    case 'expired':           return { label: 'Expired', color: COLORS.muted }
    default:                  return { label: status, color: COLORS.muted }
  }
}

/**
 * Passcode confirmation sheet — gates every P2P action that moves USDC
 * on-chain (deposit to escrow on offer creation, withdraw-remaining on
 * offer cancel, release-to-buyer on trade release). Same bottom-sheet +
 * PinKeypad pattern as Swap/Multichain Send/Claim (see SwapPage.tsx /
 * MultichainClaimPage.tsx) — copied here rather than re-derived so the
 * feel (dot progress, biometric key, shake-on-error) matches exactly.
 * When the user has no passcode set (storedPasscode is falsy), falls back
 * to a plain "Confirm" button — same fallback those other screens use —
 * so the sheet still acts as an explicit are-you-sure step either way.
 */
function PasscodeSheet({
  title, subtitle, storedPasscode, passEntry, setPassEntry, passError, setPassError, onConfirm, onClose,
}: {
  title: string
  subtitle: ReactNode
  storedPasscode: string | null | undefined
  passEntry: string
  setPassEntry: (v: string) => void
  passError: string
  setPassError: (v: string) => void
  onConfirm: () => void
  onClose: () => void
}) {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  // Keypad/confirm-button only — the title+subtitle text block above it is
  // handled separately per branch below (mobile's inline heading vs. the
  // desktop dialog's own title/subLabel props), so this part alone is
  // what's shared/reused between the two.
  const keypadContent = storedPasscode ? (
    <PinKeypad
      value={passEntry}
      onChange={v => { setPassEntry(v); setPassError('') }}
      length={6}
      error={!!passError}
      shake={!!passError}
      onComplete={() => onConfirm()}
    />
  ) : (
    <button onClick={() => onConfirm()}
      style={{ width: '100%', padding: '15px 0', borderRadius: 16, border: '1px solid color-mix(in srgb, black 12%, transparent)', cursor: 'pointer', background: COLORS.primary, color: '#fff', fontSize: 14.5, fontWeight: 700 }}>
      {title}
    </button>
  )
  const content = (
    <>
      <div style={{ textAlign: 'center', marginBottom: 28 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: COLORS.text, margin: 0 }}>{title}</h2>
        <p style={{ fontSize: 12, marginTop: 6, color: passError ? COLORS.error : COLORS.muted }}>
          {passError || subtitle}
        </p>
      </div>
      {keypadContent}
    </>
  )

  if (isDesktop) {
    return (
      <AnimatePresence>
        <DesktopTransactionAuthDialog
          onClose={onClose}
          title={title}
          subLabel={passError ? <span style={{ color: COLORS.error }}>{passError}</span> : subtitle}
        >
          {keypadContent}
        </DesktopTransactionAuthDialog>
      </AnimatePresence>
    )
  }
  return (
    <AnimatePresence>
      <motion.div key="pass-backdrop"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)', zIndex: 200 }}
        onClick={onClose} />
      <motion.div key="pass-sheet"
        initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 32, stiffness: 320 }}
        style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 201, borderRadius: '24px 24px 0 0', paddingTop: 12, paddingBottom: 40, paddingLeft: 24, paddingRight: 24, background: COLORS.surface, borderTop: `1px solid ${COLORS.border}`, maxWidth: 480, margin: '0 auto' }}>
        <div style={{ width: 40, height: 4, borderRadius: 2, margin: '0 auto 24px', background: 'color-mix(in srgb, var(--text-primary) 18%, transparent)' }} />
        {content}
      </motion.div>
    </AnimatePresence>
  )
}

// ── P2P Hub — Buy/Sell tabs, browse offers ──────────────────────────────────
export function P2PHubPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const walletAddress = useAuthStore(s => s.walletAddress)
  const user = useAuthStore(s => s.user)
  const [tab, setTab] = useState<OfferType>('buy')
  const [merchantFilter, setMerchantFilter] = useState<MerchantFilter>('all')
  const [offers, setOffers] = useState<P2POffer[]>([])
  const [remaining, setRemaining] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(true)
  const [showFilters, setShowFilters] = useState(false)
  const [currency, setCurrency] = useState('')
  const [country, setCountry] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('')
  const [search, setSearch] = useState('')

  // ── Desktop-only: P2P History (right column) ─────────────────────────────
  // Real data — reuses fetchMyTrades, the same source both P2PMyTradesPage
  // and HistoryPage.tsx already fetch from (see HistoryPage.tsx's own
  // header comment). Skipped entirely on mobile; re-fetched whenever the
  // hub's own offer list reloads (`load`, defined below) so a trade that
  // just completed shows up without a page refresh.
  const [p2pHistory, setP2pHistory] = useState<P2PTrade[]>([])
  const [p2pHistoryLoaded, setP2pHistoryLoaded] = useState(false)
  useEffect(() => {
    if (!isDesktop || !user?.id) return
    let cancelled = false
    fetchMyTrades(user.id)
      .then(trades => { if (!cancelled) setP2pHistory(trades) })
      .finally(() => { if (!cancelled) setP2pHistoryLoaded(true) })
    return () => { cancelled = true }
  }, [isDesktop, user?.id])

  // Live updates for the desktop History panel — a payment marked sent,
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

  // Auto-expiry sweep — runs once on mount, same "check on read" shape as
  // the rest of this codebase's lighter-weight scheduled work (see
  // expireStaleOffers's own doc comment in p2pService.ts).
  useEffect(() => { expireStaleOffers(); releaseOrphanedLocks() }, [])

  const load = useCallback(async () => {
    setLoading(true)
    // Browsing "Buy USDC" shows offers from SELLERS (people offering to
    // sell), and vice versa — the tab is what the viewer wants to do, the
    // fetched offer type is the counterparty's side.
    const offerTypeToFetch: OfferType = tab === 'buy' ? 'sell' : 'buy'
    const rows = await fetchOffers({
      offerType: offerTypeToFetch,
      currency: currency || undefined,
      countryRegion: country || undefined,
      paymentMethod: paymentMethod || undefined,
      excludeUserId: user?.id,
      merchantFilter,
    })
    setOffers(rows)
    setRemaining(await fetchOfferConsumedAmounts(rows.map(o => o.id)).then(consumed =>
      new Map(rows.map(o => [o.id, offerRemainingAmount(o, consumed.get(o.id) ?? 0)]))
    ))
    setLoading(false)
  }, [tab, currency, country, paymentMethod, user?.id, merchantFilter])

  useEffect(() => { load() }, [load])

  // ── Live updates for the marketplace list ────────────────────────────────
  // BUG FIX: this list used to be a one-shot fetch with nothing keeping it
  // current — a new offer, a cancellation, or someone else's offer
  // depleting never showed up until the next full reload, and switching
  // away to another tab and back never refreshed it either. p2p_offers is
  // already in the realtime publication (see subscribeToAllOffers's own
  // use in P2PAdminPage.tsx) and subscribeWithRetry already resyncs on tab
  // visibility/network regain on its own — this just needed to actually be
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

  const filtered = search
    ? offers.filter(o => o.paymentMethods.some(m => m.toLowerCase().includes(search.toLowerCase())) || o.username?.toLowerCase().includes(search.toLowerCase()))
    : offers

  // Held in a variable (not returned directly) so the exact same JSX renders
  // either as the whole page (mobile) or as the left column of the desktop
  // 2-column layout below — never duplicated.
  const flow = (
    <div style={{ background: COLORS.bg, minHeight: '100%', height: '100%', overflowY: 'auto', paddingBottom: 90 }}>
      {/* Desktop: no header history icon and no demo banner — the right
          column's own P2P History panel already covers history, and a
          "View History" button sits next to Create Offer below instead
          (see the bottom actions row). The disclaimer text fills the gap
          next to the warning icon instead of only being a hover tooltip.
          Mobile is unchanged (icon-only + the DemoBanner below the tabs
          already carries this same text there). */}
      <Header title="P2P Marketplace" onBack={() => navigate('/')} hideDemoIconOnMobile right={
        isDesktop ? (
          <span style={{ fontSize: 11.5, color: COLORS.warning, lineHeight: 1.35, display: 'inline-block', maxWidth: 380, textAlign: 'right' }}>
            No real fiat payments are processed. All currencies and payment methods are for demonstration purposes only.
          </span>
        ) : (
          <button onClick={() => navigate('/p2p/history')} style={{ background: 'none', border: 'none', padding: '4px 6px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }} aria-label="Transaction history">
            <History size={18} color={COLORS.text} />
            <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.text }}>View History</span>
          </button>
        )
      } />
      {!isDesktop && <DemoBanner />}

      {/* Buy/Sell tabs */}
      <div style={{ display: 'flex', gap: 8, padding: '0 16px 14px' }}>
        <button onClick={() => setTab('buy')} style={{
          flex: 1, padding: '12px 0', borderRadius: 14, border: 'none', cursor: 'pointer',
          background: tab === 'buy' ? COLORS.success : COLORS.surface,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}>
          <TrendingDown size={16} color={tab === 'buy' ? '#fff' : COLORS.muted} />
          <span style={{ fontSize: 14, fontWeight: 700, color: tab === 'buy' ? '#fff' : COLORS.muted }}>Buy USDC</span>
        </button>
        <button onClick={() => setTab('sell')} style={{
          flex: 1, padding: '12px 0', borderRadius: 14, border: 'none', cursor: 'pointer',
          background: tab === 'sell' ? COLORS.error : COLORS.surface,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}>
          <TrendingUp size={16} color={tab === 'sell' ? '#fff' : COLORS.muted} />
          <span style={{ fontSize: 14, fontWeight: 700, color: tab === 'sell' ? '#fff' : COLORS.muted }}>Sell USDC</span>
        </button>
      </div>

      {/* Merchant Mode filter */}
      <div style={{ display: 'flex', gap: 6, padding: '0 16px 12px', overflowX: 'auto' }}>
        {(['all', 'verified', 'community'] as MerchantFilter[]).map(f => (
          <button key={f} onClick={() => setMerchantFilter(f)} style={{
            flexShrink: 0, padding: '7px 13px', borderRadius: 20, border: `1px solid ${merchantFilter === f ? COLORS.primary : COLORS.border}`,
            background: merchantFilter === f ? 'color-mix(in srgb, var(--brand) 15%, transparent)' : 'transparent', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 5,
          }}>
            {f === 'verified' && <ShieldCheck size={12} color={merchantFilter === f ? 'var(--accent-text)' : COLORS.muted} />}
            <span style={{ fontSize: 12, fontWeight: 600, color: merchantFilter === f ? 'var(--accent-text)' : COLORS.muted }}>
              {f === 'all' ? 'All Offers' : f === 'verified' ? 'Verified Merchants' : 'Community P2P'}
            </span>
          </button>
        ))}
      </div>

      {/* Search + filter row */}
      <div style={{ display: 'flex', gap: 8, padding: '0 16px 12px' }}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, background: COLORS.surface, borderRadius: 12, padding: '10px 12px', border: `1px solid ${COLORS.border}` }}>
          <Search size={15} color={COLORS.muted} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search payment method or seller"
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: COLORS.text, fontSize: 13 }} />
        </div>
        <button onClick={() => setShowFilters(v => !v)} style={{
          width: 42, background: showFilters ? COLORS.primary : COLORS.surface, borderRadius: 12, border: `1px solid ${COLORS.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
        }}>
          <Filter size={16} color={COLORS.text} />
        </button>
      </div>

      <AnimatePresence>
        {showFilters && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            style={{ overflow: 'hidden', padding: '0 16px' }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              <select value={currency} onChange={e => setCurrency(e.target.value)}
                style={{ flex: 1, minWidth: 110, background: COLORS.surface, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '9px 10px', fontSize: 12.5 }}>
                <option value="">All currencies</option>
                {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.code} ({c.symbol})</option>)}
              </select>
              <select value={country} onChange={e => setCountry(e.target.value)}
                style={{ flex: 1, minWidth: 110, background: COLORS.surface, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '9px 10px', fontSize: 12.5 }}>
                <option value="">All regions</option>
                {COUNTRY_REGIONS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Offer list */}
      <div style={{ padding: '4px 16px' }}>
        {loading ? (
          <p style={{ textAlign: 'center', color: COLORS.muted, fontSize: 13, padding: 40 }}>Loading offers…</p>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '50px 20px', background: COLORS.surface, borderRadius: 18, border: `1px dashed ${COLORS.border}` }}>
            <p style={{ color: COLORS.muted, fontSize: 13, margin: 0 }}>No {tab === 'buy' ? 'sell' : 'buy'} offers match right now.</p>
            <p style={{ color: COLORS.muted, fontSize: 12, marginTop: 6 }}>Be the first — create one below.</p>
          </div>
        ) : filtered.map(offer => (
          <div key={offer.id} onClick={() => navigate(`/p2p/offer/${offer.id}`)}
            style={{
              background: COLORS.surface, borderRadius: 16, padding: 16, marginBottom: 10,
              border: `1px solid ${COLORS.border}`, cursor: 'pointer',
            }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'color-mix(in srgb, var(--text-primary) 8%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: COLORS.text }}>
                  {(offer.displayName || offer.username || 'U')[0].toUpperCase()}
                </div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600, color: COLORS.text }}>{offer.displayName || offer.username || 'Trader'}</span>
                    {offer.isVerifiedMerchant && <ShieldCheck size={13} color="var(--accent-text)" fill="color-mix(in srgb, var(--accent) 20%, transparent)" />}
                  </div>
                  <div style={{ fontSize: 11, color: COLORS.muted }}>{offer.countryRegion}</div>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.text }}>{currencySymbol(offer.currency)}{offer.pricePerUsdc}</div>
                <div style={{ fontSize: 10.5, color: COLORS.muted }}>per USDC</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
              {offer.paymentMethods.slice(0, 3).map(m => (
                <span key={m} style={{ fontSize: 10.5, color: 'var(--accent-text)', background: 'color-mix(in srgb, var(--accent) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 20%, transparent)', borderRadius: 8, padding: '3px 8px' }}>{m}</span>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontSize: 11.5, color: COLORS.muted }}>
              <span>
                Available: <span style={{ color: COLORS.text, fontWeight: 600 }}>{trimTrailingZeros((remaining.get(offer.id) ?? offer.maxAmount).toFixed(2))}</span> USDC
              </span>
              <span>Limit: {offer.minAmount}–{Math.min(offer.maxAmount, remaining.get(offer.id) ?? offer.maxAmount)} USDC</span>
            </div>
          </div>
        ))}
      </div>

      {/* Bottom actions. Mobile: fixed bar pinned to the viewport bottom
          (unchanged). Desktop: position:fixed here centers across the FULL
          viewport width via margin:auto — ignoring the sidebar offset and
          the 65/35 column split — so it visually lands away from column 1
          (looks like it belongs to column 2). Rendered in-flow instead,
          at the bottom of this same column, so it actually stays inside
          column 1 as intended. */}
      {!isDesktop && (
        <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, maxWidth: 480, margin: '0 auto', padding: 16, background: 'linear-gradient(180deg, transparent, var(--bg) 30%)', display: 'flex', gap: 10 }}>
          <button onClick={() => navigate('/p2p/my-offers')} style={{ flex: 1, padding: '13px 0', borderRadius: 14, background: COLORS.surface, border: `1px solid ${COLORS.border}`, color: COLORS.text, fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>My Offers</button>
          <button onClick={() => navigate('/p2p/my-trades')} style={{ flex: 1, padding: '13px 0', borderRadius: 14, background: COLORS.surface, border: `1px solid ${COLORS.border}`, color: COLORS.text, fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>My Trades</button>
          <button onClick={() => navigate('/p2p/create')} disabled={!walletAddress} style={{ flex: 1.2, padding: '13px 0', borderRadius: 14, background: COLORS.primary, border: '1px solid color-mix(in srgb, black 12%, transparent)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, whiteSpace: 'nowrap' }}>
            <Plus size={15} /> Create Offer
          </button>
        </div>
      )}
      {isDesktop && (
        <div style={{ padding: '16px 16px 4px', display: 'flex', gap: 14 }}>
          <button onClick={() => navigate('/p2p/my-offers')} style={{ flex: 1, padding: '13px 0', borderRadius: 14, background: COLORS.surface, border: `1px solid ${COLORS.border}`, color: COLORS.text, fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>My Offers</button>
          <button onClick={() => navigate('/p2p/my-trades')} style={{ flex: 1, padding: '13px 0', borderRadius: 14, background: COLORS.surface, border: `1px solid ${COLORS.border}`, color: COLORS.text, fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>My Trades</button>
          <button onClick={() => navigate('/p2p/create')} disabled={!walletAddress} style={{ flex: 1.2, padding: '13px 0', borderRadius: 14, background: COLORS.primary, border: '1px solid color-mix(in srgb, black 12%, transparent)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, whiteSpace: 'nowrap' }}>
            <Plus size={15} /> Create Offer
          </button>
          <button onClick={() => navigate('/p2p/history')} style={{ flex: 1, padding: '13px 0', borderRadius: 14, background: COLORS.surface, border: `1px solid ${COLORS.border}`, color: COLORS.text, fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, whiteSpace: 'nowrap' }}>
            <History size={15} /> View History
          </button>
        </div>
      )}
    </div>
  )

  if (!isDesktop) return flow

  // ── Desktop: flow (left) + P2P History (right), independently scrollable ──
  // Fills the full available content width (no maxWidth cap) at a fixed
  // 65/35 grow split, same treatment as Swap/Multichain Transfer/Pay/
  // Multichain Claim. Bottom padding trimmed so both columns reach down
  // close to the viewport's bottom edge.
  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, gap: 28, padding: '20px 24px 14px', boxSizing: 'border-box' }}>
      <div style={{ flex: '65 1 0%', minWidth: 0, minHeight: 0, overflowY: 'auto' }}>{flow}</div>
      <div style={{ flex: '35 1 0%', minWidth: 0, minHeight: 0 }}>
        <DesktopHistoryPanel title="P2P History" onViewAll={() => navigate('/p2p/history')}>
          {!p2pHistoryLoaded ? (
            <DesktopHistorySkeleton />
          ) : p2pHistory.length === 0 ? (
            <DesktopHistoryEmpty label="Your P2P trades will show up here" />
          ) : (
            p2pHistory.map((t, i) => {
              const isBuyer = t.buyerId === user?.id
              const done = t.status === 'completed'
              const dead = t.status === 'cancelled' || t.status === 'expired'
              const statusColor = done ? 'var(--success)' : dead ? 'var(--text-secondary)' : 'var(--warning)'
              const statusLabel = done ? 'Completed' : dead ? (t.status === 'expired' ? 'Expired' : 'Cancelled') : 'In progress'
              return (
                <div key={t.id} onClick={() => navigate(`/p2p/trade/${t.id}`)} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', cursor: 'pointer',
                  borderTop: i > 0 ? '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' : 'none',
                }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                    background: `color-mix(in srgb, ${statusColor} 12%, transparent)`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {isBuyer
                      ? <TrendingDown size={14} color={statusColor} />
                      : <TrendingUp size={14} color={statusColor} />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                      {isBuyer ? 'Bought' : 'Sold'} USDC
                    </div>
                    <div style={{ fontSize: 11, color: statusColor, marginTop: 1 }}>
                      {statusLabel} · {timeAgo(t.completedAt || t.createdAt)}
                    </div>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', flexShrink: 0 }}>
                    {trimTrailingZeros(t.amountUsdc.toFixed(2))} USDC
                  </div>
                </div>
              )
            })
          )}
        </DesktopHistoryPanel>
      </div>
    </div>
  )
}

// ── Create Offer ─────────────────────────────────────────────────────────────
export function P2PCreateOfferPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const walletAddress = useAuthStore(s => s.walletAddress)
  const user = useAuthStore(s => s.user)
  const storedPasscode = useAuthStore(s => s.passcode)
  const { showToastMessage } = useUIStore()
  const [passEntry, setPassEntry] = useState('')
  const [passError, setPassError] = useState('')
  const [showPasscodeSheet, setShowPasscodeSheet] = useState(false)

  const [offerType, setOfferType] = useState<OfferType>('sell')
  const [currency, setCurrency] = useState('USD')
  const [price, setPrice] = useState('')
  const [minAmount, setMinAmount] = useState('10')
  const [maxAmount, setMaxAmount] = useState('100')
  const [methods, setMethods] = useState<string[]>([])
  const [country, setCountry] = useState('Global')
  const [terms, setTerms] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const toggleMethod = (m: string) => setMethods(prev => prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m])

  const canSubmit = walletAddress && user?.id && price && parseFloat(price) > 0 &&
    parseFloat(minAmount) > 0 && parseFloat(maxAmount) >= parseFloat(minAmount) && methods.length > 0

  const doSubmit = async () => {
    if (!canSubmit || !walletAddress || !user?.id) return
    setSubmitting(true)
    const offer = await createOffer({
      userId: user.id, walletAddress, offerType, currency,
      pricePerUsdc: parseFloat(price), minAmount: parseFloat(minAmount), maxAmount: parseFloat(maxAmount),
      paymentMethods: methods, countryRegion: country, terms: terms || undefined,
    })
    setSubmitting(false)
    if (offer) { showToastMessage('Offer created', 'success'); navigate('/p2p/my-offers', { replace: true }) }
    else showToastMessage('Could not create offer — try again', 'error')
  }

  // Entry point for the "Create Offer" button — opens the passcode sheet
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
      if (!await verifyPasscode(passEntry, storedPasscode)) { setPassError('Incorrect passcode'); setPassEntry(''); return }
      // Verifying the passcode only proves it's correct — it does NOT by
      // itself put the private key back in memory. privateKey is
      // deliberately never persisted (see store/index.ts's partialize),
      // so after any fresh page load it's null until explicitly restored.
      // Without this call, a correct passcode entry here was previously
      // followed by a release/accept/cancel that still failed with
      // "Couldn't access your wallet on this device" — the exact bug this
      // fixes. Passing the just-verified passcode lets restorePrivateKey
      // decrypt this device's locally-stored encrypted key immediately,
      // no extra prompt needed.
      const { restorePrivateKey } = await import('@/lib/restoreWallet')
      const restored = await restorePrivateKey(passEntry)
      if (!restored && !useAuthStore.getState().privateKey) {
        setPassError("Couldn't unlock your wallet on this device. Try reloading the app.")
        return
      }
    }
    setShowPasscodeSheet(false); setPassEntry(''); setPassError('')
    await doSubmit()
  }

  const inputStyle: CSSProperties = { width: '100%', background: COLORS.surface, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: '12px 14px', fontSize: 14, outline: 'none', boxSizing: 'border-box' }
  const labelStyle: CSSProperties = { fontSize: 12, color: COLORS.muted, marginBottom: 6, fontWeight: 600 }

  return (
    <div className="lg:max-w-[900px]" style={{ background: COLORS.bg, minHeight: '100%', height: '100%', overflowY: 'auto', paddingBottom: 100 }}>
      <Header title="Create Offer" onBack={() => navigate(-1)} />
      <DemoBanner />

      <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setOfferType('sell')} style={{ flex: 1, padding: '11px 0', borderRadius: 12, border: 'none', cursor: 'pointer', background: offerType === 'sell' ? COLORS.primary : COLORS.surface, color: offerType === 'sell' ? '#fff' : COLORS.muted, fontSize: 13, fontWeight: 700 }}>I want to Sell USDC</button>
          <button onClick={() => setOfferType('buy')} style={{ flex: 1, padding: '11px 0', borderRadius: 12, border: 'none', cursor: 'pointer', background: offerType === 'buy' ? COLORS.primary : COLORS.surface, color: offerType === 'buy' ? '#fff' : COLORS.muted, fontSize: 13, fontWeight: 700 }}>I want to Buy USDC</button>
        </div>

        <div>
          <div style={labelStyle}>Currency</div>
          <select value={currency} onChange={e => setCurrency(e.target.value)} style={inputStyle}>
            {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.name} — {c.code} ({c.symbol})</option>)}
          </select>
        </div>

        <div>
          <div style={labelStyle}>Price per USDC ({currencySymbol(currency)})</div>
          <input type="number" inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} placeholder="e.g. 1.02" style={inputStyle} />
        </div>

        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={labelStyle}>Min (USDC)</div>
            <input type="number" inputMode="decimal" value={minAmount} onChange={e => setMinAmount(e.target.value)} style={inputStyle} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={labelStyle}>Max (USDC)</div>
            <input type="number" inputMode="decimal" value={maxAmount} onChange={e => setMaxAmount(e.target.value)} style={inputStyle} />
          </div>
        </div>

        <div>
          <div style={labelStyle}>Payment methods (Demo)</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {DEMO_PAYMENT_METHODS.map(m => (
              <button key={m} onClick={() => toggleMethod(m)} style={{
                padding: '8px 12px', borderRadius: 10, fontSize: 12, cursor: 'pointer',
                border: `1px solid ${methods.includes(m) ? COLORS.primary : COLORS.border}`,
                background: methods.includes(m) ? 'color-mix(in srgb, var(--brand) 15%, transparent)' : COLORS.surface,
                color: methods.includes(m) ? 'var(--accent-text)' : COLORS.muted, fontWeight: 600,
              }}>{m}</button>
            ))}
          </div>
        </div>

        <div>
          <div style={labelStyle}>Country / Region</div>
          <select value={country} onChange={e => setCountry(e.target.value)} style={inputStyle}>
            {COUNTRY_REGIONS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div>
          <div style={labelStyle}>Terms (optional)</div>
          <textarea value={terms} onChange={e => setTerms(e.target.value)} rows={3} placeholder="Any notes for the other party…" style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
        </div>

        <button onClick={submit} disabled={!canSubmit || submitting} style={{
          padding: '15px 0', borderRadius: 14, border: canSubmit ? '1px solid color-mix(in srgb, black 12%, transparent)' : 'none', cursor: canSubmit ? 'pointer' : 'default',
          background: canSubmit ? COLORS.primary : COLORS.surface,
          color: canSubmit ? '#fff' : COLORS.muted, fontSize: 14.5, fontWeight: 700, opacity: submitting ? 0.6 : 1,
        }}>{submitting ? 'Creating…' : 'Create Offer'}</button>
      </div>

      {showPasscodeSheet && (
        <PasscodeSheet
          title={storedPasscode ? 'Enter Passcode' : 'Confirm Offer'}
          subtitle={offerType === 'sell'
            ? <>Deposit up to {maxAmount || '0'} USDC to escrow for this sell offer</>
            : <>Create this buy offer for {minAmount || '0'}–{maxAmount || '0'} USDC</>}
          storedPasscode={storedPasscode}
          passEntry={passEntry} setPassEntry={setPassEntry}
          passError={passError} setPassError={setPassError}
          onConfirm={handlePasscodeConfirm}
          onClose={() => { setShowPasscodeSheet(false); setPassEntry(''); setPassError('') }}
        />
      )}
    </div>
  )
}

// ── Offer Detail — accept an offer (creates a trade) ────────────────────────
export function P2POfferDetailPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const { offerId } = useParams<{ offerId: string }>()
  const navigate = useNavigate()
  const walletAddress = useAuthStore(s => s.walletAddress)
  const user = useAuthStore(s => s.user)
  const storedPasscode = useAuthStore(s => s.passcode)
  const { showToastMessage } = useUIStore()
  const [offer, setOffer] = useState<P2POffer | null>(null)
  const [remainingAmt, setRemainingAmt] = useState<number | null>(null)
  const [rating, setRating] = useState<{ avg: number; count: number } | null>(null)
  const [reputation, setReputation] = useState<UserReputation | null>(null)
  const [amount, setAmount] = useState('')
  const [accepting, setAccepting] = useState(false)
  const [showPasscodeSheet, setShowPasscodeSheet] = useState(false)
  const [passEntry, setPassEntry] = useState('')
  const [passError, setPassError] = useState('')

  useEffect(() => {
    if (!offerId) return
    ;(async () => {
      const found = await fetchOfferById(offerId)
      setOffer(found)
      if (found) {
        const [ratingResult, reputationResult, consumedMap] = await Promise.all([
          fetchUserRating(found.userId),
          getUserReputation(found.userId),
          fetchOfferConsumedAmounts([found.id]),
        ])
        setRating(ratingResult)
        setReputation(reputationResult)
        setRemainingAmt(offerRemainingAmount(found, consumedMap.get(found.id) ?? 0))
      }
    })()
  }, [offerId])

  const isOwnOffer = !!(offer && user?.id && offer.userId === user.id)

  const doAccept = async () => {
    if (!offer || !walletAddress || !user?.id) return
    setAccepting(true)
    const amt = parseFloat(amount)
    const { trade, error } = await createTrade({ offer, acceptingUserId: user.id, acceptingWallet: walletAddress, amountUsdc: amt })
    setAccepting(false)
    if (trade) navigate(`/p2p/trade/${trade.id}`, { replace: true })
    else showToastMessage(error || 'Could not start trade — try again', 'error')
  }

  // Validates and opens the passcode sheet — accepting a BUY offer deposits
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
    setPassEntry(''); setPassError(''); setShowPasscodeSheet(true)
  }

  const handlePasscodeConfirm = async () => {
    if (storedPasscode) {
      if (passEntry.length < 6) { setPassError('Enter your 6-digit passcode'); return }
      const { verifyPasscode } = await import('@/lib/security')
      if (!await verifyPasscode(passEntry, storedPasscode)) { setPassError('Incorrect passcode'); setPassEntry(''); return }
      // Verifying the passcode only proves it's correct — it does NOT by
      // itself put the private key back in memory. privateKey is
      // deliberately never persisted (see store/index.ts's partialize),
      // so after any fresh page load it's null until explicitly restored.
      // Without this call, a correct passcode entry here was previously
      // followed by a release/accept/cancel that still failed with
      // "Couldn't access your wallet on this device" — the exact bug this
      // fixes. Passing the just-verified passcode lets restorePrivateKey
      // decrypt this device's locally-stored encrypted key immediately,
      // no extra prompt needed.
      const { restorePrivateKey } = await import('@/lib/restoreWallet')
      const restored = await restorePrivateKey(passEntry)
      if (!restored && !useAuthStore.getState().privateKey) {
        setPassError("Couldn't unlock your wallet on this device. Try reloading the app.")
        return
      }
    }
    setShowPasscodeSheet(false); setPassEntry(''); setPassError('')
    await doAccept()
  }

  if (!offer) return (
    <div className="lg:max-w-[900px]" style={{ background: COLORS.bg, minHeight: '100%', height: '100%', overflowY: 'auto' }}>
      <Header title="Offer" onBack={() => navigate(-1)} />
      <p style={{ textAlign: 'center', color: COLORS.muted, padding: 40 }}>Loading…</p>
    </div>
  )

  const amt = parseFloat(amount) || 0
  const fiatTotal = Math.round(amt * offer.pricePerUsdc * 100) / 100

  return (
    <div className="lg:max-w-[900px]" style={{ background: COLORS.bg, minHeight: '100%', height: '100%', overflowY: 'auto', paddingBottom: 100 }}>
      <Header title={offer.offerType === 'sell' ? 'Buy USDC' : 'Sell USDC'} onBack={() => navigate(-1)} />
      <DemoBanner />

      <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ background: COLORS.surface, borderRadius: 16, padding: 16, border: `1px solid ${COLORS.border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'color-mix(in srgb, var(--text-primary) 8%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700 }}>
              {(offer.displayName || offer.username || 'U')[0].toUpperCase()}
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ fontSize: 14.5, fontWeight: 700, color: COLORS.text }}>{offer.displayName || offer.username || 'Trader'}</span>
                {offer.isVerifiedMerchant && <ShieldCheck size={14} color="var(--accent-text)" fill="color-mix(in srgb, var(--accent) 20%, transparent)" />}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: COLORS.muted }}>
                <Star size={11} fill={rating && rating.count > 0 ? COLORS.warning : 'none'} color={COLORS.warning} />
                {rating && rating.count > 0 ? `${rating.avg} (${rating.count} rated)` : 'No ratings yet'}
              </div>
            </div>
          </div>

          {/* Reputation strip */}
          {reputation && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, padding: '10px 0', borderTop: `1px solid ${COLORS.border}`, borderBottom: `1px solid ${COLORS.border}` }}>
              <div style={{ flex: 1, textAlign: 'center' }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.text }}>{reputation.totalTrades}</div>
                <div style={{ fontSize: 9.5, color: COLORS.muted }}>Trades</div>
              </div>
              <div style={{ flex: 1, textAlign: 'center', borderLeft: `1px solid ${COLORS.border}`, borderRight: `1px solid ${COLORS.border}` }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: reputation.completionRate >= 90 ? COLORS.success : COLORS.text }}>{reputation.completionRate}%</div>
                <div style={{ fontSize: 9.5, color: COLORS.muted }}>Completion</div>
              </div>
              <div style={{ flex: 1, textAlign: 'center', borderRight: `1px solid ${COLORS.border}` }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.text }}>{formatReleaseTime(reputation.avgReleaseSeconds)}</div>
                <div style={{ fontSize: 9.5, color: COLORS.muted }}>Avg release</div>
              </div>
              <div style={{ flex: 1, textAlign: 'center' }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.text }}>{reputation.accountAgeDays}d</div>
                <div style={{ fontSize: 9.5, color: COLORS.muted }}>Account age</div>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: COLORS.muted, marginBottom: 4 }}>
            <span>Price</span><span style={{ color: COLORS.text, fontWeight: 700 }}>{currencySymbol(offer.currency)}{offer.pricePerUsdc} / USDC</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: COLORS.muted, marginBottom: 4 }}>
            <span>Available</span><span style={{ color: COLORS.success, fontWeight: 700 }}>{trimTrailingZeros((remainingAmt ?? offer.maxAmount).toFixed(2))} USDC</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: COLORS.muted, marginBottom: 4 }}>
            <span>Limit</span><span style={{ color: COLORS.text }}>{offer.minAmount} – {remainingAmt != null ? Math.min(offer.maxAmount, remainingAmt) : offer.maxAmount} USDC</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: COLORS.muted }}>
            <span>Region</span><span style={{ color: COLORS.text }}>{offer.countryRegion}</span>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            {offer.paymentMethods.map(m => (
              <span key={m} style={{ fontSize: 10.5, color: 'var(--accent-text)', background: 'color-mix(in srgb, var(--accent) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 20%, transparent)', borderRadius: 8, padding: '3px 8px' }}>{m}</span>
            ))}
          </div>
          {offer.terms && <p style={{ fontSize: 12, color: COLORS.muted, marginTop: 10, lineHeight: 1.4 }}>{offer.terms}</p>}
        </div>

        {isOwnOffer ? (
          <div style={{ background: 'color-mix(in srgb, var(--text-secondary) 8%, transparent)', border: `1px dashed ${COLORS.border}`, borderRadius: 14, padding: 16, textAlign: 'center' }}>
            <p style={{ fontSize: 13, color: COLORS.muted, margin: 0 }}>This is your own offer — you can't accept it yourself.</p>
          </div>
        ) : (
          <>
            <div>
              <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 6, fontWeight: 600 }}>Amount (USDC)</div>
              <input type="number" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)}
                placeholder={`${offer.minAmount} – ${remainingAmt != null ? Math.min(offer.maxAmount, remainingAmt) : offer.maxAmount}`}
                style={{ width: '100%', background: COLORS.surface, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: '14px', fontSize: 18, fontWeight: 700, outline: 'none', boxSizing: 'border-box' }} />
              {amt > 0 && (
                <p style={{ fontSize: 13, color: 'var(--accent-text)', marginTop: 8 }}>You'll {offer.offerType === 'sell' ? 'pay' : 'receive'} ≈ {currencySymbol(offer.currency)}{fiatTotal}</p>
              )}
            </div>

            <button onClick={accept} disabled={accepting || !amount} style={{
              padding: '15px 0', borderRadius: 14, border: '1px solid color-mix(in srgb, black 12%, transparent)', cursor: 'pointer',
              background: COLORS.primary, color: '#fff', fontSize: 14.5, fontWeight: 700,
              opacity: (accepting || !amount) ? 0.6 : 1,
            }}>{accepting ? 'Starting trade…' : offer.offerType === 'sell' ? 'Buy USDC' : 'Sell USDC'}</button>
          </>
        )}
      </div>

      {showPasscodeSheet && (
        <PasscodeSheet
          title={storedPasscode ? 'Enter Passcode' : 'Confirm Trade'}
          subtitle={offer.offerType === 'buy'
            ? <>Deposit {amt} USDC to escrow to start this trade</>
            : <>Start this trade for {amt} USDC</>}
          storedPasscode={storedPasscode}
          passEntry={passEntry} setPassEntry={setPassEntry}
          passError={passError} setPassError={setPassError}
          onConfirm={handlePasscodeConfirm}
          onClose={() => { setShowPasscodeSheet(false); setPassEntry(''); setPassError('') }}
        />
      )}
    </div>
  )
}

// ── Trade Detail — status flow, timer, chat ─────────────────────────────────
export function P2PTradePage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const { tradeId } = useParams<{ tradeId: string }>()
  const navigate = useNavigate()
  const user = useAuthStore(s => s.user)
  const storedPasscode = useAuthStore(s => s.passcode)
  const { showToastMessage } = useUIStore()
  const [trade, setTrade] = useState<P2PTrade | null>(null)
  const [messages, setMessages] = useState<P2PMessage[]>([])
  const [input, setInput] = useState('')
  const [acting, setActing] = useState(false)
  const [processingPayment, setProcessingPayment] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [showRating, setShowRating] = useState(false)
  const [ratingValue, setRatingValue] = useState(5)
  const [showDispute, setShowDispute] = useState(false)
  const [disputeReason, setDisputeReason] = useState('')
  const [disputeSubmitting, setDisputeSubmitting] = useState(false)
  // What the passcode sheet, once confirmed, should actually execute —
  // 'release' moves escrowed USDC to the buyer, 'cancel' can refund a
  // buy-offer trade's deposit back to the seller (see refund() in
  // p2pProviders.ts) — both are on-chain-moving actions, so both are
  // gated the same way as offer create/cancel above.
  const [pendingAction, setPendingAction] = useState<'release' | 'cancel' | null>(null)
  const [passEntry, setPassEntry] = useState('')
  const [passError, setPassError] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  // ── Payment proof attachment — buyer/seller can attach a receipt
  // screenshot to the trade chat. Previously there was no way to attach
  // anything here at all (trade messages were text-only); this reuses the
  // same Supabase Storage 'attachments' bucket and `[IMAGE](url)` content
  // convention the 1:1 chat already uses, so no schema change is needed —
  // p2p_trade_messages.content just carries the marker string.
  const proofFileInputRef = useRef<HTMLInputElement>(null)
  const [proofFile, setProofFile] = useState<{ file: File; previewUrl: string } | null>(null)
  const [uploadingProof, setUploadingProof] = useState(false)

  useEffect(() => {
    if (!tradeId) return
    fetchTrade(tradeId).then(setTrade)
    fetchTradeMessages(tradeId).then(setMessages)
    const unsubMsg = subscribeToTradeMessages(tradeId, m => setMessages(prev => prev.some(x => x.id === m.id) ? prev : [...prev, m]))
    const unsubTrade = subscribeToTradeUpdates(tradeId, setTrade)
    return () => { unsubMsg(); unsubTrade() }
  }, [tradeId])

  // Fraud protection: auto-cancel this trade if its 15-minute window has
  // already passed — same check-on-read shape as the Hub's offer-expiry
  // sweep. Scoped to just this user's trades (autoCancelExpiredTrades
  // checks all of them), which is fine — cheap at this feature's scale,
  // and guarantees this specific trade gets corrected the moment its own
  // detail page is opened, not just whenever some other screen happens to run it.
  useEffect(() => {
    if (user?.id) autoCancelExpiredTrades(user.id)
  }, [user?.id])

  // Companion sweep for the OTHER way a trade can get stranded: a release that
  // claimed the trade ('payment_sent' -> 'released') but never finished moving
  // funds, because the tab closed or the connection dropped between the claim
  // and its compensation. releaseTrade can't fix what it never gets to run, so
  // this repairs it after the fact — reading the escrow contract's own
  // tradeReleased flag rather than guessing, and changing nothing when the
  // on-chain state can't be established. Never sends a transaction.
  useEffect(() => {
    if (user?.id) reconcileStuckReleases(user.id)
  }, [user?.id])

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [])

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }) }, [messages.length])

  if (!trade || !user) return (
    <div className="lg:max-w-[900px]" style={{ background: COLORS.bg, minHeight: '100%', height: '100%', overflowY: 'auto' }}>
      <Header title="Trade" onBack={() => navigate(-1)} />
      <p style={{ textAlign: 'center', color: COLORS.muted, padding: 40 }}>Loading…</p>
    </div>
  )

  const isBuyer = trade.buyerId === user.id
  const secondsLeft = Math.max(0, Math.floor((new Date(trade.expiresAt).getTime() - now) / 1000))
  const mins = Math.floor(secondsLeft / 60)
  const secs = secondsLeft % 60
  const expired = isTradeExpired(trade) && trade.status === 'waiting_for_buyer'
  const meta = statusMeta(expired ? 'expired' : trade.status)

  const send = async () => {
    const text = input.trim()
    if (!text && !proofFile) return
    setInput('')
    // BUG FIX: this used to append a second, locally-generated copy of the
    // message (id: `local_${Date.now()}`) right after sendTradeMessage()
    // resolved. But the realtime subscription set up above already appends
    // the real row the instant Postgres inserts it — and since the local
    // copy's fake id never matches the real row's id, the id-based dedup
    // in that subscription handler couldn't catch it. Net effect: every
    // message you sent showed up twice in your own chat. The realtime
    // subscription alone is sufficient (same pattern the 1:1 chat uses),
    // so the manual append is removed rather than reconciled — no need to
    // carry a duplicate-looking optimistic message for a chat this fast.
    if (proofFile) await sendProofNow(proofFile)
    if (text) await sendTradeMessage(trade.id, user.id, text, false)
  }

  const stageProofFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) { showToastMessage('Payment proof must be an image', 'error'); return }
    const maxSize = 10 * 1024 * 1024
    if (file.size > maxSize) { showToastMessage('Image is too large — max 10MB', 'error'); return }
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
      if (uploadErr) { showToastMessage('Upload failed — please try again', 'error'); return }
      const { data: urlData } = supabase.storage.from('attachments').getPublicUrl(fileName)
      await sendTradeMessage(trade.id, user.id, `[IMAGE](${urlData.publicUrl})`, false)
      URL.revokeObjectURL(staged.previewUrl)
      setProofFile(null)
    } catch (e: any) {
      showToastMessage('Upload failed — please try again', 'error')
    } finally {
      setUploadingProof(false)
    }
  }

  const handleMarkPaid = async () => {
    // Fake payment-processing animation (2-3s) — see fiatProvider in
    // p2pProviders.ts for why this delay exists: it's the one place in the
    // whole module deliberately slow, so the demo reads as "a payment rail
    // is doing something" rather than an instantly, obviously fake flip.
    setProcessingPayment(true)
    setActing(true)
    const [result] = await Promise.all([
      markPaymentSent(trade),
      new Promise(r => setTimeout(r, 2400)),
    ])
    setProcessingPayment(false)
    setActing(false)
    if (result.success) showToastMessage(result.message, 'success')
    else showToastMessage(result.message, 'error')
  }

  const doRelease = async () => {
    setActing(true)
    const result = await releaseTrade(trade)
    setActing(false)
    if (result.success) { showToastMessage(result.message, 'success'); setShowRating(true) }
    else showToastMessage(result.message, 'error')
  }

  const doCancel = async () => {
    setActing(true)
    const result = await cancelTrade(trade, 'Cancelled by user', user.id)
    setActing(false)
    showToastMessage(result.message, result.success ? 'info' : 'error')
  }

  // Entry points for the Release/Cancel buttons — open the passcode sheet
  // instead of executing right away.
  const handleRelease = () => { setPassEntry(''); setPassError(''); setPendingAction('release') }
  const handleCancel  = () => { setPassEntry(''); setPassError(''); setPendingAction('cancel') }

  const handlePasscodeConfirm = async () => {
    if (storedPasscode) {
      if (passEntry.length < 6) { setPassError('Enter your 6-digit passcode'); return }
      const { verifyPasscode } = await import('@/lib/security')
      if (!await verifyPasscode(passEntry, storedPasscode)) { setPassError('Incorrect passcode'); setPassEntry(''); return }
      // Verifying the passcode only proves it's correct — it does NOT by
      // itself put the private key back in memory. privateKey is
      // deliberately never persisted (see store/index.ts's partialize),
      // so after any fresh page load it's null until explicitly restored.
      // Without this call, a correct passcode entry here was previously
      // followed by a release/accept/cancel that still failed with
      // "Couldn't access your wallet on this device" — the exact bug this
      // fixes. Passing the just-verified passcode lets restorePrivateKey
      // decrypt this device's locally-stored encrypted key immediately,
      // no extra prompt needed.
      const { restorePrivateKey } = await import('@/lib/restoreWallet')
      const restored = await restorePrivateKey(passEntry)
      if (!restored && !useAuthStore.getState().privateKey) {
        setPassError("Couldn't unlock your wallet on this device. Try reloading the app.")
        return
      }
    }
    const action = pendingAction
    setPendingAction(null); setPassEntry(''); setPassError('')
    if (action === 'release') await doRelease()
    else if (action === 'cancel') await doCancel()
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

  // Timeline — a real audit trail of this trade's actual state changes,
  // not just the current status. Only ever shows steps that genuinely
  // happened, in the order the timestamps say they happened.
  const timelineSteps: Array<{ label: string; at: string }> = [
    { label: 'Trade created', at: trade.createdAt },
    ...(trade.paymentSentAt ? [{ label: 'Payment marked sent (Demo)', at: trade.paymentSentAt }] : []),
    ...(trade.releasedAt ? [{ label: 'USDC released', at: trade.releasedAt }] : []),
    ...(trade.completedAt ? [{ label: 'Trade completed', at: trade.completedAt }] : []),
  ]

  return (
    <div className="lg:max-w-[900px]" style={{ background: COLORS.bg, minHeight: '100%', display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Header title="Trade Details" onBack={() => navigate('/p2p/my-trades')} />

      <div style={{ padding: '0 16px 12px' }}>
        {/* Status + timer */}
        <div style={{ background: COLORS.surface, borderRadius: 16, padding: 16, border: `1px solid ${COLORS.border}`, marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: meta.color, background: `color-mix(in srgb, ${meta.color} 13%, transparent)`, padding: '4px 10px', borderRadius: 20 }}>{meta.label}</span>
            {trade.status === 'waiting_for_buyer' && !expired && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: secondsLeft < 120 ? COLORS.error : COLORS.muted }}>
                <Clock size={13} />
                <span style={{ fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{mins}:{secs.toString().padStart(2, '0')}</span>
              </div>
            )}
          </div>
          <div style={{ fontSize: 26, fontWeight: 800, color: COLORS.text }}>{trade.amountUsdc} USDC</div>
          <div style={{ fontSize: 13, color: COLORS.muted, marginTop: 2 }}>= {currencySymbol(trade.currency)}{trade.amountFiat} · {trade.paymentMethod}</div>

          {/* Progress steps */}
          <div style={{ display: 'flex', alignItems: 'center', marginTop: 16, gap: 4 }}>
            {['waiting_for_buyer', 'payment_sent', 'released', 'completed'].map((step, i) => {
              const order = ['waiting_for_buyer', 'payment_sent', 'released', 'completed']
              const currentIdx = order.indexOf(trade.status === 'completed' ? 'completed' : trade.status)
              const reached = i <= currentIdx
              return (
                <div key={step} style={{ flex: 1, height: 4, borderRadius: 2, background: reached ? COLORS.success : COLORS.border }} />
              )
            })}
          </div>
        </div>

        {/* Actions */}
        {trade.status === 'waiting_for_buyer' && !expired && isBuyer && trade.disputeStatus !== 'open' && (
          <button onClick={handleMarkPaid} disabled={acting} style={{ width: '100%', padding: '14px 0', borderRadius: 14, border: '1px solid color-mix(in srgb, black 12%, transparent)', background: COLORS.primary, color: '#fff', fontSize: 14.5, fontWeight: 700, marginBottom: 10, opacity: acting ? 0.6 : 1 }}>
            {processingPayment ? 'Processing payment…' : "I've Paid"}
          </button>
        )}
        {trade.status === 'payment_sent' && !isBuyer && trade.disputeStatus !== 'open' && (
          <button onClick={handleRelease} disabled={acting} style={{ width: '100%', padding: '14px 0', borderRadius: 14, border: '1px solid color-mix(in srgb, black 12%, transparent)', background: COLORS.success, color: '#fff', fontSize: 14.5, fontWeight: 700, marginBottom: 10, opacity: acting ? 0.6 : 1 }}>
            {acting ? 'Releasing…' : 'Release USDC'}
          </button>
        )}
        {(trade.status === 'waiting_for_buyer' || trade.status === 'payment_sent') && canCancelTrade(trade, user.id).allowed && (
          <button onClick={handleCancel} style={{ width: '100%', padding: '11px 0', borderRadius: 14, border: `1px solid ${COLORS.border}`, background: 'none', color: COLORS.muted, fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Cancel Trade</button>
        )}
        {/* Once the counterparty has fulfilled their obligation, cancelling
            is off the table — release/pay or dispute are the only ways
            forward. Dispute stays available the whole time the trade is
            active, not just once cancel disappears. */}
        {(trade.status === 'waiting_for_buyer' || trade.status === 'payment_sent') && trade.disputeStatus !== 'open' && (
          <button onClick={() => setShowDispute(true)} style={{ width: '100%', padding: '11px 0', borderRadius: 14, border: `1px solid ${COLORS.border}`, background: 'none', color: COLORS.warning, fontSize: 13, fontWeight: 600, marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <Scale size={13} /> Open Dispute
          </button>
        )}
        {trade.disputeStatus === 'open' && (
          <div style={{ textAlign: 'center', fontSize: 12.5, color: COLORS.warning, background: 'color-mix(in srgb, var(--warning) 10%, transparent)', borderRadius: 14, padding: '11px 14px', marginBottom: 10, fontWeight: 600 }}>
            {DISPUTE_LOCKED_MESSAGE}
          </div>
        )}
        {trade.status === 'completed' && trade.txHash && (
          <a href={`https://testnet.arcscan.app/tx/${trade.txHash}`} target="_blank" rel="noopener noreferrer"
            style={{ display: 'flex', alignItems: 'center', gap: 6, color: COLORS.success, fontSize: 12.5, marginBottom: 10, textDecoration: 'none' }}>
            <CheckCircle2 size={14} /> USDC transferred on Arc Testnet — View on Explorer ↗
          </a>
        )}

        {/* Timeline */}
        {timelineSteps.length > 1 && (
          <div style={{ background: COLORS.surfaceSecondary, borderRadius: 14, padding: '12px 14px', marginBottom: 10 }}>
            {timelineSteps.map((step, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: i < timelineSteps.length - 1 ? 10 : 0 }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: COLORS.success, flexShrink: 0 }} />
                <div style={{ flex: 1, fontSize: 12, color: COLORS.text }}>{step.label}</div>
                <div style={{ fontSize: 10.5, color: COLORS.muted }}>{new Date(step.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Fake payment-processing overlay — see handleMarkPaid's comment */}
      <AnimatePresence>
        {processingPayment && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 200, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
            <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.1, repeat: Infinity, ease: 'linear' }}
              style={{ width: 46, height: 46, borderRadius: '50%', border: `3px solid ${COLORS.border}`, borderTopColor: COLORS.primary }} />
            <p style={{ fontSize: 14.5, fontWeight: 600, color: '#fff' }}>Processing demo payment…</p>
            <p style={{ fontSize: 11.5, color: COLORS.muted, textAlign: 'center', maxWidth: 260 }}>Simulating a real payment rail — no real money is moving.</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Chat */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {messages.map(m => m.isSystem ? (
          <div key={m.id} style={{ textAlign: 'center', margin: '6px 0' }}>
            <span style={{ fontSize: 11, color: COLORS.muted, background: COLORS.surfaceSecondary, padding: '5px 12px', borderRadius: 12 }}>{m.content}</span>
          </div>
        ) : m.content.startsWith('[IMAGE](') ? (
          <div key={m.id} style={{ alignSelf: m.senderId === user.id ? 'flex-end' : 'flex-start', maxWidth: '75%' }}>
            <img
              src={m.content.match(/^\[IMAGE\]\((.+)\)$/)?.[1] || ''}
              alt="payment proof"
              onClick={() => window.open(m.content.match(/^\[IMAGE\]\((.+)\)$/)?.[1] || '', '_blank')}
              style={{ maxWidth: '100%', borderRadius: 14, display: 'block', cursor: 'zoom-in' }}
            />
          </div>
        ) : (
          <div key={m.id} style={{ alignSelf: m.senderId === user.id ? 'flex-end' : 'flex-start', maxWidth: '75%' }}>
            <div style={{ background: m.senderId === user.id ? COLORS.primary : COLORS.surface, color: m.senderId === user.id ? '#fff' : COLORS.text, borderRadius: 14, padding: '9px 13px', fontSize: 13.5 }}>{m.content}</div>
          </div>
        ))}
      </div>

      {/* Staged payment-proof preview */}
      {proofFile && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderTop: `1px solid ${COLORS.border}` }}>
          <img src={proofFile.previewUrl} alt="proof preview" style={{ width: 44, height: 44, borderRadius: 8, objectFit: 'cover' }} />
          <div style={{ flex: 1, fontSize: 12.5, color: COLORS.muted }}>{uploadingProof ? 'Uploading payment proof…' : 'Payment proof ready to send'}</div>
          <button onClick={clearProofFile} disabled={uploadingProof} style={{ width: 26, height: 26, borderRadius: '50%', background: COLORS.surface, border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <XIcon size={14} color={COLORS.muted} />
          </button>
        </div>
      )}

      {/* Composer */}
      <div style={{ display: 'flex', gap: 8, padding: 14, borderTop: `1px solid ${COLORS.border}` }}>
        <input ref={proofFileInputRef} type="file" accept="image/*" onChange={stageProofFile} style={{ display: 'none' }} />
        <button
          onClick={() => proofFileInputRef.current?.click()}
          title="Attach payment proof"
          style={{ width: 42, height: 42, flexShrink: 0, borderRadius: '50%', background: COLORS.surface, border: `1px solid ${COLORS.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
        >
          <Paperclip size={16} color={COLORS.muted} />
        </button>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()}
          placeholder={proofFile ? 'Add a note (optional)…' : 'Message your trade partner…'} style={{ flex: 1, background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 20, padding: '11px 16px', color: COLORS.text, fontSize: 13.5, outline: 'none' }} />
        <button onClick={send} disabled={uploadingProof} style={{ width: 42, height: 42, borderRadius: '50%', background: COLORS.primary, border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: uploadingProof ? 'default' : 'pointer', opacity: uploadingProof ? 0.6 : 1 }}>
          <Send size={16} color="#fff" />
        </button>
      </div>

      {/* Dispute sheet / dialog */}
      <AnimatePresence>
        {showDispute && (() => {
          const disputeContent = (
            <>
              <p style={{ fontSize: 16, fontWeight: 700, color: COLORS.text, marginBottom: 4 }}>Open a dispute</p>
              <p style={{ fontSize: 12, color: COLORS.muted, marginBottom: 16 }}>Tell us what went wrong — an admin will review the chat and step in.</p>
              <textarea value={disputeReason} onChange={e => setDisputeReason(e.target.value)} placeholder="e.g. Payment was marked sent but I never received it"
                rows={4} style={{ width: '100%', background: COLORS.surface, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 12, fontSize: 13.5, marginBottom: 16, boxSizing: 'border-box', fontFamily: 'inherit', resize: 'none' }} />
              <button onClick={handleOpenDispute} disabled={disputeSubmitting} style={{ width: '100%', padding: '14px 0', borderRadius: 14, border: 'none', background: COLORS.warning, color: '#1A1A1A', fontSize: 14, fontWeight: 700, marginBottom: 10, opacity: disputeSubmitting ? 0.6 : 1 }}>
                {disputeSubmitting ? 'Submitting…' : 'Submit Dispute'}
              </button>
              <button onClick={() => setShowDispute(false)} style={{ width: '100%', padding: '10px 0', borderRadius: 14, border: 'none', background: 'none', color: COLORS.muted, fontSize: 13 }}>Cancel</button>
            </>
          )
          return isDesktop ? (
            <DesktopDialogFrame onClose={() => setShowDispute(false)} maxWidth={440}>
              <div style={{ padding: '24px 20px 28px' }}>{disputeContent}</div>
            </DesktopDialogFrame>
          ) : (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'flex-end' }}>
              <div style={{ width: '100%', maxWidth: 480, margin: '0 auto', background: COLORS.surface, borderRadius: '24px 24px 0 0', padding: '24px 20px 36px' }}>
                {disputeContent}
              </div>
            </motion.div>
          )
        })()}
      </AnimatePresence>

      {/* Rating sheet / dialog */}
      <AnimatePresence>
        {showRating && (() => {
          const ratingContent = (
            <>
              <p style={{ fontSize: 16, fontWeight: 700, color: COLORS.text, marginBottom: 4 }}>Rate your trade partner</p>
              <p style={{ fontSize: 12, color: COLORS.muted, marginBottom: 18 }}>Demo reputation — helps other traders on this testnet marketplace.</p>
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
          return isDesktop ? (
            <DesktopDialogFrame onClose={() => setShowRating(false)} maxWidth={400}>
              <div style={{ padding: '24px 20px 28px', textAlign: 'center' }}>{ratingContent}</div>
            </DesktopDialogFrame>
          ) : (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'flex-end' }}>
              <div style={{ width: '100%', maxWidth: 480, margin: '0 auto', background: COLORS.surface, borderRadius: '24px 24px 0 0', padding: '24px 20px 36px', textAlign: 'center' }}>
                {ratingContent}
              </div>
            </motion.div>
          )
        })()}
      </AnimatePresence>

      {pendingAction && (
        <PasscodeSheet
          title={storedPasscode ? 'Enter Passcode' : (pendingAction === 'release' ? 'Confirm Release' : 'Confirm Cancel')}
          subtitle={pendingAction === 'release'
            ? <>Release {trade.amountUsdc} USDC from escrow to the buyer</>
            : <>Cancel this trade{!isBuyer ? ' and return escrowed USDC' : ''}</>}
          storedPasscode={storedPasscode}
          passEntry={passEntry} setPassEntry={setPassEntry}
          passError={passError} setPassError={setPassError}
          onConfirm={handlePasscodeConfirm}
          onClose={() => { setPendingAction(null); setPassEntry(''); setPassError('') }}
        />
      )}
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
  const [offers, setOffers] = useState<P2POffer[]>([])
  const [remaining, setRemaining] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(true)
  const [cancelling, setCancelling] = useState(false)
  const [offerToCancel, setOfferToCancel] = useState<P2POffer | null>(null)
  const [passEntry, setPassEntry] = useState('')
  const [passError, setPassError] = useState('')

  // ── Edit offer (price / payment methods / terms) ──────────────────────────
  const [editingOffer, setEditingOffer] = useState<P2POffer | null>(null)
  const [editPrice, setEditPrice] = useState('')
  const [editMethods, setEditMethods] = useState<string[]>([])
  const [editTerms, setEditTerms] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [showEditPasscode, setShowEditPasscode] = useState(false)

  // ── Top up escrow (sell offers only) ───────────────────────────────────────
  const [toppingUpOffer, setToppingUpOffer] = useState<P2POffer | null>(null)
  const [topUpAmount, setTopUpAmount] = useState('')
  const [topUpSaving, setTopUpSaving] = useState(false)
  const [showTopUpPasscode, setShowTopUpPasscode] = useState(false)

  const load = useCallback(async () => {
    if (!user?.id) { setLoading(false); return }
    setLoading(true)
    const rows = await fetchMyOffers(user.id)
    setOffers(rows)
    const consumed = await fetchOfferConsumedAmounts(rows.map(o => o.id))
    setRemaining(new Map(rows.map(o => [o.id, offerRemainingAmount(o, consumed.get(o.id) ?? 0)])))
    setLoading(false)
  }, [user?.id])

  useEffect(() => { load() }, [load])

  // Live updates — same reasoning as the marketplace list in P2PPage:
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

  // Actual cancellation — for a sell offer this withdraws whatever's still
  // in escrow back to the wallet, so it's gated behind the passcode sheet
  // below rather than firing straight off the button tap.
  const doCancel = async (offer: P2POffer) => {
    setCancelling(true)
    const result = await cancelOfferAndWithdrawEscrow(offer)
    setCancelling(false)
    showToastMessage(result.message, result.success ? 'success' : 'error')
    load()
  }

  const requestCancel = (offer: P2POffer) => {
    setPassEntry(''); setPassError(''); setOfferToCancel(offer)
  }

  const handlePasscodeConfirm = async () => {
    if (storedPasscode) {
      if (passEntry.length < 6) { setPassError('Enter your 6-digit passcode'); return }
      const { verifyPasscode } = await import('@/lib/security')
      if (!await verifyPasscode(passEntry, storedPasscode)) { setPassError('Incorrect passcode'); setPassEntry(''); return }
      // Verifying the passcode only proves it's correct — it does NOT by
      // itself put the private key back in memory. privateKey is
      // deliberately never persisted (see store/index.ts's partialize),
      // so after any fresh page load it's null until explicitly restored.
      // Without this call, a correct passcode entry here was previously
      // followed by a release/accept/cancel that still failed with
      // "Couldn't access your wallet on this device" — the exact bug this
      // fixes. Passing the just-verified passcode lets restorePrivateKey
      // decrypt this device's locally-stored encrypted key immediately,
      // no extra prompt needed.
      const { restorePrivateKey } = await import('@/lib/restoreWallet')
      const restored = await restorePrivateKey(passEntry)
      if (!restored && !useAuthStore.getState().privateKey) {
        setPassError("Couldn't unlock your wallet on this device. Try reloading the app.")
        return
      }
    }
    const offer = offerToCancel
    setOfferToCancel(null); setPassEntry(''); setPassError('')
    if (offer) await doCancel(offer)
  }

  // ── Edit offer entry point + confirm ───────────────────────────────────────
  const openEdit = (offer: P2POffer) => {
    setEditingOffer(offer)
    setEditPrice(String(offer.pricePerUsdc))
    setEditMethods([...offer.paymentMethods])
    setEditTerms(offer.terms || '')
  }

  const submitEdit = () => {
    if (!editingOffer) return
    if (!editPrice || parseFloat(editPrice) <= 0 || editMethods.length === 0) return
    setPassEntry(''); setPassError(''); setShowEditPasscode(true)
  }

  const handleEditPasscodeConfirm = async () => {
    if (storedPasscode) {
      if (passEntry.length < 6) { setPassError('Enter your 6-digit passcode'); return }
      const { verifyPasscode } = await import('@/lib/security')
      if (!await verifyPasscode(passEntry, storedPasscode)) { setPassError('Incorrect passcode'); setPassEntry(''); return }
    }
    setShowEditPasscode(false); setPassEntry(''); setPassError('')
    const offer = editingOffer
    setEditingOffer(null)
    if (!offer || !user?.id) return
    setEditSaving(true)
    const result = await updateOfferDetails(offer, user.id, {
      pricePerUsdc: parseFloat(editPrice), paymentMethods: editMethods, terms: editTerms || undefined,
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
  // — unlike the price/payment-method edit above — this path also needs
  // restorePrivateKey(), exactly like Release/Cancel/Accept, since the
  // deposit transaction has to actually sign with the wallet.
  const handleTopUpPasscodeConfirm = async () => {
    if (storedPasscode) {
      if (passEntry.length < 6) { setPassError('Enter your 6-digit passcode'); return }
      const { verifyPasscode } = await import('@/lib/security')
      if (!await verifyPasscode(passEntry, storedPasscode)) { setPassError('Incorrect passcode'); setPassEntry(''); return }
      const { restorePrivateKey } = await import('@/lib/restoreWallet')
      const restored = await restorePrivateKey(passEntry)
      if (!restored && !useAuthStore.getState().privateKey) {
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
    const result = await topUpOfferEscrow(offer, user.id, amount)
    setTopUpSaving(false)
    showToastMessage(result.message, result.success ? 'success' : 'error')
    if (result.success) load()
  }

  return (
    <div className="lg:max-w-[900px]" style={{ background: COLORS.bg, minHeight: '100%', height: '100%', overflowY: 'auto', paddingBottom: 40 }}>
      <Header title="My Offers" onBack={() => navigate('/p2p')} />
      <div style={{ padding: '8px 16px' }}>
        {loading ? <p style={{ textAlign: 'center', color: COLORS.muted, padding: 40 }}>Loading…</p> :
         offers.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '50px 20px', background: COLORS.surface, borderRadius: 18, border: `1px dashed ${COLORS.border}` }}>
            <p style={{ color: COLORS.muted, fontSize: 13 }}>No offers yet.</p>
            <button onClick={() => navigate('/p2p/create')} style={{ marginTop: 10, padding: '10px 20px', borderRadius: 12, border: '1px solid color-mix(in srgb, black 12%, transparent)', background: COLORS.primary, color: '#fff', fontSize: 13, fontWeight: 700 }}>Create your first offer</button>
          </div>
        ) : offers.map(o => (
          <div key={o.id} style={{ background: COLORS.surface, borderRadius: 16, padding: 14, marginBottom: 10, border: `1px solid ${COLORS.border}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: o.offerType === 'sell' ? COLORS.error : COLORS.success }}>{o.offerType === 'sell' ? 'Selling' : 'Buying'} USDC</span>
              <span style={{ fontSize: 11, color: o.status === 'active' ? COLORS.success : COLORS.muted, background: o.status === 'active' ? 'color-mix(in srgb, var(--success) 12%, transparent)' : 'color-mix(in srgb, var(--text-primary) 6%, transparent)', padding: '3px 9px', borderRadius: 10, fontWeight: 600 }}>{o.status}</span>
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.text, marginTop: 6 }}>{currencySymbol(o.currency)}{o.pricePerUsdc} / USDC</div>
            <div style={{ fontSize: 11.5, color: COLORS.muted, marginTop: 2 }}>
              {o.minAmount}–{o.status === 'active' ? Math.min(o.maxAmount, remaining.get(o.id) ?? o.maxAmount) : o.maxAmount} USDC · {o.countryRegion}
            </div>
            {o.status === 'active' && (
              <div style={{ fontSize: 11, color: COLORS.success, marginTop: 4, fontWeight: 600 }}>
                Available: {trimTrailingZeros((remaining.get(o.id) ?? o.maxAmount).toFixed(2))} USDC left
              </div>
            )}
            {o.status === 'active' && (
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button onClick={() => openEdit(o)} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '9px 0', borderRadius: 10, border: `1px solid ${COLORS.border}`, background: 'none', color: 'var(--accent-text)', fontSize: 12, fontWeight: 600 }}>
                  <Pencil size={12} /> Edit
                </button>
                {o.offerType === 'sell' && (
                  <button onClick={() => openTopUp(o)} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '9px 0', borderRadius: 10, border: `1px solid ${COLORS.border}`, background: 'none', color: COLORS.success, fontSize: 12, fontWeight: 600 }}>
                    <PlusCircle size={12} /> Top Up
                  </button>
                )}
                <button onClick={() => requestCancel(o)} disabled={cancelling} style={{ flex: 1, padding: '9px 0', borderRadius: 10, border: `1px solid ${COLORS.border}`, background: 'none', color: COLORS.muted, fontSize: 12, fontWeight: 600, opacity: cancelling ? 0.6 : 1 }}>Cancel</button>
              </div>
            )}
          </div>
        ))}
      </div>

      <AnimatePresence>
      {editingOffer && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div style={{ width: '100%', maxWidth: 480, background: COLORS.surface, borderRadius: '20px 20px 0 0', padding: 20, maxHeight: '85vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <p style={{ fontSize: 16, fontWeight: 700, color: COLORS.text, margin: 0 }}>Edit Offer</p>
              <button onClick={() => setEditingOffer(null)} style={{ background: 'none', border: 'none', padding: 4, cursor: 'pointer' }}>
                <XIcon size={20} color={COLORS.muted} />
              </button>
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 6, fontWeight: 600 }}>Price per USDC ({currencySymbol(editingOffer.currency)})</div>
              <input type="number" inputMode="decimal" value={editPrice} onChange={e => setEditPrice(e.target.value)}
                style={{ width: '100%', background: COLORS.surface, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: '12px 14px', fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 6, fontWeight: 600 }}>Payment methods</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {DEMO_PAYMENT_METHODS.map(m => (
                  <button key={m} onClick={() => toggleEditMethod(m)} style={{
                    padding: '8px 12px', borderRadius: 10, fontSize: 12, cursor: 'pointer',
                    border: `1px solid ${editMethods.includes(m) ? COLORS.primary : COLORS.border}`,
                    background: editMethods.includes(m) ? 'color-mix(in srgb, var(--brand) 15%, transparent)' : COLORS.surface,
                    color: editMethods.includes(m) ? 'var(--accent-text)' : COLORS.muted, fontWeight: 600,
                  }}>{m}</button>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 6, fontWeight: 600 }}>Terms (optional)</div>
              <textarea value={editTerms} onChange={e => setEditTerms(e.target.value)} rows={3} placeholder="Any notes for the other party…"
                style={{ width: '100%', background: COLORS.surface, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: '12px 14px', fontSize: 14, outline: 'none', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }} />
            </div>

            <button onClick={submitEdit} disabled={editSaving || !editPrice || parseFloat(editPrice) <= 0 || editMethods.length === 0} style={{
              width: '100%', padding: '14px 0', borderRadius: 14, border: '1px solid color-mix(in srgb, black 12%, transparent)',
              cursor: (!editSaving && editPrice && parseFloat(editPrice) > 0 && editMethods.length > 0) ? 'pointer' : 'default',
              background: COLORS.primary, color: '#fff', fontSize: 14.5, fontWeight: 700,
              opacity: editSaving ? 0.6 : 1,
            }}>{editSaving ? 'Saving…' : 'Save Changes'}</button>
          </div>
        </motion.div>
      )}
      </AnimatePresence>

      {showEditPasscode && (
        <PasscodeSheet
          title={storedPasscode ? 'Enter Passcode' : 'Confirm Changes'}
          subtitle={<>Confirm changes to your offer's price and payment methods</>}
          storedPasscode={storedPasscode}
          passEntry={passEntry} setPassEntry={setPassEntry}
          passError={passError} setPassError={setPassError}
          onConfirm={handleEditPasscodeConfirm}
          onClose={() => { setShowEditPasscode(false); setPassEntry(''); setPassError('') }}
        />
      )}

      <AnimatePresence>
      {toppingUpOffer && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ width: '100%', maxWidth: 380, background: COLORS.surface, borderRadius: 18, padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <PlusCircle size={18} color={COLORS.success} />
              <p style={{ fontSize: 15, fontWeight: 700, color: COLORS.text, margin: 0 }}>Top Up Escrow</p>
            </div>
            <p style={{ fontSize: 12, color: COLORS.muted, marginBottom: 12 }}>
              Deposits additional USDC into this offer's escrow and raises its available capacity by the same amount.
            </p>
            <input type="number" inputMode="decimal" value={topUpAmount} onChange={e => setTopUpAmount(e.target.value)} placeholder="Amount in USDC"
              style={{ width: '100%', background: COLORS.surface, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 12, fontSize: 14, marginBottom: 14, boxSizing: 'border-box' }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setToppingUpOffer(null)} style={{ flex: 1, padding: '11px 0', borderRadius: 10, border: `1px solid ${COLORS.border}`, background: 'none', color: COLORS.muted, fontSize: 13 }}>Cancel</button>
              <button onClick={submitTopUp} disabled={topUpSaving || !topUpAmount || parseFloat(topUpAmount) <= 0}
                style={{ flex: 1, padding: '11px 0', borderRadius: 10, border: '1px solid color-mix(in srgb, black 12%, transparent)', background: COLORS.success, color: '#fff', fontSize: 13, fontWeight: 700, opacity: topUpSaving ? 0.6 : 1 }}>
                {topUpSaving ? 'Depositing…' : 'Deposit'}
              </button>
            </div>
          </div>
        </motion.div>
      )}
      </AnimatePresence>

      {showTopUpPasscode && (
        <PasscodeSheet
          title={storedPasscode ? 'Enter Passcode' : 'Confirm Top Up'}
          subtitle={<>Deposit {topUpAmount || '0'} USDC to this offer's escrow</>}
          storedPasscode={storedPasscode}
          passEntry={passEntry} setPassEntry={setPassEntry}
          passError={passError} setPassError={setPassError}
          onConfirm={handleTopUpPasscodeConfirm}
          onClose={() => { setShowTopUpPasscode(false); setPassEntry(''); setPassError('') }}
        />
      )}

      {offerToCancel && (
        <PasscodeSheet
          title={storedPasscode ? 'Enter Passcode' : 'Confirm Cancel'}
          subtitle={offerToCancel.offerType === 'sell'
            ? <>Cancel offer and return escrowed USDC to your wallet</>
            : <>Cancel this buy offer</>}
          storedPasscode={storedPasscode}
          passEntry={passEntry} setPassEntry={setPassEntry}
          passError={passError} setPassError={setPassError}
          onConfirm={handlePasscodeConfirm}
          onClose={() => { setOfferToCancel(null); setPassEntry(''); setPassError('') }}
        />
      )}
    </div>
  )
}

// ── My Trades ─────────────────────────────────────────────────────────────
export function P2PMyTradesPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const user = useAuthStore(s => s.user)
  const [trades, setTrades] = useState<P2PTrade[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user?.id) { setLoading(false); return }
    fetchMyTrades(user.id).then(rows => { setTrades(rows); setLoading(false) })
  }, [user?.id])

  // Live updates — same reasoning as P2PPage's desktop History panel: a
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

  return (
    <div className="lg:max-w-[900px]" style={{ background: COLORS.bg, minHeight: '100%', height: '100%', overflowY: 'auto', paddingBottom: 40 }}>
      <Header title="My Trades" onBack={() => navigate('/p2p')} right={
        <button onClick={() => navigate('/p2p/history')} style={{ background: 'none', border: 'none', padding: 4, cursor: 'pointer', display: 'flex' }} aria-label="Transaction history">
          <History size={20} color={COLORS.text} />
        </button>
      } />
      <div style={{ padding: '8px 16px' }}>
        {loading ? <p style={{ textAlign: 'center', color: COLORS.muted, padding: 40 }}>Loading…</p> :
         trades.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '50px 20px', background: COLORS.surface, borderRadius: 18, border: `1px dashed ${COLORS.border}` }}>
            <p style={{ color: COLORS.muted, fontSize: 13 }}>No trades yet.</p>
          </div>
        ) : trades.map(t => {
          const isBuyer = t.buyerId === user?.id
          const meta = statusMeta(isTradeExpired(t) ? 'expired' : t.status)
          return (
            <div key={t.id} onClick={() => navigate(`/p2p/trade/${t.id}`)} style={{ background: COLORS.surface, borderRadius: 16, padding: 14, marginBottom: 10, border: `1px solid ${COLORS.border}`, cursor: 'pointer' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: isBuyer ? COLORS.success : COLORS.error }}>{isBuyer ? 'Buying' : 'Selling'} USDC</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: meta.color }}>{meta.label}</span>
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.text, marginTop: 6 }}>{t.amountUsdc} USDC</div>
              <div style={{ fontSize: 11.5, color: COLORS.muted, marginTop: 2 }}>{currencySymbol(t.currency)}{t.amountFiat} · {t.paymentMethod}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
