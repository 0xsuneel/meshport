// features/p2p/P2PAdminPage.tsx
//
// P2P Admin console. Gated at the route level in App.tsx (see the
// AdminGuard/isAdmin pattern already used for the rest of /admin/*) — this
// component itself does not re-check admin status, matching every other
// admin screen in this codebase.

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowLeft, Snowflake, XCircle, Scale, Ban, ShieldAlert, PauseCircle, PlayCircle, Power, Tag } from 'lucide-react'
import { useUIStore, useAuthStore } from '@/store'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useSettingsStore } from '@/store/settingsStore'
import { updateSetting } from '@/lib/adminSupabase'
import { trimTrailingZeros } from '@/lib/utils'
import { RoleManagersPanel } from './RoleManagersPanel'
import { useProcessingFlip, ProcessingFlipCard } from '@/components/ui/ProcessingFlipCard'
import {
  adminFetchAllActiveTrades, subscribeToAllTrades, adminFreezeTrade, adminCancelTrade, adminBanUser,
  adminInvestigateDisputeViaWallet, adminExecuteDisputeResolutionViaWallet,
  adminPauseEscrow, adminUnpauseEscrow, adminFetchEscrowPaused, adminFetchEscrowAdminAddress, adminFetchIsPauser,
  fetchTradeMessages, currencySymbol, type P2PTrade, type P2PMessage,
  fetchAllOffersAdmin, subscribeToAllOffers, adminCancelOffer, type P2POffer,
  fetchOfferConsumedAmounts, offerRemainingAmount,
} from '@/lib/p2pService'
import {
  connectInjectedWallet, getConnectedInjectedWalletAddress, hasInjectedWallet,
  getTradeOnChain, checkIsPauser, checkIsInvestigator, getEscrowAdminAddress,
  type OnChainTrade,
} from '@/lib/p2pEscrowContract'

const COLORS = {
  bg: 'var(--bg)', surface: 'var(--surface)', surfaceSecondary: 'var(--surface)',
  primary: 'var(--brand)', success: 'var(--success)', error: 'var(--danger)', warning: 'var(--warning)',
  text: 'var(--text-primary)', muted: 'var(--text-secondary)', border: 'var(--border)',
}

