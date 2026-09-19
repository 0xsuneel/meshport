// features/p2p/P2PAdminPage.tsx
//
// P2P Admin console. Gated at the route level in App.tsx (see the
// AdminGuard/isAdmin pattern already used for the rest of /admin/*) — this
// component itself does not re-check admin status, matching every other
// admin screen in this codebase.

import { useState, useEffect, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowLeft, Snowflake, XCircle, Scale, Ban, ShieldAlert, PauseCircle, PlayCircle, Power, Tag, Lock, Unlock, Sliders, ListChecks } from 'lucide-react'
import { useUIStore } from '@/store'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useSettingsStore } from '@/store/settingsStore'
import { updateSetting } from '@/lib/adminSupabase'
import { trimTrailingZeros } from '@/lib/utils'
import { RoleManagersPanel } from './RoleManagersPanel'
import { AddressChip } from './AddressChip'
import { useProcessingFlip, ProcessingFlipCard } from '@/components/ui/ProcessingFlipCard'
import {
  adminFetchAllActiveTrades, subscribeToAllTrades, adminFreezeTradeViaWallet, adminCancelTrade, adminBanUser,
  adminFreezeDisputeViaWallet, adminInvestigateDisputeViaWallet, adminExecuteDisputeResolutionViaWallet, sendAdminTradeMessage,
  adminPauseEscrowViaWallet, adminUnpauseEscrowViaWallet, adminFetchEscrowPaused,
  fetchTradeMessages, currencySymbol, type P2PTrade, type P2PMessage,
  fetchAllOffersAdmin, subscribeToAllOffers, adminCancelOffer, type P2POffer,
  fetchOfferConsumedAmounts, offerRemainingAmount, adminFreezeOfferViaWallet, adminFetchOfferFrozen,
} from '@/lib/p2pService'
import {
  connectInjectedWallet, disconnectInjectedWallet, getConnectedInjectedWalletAddress, hasInjectedWallet,
  getTradeOnChain, checkIsPauser, checkIsInvestigator, getEscrowAdminAddress,
  type OnChainTrade,
} from '@/lib/p2pEscrowContract'

const COLORS = {
  bg: 'var(--bg)', surface: 'var(--surface)', surfaceSecondary: 'var(--surface)',
  primary: 'var(--brand)', success: 'var(--success)', error: 'var(--danger)', warning: 'var(--warning)',
  text: 'var(--text-primary)', muted: 'var(--text-secondary)', border: 'var(--border)',
}

