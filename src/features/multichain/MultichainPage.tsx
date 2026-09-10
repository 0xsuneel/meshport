import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore, useWalletStore, useUIStore } from '@/store'
import { formatAmount, timeAgo, copyToClipboard } from '@/lib/utils'
import { subscribeToWalletClaims, type Claim as ServerClaim } from '@/lib/claimService'
import { useSettingsStore } from '@/store/settingsStore'
import { explorerTxUrl, arcExplorerTxUrl } from '@/lib/chainExplorers'
import { readExternalBalances } from '@/blockchain/BlockchainManager'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'
import { Copy, Check } from 'lucide-react'
const CHAIN_LABELS: Record<string, string> = {
  Ethereum_Sepolia: 'Ethereum', Base_Sepolia: 'Base', Arbitrum_Sepolia: 'Arbitrum',
  Optimism_Sepolia: 'Optimism', Polygon_Sepolia: 'Polygon', Avalanche_Fuji: 'Avalanche',
  HyperEVM_Testnet: 'HyperEVM', Sei_Testnet: 'Sei', Sonic_Testnet: 'Sonic',
  Unichain_Sepolia: 'Unichain', World_Chain_Sepolia: 'World Chain',
  Linea_Sepolia: 'Linea', Ink_Testnet: 'Ink', Monad_Testnet: 'Monad',
  Morph_Testnet: 'Morph', Pharos_Testnet: 'Pharos', Plume_Testnet: 'Plume',
  XDC_Apothem: 'XDC', Codex_Testnet: 'Codex', Edge_Testnet: 'Edge',
  Injective_Testnet: 'Injective',
}

type TabType = 'all' | 'pending' | 'success' | 'failed'

interface ActivityItem {
  id: string
  type: 'claim' | 'transfer'
  // Marks a UB fund-recovery row specifically (see recoveryItems below) —
  // these are mapped onto the 'claim' type for icon/color/+amount reuse,
  // but are NOT a real row in the `claims` table and need their own title
  // ("this was a refund of a failed transfer", not "money arrived via a
  // claim") and their own tap behavior (no claim-tracking page to deep
  // link into).
  isRecovery?: boolean
  status: 'pending' | 'success' | 'failed'
  amount: number
  // For claims: `amount` shows the real arrived figure once known.
  // claimedAmount/arrivedAmount are kept separately so the detail card can
  // show both explicitly when a real fee made them differ.
  claimedAmount?: number
  arrivedAmount?: number
  chain: string
  chainLabel: string
  timestamp: number
  // For claims: sourceTxHash = burn on the external chain, destinationTxHash
  // = mint on Arc. For transfers: sourceTxHash = departure on Arc,
  // destinationTxHash = arrival on the external chain. Kept as two explicit
  // fields (previously a single ambiguous `txHash` silently dropped whichever
  // side wasn't picked) so both sides of the journey can be shown at once.
  sourceTxHash?: string
  destinationTxHash?: string
  // The wallet address the transfer was actually sent to, on the
  // destination chain. Only populated going forward — Activity.bridge()
  // never recorded this before, so older rows won't have it.
  destinationAddress?: string
  error?: string
}