export function P2PAdminPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const { showToastMessage } = useUIStore()
  const { flipState, runFlip, dismissFlip } = useProcessingFlip()
  const [trades, setTrades] = useState<P2PTrade[]>([])
  const [loading, setLoading] = useState(true)
  const [banTarget, setBanTarget] = useState<string | null>(null)
  const [banReason, setBanReason] = useState('')
  const [disputeTarget, setDisputeTarget] = useState<P2PTrade | null>(null)
  const [disputeNote, setDisputeNote] = useState('')
  // Dispute chat viewer — lets an admin see the buyer/seller conversation,
  // including any payment-proof screenshot, before deciding who to favor.
  // Previously "Resolve Dispute" only opened a blind note field with no
  // way to actually see what either side said or attached.
  const [disputeMessages, setDisputeMessages] = useState<P2PMessage[]>([])
  const [disputeMessagesLoading, setDisputeMessagesLoading] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(new Set())
  const [escrowPaused, setEscrowPaused] = useState(false)
  const [pauseToggling, setPauseToggling] = useState(false)
  const [contractAdmin, setContractAdmin] = useState<string | null>(null)
  // Whether THIS dashboard session's wallet holds the Pauser role — the
  // only thing Emergency Pause and trade Freeze/Unfreeze actually check
  // on P2PMeshportEscrowV2 (they sign with useAuthStore's key, unchanged
  // from before). Dispute resolution (Investigate/Execute) no longer uses
  // this wallet AT ALL — see the dispute modal, which has its own
  // connect-wallet flow and its own inline role warnings per step.
  const [walletIsPauser, setWalletIsPauser] = useState(false)
  const walletAddress = useAuthStore(s => s.walletAddress)
  const walletUnlocked = useAuthStore(s => !!s.privateKey)
  const { settings: appSettings, loaded: settingsLoaded, load: loadSettings } = useSettingsStore()
  const [p2pToggling, setP2PToggling] = useState(false)
  const [offers, setOffers] = useState<P2POffer[]>([])
  const [offersLoading, setOffersLoading] = useState(true)
  // How much of each offer is actually still tradeable right now — max_amount
  // minus whatever's already been consumed by completed trades against it.
  // Not the same as escrowBalance (total ever deposited) or maxAmount (the
  // advertised ceiling) — this is the number a real buyer/seller would see
  // as "available", so it's what the admin view should show too.
  const [remainingByOffer, setRemainingByOffer] = useState<Map<string, number>>(new Map())
  const [offerTab, setOfferTab] = useState<'all' | 'buy' | 'sell'>('all')
  const [cancellingOfferIds, setCancellingOfferIds] = useState<Set<string>>(new Set())

  useEffect(() => { adminFetchEscrowPaused().then(setEscrowPaused) }, [])
  useEffect(() => { adminFetchEscrowAdminAddress().then(setContractAdmin) }, [])
  useEffect(() => { if (walletAddress) adminFetchIsPauser(walletAddress).then(setWalletIsPauser) }, [walletAddress])
  useEffect(() => { loadSettings() }, [loadSettings])

  // SECURITY-REVIEW FIX: this used to be `contractAdmin !== walletAddress`
  // (i.e. "is this wallet the full admin"), which was correct on the old
  // single-role contract but is WRONG on P2PMeshportEscrowV2 — Admin has
  // ZERO implicit Pauser rights there (see the contract's own comment on
  // this), so a wallet being admin no longer means Pause/Freeze will work.
  // The only thing that actually determines whether THIS session's wallet
  // can Pause/Freeze is walletIsPauser, checked directly against the
  // contract's own isPauser() — not derived from an admin comparison at all.
  const pauseWalletMismatch = walletUnlocked && !walletIsPauser

  // Defaults to enabled if the row hasn't loaded yet or doesn't exist —
  // same "fail open" convention useSettingsStore.isEnabled() already uses
  // everywhere else, so a slow network never silently locks P2P out for
  // everyone before the admin even gets a chance to see the real state.
  const p2pEnabled = !settingsLoaded || (appSettings['p2p_enabled']?.enabled ?? true)

  const toggleP2PEnabled = async () => {
    if (p2pToggling) return
    setP2PToggling(true)
    const next = !p2pEnabled
    const { error } = await updateSetting('p2p_enabled', next)
    setP2PToggling(false)
    if (error) {
      showToastMessage(`Could not update: ${error}`, 'error')
    } else {
      showToastMessage(next ? 'P2P marketplace enabled.' : 'P2P marketplace disabled — new offers/trades are blocked; existing trades can still be completed.', 'success')
      useSettingsStore.setState((s) => ({
        settings: { ...s.settings, p2p_enabled: { ...(s.settings['p2p_enabled'] ?? { id: '', feature: 'p2p_enabled', category: 'p2p', label: 'P2P Marketplace', value: null, updated_at: new Date().toISOString() }), enabled: next } },
      }))
    }
  }

  const togglePause = async () => {
    if (pauseToggling) return
    setPauseToggling(true)
    const result = escrowPaused ? await adminUnpauseEscrow() : await adminPauseEscrow()
    setPauseToggling(false)
    showToastMessage(result.message, result.success ? 'success' : 'error')
    if (result.success) setEscrowPaused(!escrowPaused)
  }

  useEffect(() => {
    if (!disputeTarget) { setDisputeMessages([]); return }
    setDisputeMessagesLoading(true)
    fetchTradeMessages(disputeTarget.id)
      .then(setDisputeMessages)
      .finally(() => setDisputeMessagesLoading(false))
  }, [disputeTarget])

  const load = async () => { setLoading(true); setTrades(await adminFetchAllActiveTrades()); setLoading(false) }
  useEffect(() => { load() }, [])

  // Live updates — mirrors the Offers panel's own subscribeToAllOffers just
  // below: a payment marked sent, a release, a dispute, or a brand-new
  // trade should appear here instantly, and survive a tab switch, instead
  // of only ever refreshing on a manual reload.
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = subscribeToAllTrades(() => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(load, 400)
    })
    return () => { if (debounceTimer) clearTimeout(debounceTimer); unsubscribe() }
  }, [])

  const loadOffers = async () => {
    setOffersLoading(true)
    const rows = await fetchAllOffersAdmin()
    setOffers(rows)
    const consumed = await fetchOfferConsumedAmounts(rows.map(o => o.id))
    setRemainingByOffer(new Map(rows.map(o => [o.id, offerRemainingAmount(o, consumed.get(o.id) ?? 0)])))
    setOffersLoading(false)
  }
  useEffect(() => { loadOffers() }, [])
  useEffect(() => subscribeToAllOffers(updated => {
    setOffers(prev => {
      const idx = prev.findIndex(o => o.id === updated.id)
      if (idx === -1) return [updated, ...prev]
      const next = [...prev]
      next[idx] = updated
      return next
    })
    // Recompute just this one offer's remaining amount rather than
    // re-fetching consumed amounts for every offer on every realtime tick.
    fetchOfferConsumedAmounts([updated.id]).then(consumed => {
      setRemainingByOffer(prev => {
        const next = new Map(prev)
        next.set(updated.id, offerRemainingAmount(updated, consumed.get(updated.id) ?? 0))
        return next
      })
    })
  }), [])

  const doCancelOffer = async (o: P2POffer) => {
    if (cancellingOfferIds.has(o.id)) return
    setCancellingOfferIds(prev => new Set(prev).add(o.id))
    const result = await runFlip(
      o.offerType === 'sell' ? 'Withdrawing escrow and cancelling offer…' : 'Cancelling offer…',
      () => adminCancelOffer(o),
      { successTitle: 'Offer Cancelled', errorTitle: 'Could Not Cancel Offer' },
    )
    setCancellingOfferIds(prev => { const next = new Set(prev); next.delete(o.id); return next })
    // Realtime subscription above will also pick up the status change, but
    // updating locally too means the button disables instantly rather than
    // waiting on a round-trip.
    if (result.success) setOffers(prev => prev.map(x => x.id === o.id ? { ...x, status: 'cancelled' } : x))
  }

  const toggleFreeze = async (t: P2PTrade) => {
    await adminFreezeTrade(t.id, !t.adminFrozen)
    showToastMessage(t.adminFrozen ? 'Trade unfrozen' : 'Trade frozen', 'success')
    load()
  }

  const doCancel = async (t: P2PTrade) => {
    if (cancellingIds.has(t.id)) return
    setCancellingIds(prev => new Set(prev).add(t.id))
    const result = await adminCancelTrade(t, 'Cancelled via admin console')
    setCancellingIds(prev => { const next = new Set(prev); next.delete(t.id); return next })
    showToastMessage(result.message, result.success ? 'success' : 'error')
    if (result.success) load()
  }

  const doBan = async () => {
    if (!banTarget) return
    await adminBanUser(banTarget, banReason || 'Banned by admin', 'admin')
    setBanTarget(null); setBanReason('')
    showToastMessage('User banned from P2P marketplace', 'success')
  }

  // ── Dispute resolution — real on-chain Pauser -> Investigator -> Admin
  // flow. Freeze already happens via adminFreezeTrade (unchanged — a
  // best-effort mirror using the dashboard's own session wallet, fine
  // since freezing never moves funds). Investigate/Resolve below MUST use
  // a connected browser wallet, not the dashboard session's key — the
  // contract requires each step to be signed by a genuinely different
  // address (per-dispute independence), so the person acting as
  // Investigator or Admin is very likely not whoever is currently logged
  // into this dashboard.
  const [disputeWallet, setDisputeWallet] = useState<string | null>(null)
  const [disputeOnChain, setDisputeOnChain] = useState<OnChainTrade | null>(null)
  const [disputeWalletIsInvestigator, setDisputeWalletIsInvestigator] = useState(false)
  const [disputeWalletIsAdmin, setDisputeWalletIsAdmin] = useState(false)
  const [investigating, setInvestigating] = useState(false)

  useEffect(() => {
    if (!disputeTarget) { setDisputeOnChain(null); setDisputeWallet(null); return }
    getConnectedInjectedWalletAddress().then(setDisputeWallet)
    getTradeOnChain(disputeTarget.id).then(setDisputeOnChain)
  }, [disputeTarget])

  useEffect(() => {
    if (!disputeWallet) { setDisputeWalletIsInvestigator(false); setDisputeWalletIsAdmin(false); return }
    checkIsInvestigator(disputeWallet).then(setDisputeWalletIsInvestigator)
    getEscrowAdminAddress().then(a => setDisputeWalletIsAdmin(!!a && a.toLowerCase() === disputeWallet.toLowerCase()))
  }, [disputeWallet])

  const doConnectDisputeWallet = async () => {
    if (!hasInjectedWallet()) { showToastMessage('No browser wallet extension detected (e.g. MetaMask).', 'error'); return }
    const addr = await connectInjectedWallet()
    if (addr) setDisputeWallet(addr)
    else showToastMessage('Wallet connection was rejected or failed.', 'error')
  }

  const refreshDisputeOnChain = async () => {
    if (!disputeTarget) return
    setDisputeOnChain(await getTradeOnChain(disputeTarget.id))
  }

  const doInvestigate = async (approveRelease: boolean) => {
    if (!disputeTarget || investigating) return
    setInvestigating(true)
    const result = await adminInvestigateDisputeViaWallet(disputeTarget, approveRelease)
    setInvestigating(false)
    showToastMessage(result.message, result.success ? 'success' : 'error')
    if (result.success) await refreshDisputeOnChain()
  }

  const doExecuteResolution = async () => {
    if (!disputeTarget || resolving) return
    setResolving(true)
    const result = await adminExecuteDisputeResolutionViaWallet(disputeTarget)
    setResolving(false)
    showToastMessage(result.message, result.success ? 'success' : 'error')
    if (result.success) { setDisputeTarget(null); setDisputeNote(''); load() }
    else await refreshDisputeOnChain()
  }

  return (
    <div className="lg:max-w-[900px]" style={{ background: COLORS.bg, minHeight: '100%', height: '100%', overflowY: 'auto', paddingBottom: 40 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 16px 6px' }}>
        {!isDesktop && (
          <button onClick={() => navigate(-1)} style={{ background: 'none', border: 'none', padding: 4, cursor: 'pointer' }}>
            <ArrowLeft size={22} color={COLORS.text} />
          </button>
        )}
        <h1 style={{ fontSize: 20, fontWeight: 700, color: COLORS.text, margin: 0, letterSpacing: '-0.2px' }}>P2P Admin</h1>
      </div>

      <div style={{ padding: '0 16px', marginBottom: 10 }}>
        {!walletUnlocked && (
          <div style={{
            marginBottom: 10, padding: 12, borderRadius: 12,
            background: 'color-mix(in srgb, var(--warning) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <ShieldAlert size={14} color={COLORS.warning} />
              <span style={{ fontSize: 12.5, fontWeight: 700, color: COLORS.warning }}>Wallet not unlocked in this session</span>
            </div>
            <p style={{ fontSize: 11.5, color: COLORS.muted, margin: 0, lineHeight: 1.4 }}>
              Emergency Pause and trade Freeze/Unfreeze sign a real transaction with this session's own wallet — the exact cause of "Couldn't access your wallet on this device" errors. Reload the app and make sure you've unlocked your wallet (PIN/biometric) in this browser before retrying. (Dispute resolution below uses a separately connected wallet, not this one — see the note there.)
            </p>
          </div>
        )}
        {pauseWalletMismatch && (
          <div style={{
            marginBottom: 10, padding: 12, borderRadius: 12,
            background: 'color-mix(in srgb, var(--danger) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <ShieldAlert size={14} color={COLORS.error} />
              <span style={{ fontSize: 12.5, fontWeight: 700, color: COLORS.error }}>This session's wallet isn't a Pauser — Emergency Pause and Freeze/Unfreeze will fail</span>
            </div>
            <p style={{ fontSize: 11.5, color: COLORS.muted, margin: '0 0 4px', lineHeight: 1.4 }}>
              These two actions require this session's own wallet to hold the Pauser role on the escrow contract — being the contract's Admin is <strong>not</strong> enough on its own; Admin has no implicit Pauser rights. Pauser is granted through the Role Managers panel's 2-of-3 + timelock flow, not by logging into this dashboard.
            </p>
            <p style={{ fontSize: 11, color: COLORS.muted, margin: 0, fontFamily: 'monospace' }}>
              Contract admin: {contractAdmin ?? '—'}<br/>
              Your wallet: {walletAddress?.toLowerCase()}
            </p>
          </div>
        )}
        <div style={{
          marginBottom: 10, padding: 12, borderRadius: 12,
          background: COLORS.surface, border: `1px solid ${COLORS.border}`,
        }}>
          <p style={{ fontSize: 11.5, color: COLORS.muted, margin: 0, lineHeight: 1.4 }}>
            <strong style={{ color: COLORS.text }}>Dispute resolution</strong> doesn't use this session's wallet at all — opening a dispute below prompts you to connect a wallet for each step (Investigate, then Execute), and each step must be signed by a different address holding the matching role. See the dispute modal for live role checks.
          </p>
        </div>
        <button
          onClick={togglePause}
          disabled={pauseToggling}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%',
            padding: '11px 0', borderRadius: 12, fontSize: 13, fontWeight: 700,
            border: `1px solid ${escrowPaused ? 'color-mix(in srgb, var(--danger) 40%, transparent)' : COLORS.border}`,
            background: escrowPaused ? 'color-mix(in srgb, var(--danger) 12%, transparent)' : 'none',
            color: escrowPaused ? COLORS.error : COLORS.muted,
            opacity: pauseToggling ? 0.6 : 1,
          }}
        >
          {escrowPaused ? <PlayCircle size={16} /> : <PauseCircle size={16} />}
          {pauseToggling ? 'Updating…' : escrowPaused ? 'Escrow Paused — Tap to Resume' : 'Emergency Pause Escrow'}
        </button>
        {/*
          Two different controls, two different scopes — worth keeping
          visually distinct so an admin doesn't reach for the wrong one:
          - Emergency Pause Escrow (above) = hard stop, contract-level. Blocks
            deposits/releases/refunds for EVERYONE, including trades already
            in progress. For active incidents (e.g. suspected exploit).
          - P2P Marketplace toggle (below) = soft stop, app-level. Blocks
            new offers/trades only; anyone already mid-trade can still
            finish it out normally. For routine maintenance / gradual wind-down.
        */}
        <button
          onClick={toggleP2PEnabled}
          disabled={p2pToggling || !settingsLoaded}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%',
            padding: '11px 0', borderRadius: 12, fontSize: 13, fontWeight: 700, marginTop: 8,
            border: `1px solid ${!p2pEnabled ? 'color-mix(in srgb, var(--danger) 40%, transparent)' : COLORS.border}`,
            background: !p2pEnabled ? 'color-mix(in srgb, var(--danger) 12%, transparent)' : 'none',
            color: !p2pEnabled ? COLORS.error : COLORS.muted,
            opacity: (p2pToggling || !settingsLoaded) ? 0.6 : 1,
          }}
        >
          <Power size={16} />
          {p2pToggling ? 'Updating…' : !settingsLoaded ? 'Loading…' : p2pEnabled ? 'P2P Marketplace Enabled — Tap to Disable' : 'P2P Marketplace Disabled — Tap to Enable'}
        </button>
      </div>

      <div style={{ borderTop: `1px solid ${COLORS.border}`, marginTop: 20 }}>
        <RoleManagersPanel />
      </div>

      <p style={{ padding: '0 16px', fontSize: 12, color: COLORS.muted, marginBottom: 14 }}>
        {trades.length} active trade{trades.length === 1 ? '' : 's'} (awaiting seller confirmation, buyer, or payment sent)
      </p>

      <div style={{ padding: '0 16px' }}>
        {loading ? <p style={{ textAlign: 'center', color: COLORS.muted, padding: 40 }}>Loading…</p> :
         trades.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '50px 20px', background: COLORS.surface, borderRadius: 18, border: `1px dashed ${COLORS.border}` }}>
            <p style={{ color: COLORS.muted, fontSize: 13 }}>No active trades right now.</p>
          </div>
        ) : trades.map(t => (
          <div key={t.id} style={{ background: COLORS.surface, borderRadius: 16, padding: 14, marginBottom: 10, border: `1px solid ${t.adminFrozen ? 'color-mix(in srgb, var(--danger) 40%, transparent)' : COLORS.border}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: COLORS.text }}>{t.amountUsdc} USDC · {currencySymbol(t.currency)}{t.amountFiat}</span>
              {t.adminFrozen && <span style={{ fontSize: 10, fontWeight: 700, color: COLORS.error, background: 'color-mix(in srgb, var(--danger) 12%, transparent)', padding: '3px 8px', borderRadius: 10 }}>FROZEN</span>}
            </div>
            <div style={{ fontSize: 11, color: COLORS.muted, marginBottom: 2 }}>Buyer: {t.buyerId.slice(0, 8)}… · Seller: {t.sellerId.slice(0, 8)}…</div>
            <div style={{ fontSize: 11, color: COLORS.muted, marginBottom: 10 }}>Status: {t.status} · Method: {t.paymentMethod}</div>

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button onClick={() => toggleFreeze(t)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '7px 11px', borderRadius: 10, border: `1px solid ${COLORS.border}`, background: 'none', color: COLORS.warning, fontSize: 11.5, fontWeight: 600 }}>
                <Snowflake size={12} /> {t.adminFrozen ? 'Unfreeze' : 'Freeze'}
              </button>
              <button
                onClick={() => doCancel(t)}
                disabled={cancellingIds.has(t.id)}
                title={(t.status === 'payment_sent' || t.offerType === 'buy') && !t.adminFrozen && t.disputeStatus !== 'open' ? 'Freeze or open a dispute first — the counterparty already fulfilled their obligation' : undefined}
                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '7px 11px', borderRadius: 10, border: `1px solid ${COLORS.border}`, background: 'none', color: COLORS.error, fontSize: 11.5, fontWeight: 600, opacity: cancellingIds.has(t.id) ? 0.6 : 1 }}
              >
                <XCircle size={12} /> {cancellingIds.has(t.id) ? 'Cancelling…' : 'Cancel Trade'}
              </button>
              <button onClick={() => setDisputeTarget(t)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '7px 11px', borderRadius: 10, border: `1px solid ${COLORS.border}`, background: 'none', color: 'var(--accent-text)', fontSize: 11.5, fontWeight: 600 }}>
                <Scale size={12} /> Resolve Dispute
              </button>
              <button onClick={() => setBanTarget(t.buyerId)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '7px 11px', borderRadius: 10, border: `1px solid ${COLORS.border}`, background: 'none', color: COLORS.muted, fontSize: 11.5, fontWeight: 600 }}>
                <Ban size={12} /> Ban Buyer
              </button>
              <button onClick={() => setBanTarget(t.sellerId)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '7px 11px', borderRadius: 10, border: `1px solid ${COLORS.border}`, background: 'none', color: COLORS.muted, fontSize: 11.5, fontWeight: 600 }}>
                <Ban size={12} /> Ban Seller
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* ── OFFERS — live, all statuses, both types ─────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '18px 16px 6px' }}>
        <Tag size={16} color={COLORS.text} />
        <h2 style={{ fontSize: 15, fontWeight: 700, color: COLORS.text, margin: 0 }}>Offers</h2>
        <span style={{ width: 6, height: 6, borderRadius: 3, background: COLORS.success, marginLeft: 2 }} title="Live" />
      </div>
      <div style={{ display: 'flex', gap: 6, padding: '0 16px 10px' }}>
        {(['all', 'buy', 'sell'] as const).map(t => (
          <button key={t} onClick={() => setOfferTab(t)} style={{
            padding: '6px 13px', borderRadius: 16,
            border: `1px solid ${offerTab === t ? COLORS.primary : COLORS.border}`,
            background: offerTab === t ? 'color-mix(in srgb, var(--brand) 12%, transparent)' : 'none', cursor: 'pointer',
          }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: offerTab === t ? 'var(--accent-text)' : COLORS.muted, textTransform: 'capitalize' }}>{t}</span>
          </button>
        ))}
      </div>

      <div style={{ padding: '0 16px' }}>
        {offersLoading ? <p style={{ textAlign: 'center', color: COLORS.muted, padding: 30 }}>Loading offers…</p> : (() => {
          const visible = offers.filter(o => offerTab === 'all' || o.offerType === offerTab)
          if (visible.length === 0) {
            return (
              <div style={{ textAlign: 'center', padding: '40px 20px', background: COLORS.surface, borderRadius: 18, border: `1px dashed ${COLORS.border}` }}>
                <p style={{ color: COLORS.muted, fontSize: 13 }}>No offers to show.</p>
              </div>
            )
          }
          return visible.map(o => {
            const statusColor = o.status === 'active' ? COLORS.success : o.status === 'cancelled' ? COLORS.error : o.status === 'paused' ? COLORS.warning : COLORS.muted
            return (
              <div key={o.id} style={{ background: COLORS.surface, borderRadius: 16, padding: 14, marginBottom: 10, border: `1px solid ${COLORS.border}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: o.offerType === 'sell' ? COLORS.error : COLORS.success, textTransform: 'uppercase' }}>{o.offerType}</span>
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: COLORS.text }}>{o.minAmount}–{o.maxAmount} USDC</span>
                  </div>
                  <span style={{ fontSize: 10, fontWeight: 700, color: statusColor, background: `color-mix(in srgb, ${statusColor} 10%, transparent)`, padding: '3px 9px', borderRadius: 10, textTransform: 'uppercase' }}>{o.status}</span>
                </div>
                <div style={{ fontSize: 11, color: COLORS.muted, marginBottom: 2 }}>
                  {o.username ? `${o.username}.arc` : o.displayName || `${o.userId.slice(0, 8)}…`} · ₹{o.pricePerUsdc}/USDC · {o.countryRegion}
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.success, marginBottom: 2 }}>
                  {trimTrailingZeros((remainingByOffer.get(o.id) ?? o.maxAmount).toFixed(2))} USDC available
                </div>
                <div style={{ fontSize: 11, color: COLORS.muted, marginBottom: 10 }}>
                  {o.escrowBalance != null ? `Escrow: ${o.escrowBalance} USDC · ` : ''}{o.lockedByTradeId ? 'Locked by an active trade' : 'Not locked'}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    onClick={() => doCancelOffer(o)}
                    disabled={o.status !== 'active' || cancellingOfferIds.has(o.id)}
                    title={o.lockedByTradeId ? 'This offer has an active trade — cancel that trade first' : undefined}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 4, padding: '7px 11px', borderRadius: 10,
                      border: `1px solid ${COLORS.border}`, background: 'none', color: COLORS.error, fontSize: 11.5, fontWeight: 600,
                      opacity: (o.status !== 'active' || cancellingOfferIds.has(o.id)) ? 0.4 : 1,
                    }}
                  >
                    <XCircle size={12} /> {cancellingOfferIds.has(o.id) ? 'Cancelling…' : 'Cancel Offer'}
                  </button>
                  <button onClick={() => setBanTarget(o.userId)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '7px 11px', borderRadius: 10, border: `1px solid ${COLORS.border}`, background: 'none', color: COLORS.muted, fontSize: 11.5, fontWeight: 600 }}>
                    <Ban size={12} /> Ban Owner
                  </button>
                </div>
              </div>
            )
          })
        })()}
      </div>

      {/* Ban modal */}
      <AnimatePresence>
      {banTarget && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ width: '100%', maxWidth: 380, background: COLORS.surface, borderRadius: 18, padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <ShieldAlert size={18} color={COLORS.error} />
              <p style={{ fontSize: 15, fontWeight: 700, color: COLORS.text, margin: 0 }}>Ban User</p>
            </div>
            <p style={{ fontSize: 12, color: COLORS.muted, marginBottom: 12 }}>User: {banTarget.slice(0, 12)}…</p>
            <textarea value={banReason} onChange={e => setBanReason(e.target.value)} placeholder="Reason for ban" rows={3}
              style={{ width: '100%', background: COLORS.surface, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 10, fontSize: 13, marginBottom: 12, boxSizing: 'border-box', fontFamily: 'inherit' }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setBanTarget(null)} style={{ flex: 1, padding: '11px 0', borderRadius: 10, border: `1px solid ${COLORS.border}`, background: 'none', color: COLORS.muted, fontSize: 13 }}>Cancel</button>
              <button onClick={doBan} style={{ flex: 1, padding: '11px 0', borderRadius: 10, border: '1px solid color-mix(in srgb, black 12%, transparent)', background: COLORS.error, color: '#fff', fontSize: 13, fontWeight: 700 }}>Confirm Ban</button>
            </div>
          </div>
        </motion.div>
      )}
      </AnimatePresence>

      {/* Dispute modal */}
      <AnimatePresence>
      {disputeTarget && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ width: '100%', maxWidth: 380, background: COLORS.surface, borderRadius: 18, padding: 20 }}>
            <p style={{ fontSize: 15, fontWeight: 700, color: COLORS.text, marginBottom: 12 }}>Resolve Dispute</p>

            <p style={{ fontSize: 11, fontWeight: 700, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>Trade chat</p>
            <div style={{ maxHeight: 220, overflowY: 'auto', background: COLORS.surface, borderRadius: 12, border: `1px solid ${COLORS.border}`, padding: 10, marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {disputeMessagesLoading ? (
                <p style={{ textAlign: 'center', color: COLORS.muted, fontSize: 12, padding: 12 }}>Loading messages…</p>
              ) : disputeMessages.length === 0 ? (
                <p style={{ textAlign: 'center', color: COLORS.muted, fontSize: 12, padding: 12 }}>No messages in this trade.</p>
              ) : disputeMessages.map(m => {
                const isBuyer = m.senderId === disputeTarget.buyerId
                const isSeller = m.senderId === disputeTarget.sellerId
                const label = m.isSystem ? 'System' : isBuyer ? 'Buyer' : isSeller ? 'Seller' : 'Unknown'
                const imageUrl = m.content.match(/^\[IMAGE\]\((.+)\)$/)?.[1]
                return (
                  <div key={m.id} style={{ fontSize: 11.5 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 }}>
                      <span style={{
                        fontWeight: 700,
                        color: m.isSystem ? COLORS.muted : isBuyer ? COLORS.success : 'var(--accent-text)',
                      }}>{label}</span>
                      <span style={{ color: COLORS.muted, fontSize: 10 }}>{new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    {imageUrl ? (
                      <img
                        src={imageUrl}
                        alt="payment proof"
                        onClick={() => window.open(imageUrl, '_blank')}
                        style={{ maxWidth: '100%', maxHeight: 160, borderRadius: 8, cursor: 'zoom-in', display: 'block' }}
                      />
                    ) : (
                      <p style={{ color: COLORS.text, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.content}</p>
                    )}
                  </div>
                )
              })}
            </div>

            <textarea value={disputeNote} onChange={e => setDisputeNote(e.target.value)} placeholder="Note (optional, for the chat log)" rows={2}
              style={{ width: '100%', background: COLORS.surface, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 10, fontSize: 13, marginBottom: 12, boxSizing: 'border-box', fontFamily: 'inherit' }} />

            {/* ── Real on-chain dispute resolution — Investigator then Admin, each a genuinely different connected wallet ── */}
            <div style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 12, marginBottom: 12 }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
                On-chain resolution — {disputeOnChain?.state ?? (disputeTarget.adminFrozen ? 'Frozen' : 'Active')}
              </p>

              {!disputeOnChain?.state || disputeOnChain.state === 'None' ? (
                <p style={{ fontSize: 12, color: COLORS.warning }}>Could not read this trade's on-chain state — make sure it's registered on-chain and frozen before investigating.</p>
              ) : disputeOnChain.state === 'Active' ? (
                <p style={{ fontSize: 12, color: COLORS.muted }}>Freeze this trade first (use the freeze toggle in the trade list) before it can be investigated.</p>
              ) : (
                <>
                  {disputeWallet ? (
                    <div style={{ marginBottom: 8 }}>
                      <p style={{ fontSize: 11.5, color: COLORS.muted, fontFamily: 'monospace' }}>Connected: {disputeWallet}</p>
                      {disputeOnChain.state === 'Frozen' && !disputeWalletIsInvestigator && (
                        <p style={{ fontSize: 11, color: COLORS.warning, marginTop: 2 }}>This wallet doesn't hold the Investigator role — the transaction will revert.</p>
                      )}
                      {disputeOnChain.state === 'Investigated' && !disputeWalletIsAdmin && (
                        <p style={{ fontSize: 11, color: COLORS.warning, marginTop: 2 }}>This wallet isn't the contract's Admin — the transaction will revert.</p>
                      )}
                    </div>
                  ) : (
                    <button onClick={doConnectDisputeWallet} style={{ width: '100%', padding: '10px 0', borderRadius: 10, border: 'none', background: COLORS.text, color: COLORS.bg, fontSize: 12.5, fontWeight: 700, marginBottom: 8 }}>
                      Connect Wallet to Investigate / Resolve
                    </button>
                  )}

                  {disputeOnChain.state === 'Frozen' && (
                    <>
                      <p style={{ fontSize: 12, color: COLORS.muted, marginBottom: 8 }}>
                        Step 1: Investigate. Connected wallet must hold the Investigator role and be
                        different from whoever froze this trade — the contract itself enforces this.
                      </p>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button onClick={() => doInvestigate(true)} disabled={!disputeWallet || investigating}
                          style={{ flex: 1, padding: '10px 0', borderRadius: 10, border: 'none', background: COLORS.success, color: '#fff', fontSize: 12, fontWeight: 700, opacity: (!disputeWallet || investigating) ? 0.6 : 1 }}>
                          {investigating ? 'Signing…' : 'Recommend Release'}
                        </button>
                        <button onClick={() => doInvestigate(false)} disabled={!disputeWallet || investigating}
                          style={{ flex: 1, padding: '10px 0', borderRadius: 10, border: 'none', background: COLORS.error, color: '#fff', fontSize: 12, fontWeight: 700, opacity: (!disputeWallet || investigating) ? 0.6 : 1 }}>
                          {investigating ? 'Signing…' : 'Recommend Refund'}
                        </button>
                      </div>
                    </>
                  )}

                  {disputeOnChain.state === 'Investigated' && (
                    <>
                      <p style={{ fontSize: 12, color: COLORS.muted, marginBottom: 8 }}>
                        Step 2: Execute. Investigator recommended{' '}
                        <strong style={{ color: disputeOnChain.investigatedApproveRelease ? COLORS.success : COLORS.error }}>
                          {disputeOnChain.investigatedApproveRelease ? 'release to buyer' : 'refund to seller'}
                        </strong>. Connected wallet must be Admin and different from both whoever froze and whoever investigated this trade.
                      </p>
                      <button onClick={doExecuteResolution} disabled={!disputeWallet || resolving}
                        style={{ width: '100%', padding: '11px 0', borderRadius: 10, border: 'none', background: COLORS.text, color: COLORS.bg, fontSize: 12.5, fontWeight: 700, opacity: (!disputeWallet || resolving) ? 0.6 : 1 }}>
                        {resolving ? 'Executing…' : `Execute: ${disputeOnChain.investigatedApproveRelease ? 'Release to Buyer' : 'Refund to Seller'}`}
                      </button>
                    </>
                  )}

                  {(disputeOnChain.state === 'Released' || disputeOnChain.state === 'Refunded') && (
                    <p style={{ fontSize: 12.5, fontWeight: 700, color: COLORS.success }}>
                      Already resolved on-chain: {disputeOnChain.state === 'Released' ? 'released to buyer' : 'refunded to seller'}.
                    </p>
                  )}
                </>
              )}
            </div>
            <button onClick={() => setDisputeTarget(null)} disabled={resolving} style={{ width: '100%', padding: '10px 0', borderRadius: 10, border: `1px solid ${COLORS.border}`, background: 'none', color: COLORS.muted, fontSize: 13, opacity: resolving ? 0.6 : 1 }}>Close</button>
          </div>
        </motion.div>
      )}
      </AnimatePresence>
      <ProcessingFlipCard {...flipState} onDismiss={dismissFlip} />
    </div>
  )
}