// One consistent header treatment for every major section on this page —
// previously only "Offers" had an icon + title + live dot; "Escrow
// Controls" and "Active Trades" were unlabeled blocks that just started
// with a button or a plain paragraph, making the page read as one long
// scroll instead of clearly separated areas.
function SectionHeader({ icon, title, live }: { icon: ReactNode; title: string; live?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '18px 16px 8px' }}>
      {icon}
      <h2 style={{ fontSize: 15, fontWeight: 700, color: COLORS.text, margin: 0 }}>{title}</h2>
      {live && <span style={{ width: 6, height: 6, borderRadius: 3, background: COLORS.success, marginLeft: 2 }} title="Live" />}
    </div>
  )
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
  // Live on-chain freeze state per offer — see adminFetchOfferFrozen's own
  // comment on why this has to be read from the contract rather than a DB
  // column (p2p_offers has no admin_frozen field; the on-chain call IS the
  // whole action for offer-level freeze).
  const [frozenByOffer, setFrozenByOffer] = useState<Map<string, boolean>>(new Map())
  const [freezingOfferIds, setFreezingOfferIds] = useState<Set<string>>(new Set())

  useEffect(() => { adminFetchEscrowPaused().then(setEscrowPaused) }, [])
  useEffect(() => { loadSettings() }, [loadSettings])

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
    const result = escrowPaused ? await adminUnpauseEscrowViaWallet() : await adminPauseEscrowViaWallet()
    setPauseToggling(false)
    showToastMessage(result.message, result.success ? 'success' : 'error')
    if (result.success) setEscrowPaused(!escrowPaused)
  }

  useEffect(() => {
    // A fresh dispute target means fresh reason/note/chat fields — never
    // carry stale text from one trade's review into another's.
    setFreezeReason(''); setInvestigateReason(''); setResolveNote(''); setAdminChatInput('')
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
    // Only sell offers can ever be frozen (nothing's escrowed for a buy
    // offer) — skip the on-chain read for the rest.
    const sellOffers = rows.filter(o => o.offerType === 'sell')
    const frozenFlags = await Promise.all(sellOffers.map(o => adminFetchOfferFrozen(o)))
    setFrozenByOffer(new Map(sellOffers.map((o, i) => [o.id, frozenFlags[i]])))
    setOffersLoading(false)
  }
  useEffect(() => { loadOffers() }, [])

  const toggleFreezeOffer = async (o: P2POffer) => {
    if (freezingOfferIds.has(o.id)) return
    setFreezingOfferIds(prev => new Set(prev).add(o.id))
    const nextFrozen = !(frozenByOffer.get(o.id) ?? false)
    const result = await adminFreezeOfferViaWallet(o, nextFrozen)
    setFreezingOfferIds(prev => { const next = new Set(prev); next.delete(o.id); return next })
    showToastMessage(result.message, result.success ? 'success' : 'error')
    if (result.success) setFrozenByOffer(prev => new Map(prev).set(o.id, nextFrozen))
  }
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
    const result = await adminFreezeTradeViaWallet(t.id, !t.adminFrozen)
    showToastMessage(result.message, result.success ? 'success' : 'error')
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

  // ── Connected wallet — shared by EVERY privileged action on this page ──
  // ROOT-CAUSE FIX: Emergency Pause, per-trade Freeze/Unfreeze, and
  // per-offer Freeze/Unfreeze used to sign with whatever wallet is logged
  // into this dashboard's own MeshPort session (useAuthStore) — that's why
  // "Wallet not unlocked in this session" / "session's wallet isn't a
  // Pauser" banners used to exist here. Pauser/Investigator/Admin are
  // genuinely separate wallets from whoever is logged into this dashboard
  // (see the contract's own file header on separation of duties) — so
  // that key was almost never actually a Pauser, and those actions
  // silently reverted on-chain (or did nothing at all if the session
  // wallet had no key). Every privileged action on this page now signs
  // through the SAME connected browser wallet (MetaMask etc.) instead —
  // one connect, reused for Pause/Freeze/dispute resolution — with live
  // role badges so it's obvious up front what this connected address can
  // actually do, instead of finding out via a revert.
  const [connectedWallet, setConnectedWallet] = useState<string | null>(null)
  const [connectedWalletIsPauser, setConnectedWalletIsPauser] = useState(false)
  const [connectedWalletIsInvestigator, setConnectedWalletIsInvestigator] = useState(false)
  const [connectedWalletIsAdmin, setConnectedWalletIsAdmin] = useState(false)
  const [connectingWallet, setConnectingWallet] = useState(false)

  useEffect(() => { getConnectedInjectedWalletAddress().then(setConnectedWallet) }, [])

  useEffect(() => {
    if (!connectedWallet) { setConnectedWalletIsPauser(false); setConnectedWalletIsInvestigator(false); setConnectedWalletIsAdmin(false); return }
    checkIsPauser(connectedWallet).then(setConnectedWalletIsPauser)
    checkIsInvestigator(connectedWallet).then(setConnectedWalletIsInvestigator)
    getEscrowAdminAddress().then(a => setConnectedWalletIsAdmin(!!a && a.toLowerCase() === connectedWallet.toLowerCase()))
  }, [connectedWallet])

  const doConnectWallet = async () => {
    if (!hasInjectedWallet()) { showToastMessage('No browser wallet extension detected (e.g. MetaMask).', 'error'); return }
    setConnectingWallet(true)
    const addr = await connectInjectedWallet()
    setConnectingWallet(false)
    if (addr) setConnectedWallet(addr)
    else showToastMessage('Wallet connection was rejected or failed.', 'error')
  }

  // Lets whoever's using this console switch wallets — e.g. the Pauser
  // connected the wrong account, or the browser is being handed to the
  // Investigator next without a full page reload. Each dispute stage's
  // own success handler already clears this automatically; this is the
  // manual escape hatch for everything else (Pause, trade/offer Freeze).
  const doDisconnectWallet = async () => {
    await disconnectInjectedWallet()
    setConnectedWallet(null)
  }

  // ── Dispute resolution — real on-chain Pauser -> Investigator -> Admin
  // flow, all signed through the same connectedWallet above.
  const [disputeOnChain, setDisputeOnChain] = useState<OnChainTrade | null>(null)
  const [freezing, setFreezing] = useState(false)
  const [investigating, setInvestigating] = useState(false)
  // Required reason text for each escalation step — Pauser forwarding to
  // Investigator, and Investigator forwarding to Admin — so the next tier
  // sees WHY this trade was escalated, not just that it was. Recorded as a
  // system message in the trade chat by adminFreezeDisputeViaWallet /
  // adminInvestigateDisputeViaWallet. Separate from resolveNote (Admin's
  // own optional closing note) and adminChatInput (a live message to
  // either party, e.g. asking for proof of payment).
  const [freezeReason, setFreezeReason] = useState('')
  const [investigateReason, setInvestigateReason] = useState('')
  const [resolveNote, setResolveNote] = useState('')
  const [adminChatInput, setAdminChatInput] = useState('')
  const [sendingAdminMessage, setSendingAdminMessage] = useState(false)

  useEffect(() => {
    if (!disputeTarget) { setDisputeOnChain(null); return }
    getTradeOnChain(disputeTarget.id).then(setDisputeOnChain)
  }, [disputeTarget])

  // Proactive independence checks — mirrors what the contract itself
  // enforces (investigate() reverts if msg.sender === frozenBy;
  // adminResolve() reverts if msg.sender === frozenBy or investigatedBy)
  // so the buttons below can be disabled BEFORE wasting a signature and
  // gas on a guaranteed revert, not just warn after the fact.
  const sameAsFreezer = !!connectedWallet && !!disputeOnChain?.frozenBy && connectedWallet.toLowerCase() === disputeOnChain.frozenBy.toLowerCase()
  const sameAsInvestigator = !!connectedWallet && !!disputeOnChain?.investigatedBy && connectedWallet.toLowerCase() === disputeOnChain.investigatedBy.toLowerCase()
  const canFreeze = !!connectedWallet && connectedWalletIsPauser
  const canInvestigate = !!connectedWallet && connectedWalletIsInvestigator && !sameAsFreezer
  const canExecute = !!connectedWallet && connectedWalletIsAdmin && !sameAsFreezer && !sameAsInvestigator

  const refreshDisputeOnChain = async () => {
    if (!disputeTarget) return
    setDisputeOnChain(await getTradeOnChain(disputeTarget.id))
  }

  const refreshDisputeMessages = async () => {
    if (!disputeTarget) return
    setDisputeMessages(await fetchTradeMessages(disputeTarget.id))
  }

  const doFreezeDispute = async () => {
    if (!disputeTarget || freezing) return
    setFreezing(true)
    const result = await adminFreezeDisputeViaWallet(disputeTarget, freezeReason)
    setFreezing(false)
    showToastMessage(result.message, result.success ? 'success' : 'error')
    if (result.success) {
      setFreezeReason('')
      // ROOT-CAUSE FIX: without this, the Pauser's own wallet stayed
      // "Connected" for the Investigate step too — the UI would show a
      // "wrong role, will revert" warning instead of clearly asking the
      // NEXT person (a genuinely different wallet) to connect. Clearing it
      // here is what actually makes the modal say "Investigator needs to
      // sign" after a freeze, instead of stalling on a stale connection.
      setConnectedWallet(null)
      await Promise.all([refreshDisputeOnChain(), refreshDisputeMessages()])
      load()
    }
  }

  const doInvestigate = async (approveRelease: boolean) => {
    if (!disputeTarget || investigating) return
    setInvestigating(true)
    const result = await adminInvestigateDisputeViaWallet(disputeTarget, approveRelease, investigateReason)
    setInvestigating(false)
    showToastMessage(result.message, result.success ? 'success' : 'error')
    if (result.success) {
      setInvestigateReason('')
      // Same fix as doFreezeDispute — clear the Investigator's wallet so
      // the modal cleanly asks for Admin next, rather than showing a
      // stale "wrong role" warning under the Investigator's own address.
      setConnectedWallet(null)
      await Promise.all([refreshDisputeOnChain(), refreshDisputeMessages()])
    }
  }

  const doExecuteResolution = async () => {
    if (!disputeTarget || resolving) return
    setResolving(true)
    const result = await adminExecuteDisputeResolutionViaWallet(disputeTarget, resolveNote)
    setResolving(false)
    showToastMessage(result.message, result.success ? 'success' : 'error')
    if (result.success) { setDisputeTarget(null); setResolveNote(''); load() }
    else await refreshDisputeOnChain()
  }

  const doSendAdminMessage = async () => {
    if (!disputeTarget || !adminChatInput.trim() || sendingAdminMessage) return
    setSendingAdminMessage(true)
    await sendAdminTradeMessage(disputeTarget.id, adminChatInput)
    setAdminChatInput('')
    await refreshDisputeMessages()
    setSendingAdminMessage(false)
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

      <SectionHeader icon={<Sliders size={16} color={COLORS.text} />} title="Escrow Controls" />
      <div style={{ padding: '0 16px', marginBottom: 10 }}>
        {/* ROOT-CAUSE FIX: Emergency Pause, trade Freeze/Unfreeze, and offer
            Freeze/Unfreeze used to sign with this dashboard's own MeshPort
            session key — which is essentially never a Pauser (a genuinely
            separate wallet by design, see the contract's own file header on
            separation of duties), so those actions silently reverted or did
            nothing. This card is the ONE wallet connection every privileged
            action on this whole page now shares — Pause, per-trade Freeze,
            per-offer Freeze, and every step of dispute resolution below. */}
        <div style={{ marginBottom: 10, padding: 12, borderRadius: 12, background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
          {connectedWallet ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, color: COLORS.text, minWidth: 0 }}>
                  <AddressChip address={connectedWallet} size={12.5} />
                </span>
                <button onClick={doDisconnectWallet} style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, color: COLORS.muted, background: 'none', border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '4px 9px', cursor: 'pointer' }}>
                  Disconnect
                </button>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {[
                  { label: 'Pauser', on: connectedWalletIsPauser },
                  { label: 'Investigator', on: connectedWalletIsInvestigator },
                  { label: 'Admin', on: connectedWalletIsAdmin },
                ].filter(b => b.on).map(b => (
                  <span key={b.label} style={{ fontSize: 10.5, fontWeight: 700, color: COLORS.primary, background: 'color-mix(in srgb, var(--brand) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--brand) 35%, transparent)', borderRadius: 999, padding: '3px 9px' }}>{b.label}</span>
                ))}
                {!connectedWalletIsPauser && !connectedWalletIsInvestigator && !connectedWalletIsAdmin && (
                  <span style={{ fontSize: 11, color: COLORS.muted }}>This address holds no privileged role on this contract.</span>
                )}
              </div>
              {!connectedWalletIsPauser && (
                <p style={{ fontSize: 11, color: COLORS.warning, margin: '6px 0 0', lineHeight: 1.4 }}>
                  Not a Pauser — Emergency Pause and Freeze/Unfreeze (trades, offers) will revert. Disconnect and connect the Pauser's own wallet, or grant this one Pauser via the Role Managers panel below.
                </p>
              )}
            </div>
          ) : (
            <button onClick={doConnectWallet} disabled={connectingWallet} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '11px 0', borderRadius: 12, border: 'none', background: COLORS.primary, color: '#fff', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', opacity: connectingWallet ? 0.7 : 1 }}>
              {connectingWallet ? 'Connecting…' : 'Connect Wallet'}
            </button>
          )}
        </div>
        <button
          onClick={togglePause}
          disabled={pauseToggling || !canFreeze}
          title={!canFreeze ? 'Connect a wallet holding the Pauser role first.' : undefined}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%',
            padding: '11px 0', borderRadius: 12, fontSize: 13, fontWeight: 700,
            border: `1px solid ${escrowPaused ? 'color-mix(in srgb, var(--danger) 40%, transparent)' : COLORS.border}`,
            background: escrowPaused ? 'color-mix(in srgb, var(--danger) 12%, transparent)' : 'none',
            color: escrowPaused ? COLORS.error : COLORS.muted,
            opacity: (pauseToggling || !canFreeze) ? 0.5 : 1,
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

      <div style={{ borderTop: `1px solid ${COLORS.border}`, marginTop: 24 }}>
        <RoleManagersPanel />
      </div>

      <div style={{ borderTop: `1px solid ${COLORS.border}`, marginTop: 4 }}>
        <SectionHeader icon={<ListChecks size={16} color={COLORS.text} />} title="Active Trades" live />
        <p style={{ padding: '0 16px', fontSize: 12, color: COLORS.muted, marginBottom: 14, marginTop: -2 }}>
          {trades.length} active trade{trades.length === 1 ? '' : 's'} (awaiting seller confirmation, buyer, or payment sent)
        </p>
      </div>

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
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 11, color: COLORS.muted, marginBottom: 2 }}>
              <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>Buyer: <AddressChip address={t.buyerId} size={11} mono={false} /></span>
              <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>Seller: <AddressChip address={t.sellerId} size={11} mono={false} /></span>
            </div>
            <div style={{ fontSize: 11, color: COLORS.muted, marginBottom: 10 }}>Status: {t.status} · Method: {t.paymentMethod}</div>

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button onClick={() => toggleFreeze(t)} disabled={!canFreeze} title={!canFreeze ? 'Connect a wallet holding the Pauser role first (see Escrow Controls above).' : undefined}
                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '7px 11px', borderRadius: 10, border: `1px solid ${COLORS.border}`, background: 'none', color: COLORS.warning, fontSize: 11.5, fontWeight: 600, opacity: canFreeze ? 1 : 0.5 }}>
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
      <div style={{ borderTop: `1px solid ${COLORS.border}`, marginTop: 8 }}>
        <SectionHeader icon={<Tag size={16} color={COLORS.text} />} title="Offers" live />
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
            const isFrozen = frozenByOffer.get(o.id) ?? false
          return (
              <div key={o.id} style={{ background: COLORS.surface, borderRadius: 16, padding: 14, marginBottom: 10, border: `1px solid ${isFrozen ? 'color-mix(in srgb, var(--danger) 40%, transparent)' : COLORS.border}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: o.offerType === 'sell' ? COLORS.error : COLORS.success, textTransform: 'uppercase' }}>{o.offerType}</span>
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: COLORS.text }}>{o.minAmount}–{o.maxAmount} USDC</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {isFrozen && <span style={{ fontSize: 10, fontWeight: 700, color: COLORS.error, background: 'color-mix(in srgb, var(--danger) 12%, transparent)', padding: '3px 8px', borderRadius: 10 }}>FROZEN</span>}
                    <span style={{ fontSize: 10, fontWeight: 700, color: statusColor, background: `color-mix(in srgb, ${statusColor} 10%, transparent)`, padding: '3px 9px', borderRadius: 10, textTransform: 'uppercase' }}>{o.status}</span>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: COLORS.muted, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {o.username ? `${o.username}.arc` : o.displayName || `${o.userId.slice(0, 8)}…`} · {currencySymbol(o.currency)}{o.pricePerUsdc}/USDC · {o.countryRegion}
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.success, marginBottom: 2 }}>
                  {trimTrailingZeros((remainingByOffer.get(o.id) ?? o.maxAmount).toFixed(2))} USDC available
                </div>
                <div style={{ fontSize: 11, color: COLORS.muted, marginBottom: 10 }}>
                  {o.escrowBalance != null ? `Escrow: ${o.escrowBalance} USDC · ` : ''}{o.lockedByTradeId ? 'Locked by an active trade' : 'Not locked'}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {o.offerType === 'sell' && o.status === 'active' && (
                    <button
                      onClick={() => toggleFreezeOffer(o)}
                      disabled={freezingOfferIds.has(o.id) || !canFreeze}
                      title={!canFreeze ? 'Connect a wallet holding the Pauser role first (see Escrow Controls above).' : 'Pauser-only: blocks new deposits/trades against this offer without moving any funds'}
                      style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '7px 11px', borderRadius: 10, border: `1px solid ${COLORS.border}`, background: 'none', color: COLORS.warning, fontSize: 11.5, fontWeight: 600, opacity: (freezingOfferIds.has(o.id) || !canFreeze) ? 0.5 : 1 }}
                    >
                      {isFrozen ? <Unlock size={12} /> : <Lock size={12} />} {freezingOfferIds.has(o.id) ? 'Updating…' : isFrozen ? 'Unfreeze Offer' : 'Freeze Offer'}
                    </button>
                  )}
                  <button
                    onClick={() => doCancelOffer(o)}
                    disabled={o.status !== 'active' || cancellingOfferIds.has(o.id)}
                    title={o.lockedByTradeId ? 'This offer has an active trade — cancel that trade first' : (remainingByOffer.get(o.id) ?? 0) > 0 ? 'This offer still holds escrow — only the seller\'s own wallet can withdraw it on P2PMeshportEscrowV2; Freeze Offer instead to block new trades' : undefined}
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
            <div style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 12, color: COLORS.muted, marginBottom: 12 }}>User: <AddressChip address={banTarget} size={12} mono={false} /></div>
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
                const isAdminMsg = m.isSystem && m.senderId === 'admin'
                const label = isAdminMsg ? 'Admin' : m.isSystem ? 'System' : isBuyer ? 'Buyer' : isSeller ? 'Seller' : 'Unknown'
                const imageUrl = m.content.match(/^\[IMAGE\]\((.+)\)$/)?.[1]
                return (
                  <div key={m.id} style={{ fontSize: 11.5 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 }}>
                      <span style={{
                        fontWeight: 700,
                        color: isAdminMsg ? COLORS.primary : m.isSystem ? COLORS.muted : isBuyer ? COLORS.success : 'var(--accent-text)',
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

            {/* Admin can talk directly to both parties at any point in the dispute — e.g. asking for proof of payment. Sent as a clearly-labeled Admin message (see the chat renderer above), not a plain system log line. */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
              <input value={adminChatInput} onChange={e => setAdminChatInput(e.target.value)} placeholder="Message both parties (e.g. ask for proof of payment)…"
                onKeyDown={e => { if (e.key === 'Enter') doSendAdminMessage() }}
                style={{ flex: 1, background: COLORS.surface, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '9px 11px', fontSize: 12.5, boxSizing: 'border-box' }} />
              <button onClick={doSendAdminMessage} disabled={!adminChatInput.trim() || sendingAdminMessage}
                style={{ padding: '9px 14px', borderRadius: 10, border: 'none', background: COLORS.primary, color: '#fff', fontSize: 12, fontWeight: 700, opacity: (!adminChatInput.trim() || sendingAdminMessage) ? 0.5 : 1 }}>
                {sendingAdminMessage ? '…' : 'Send'}
              </button>
            </div>

            {/* ── Real on-chain dispute resolution — Pauser forwards to Investigator, Investigator forwards to Admin, each a genuinely different connected wallet with a required reason ── */}
            <div style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 12, marginBottom: 12 }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
                On-chain resolution — {disputeOnChain?.state ?? (disputeTarget.adminFrozen ? 'Frozen' : 'Active')}
              </p>

              {!disputeOnChain?.state ? (
                <p style={{ fontSize: 12, color: COLORS.warning }}>Could not read this trade's on-chain state — make sure it's registered on-chain before continuing.</p>
              ) : (
                <>
                  {connectedWallet ? (
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: COLORS.muted, minWidth: 0 }}>
                          Connected: <AddressChip address={connectedWallet} size={11.5} />
                        </span>
                        <button onClick={doDisconnectWallet} style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, color: COLORS.muted, background: 'none', border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '4px 9px', cursor: 'pointer' }}>
                          Switch wallet
                        </button>
                      </div>
                      {(disputeOnChain.state === 'Active' || disputeOnChain.state === 'None') && !connectedWalletIsPauser && (
                        <p style={{ fontSize: 11, color: COLORS.warning, marginTop: 2 }}>This wallet doesn't hold the Pauser role — the transaction will revert. Tap "Switch wallet" and connect the Pauser's own wallet.</p>
                      )}
                      {disputeOnChain.state === 'Frozen' && !connectedWalletIsInvestigator && (
                        <p style={{ fontSize: 11, color: COLORS.warning, marginTop: 2 }}>This wallet doesn't hold the Investigator role — the transaction will revert. Tap "Switch wallet" and connect a DIFFERENT wallet holding the Investigator role.</p>
                      )}
                      {disputeOnChain.state === 'Frozen' && connectedWalletIsInvestigator && sameAsFreezer && (
                        <p style={{ fontSize: 11, color: COLORS.warning, marginTop: 2 }}>This is the SAME wallet that froze this trade — the contract requires a different Investigator. Tap "Switch wallet".</p>
                      )}
                      {disputeOnChain.state === 'Investigated' && !connectedWalletIsAdmin && (
                        <p style={{ fontSize: 11, color: COLORS.warning, marginTop: 2 }}>This wallet isn't the contract's Admin — the transaction will revert. Tap "Switch wallet" and connect the Admin wallet.</p>
                      )}
                      {disputeOnChain.state === 'Investigated' && connectedWalletIsAdmin && (sameAsFreezer || sameAsInvestigator) && (
                        <p style={{ fontSize: 11, color: COLORS.warning, marginTop: 2 }}>Admin must be different from whoever froze AND whoever investigated this trade — this wallet already acted on it. Tap "Switch wallet".</p>
                      )}
                    </div>
                  ) : (
                    <button onClick={doConnectWallet} disabled={connectingWallet} style={{ width: '100%', padding: '10px 0', borderRadius: 10, border: 'none', background: COLORS.text, color: COLORS.bg, fontSize: 12.5, fontWeight: 700, marginBottom: 8, opacity: connectingWallet ? 0.6 : 1 }}>
                      {connectingWallet ? 'Connecting…' : 'Connect Wallet to Act on This Dispute'}
                    </button>
                  )}

                  {(disputeOnChain.state === 'Active' || disputeOnChain.state === 'None') && (
                    <>
                      <p style={{ fontSize: 12, color: COLORS.muted, marginBottom: 8 }}>
                        Step 1: Pauser review. Freeze this trade and forward it to an Investigator — a reason is required so the Investigator knows why it was escalated.
                      </p>
                      <textarea value={freezeReason} onChange={e => setFreezeReason(e.target.value)} placeholder="Reason for freezing / forwarding to Investigator…" rows={2}
                        style={{ width: '100%', background: COLORS.surface, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 9, fontSize: 12.5, marginBottom: 8, boxSizing: 'border-box', fontFamily: 'inherit' }} />
                      <button onClick={doFreezeDispute} disabled={!canFreeze || !freezeReason.trim() || freezing}
                        style={{ width: '100%', padding: '10px 0', borderRadius: 10, border: 'none', background: COLORS.warning, color: '#fff', fontSize: 12.5, fontWeight: 700, opacity: (!canFreeze || !freezeReason.trim() || freezing) ? 0.6 : 1 }}>
                        {freezing ? 'Signing…' : 'Freeze & Forward to Investigator'}
                      </button>
                    </>
                  )}

                  {disputeOnChain.state === 'Frozen' && (
                    <>
                      <p style={{ fontSize: 12, color: COLORS.muted, marginBottom: 8 }}>
                        Step 2: Investigate. Connected wallet must hold the Investigator role and be
                        different from whoever froze this trade — the contract itself enforces this.
                        A reason is required so Admin knows why this was forwarded.
                      </p>
                      <textarea value={investigateReason} onChange={e => setInvestigateReason(e.target.value)} placeholder="Reason for this recommendation…" rows={2}
                        style={{ width: '100%', background: COLORS.surface, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 9, fontSize: 12.5, marginBottom: 8, boxSizing: 'border-box', fontFamily: 'inherit' }} />
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button onClick={() => doInvestigate(true)} disabled={!canInvestigate || !investigateReason.trim() || investigating}
                          style={{ flex: 1, padding: '10px 0', borderRadius: 10, border: 'none', background: COLORS.success, color: '#fff', fontSize: 12, fontWeight: 700, opacity: (!canInvestigate || !investigateReason.trim() || investigating) ? 0.6 : 1 }}>
                          {investigating ? 'Signing…' : 'Recommend Release'}
                        </button>
                        <button onClick={() => doInvestigate(false)} disabled={!canInvestigate || !investigateReason.trim() || investigating}
                          style={{ flex: 1, padding: '10px 0', borderRadius: 10, border: 'none', background: COLORS.error, color: '#fff', fontSize: 12, fontWeight: 700, opacity: (!canInvestigate || !investigateReason.trim() || investigating) ? 0.6 : 1 }}>
                          {investigating ? 'Signing…' : 'Recommend Refund'}
                        </button>
                      </div>
                    </>
                  )}

                  {disputeOnChain.state === 'Investigated' && (
                    <>
                      <p style={{ fontSize: 12, color: COLORS.muted, marginBottom: 8 }}>
                        Step 3: Execute. Investigator recommended{' '}
                        <strong style={{ color: disputeOnChain.investigatedApproveRelease ? COLORS.success : COLORS.error }}>
                          {disputeOnChain.investigatedApproveRelease ? 'release to buyer' : 'refund to seller'}
                        </strong>. Connected wallet must be Admin and different from both whoever froze and whoever investigated this trade.
                      </p>
                      <textarea value={resolveNote} onChange={e => setResolveNote(e.target.value)} placeholder="Closing note (optional)…" rows={2}
                        style={{ width: '100%', background: COLORS.surface, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 9, fontSize: 12.5, marginBottom: 8, boxSizing: 'border-box', fontFamily: 'inherit' }} />
                      <button onClick={doExecuteResolution} disabled={!canExecute || resolving}
                        style={{ width: '100%', padding: '11px 0', borderRadius: 10, border: 'none', background: COLORS.text, color: COLORS.bg, fontSize: 12.5, fontWeight: 700, opacity: (!canExecute || resolving) ? 0.6 : 1 }}>
                        {resolving ? 'Executing…' : `Execute: ${disputeOnChain.investigatedApproveRelease ? 'Release to Buyer' : 'Refund to Seller'}`}
                      </button>
                    </>
                  )}

                  {(disputeOnChain.state === 'Released' || disputeOnChain.state === 'Refunded') && (
                    <p style={{ fontSize: 12.5, fontWeight: 700, color: COLORS.success }}>
                      Already resolved on-chain: {disputeOnChain.state === 'Released' ? 'released to buyer' : 'refunded to seller'}.
                    </p>
                  )}

                  {disputeOnChain.state === 'Cancelled' && (
                    <p style={{ fontSize: 12.5, fontWeight: 700, color: COLORS.muted }}>
                      This trade was cancelled by its own seller (cancelTrade) before this dispute needed resolving — nothing left to freeze, investigate, or resolve.
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