export function MultichainPage() {
  const isDesktop   = useMediaQuery('(min-width: 980px)')
  const navigate    = useNavigate()
  const walletAddress = useAuthStore(s => s.walletAddress)
  const { balance: arcBalance } = useWalletStore()
  const { showToastMessage } = useUIStore()
  const [rowCopied, setRowCopied] = useState<string | null>(null)
  // Admin Panel → Chains toggles — a chain disabled by admin is excluded
  // from balance scanning entirely, so it never contributes to "Available
  // to claim" here. Live subscription: re-enabling a chain picks it back up
  // on the next scan without needing a reload.
  const settingsMap = useSettingsStore((s) => s.settings)
  const settingsLoaded = useSettingsStore((s) => s.loaded)
  const [chainBalances, setChainBalances] = useState<Array<{ id: string; label: string; balance: number }>>([])
  const [totalExternal, setTotalExternal] = useState(0)
  const [scanning, setScanning]           = useState(true)
  const [tab, setTab]                     = useState<TabType>('all')
  const [dbActivity, setDbActivity]       = useState<ActivityItem[]>([])
  const [loadingActivity, setLoadingActivity] = useState(true)
  const [selectedItem, setSelectedItem]   = useState<ActivityItem | null>(null)
  // Server-owned claims (Supabase `claims` table) — this is the ONLY source
  // of truth for claim state. Populated + kept live via Realtime.
  const [serverClaims, setServerClaims]   = useState<ServerClaim[]>([])

  // Subscribe to this wallet's claim rows — updates arrive even if the claim
  // was submitted from a different tab/device, and keep flowing regardless
  // of whether the claim page that started it is still mounted.
  useEffect(() => {
    if (!walletAddress) return
    const unsubscribe = subscribeToWalletClaims(walletAddress, setServerClaims)
    return unsubscribe
  }, [walletAddress])

  // Processing claims are only those in intermediate states
  // Supabase is the single source of truth - no age-based filtering
  const processingClaims = serverClaims.filter(c =>
    ['submitted', 'bridging', 'verifying', 'settling'].includes(c.status)
  )

  // No background bridge jobs - using Supabase claims as single source of truth

  // Scan external wallet balances.
  // Re-runs whenever the server-owned claim list changes (e.g. right after a
  // burn is submitted) — not just once on mount — so "Available to claim"
  // doesn't keep showing funds that are already mid-bridge. The live RPC
  // balance itself already reflects only what's actually left on each chain
  // (burning removes just the claimed amount), so no chain is ever zeroed
  // out wholesale here — that would incorrectly hide any remaining balance
  // on a chain that still has funds left after a partial claim.
  useEffect(() => {
    if (!walletAddress) { setScanning(false); return }
    let cancelled = false
    // Re-entrancy guard, mirroring HomePage's `inFlight` exactly. The 60s
    // interval and the visibilitychange handler below can fire within the same
    // tick; without this, both start their own promise chain and both call
    // setState. The RPC layer was already protected — cache.dedupe() shares one
    // in-flight request per `external:<wallet>:<settings>` key, so this never
    // caused duplicate network traffic — but the duplicated chains and
    // setChainBalances/setTotalExternal churn were real and pointless.
    let inFlight = false
    const scanBalances = () => {
      if (inFlight) return
      inFlight = true
      readExternalBalances(walletAddress, settingsMap, settingsLoaded).then(({ chains: results }) => {
        if (cancelled) return
        const withBalance = results.filter(r => r.balance > 0.001).map(r => ({
          id: r.chainId, label: CHAIN_LABELS[r.chainId] ?? r.chainId, balance: r.balance,
        }))
        setChainBalances(withBalance)
        setTotalExternal(withBalance.reduce((s, c) => s + c.balance, 0))
        setScanning(false)
      }).catch(() => { /* readExternalBalances resolves 0 per failed chain; nothing to surface */ })
        .finally(() => { inFlight = false })
    }
    scanBalances()
    // Previously this only ran on mount and when processingClaims/settingsMap
    // changed, with no periodic or visibility-based refresh — unlike Home's
    // scanExternalBalances, which rescans every 60s and whenever the tab
    // becomes visible again. That meant this total could sit stale
    // indefinitely (e.g. after funds arrived on a chain from outside this
    // session) while Home's independently-scanned total kept moving,
    // producing exactly the "$555 on Home vs $177 here" mismatch.
    const iv = setInterval(scanBalances, 60_000)
    const onVisible = () => { if (document.visibilityState === 'visible' && !cancelled) scanBalances() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { cancelled = true; clearInterval(iv); document.removeEventListener('visibilitychange', onVisible) }
  }, [walletAddress, processingClaims.map(c => `${c.id}:${c.status}`).join(','), settingsMap, settingsLoaded])

  // Load completed activity from DB — shared across all devices via Supabase
  useEffect(() => {
    if (!walletAddress) { setLoadingActivity(false); return }

    const loadActivity = () => import('@/lib/ActivityService').then(async ({ fetchActivity }) => {
      try {
        // Transfers-out still come from the `activity` table — multichain
        // sends don't have a server-tracked state machine of their own.
        const bridges = await fetchActivity(walletAddress, { activityType: 'bridge', limit: 30, includePendingBridge: true })

        // Claims: `serverClaims` (the `claims` table, kept live via
        // subscribeToWalletClaims) is the ONLY source of truth for claim
        // state — build Activity rows straight from it instead of from a
        // separately-written `activity` row. Previously backgroundBridge.ts
        // wrote its own `activity` row on burn AND submitClaim() wrote a
        // `claims` row for that same burn — so every claim rendered as two
        // near-identical cards (one here, one in the old "Processing
        // Claims" section). Sourcing from one table fixes that for good,
        // and since `claims` rows persist indefinitely, this also gives
        // full history (not just in-flight claims) with no extra fetch.
        const claimItems: ActivityItem[] = serverClaims.map(c => {
          const label = CHAIN_LABELS[c.sourceChain]
            ?? c.sourceChain.replace('_Sepolia', '').replace('_Testnet', '').replace('_Fuji', '').replace(/_/g, ' ').trim()
          // Show the real, verified arrived amount once known (parsed
          // directly from the on-chain Transfer log at completion) rather
          // than always showing the originally-claimed figure — a real
          // CCTP/relay fee (confirmed in practice: ~2.5%) means these can
          // genuinely differ, and showing "claimed" as if it were "arrived"
          // was misleading. Falls back to the claimed amount before
          // completion, or if completed via the CCTP-log path which doesn't
          // currently capture the real transfer amount.
          const displayAmount = c.arrivedAmount ?? c.amount
          return {
            id:         c.id,
            type:       'claim',
            status:     c.status === 'completed' ? 'success' : c.status === 'failed' ? 'failed' : 'pending',
            amount:     displayAmount,
            claimedAmount: c.amount,
            arrivedAmount: c.arrivedAmount ?? undefined,
            chain:      c.sourceChain,
            chainLabel: label || 'Chain',
            timestamp:  new Date(c.createdAt).getTime(),
            sourceTxHash:      c.txHash,
            destinationTxHash: c.destinationTxHash ?? undefined,
            error:      c.error ?? undefined,
          }
        })

        // fetchActivity('bridge') intentionally also returns 'claim' rows —
        // see ActivityService.ts's `activity_type=in.(bridge,claim)` — for
        // the global Activity page's "Multichain" tab, which groups both
        // together. But claim items here are already built directly from
        // `serverClaims` above, so including 'claim' rows from this fetch
        // too rendered every claim TWICE: once correctly ("Claim from X",
        // +amount) and once mislabeled by the transfer template ("Transfer
        // to Arc", -amount, since it assumes an outgoing send). Filter them
        // out — only genuine 'bridge' rows belong in this list.
        const bridgeItems: ActivityItem[] = bridges
          .filter((item: any) => item.activityType === 'bridge')
          .map((item: any) => ({
          id:         item.id ?? item.txHash ?? Math.random().toString(),
          type:       'transfer',
          status:     'success',
          amount:     item.amount ?? 0,
          chain:      item.metadata?.destinationChain || item.destinationChain || item.metadata?.toChain || item.toChain || item.metadata?.sourceChain || item.sourceChain || '',
          chainLabel: (() => {
            const raw = item.metadata?.destinationChain || item.destinationChain || item.metadata?.toChain || item.toChain || item.metadata?.chain || item.chain || item.metadata?.sourceChain || item.sourceChain || ''
            if (!raw) return 'Chain'
            if (CHAIN_LABELS[raw]) return CHAIN_LABELS[raw]
            return raw.replace('_Sepolia','').replace('_Testnet','').replace('_Fuji','').replace(/_/g,' ').replace(/\s+/g,' ').trim() || 'Chain'
          })(),
          timestamp:  new Date(item.createdAt).getTime(),
          sourceTxHash:      item.txHash,
          destinationTxHash: item.destinationTxHash ?? undefined,
          destinationAddress: item.counterpartyAddress ?? undefined,
        }))

        // UB fund-recovery rows (activity_type: 'withdraw', see
        // lib/ubFundRecovery.ts) — a byproduct of a failed multichain
        // transfer, so they belong here in the Multichain Hub view, not
        // dropped silently now that fetchActivity('bridge') also returns
        // them (see ActivityService.ts). Mapped onto the SAME shape as a
        // claim rather than a new 'transfer'/'recovery' type: both
        // represent money arriving INTO the Arc wallet from an external
        // process, so every existing branch below that keys off
        // type === 'claim' (the +amount sign, "money arriving" framing,
        // direction of source/destination tx labels) already does the
        // right thing here with zero further changes needed.
        const recoveryItems: ActivityItem[] = bridges
          .filter((item: any) => item.activityType === 'withdraw' && item.metadata?.ub_recovery)
          .map((item: any) => ({
            id:         item.id ?? item.txHash ?? Math.random().toString(),
            type:       'claim',
            isRecovery: true,
            status:     item.status === 'completed' ? 'success' : item.status === 'failed' ? 'failed' : 'pending',
            amount:     item.amount ?? 0,
            chain:      'Arc_Testnet',
            chainLabel: 'Unified Balance',
            timestamp:  new Date(item.createdAt).getTime(),
            sourceTxHash:      item.metadata?.init_tx_hash || undefined,
            destinationTxHash: item.metadata?.completed_tx_hash || undefined,
          }))

        setDbActivity([...claimItems, ...bridgeItems, ...recoveryItems].sort((a, b) => b.timestamp - a.timestamp))
      } catch { setDbActivity([]) }
      finally { setLoadingActivity(false) }
    })

    // Load immediately
    loadActivity()

    // Also refresh Arc balance from chain directly — works on any device
    const refreshBalance = async () => {
      try {
        const { getUSDCBalance } = await import('@/lib/arcService')
        const bal = await getUSDCBalance(walletAddress)
        useWalletStore.getState().setBalance?.(bal)
      } catch {}
    }
    refreshBalance()

    // Refresh every 30s — picks up claims from other devices automatically
    const interval = setInterval(() => {
      loadActivity()
      refreshBalance()
    }, 30_000)

    return () => clearInterval(interval)
  }, [walletAddress, serverClaims.map(c => `${c.id}:${c.status}`).join(',')])

  // Use dbActivity as the single source of truth for activity
  const allItems: ActivityItem[] = [...dbActivity].sort((a, b) => b.timestamp - a.timestamp)

  const filtered = tab === 'all'
    ? [...allItems].sort((a, b) => {
        // Pending always first
        if (a.status === 'pending' && b.status !== 'pending') return -1
        if (b.status === 'pending' && a.status !== 'pending') return 1
        return b.timestamp - a.timestamp
      })
    : allItems.filter(i => i.status === tab)
  const pendingCount = allItems.filter(i => i.status === 'pending').length

  const cardS = { background: 'var(--surface)', borderRadius: 16, border: '1px solid var(--border)' }

  return (
    <div className="lg:max-w-[900px]" style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)', paddingBottom: 90 }}>
      {/* Header */}
      <div style={{ position: 'sticky', top: 0, zIndex: 20, background: 'color-mix(in srgb, var(--bg) 95%, transparent)',
        backdropFilter: 'blur(20px)',
        paddingTop: 'calc(env(safe-area-inset-top, 0px) + 22px)', paddingBottom: 18,
        paddingLeft: 20, paddingRight: 20, minHeight: 44, boxSizing: 'border-box',
        display: 'flex', alignItems: 'center', gap: 12 }}>
        {!isDesktop && (
          <button onClick={() => navigate('/')} className="back-btn">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M15 6L9 12l6 6" stroke="var(--text-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        )}
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.2px', margin: 0 }}>Multichain Hub</h1>
        </div>
        <button onClick={() => {
          const { walletAddress } = useAuthStore.getState()
          if (walletAddress) {
            copyToClipboard(walletAddress).then(ok => {
              showToastMessage(ok ? 'Address copied — paste it on the faucet page' : 'Could not copy address', ok ? 'success' : 'error')
            })
          }
          window.open('https://faucet.circle.com/', '_blank', 'noopener,noreferrer')
        }}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            fontSize: 15.4, color: 'var(--brand)', fontWeight: 500,
          }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M12 3s6 6.5 6 10.5a6 6 0 01-12 0C6 9.5 12 3 12 3z" stroke="var(--brand)" strokeWidth="1.8" strokeLinejoin="round"/>
          </svg>
          Faucet
        </button>
      </div>

      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* Transfer card */}
        <div onClick={() => navigate('/multichain-transfer')} style={{
          background: 'var(--surface)', borderRadius: 16,
          border: '1px solid var(--border)',
          padding: '18px 20px', cursor: 'pointer',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 48, height: 48, borderRadius: 14, flexShrink: 0,
              background: 'color-mix(in srgb, var(--brand) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--brand) 20%, transparent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                <path d="M3 11h16M15 7l4 4-4 4" stroke="var(--brand)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Transfer Funds</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
                Available:&nbsp;
                <span style={{ fontSize: 13, color: 'var(--success)', fontWeight: 600 }}>${formatAmount(arcBalance)} USDC</span>
              </div>
            </div>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M6 3l6 6-6 6" stroke="var(--text-secondary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        </div>

        {/* Claim card */}
        <div onClick={() => navigate('/multichain-claim')} style={{
          background: 'var(--surface)', borderRadius: 16,
          border: '1px solid var(--border)',
          padding: '18px 20px', cursor: 'pointer',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 48, height: 48, borderRadius: 14, flexShrink: 0,
              background: 'color-mix(in srgb, var(--success) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--success) 20%, transparent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                <path d="M11 3v12M6 11l5 5 5-5M3 19h16" stroke="var(--success)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Claim Funds</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
                Available to claim:&nbsp;
                {scanning
                  ? <span style={{ color: 'var(--text-secondary)' }}>scanning...</span>
                  : totalExternal > 0
                    ? <span style={{ color: 'var(--success)', fontWeight: 600 }}>${formatAmount(totalExternal)} USDC</span>
                    : <span style={{ color: 'var(--text-secondary)' }}>$0.00</span>
                }
              </div>
            </div>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M6 3l6 6-6 6" stroke="var(--text-secondary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        </div>


        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontSize: 17, fontWeight: 600 }}>Activity</span>
          </div>

          {/* Tabs */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            {(['all', 'pending', 'success', 'failed'] as TabType[]).map(t => (
              <button key={t} onClick={() => setTab(t)} style={{
                padding: '6px 14px', borderRadius: 20,
                fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
                position: 'relative',
                background: tab === t
                  ? t === 'pending' ? 'color-mix(in srgb, var(--warning) 20%, transparent)'
                    : t === 'success' ? 'color-mix(in srgb, var(--success) 15%, transparent)'
                    : t === 'failed' ? 'color-mix(in srgb, var(--danger) 15%, transparent)'
                    : 'color-mix(in srgb, var(--brand) 20%, transparent)'
                  : 'color-mix(in srgb, var(--text-primary) 5%, transparent)',
                color: tab === t
                  ? t === 'pending' ? 'var(--warning)'
                    : t === 'success' ? 'var(--success)'
                    : t === 'failed' ? 'var(--danger)'
                    : 'var(--brand)'
                  : 'var(--text-secondary)',
              }}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
                {t === 'pending' && pendingCount > 0 && (
                  <span style={{
                    position: 'absolute', top: -4, right: -4,
                    background: 'var(--warning)', color: '#000',
                    borderRadius: '50%', width: 16, height: 16,
                    fontSize: 10, fontWeight: 700,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>{pendingCount}</span>
                )}
              </button>
            ))}
          </div>

          {/* Activity list */}
          <div style={{ ...cardS, overflow: 'hidden' }}>
            {loadingActivity && filtered.length === 0 ? (
              <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}>
                <div style={{ width: 20, height: 20, borderRadius: '50%', border: '2px solid var(--brand)', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite' }}/>
              </div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 14 }}>
                {tab === 'all' ? 'No multichain activity yet' : `No ${tab} transactions`}
              </div>
            ) : filtered.map((item, i) => {
              const isClaim    = item.type === 'claim'
              const isPending  = item.status === 'pending'
              const isSuccess  = item.status === 'success'
              const isFailed   = item.status === 'failed'
              const statusColor = isPending ? 'var(--warning)' : isSuccess ? 'var(--success)' : 'var(--danger)'
              const statusLabel = isPending ? 'Processing...' : isSuccess ? 'Completed' : 'Failed'

              return (
                <div key={item.id}
                  onClick={() => {
                    if (isPending && item.type === 'claim' && !item.isRecovery) {
                      // Deep-link straight into Track Progress for THIS claim —
                      // previously this always sent every pending tap to the
                      // generic Claim Funds landing page with no reference to
                      // which claim was tapped, so there was no way to reach
                      // this specific claim's live status from here.
                      //
                      // The claim id is passed BOTH as router state and as a
                      // `?claim=` query param. Router state alone doesn't
                      // reliably survive a hard refresh in every environment
                      // this app runs in — the query param does, since it's
                      // part of the URL itself, which is what lets a refresh
                      // on the tracking screen resume correctly instead of
                      // falling back to the scan/select ("assets") screen.
                      navigate(`/multichain-claim?claim=${encodeURIComponent(item.id)}`, { state: { trackClaimId: item.id } })
                    } else if (isPending && !item.isRecovery) {
                      navigate('/multichain-transfer')
                    } else {
                      setSelectedItem(item)
                    }
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px',
                    borderTop: i > 0 ? '1px solid color-mix(in srgb, var(--text-primary) 5%, transparent)' : 'none',
                    cursor: 'pointer',
                  }}>
                  {/* Icon — status-based, static (no animation). Processing
                      Claims is the only place with a live spinner; Activity
                      just reflects current state at a glance. */}
                  <div style={{ width: 38, height: 38, borderRadius: '50%', flexShrink: 0,
                    background: isFailed ? 'color-mix(in srgb, var(--danger) 10%, transparent)' : isPending ? 'color-mix(in srgb, var(--warning) 10%, transparent)' : isClaim ? 'color-mix(in srgb, var(--success) 10%, transparent)' : 'color-mix(in srgb, var(--brand) 10%, transparent)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      {isPending ? (
                        <>
                          <circle cx="8" cy="8" r="6.2" stroke="var(--warning)" strokeWidth="1.4"/>
                          <path d="M8 4.6V8l2.4 1.4" stroke="var(--warning)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                        </>
                      ) : isFailed ? (
                        <>
                          <circle cx="8" cy="8" r="6.2" stroke="var(--danger)" strokeWidth="1.4"/>
                          <path d="M6.2 6.2l3.6 3.6M9.8 6.2l-3.6 3.6" stroke="var(--danger)" strokeWidth="1.4" strokeLinecap="round"/>
                        </>
                      ) : isClaim ? (
                        <path d="M8 2v9M5 8l3 3 3-3M2 13h12" stroke="var(--success)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                      ) : (
                        <path d="M2 8h12M10 5l3 3-3 3" stroke="var(--brand)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                      )}
                    </svg>
                  </div>

                  {/* Details */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                      {item.isRecovery ? `Transfer Refund · ${item.chainLabel}` : isClaim ? `Claim from ${item.chainLabel || item.chain}` : `Transfer to ${item.chainLabel || item.chain}`}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                      <span style={{ fontSize: 11, color: statusColor, fontWeight: 600 }}>{statusLabel}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>· {timeAgo(new Date(item.timestamp).toISOString())}</span>
                    </div>
                    {isFailed && item.error && (
                      <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 2, opacity: 0.8 }}>
                        {item.error.slice(0, 60)}
                      </div>
                    )}
                  </div>

                  {/* Amount */}
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700,
                      color: isFailed ? 'var(--danger)' : isClaim ? 'var(--success)' : 'var(--danger)' }}>
                      {isFailed
                        ? `$${formatAmount(item.amount)}`
                        : isClaim
                          ? `+$${formatAmount(item.amount)}`
                          : `-$${formatAmount(item.amount)}`
                      }
                    </div>
                    {isPending && (
                      <div style={{ fontSize: 10, color: 'var(--warning)', marginTop: 2 }}>Tap to view →</div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}`}</style>

      {/* ── Detail Sheet / Dialog ── */}
      {selectedItem && (() => {
        const detailContent = (
          <>
            {/* Header */}
            <div style={{ padding: '0 20px 16px', borderBottom: '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 44, height: 44, borderRadius: '50%', flexShrink: 0,
                  background: selectedItem.type === 'claim' ? 'color-mix(in srgb, var(--success) 12%, transparent)' : 'color-mix(in srgb, var(--brand) 12%, transparent)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                    {selectedItem.type === 'claim'
                      ? <><path d="M9 2v10M5 9l4 4 4-4M2 15h14" stroke="var(--success)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></>
                      : <><path d="M2 9h14M11 5l4 4-4 4" stroke="var(--brand)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></>
                    }
                  </svg>
                </div>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
                    {selectedItem.isRecovery
                      ? `Transfer Refund · ${selectedItem.chainLabel}`
                      : selectedItem.type === 'claim'
                      ? `Claim from ${selectedItem.chainLabel || selectedItem.chain}`
                      : `Transfer to ${selectedItem.chainLabel || selectedItem.chain}`}
                  </div>
                  <div style={{ fontSize: 12, marginTop: 2,
                    color: selectedItem.status === 'success' ? 'var(--success)' : selectedItem.status === 'failed' ? 'var(--danger)' : 'var(--warning)',
                    fontWeight: 600 }}>
                    {selectedItem.status === 'success' ? 'Completed' : selectedItem.status === 'failed' ? 'Failed' : 'Processing...'}
                  </div>
                </div>
                <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                  <div style={{ fontSize: 20, fontWeight: 800,
                    color: selectedItem.status === 'failed' ? 'var(--danger)' : selectedItem.type === 'claim' ? 'var(--success)' : 'var(--danger)' }}>
                    {selectedItem.status === 'failed' ? '' : selectedItem.type === 'claim' ? '+' : '-'}
                    ${formatAmount(selectedItem.amount)}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>USDC</div>
                </div>
              </div>
            </div>

            {/* Details */}
            <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              {(() => {
                // EXPLORER_BASE/explorerTxUrl come from src/lib/chainExplorers.ts —
                // this used to be a local 11-chain map (missing Linea, Ink, Monad,
                // Pharos, Plume, XDC, Codex, Edge, Injective entirely, plus a wrong
                // Sei URL) that silently fell back to Arc's explorer for any of
                // those missing chains — showing a destination-chain hash on Arc's
                // explorer, a broken link. Now uses the same complete, verified map
                // as the Send/Claim/Activity pages.
                const externalExplorerUrl = (hash: string | undefined) =>
                  selectedItem.chain ? explorerTxUrl(selectedItem.chain, hash) : null

                // Claims: source hash lives on the external chain (the burn);
                // destination hash lives on Arc (the mint).
                // Transfers: source hash lives on Arc (the departure);
                // destination hash lives on the external chain (the arrival).
                // Previously only one of these was ever kept — the other was
                // silently discarded even though both existed in the data.
                // Recovered claims (see claim-recovery-scan) genuinely don't
                // know the real source-chain burn hash — only the Arc-side
                // mint was ever observed, so both hashes get set to that same
                // value as a required-field placeholder. Showing "Source Tx
                // (Burn)" from that would link to an Arc-hosted hash under
                // the source chain's own explorer — a transaction that
                // doesn't exist there at all.
                const isRecoveredClaim = selectedItem.type === 'claim'
                  && !!selectedItem.sourceTxHash && selectedItem.sourceTxHash === selectedItem.destinationTxHash

                const sourceLabel      = selectedItem.type === 'claim' ? 'Source Tx (Burn)' : 'Source Tx (Arc)'
                const destinationLabel = selectedItem.type === 'claim' ? 'Destination Tx (Arc Mint)' : 'Destination Tx (Arrival)'
                const sourceHref      = isRecoveredClaim ? null : selectedItem.type === 'claim' ? externalExplorerUrl(selectedItem.sourceTxHash) : arcExplorerTxUrl(selectedItem.sourceTxHash)
                const destinationHref = selectedItem.type === 'claim' ? arcExplorerTxUrl(selectedItem.destinationTxHash) : externalExplorerUrl(selectedItem.destinationTxHash)

                const feeWasDeducted = selectedItem.type === 'claim'
                  && selectedItem.claimedAmount != null && selectedItem.arrivedAmount != null
                  && Math.abs(selectedItem.claimedAmount - selectedItem.arrivedAmount) > 0.000001

                const rows = [
                  { label: 'Type',   value: selectedItem.isRecovery ? '↩ Refund to Arc' : selectedItem.type === 'claim' ? '↓ Claim to Arc' : '↑ Transfer out' },
                  { label: selectedItem.type === 'claim' ? 'From Chain' : 'To Chain',
                    value: selectedItem.chainLabel || selectedItem.chain || '—' },
                  ...(feeWasDeducted
                    ? [
                        { label: 'Claimed',  value: `$${formatAmount(selectedItem.claimedAmount!)} USDC` },
                        { label: 'Fee',       value: `-$${formatAmount(selectedItem.claimedAmount! - selectedItem.arrivedAmount!)} USDC` },
                        { label: 'Arrived',   value: `$${formatAmount(selectedItem.arrivedAmount!)} USDC` },
                      ]
                    : [{ label: 'Amount', value: `$${formatAmount(selectedItem.amount)} USDC` }]),
                  { label: 'Status', value: selectedItem.status === 'success' ? 'Completed ✓' : selectedItem.status === 'failed' ? 'Failed ✗' : 'Processing...' },
                  { label: 'Date',   value: new Date(selectedItem.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) },
                  { label: 'Time',   value: new Date(selectedItem.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) },
                  ...(selectedItem.sourceTxHash && !isRecoveredClaim ? [{ label: sourceLabel, value: selectedItem.sourceTxHash.slice(0,10) + '...' + selectedItem.sourceTxHash.slice(-8), copy: selectedItem.sourceTxHash }] : []),
                  ...(selectedItem.destinationTxHash ? [{ label: destinationLabel, value: selectedItem.destinationTxHash.slice(0,10) + '...' + selectedItem.destinationTxHash.slice(-8), copy: selectedItem.destinationTxHash }] : []),
                  // Only transfers have a "sent to" address — claims land in
                  // this account's own Arc wallet, which isn't worth a row.
                  // Only present on rows recorded after Activity.bridge()
                  // started saving it — older transfers won't have this.
                  ...(selectedItem.type === 'transfer' && selectedItem.destinationAddress
                    ? [{ label: 'Sent To', value: selectedItem.destinationAddress.slice(0,10) + '...' + selectedItem.destinationAddress.slice(-8), copy: selectedItem.destinationAddress }]
                    : []),
                ]

                return (
                  <>
                    {rows.map(row => (
                      <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{row.label}</span>
                        <span style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500, fontFamily: (row as any).copy ? 'monospace' : 'inherit',
                          cursor: (row as any).copy ? 'pointer' : 'default', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                          onClick={async () => {
                            const copyVal = (row as any).copy
                            if (!copyVal) return
                            const ok = await copyToClipboard(copyVal)
                            setRowCopied(row.label)
                            showToastMessage(ok ? `${row.label} copied` : `Could not copy ${row.label.toLowerCase()}`, ok ? 'success' : 'error')
                            setTimeout(() => setRowCopied(null), 1500)
                          }}>
                          {row.value}
                          {(row as any).copy && (rowCopied === row.label
                            ? <Check className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--success)' }} />
                            : <Copy className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--brand)' }} />)}
                        </span>
                      </div>
                    ))}

                    {selectedItem.error && selectedItem.status === 'failed' && (
                      <div style={{ padding: '10px 12px', borderRadius: 10, background: 'color-mix(in srgb, var(--danger) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--danger) 20%, transparent)' }}>
                        <p style={{ fontSize: 12, color: 'var(--danger)', margin: 0 }}>{selectedItem.error}</p>
                      </div>
                    )}

                    {/* Explorer links — one per hash, pointed at the chain that hash actually lives on */}
                    {sourceHref && (
                      <a href={sourceHref}
                        target="_blank" rel="noopener noreferrer"
                        style={{ display: 'block', textAlign: 'center', padding: '12px', borderRadius: 14, marginTop: 4,
                          background: 'color-mix(in srgb, var(--brand) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--brand) 20%, transparent)',
                          color: 'var(--brand)', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
                        View {sourceLabel} ↗
                      </a>
                    )}
                    {destinationHref && (
                      <a href={destinationHref}
                        target="_blank" rel="noopener noreferrer"
                        style={{ display: 'block', textAlign: 'center', padding: '12px', borderRadius: 14,
                          background: 'color-mix(in srgb, var(--success) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--success) 20%, transparent)',
                          color: 'var(--success)', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
                        View {destinationLabel} ↗
                      </a>
                    )}
                  </>
                )
              })()}
            </div>
          </>
        )

        return isDesktop ? (
          <DesktopDialogFrame onClose={() => setSelectedItem(null)} maxWidth={460}>
            <div style={{ paddingTop: 20 }}>{detailContent}</div>
          </DesktopDialogFrame>
        ) : (
          <div onClick={() => setSelectedItem(null)} style={{
            position: 'absolute', inset: 0, zIndex: 50,
            background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'flex-end',
          }}>
            <div onClick={e => e.stopPropagation()} style={{
              width: '100%', background: 'var(--surface)',
              borderRadius: '20px 20px 0 0',
              border: '1px solid var(--border)',
              padding: '8px 0 40px',
              animation: 'slideUp 0.25s ease',
            }}>
              {/* Handle */}
              <div style={{ width: 36, height: 4, borderRadius: 2, background: 'color-mix(in srgb, var(--text-primary) 20%, transparent)', margin: '8px auto 20px' }}/>
              {detailContent}
            </div>
          </div>
        )
      })()}
    </div>
  )
}