import { RecoveryPanel } from './MultichainRecoveryPage'
// Transfer and claim forms render inline under the Hub's tabs (no page change).
const TransferSheetBody = lazy(() => import('./MultichainTransferPage').then(m => ({ default: m.MultichainTransferPage })))
const ClaimSheetBody = lazy(() => import('./MultichainClaimPage').then(m => ({ default: m.MultichainClaimPage })))
function InlineSpinner() {
  return <div style={{ padding: 32, display: 'flex', justifyContent: 'center' }}><div style={{ width: 22, height: 22, borderRadius: '50%', border: '2px solid var(--brand)', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite' }}/></div>
}
import { UB_CLAIM_CHAINS } from '@/lib/ubClaim'
import { useMerchant } from '@/lib/merchant'
import { MerchantLedger } from '@/features/merchant/MerchantLedger'
import { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore, useWalletStore, useUIStore } from '@/store'
import { formatAmount, timeAgo, copyToClipboard } from '@/lib/utils'
import { subscribeToWalletClaims, type Claim as ServerClaim } from '@/lib/claimService'
import { useSettingsStore } from '@/store/settingsStore'
import { explorerTxUrl, arcExplorerTxUrl } from '@/lib/chainExplorers'
import { readExternalBalances, readExternalChainBalance } from '@/blockchain/BlockchainManager'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { motion } from 'framer-motion'
import { useSharedKeypadLift, KEYPAD_SPRING } from '@/hooks/useKeypadLift'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'
import { DesktopHistoryPanel } from '@/components/ui/DesktopHistoryPanel'
import { Copy, Check } from 'lucide-react'
import { UbProgressTracker, type UbTrackerProgress } from '@/components/multichain/UbProgressTracker'
import { TrackDetails, type TrackDetailRow } from '@/components/multichain/TrackDetails'
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
type HubTab = 'transfer' | 'bring' | 'activity' | 'recovery'

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
  // 7-day withdrawal: when the funds return to the wallet.
  readyAt?: string
  // UB claim still running: server intent id, and whether the funds are
  // parked in Unified Balance waiting for auto-finish / Recover.
  ubIntentId?: string
  ubHeld?: boolean
  // UB claim made by an approved merchant — a customer payment.
  merchant?: boolean
  // Merchant auto-convert: one Ledger → Arc transfer covering several chains.
  autoConvert?: boolean
  // Merchant: a payment received on another chain (Hub only — not in the
  // main Activity page until it reaches Arc as "Ledger payment received").
  chainReceipt?: 'received' | 'converting' | 'converted'
  autoConvertChains?: string[]
  // 'ub' | 'cctp' when finished through Recover → "Recovered via UB/CCTP".
  recoveredVia?: string
  // Claim route; 'ub' claims come from the activity table (no claims row).
  route?: 'ub' | 'cctp'
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

/** Merchants: payments received on other chains, as Hub Activity rows (Hub only). */
async function loadChainReceiptItems(): Promise<ActivityItem[]> {
  try {
    const { isMerchantNow, refreshMerchant } = await import('@/lib/merchant')
    // The merchant check may still be loading when the Hub first loads.
    if (!isMerchantNow()) await refreshMerchant().catch(() => {})
    if (!isMerchantNow()) return []
    const { listChainReceipts } = await import('@/lib/merchantPay')
    return (await listChainReceipts(50)).map(r => ({
      id: `rcpt_${r.id}`, type: 'claim' as const, merchant: true, chainReceipt: r.status,
      status: 'success' as const, amount: r.amount, chain: r.chain,
      chainLabel: CHAIN_LABELS[r.chain] ?? r.chain.replace(/_(Sepolia|Testnet|Fuji)$/, '').replace(/_/g, ' '),
      timestamp: new Date(r.createdAt).getTime(), sourceTxHash: r.txHash,
    }))
  } catch { return [] }
}

/** Status line for a merchant's payment on another chain (Hub only). */
function chainReceiptLabel(item: ActivityItem): string | null {
  if (!item.chainReceipt) return null
  const chain = item.chainLabel || item.chain
  return item.chainReceipt === 'converted' ? 'Moved to Arc' : item.chainReceipt === 'converting' ? 'Moving to Arc' : `In ${chain} Ledger`
}

// Row / detail title for Hub Activity.
function hubItemTitle(item: ActivityItem): string {
  const chain = item.chainLabel || item.chain
  if (item.chainReceipt) return `Payment received on ${chain}`
  if (item.autoConvert && item.type === 'claim') return item.status === 'pending' ? 'Ledger funds moving to Arc' : 'Ledger payment received'
  if (item.merchant && item.type === 'claim') return `Payment received · ${chain}`
  // 7-day Unified Balance withdrawal still running (or a refund row).
  if (item.isRecovery) {
    if (item.status === 'pending') {
      const when = item.readyAt ? new Date(item.readyAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null
      return when ? `7-day withdrawal · returns ${when}` : '7-day withdrawal in progress'
    }
    return item.status === 'failed' ? `Withdrawal · ${chain}` : `Recovered via UB · ${chain}`
  }
  // "Recovered via …" only once the recovery actually finished.
  if (item.recoveredVia && item.status === 'success') {
    const via = `Recovered via ${item.recoveredVia.toUpperCase()}`
    return item.type === 'claim' ? `${via} · ${chain}` : `Transfer to ${chain} · ${via}`
  }
  return item.type === 'claim' ? `Claim from ${chain}` : `Transfer to ${chain}`
}

// Track Progress for a UB claim opened from Hub Activity. Follows the
// server row (ub_claim_intents) live: waiting → Verifying, submitted →
// Settling, completed → Completed.
function HubUbTracker({ item }: { item: ActivityItem }) {
  const initial: UbTrackerProgress = item.ubHeld
    ? { stage: 'error', txHash: item.sourceTxHash || 'held' }
    : { stage: 'attesting', txHash: item.sourceTxHash }
  const [progress, setProgress] = useState<UbTrackerProgress>(initial)

  useEffect(() => {
    if (!item.ubIntentId) return
    let stop = false
    const load = async () => {
      try {
        const { supabase } = await import('@/lib/supabase')
        const { data } = await supabase.from('ub_claim_intents').select('status').eq('id', item.ubIntentId!).maybeSingle()
        const st = (data as any)?.status as string | undefined
        if (stop || !st) return
        setProgress(
          st === 'completed' ? { stage: 'done', txHash: item.sourceTxHash }
          : st === 'submitted' ? { stage: 'minting', txHash: item.sourceTxHash }
          : st === 'failed' || st === 'expired' ? { stage: 'error', txHash: item.sourceTxHash || 'held' }
          : { stage: 'attesting', txHash: item.sourceTxHash },
        )
      } catch { /* keep last state */ }
    }
    load()
    const iv = setInterval(load, 10_000)
    return () => { stop = true; clearInterval(iv) }
  }, [item.ubIntentId])

  return <UbProgressTracker progress={progress} chainLabel={item.chainLabel || item.chain} />
}

// Track Progress screen for a UB claim opened from Hub Activity — same
// layout and buttons as the CCTP Track Progress screen, with the claim's
// details tucked behind "View details".
function HubUbTrackView({ item, onBack, onViewInHub, onHome }: {
  item: ActivityItem; onBack: () => void; onViewInHub: () => void; onHome: () => void
}) {
  const chain = item.chainLabel || item.chain
  const claimed = item.claimedAmount
  const arriving = item.arrivedAmount ?? item.amount
  const fee = claimed != null && arriving != null ? claimed - arriving : null
  const when = new Date(item.timestamp)
  const src = item.sourceTxHash
  const rows: TrackDetailRow[] = [
    { label: 'Type', value: '↓ Claim to Arc' },
    { label: 'Route', value: 'Unified Balance' },
    { label: 'From Chain', value: chain },
    ...(claimed != null ? [{ label: 'Claimed', value: `$${formatAmount(claimed)} USDC` }] : []),
    ...(fee != null && fee > 0.000001 ? [{ label: 'Fee', value: `-$${formatAmount(fee)} USDC` }] : []),
    { label: 'Arriving', value: `$${formatAmount(arriving)} USDC` },
    { label: 'Date', value: when.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) },
    { label: 'Time', value: when.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) },
    ...(src ? [{ label: 'Source Tx', value: `${src.slice(0, 10)}…${src.slice(-8)}`, copy: src, href: explorerTxUrl(item.chain, src) }] : []),
  ]
  return (
    <div style={{ margin: '0 -12px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', padding: '16px' }}>
        <button onClick={onBack} aria-label="Back" style={{ position: 'absolute', left: 16, background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--text-primary)', display: 'flex', alignItems: 'center' }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        </button>
        <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>Track Progress</span>
      </div>
      <div style={{ padding: '16px 16px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, textAlign: 'center' }}>
          <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>${formatAmount(claimed ?? arriving)} USDC</span> · You may safely leave this page at any time.
        </p>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <img src={chainLogoSrc(item.chain)} alt="" width={28} height={28} style={{ borderRadius: '50%' }}
              onError={e => { (e.currentTarget as HTMLImageElement).src = '/logos/chains/_fallback.svg' }} />
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{chain}</span>
          </div>
          <HubUbTracker item={item} />
        </div>
        <TrackDetails rows={rows} />
      </div>
      <div style={{ display: 'flex', gap: 12, padding: '16px 24px 24px' }}>
        <button onClick={onViewInHub} style={{ flex: 1, padding: 16, borderRadius: 16, border: '1px solid var(--border)', background: 'transparent', fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', cursor: 'pointer' }}>
          View in Hub
        </button>
        <button onClick={onHome} style={{ flex: 1, padding: 16, borderRadius: 16, border: '1px solid color-mix(in srgb, black 12%, transparent)', fontSize: 13, fontWeight: 600, color: '#fff', background: 'var(--brand)', cursor: 'pointer' }}>
          Go Home
        </button>
      </div>
    </div>
  )
}

// Logo files under public/logos/chains/ for each scanned chain id.
const CHAIN_LOGO_FILE: Record<string, string> = {
  Ethereum_Sepolia: 'ethereum', Base_Sepolia: 'base', Arbitrum_Sepolia: 'arbitrum',
  Optimism_Sepolia: 'optimism', Polygon_Sepolia: 'polygon', Avalanche_Fuji: 'avalanche',
  HyperEVM_Testnet: 'hyperevm', Sei_Testnet: 'sei', Sonic_Testnet: 'sonic',
  Unichain_Sepolia: 'unichain', World_Chain_Sepolia: 'world', Linea_Sepolia: 'linea',
  Ink_Testnet: 'ink', Monad_Testnet: 'monad', Morph_Testnet: 'morph',
  Pharos_Testnet: 'pharos', Plume_Testnet: 'plume', XDC_Apothem: 'xdc',
  Codex_Testnet: 'codex', Edge_Testnet: 'edge', Injective_Testnet: 'injective',
}
const chainLogoSrc = (id: string) => `/logos/chains/${CHAIN_LOGO_FILE[id] ?? '_fallback'}.svg`

// ── Hero card — ticket style. Left: Available To Transfer (on Arc).
// Right: Available To Bring (USDC on other chains, with their logos).
function HubHeroCard({ arcAvailable, claimAvailable, scanning, balanceHidden, onToggleHidden, chains, bringLabel = 'Available To Bring' }: {
  arcAvailable: number; claimAvailable: number; scanning: boolean; balanceHidden: boolean; onToggleHidden: () => void; bringLabel?: string
  chains: Array<{ id: string; label: string; balance: number }>
}) {
  const amountSize = (n: number) => {
    const digits = Math.trunc(Math.abs(n)).toString().length
    return digits >= 8 ? 15 : digits >= 6 ? 18 : digits >= 5 ? 20 : 22
  }
  const withFunds = chains.filter(c => c.balance > 0.001)
  const shown = withFunds.slice(0, 4)
  const extra = withFunds.length - shown.length
  const line: React.CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }
  const label: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: 'rgba(255,255,255,0.72)', textTransform: 'uppercase', ...line }
  const amount = (n: number): React.CSSProperties => ({ fontSize: amountSize(n), fontWeight: 800, letterSpacing: '-0.4px', lineHeight: 1.15, color: '#fff', ...line })
  const sub: React.CSSProperties = { fontSize: 11, color: 'rgba(255,255,255,0.78)', ...line }
  const logo = (overlap: boolean): React.CSSProperties => ({
    width: 22, height: 22, borderRadius: '50%', background: '#fff', border: '2px solid var(--brand)',
    boxSizing: 'border-box', objectFit: 'cover', marginLeft: overlap ? -7 : 0, flexShrink: 0,
  })
  const bringText = balanceHidden ? '••••' : scanning && claimAvailable === 0 ? '…' : `$${formatAmount(claimAvailable)}`
  const bringSub = scanning && withFunds.length === 0 ? 'Checking chains…'
    : withFunds.length === 0 ? 'No funds on other chains'
    : `${withFunds.length} chain${withFunds.length === 1 ? '' : 's'}`

  return (
    <div style={{ position: 'relative', background: 'var(--brand)', borderRadius: 18, display: 'flex', color: '#fff', overflow: 'hidden' }}>
      {/* Left — Available To Transfer (Arc) */}
      <div style={{ flex: 1, minWidth: 0, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={label}>Available To Transfer</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 22 }}>
          <img src="/logos/chains/arc.svg" alt="Arc" style={logo(false)} />
          <button onClick={onToggleHidden} aria-label={balanceHidden ? 'Show balances' : 'Hide balances'}
            style={{ width: 22, height: 22, borderRadius: '50%', background: 'rgba(255,255,255,0.14)', border: 'none', padding: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
            {balanceHidden ? (
              <svg width="12" height="10" viewBox="0 0 22 18" fill="none">
                <path d="M2 2l18 14" stroke="#fff" strokeWidth="1.6" strokeLinecap="round"/>
                <path d="M6.5 5.5A9.7 9.7 0 011 9c2 3.5 5.5 6 10 6a9.5 9.5 0 005.5-1.8" stroke="#fff" strokeWidth="1.6" strokeLinecap="round"/>
                <path d="M9 3.5A10 10 0 0121 9a10.3 10.3 0 01-2.5 3.5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round"/>
                <circle cx="11" cy="9" r="3" stroke="#fff" strokeWidth="1.6"/>
              </svg>
            ) : (
              <svg width="12" height="9" viewBox="0 0 22 16" fill="none">
                <ellipse cx="11" cy="8" rx="10" ry="7" stroke="#fff" strokeWidth="1.6"/>
                <circle cx="11" cy="8" r="3" stroke="#fff" strokeWidth="1.6"/>
              </svg>
            )}
          </button>
        </div>
        <span style={amount(arcAvailable)}>{balanceHidden ? '••••' : `$${formatAmount(arcAvailable)}`}</span>
        <span style={sub}>On Arc</span>
      </div>

      {/* Perforation */}
      <div style={{ width: 0, margin: '14px 0', borderLeft: '2px dashed rgba(255,255,255,0.35)' }} />

      {/* Right — Available To Bring (other chains) */}
      <div style={{ flex: 1, minWidth: 0, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end', textAlign: 'right' }}>
        <span style={label}>{bringLabel}</span>
        <div style={{ display: 'flex', alignItems: 'center', height: 22 }}>
          {shown.map((c, i) => (
            <img key={c.id} src={chainLogoSrc(c.id)} alt={c.label} title={c.label}
              onError={e => { (e.currentTarget as HTMLImageElement).src = '/logos/chains/_fallback.svg' }}
              style={logo(i > 0)} />
          ))}
          {extra > 0 && (
            <span style={{ marginLeft: -7, height: 22, minWidth: 22, padding: '0 5px', boxSizing: 'border-box', borderRadius: 11,
              background: 'rgba(0,0,0,0.25)', border: '2px solid var(--brand)', fontSize: 10, fontWeight: 800,
              display: 'flex', alignItems: 'center', justifyContent: 'center' }}>+{extra}</span>
          )}
        </div>
        <span style={amount(claimAvailable)}>{bringText}</span>
        <span style={sub}>{bringSub}</span>
      </div>

      {/* Ticket notches */}
      <div style={{ position: 'absolute', left: '50%', top: -9, width: 18, height: 18, marginLeft: -9, borderRadius: '50%', background: 'var(--bg)' }} />
      <div style={{ position: 'absolute', left: '50%', bottom: -9, width: 18, height: 18, marginLeft: -9, borderRadius: '50%', background: 'var(--bg)' }} />
    </div>
  )
}

export function MultichainPage() {
  const isDesktop   = useMediaQuery('(min-width: 980px)')
  // Approved merchants get the Ledger (UB chains only) instead of Bring Funds.
  const isMerchant  = useMerchant().isMerchant
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
  const loadSettings = useSettingsStore((s) => s.load)
  // See the identical fix + comment in MultichainClaimPage.tsx — without
  // this, the Hub's own "Available to claim" figure on the Claim Funds card
  // could include disabled chains' balances indefinitely if this page is
  // the first one opened in a session.
  useEffect(() => { loadSettings() }, [loadSettings])
  const [chainBalances, setChainBalances] = useState<Array<{ id: string; label: string; balance: number }>>([])
  const [totalExternal, setTotalExternal] = useState(0)
  const [scanning, setScanning]           = useState(true)
  // Every scanned chain (incl. zero balance) for the Bring in list; balances first.
  const [allChainRows, setAllChainRows]   = useState<Array<{ id: string; label: string; balance: number }>>([])
  const [scanNonce, setScanNonce]         = useState(0)
  const [tab, setTab]                     = useState<TabType>('all')
  const location = useLocation()
  // Returning from the claim page (Back) reopens Bring in.
  // Tab comes from router state, or ?tab= (search results, old /multichain-* links).
  const initialQuery = new URLSearchParams(location.search)
  const [hubTab, setHubTab]               = useState<HubTab>(() => {
    const t = (location.state as any)?.tab ?? initialQuery.get('tab') ?? (initialQuery.get('claim') || initialQuery.get('chain') ? 'bring' : null)
    return t === 'bring' || t === 'activity' || t === 'recovery' ? t : 'transfer'
  })
  const [showRecovery, setShowRecovery]   = useState(false)
  // Tab requests arriving while already on the Hub (e.g. the inline transfer
  // form's "Open Recover") — location.state changes without a remount.
  useEffect(() => {
    const t = (location.state as any)?.tab
    if (t === 'transfer' || t === 'bring' || t === 'activity' || t === 'recovery') {
      setHubTab(t)
      if (t === 'recovery') setShowRecovery(true)
    }
  }, [location.key])
  // Inline forms under the tabs (Arc Bridge style — no page change, no pop-up).
  const [claimChain, setClaimChain] = useState<string | null>(() => initialQuery.get('chain'))
  // A claim being followed in Track Progress, shown inline under Bring Funds.
  // ?claim= in the URL (mirrored by the claim form) lets a refresh resume it.
  const [trackClaim, setTrackClaim] = useState<string | null>(() => initialQuery.get('claim') || (location.state as any)?.trackClaimId || null)
  const closeTracking = () => {
    setTrackClaim(null)
    // Strip ?claim= once the history entry below has settled.
    setTimeout(() => {
      const q = new URLSearchParams(window.location.search)
      if (q.has('claim')) { q.delete('claim'); navigate({ search: q.toString() ? `?${q}` : '' }, { replace: true, state: window.history.state?.usr }) }
    }, 60)
  }
  // Device/browser back while a claim form or Track Progress is open inline
  // closes it (back to the Bring Funds list) instead of leaving the Hub.
  // A Unified Balance claim followed from Hub Activity (no `claims` row, so
  // it gets its own Track Progress view — same layout as CCTP's).
  const [trackUb, setTrackUb] = useState<ActivityItem | null>(null)
  const bringSubOpen = hubTab === 'bring' && !!(claimChain || trackClaim || trackUb)
  useEffect(() => {
    if (!bringSubOpen) return
    let poppedByBack = false
    window.history.pushState({ ...(window.history.state ?? {}), mpHubSub: true }, '')
    const onPop = () => { poppedByBack = true; setClaimChain(null); setTrackUb(null); closeTracking() }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      // Closed with an on-screen button while still on the Hub: drop the
      // extra history entry so the next back press leaves the Hub normally.
      if (!poppedByBack && window.location.pathname === '/multichain') window.history.back()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bringSubOpen])
  // Same hide-balance setting as the Home screen's hero cards.
  const [balanceHidden, setBalanceHidden] = useState(() => {
    try { return localStorage.getItem('meshport_balance_hidden') === '1' } catch { return false }
  })
  const toggleBalanceHidden = () => setBalanceHidden(h => {
    const next = !h
    try { localStorage.setItem('meshport_balance_hidden', next ? '1' : '0') } catch {}
    return next
  })
  const [transferKey, setTransferKey] = useState(0)
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
  // RPC-USAGE FIX (2026-09-21): this used to ALSO re-run the full scan on
  // every 'visibilitychange' and every 60s — same issue already found and
  // fixed on HomePage.tsx (see that file's own comment for the full
  // writeup, including the real Alchemy 429 incident this pattern caused
  // previously). Removed the visibilitychange trigger entirely; replaced
  // blind polling with a Realtime subscription on claims/activity for this
  // wallet, so a refresh fires reactively exactly when a claim or transfer
  // actually completes — patching ONLY the one chain that changed
  // (readExternalChainBalance) via chainBalancesMapRef, not a full rescan.
  // The periodic interval is kept only as a backstop (60s -> 5min) for the
  // one case Realtime can't see: funds arriving on an external chain
  // completely outside MeshPort's own claim/transfer flow.
  const chainBalancesMapRef = useRef<Record<string, number>>({})
  useEffect(() => {
    if (!walletAddress) { setScanning(false); return }
    let cancelled = false
    // Re-entrancy guard, mirroring HomePage's `inFlight` exactly. The
    // interval and a reactive Realtime trigger can fire within the same
    // tick; without this, both start their own promise chain and both call
    // setState. The RPC layer was already protected — cache.dedupe() shares
    // one in-flight request per `external:<wallet>:<settings>` key, so this
    // never caused duplicate network traffic — but the duplicated chains
    // and setChainBalances/setTotalExternal churn were real and pointless.
    let inFlight = false
    const applyChainMap = (map: Record<string, number>) => {
      const withBalance = Object.entries(map)
        .filter(([, balance]) => balance > 0.001)
        .map(([id, balance]) => ({ id, label: CHAIN_LABELS[id] ?? id, balance }))
      setChainBalances(withBalance)
      setTotalExternal(withBalance.reduce((s, c) => s + c.balance, 0))
      setAllChainRows(Object.entries(map)
        .map(([id, balance]) => ({ id, label: id === 'Polygon_Sepolia' ? 'Polygon Amoy' : id.replace(/_/g, ' '), balance }))
        .sort((x, y) => (y.balance > 0.001 ? 1 : 0) - (x.balance > 0.001 ? 1 : 0) || y.balance - x.balance))
    }
    const fullScan = () => {
      if (inFlight) return
      inFlight = true
      readExternalBalances(walletAddress, settingsMap, settingsLoaded).then(({ chains: results }) => {
        if (cancelled) return
        const map: Record<string, number> = {}
        for (const r of results) map[r.chainId] = r.balance
        chainBalancesMapRef.current = map
        applyChainMap(map)
        setScanning(false)
      }).catch(() => { /* readExternalBalances resolves 0 per failed chain; nothing to surface */ })
        .finally(() => { inFlight = false })
    }
    // Targeted single-chain refresh — patches one entry in the known
    // per-chain map and re-derives chainBalances/totalExternal from it,
    // instead of re-scanning every chain.
    const refreshOneChain = (chainId: string) => {
      readExternalChainBalance(chainId as any, walletAddress).then(balance => {
        if (cancelled) return
        chainBalancesMapRef.current = { ...chainBalancesMapRef.current, [chainId]: balance }
        applyChainMap(chainBalancesMapRef.current)
      }).catch(() => {})
    }
    fullScan()
    const iv = setInterval(fullScan, 5 * 60_000)

    let channel: any
    import('@/lib/supabase').then(({ supabase }) => {
      if (cancelled) return
      channel = supabase
        .channel('multichain-hub-page-balance-' + walletAddress.slice(2, 10).toLowerCase())
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'claims', filter: `wallet_address=eq.${walletAddress.toLowerCase()}` },
          (payload: any) => {
            if (payload.new?.status === 'completed' && payload.old?.status !== 'completed' && payload.new?.source_chain) {
              refreshOneChain(payload.new.source_chain)
            }
          })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'activity', filter: `wallet_address=eq.${walletAddress.toLowerCase()}` },
          (payload: any) => {
            if (payload.new?.activity_type === 'bridge' && payload.new?.status === 'completed' && payload.old?.status !== 'completed' && payload.new?.destination_chain) {
              refreshOneChain(payload.new.destination_chain)
            }
          })
        .subscribe()
    })

    return () => { cancelled = true; clearInterval(iv); channel?.unsubscribe() }
  }, [walletAddress, processingClaims.map(c => `${c.id}:${c.status}`).join(','), settingsMap, settingsLoaded, scanNonce])

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
            route:      'cctp',
            recoveredVia: c.recoveredVia ?? undefined,
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
        // Unified Balance claims (direct or recovered) — written to `activity`
        // by lib/ubClaim.ts since UB has no `claims` row.
        const ubClaimItems: ActivityItem[] = bridges
          .filter((item: any) => item.activityType === 'claim' && item.metadata?.route === 'ub')
          .map((item: any) => ({
            id:         item.id ?? item.txHash,
            type:       'claim',
            route:      'ub',
            recoveredVia: item.metadata?.recovered_via || undefined,
            status:     item.status === 'failed' ? 'failed' : item.status === 'pending' ? 'pending' : 'success',
            amount:     item.amount ?? 0,
            claimedAmount: item.metadata?.claimed_amount != null ? Number(item.metadata.claimed_amount) : undefined,
            arrivedAmount: item.amount ?? undefined,
            chain:      item.sourceChain || '',
            chainLabel: CHAIN_LABELS[item.sourceChain] ?? String(item.sourceChain || 'Chain').replace(/_(Sepolia|Testnet|Fuji)$/,'').replace(/_/g, ' '),
            timestamp:  new Date(item.createdAt).getTime(),
            // Only a real source-chain deposit hash is shown as the source tx.
            sourceTxHash:      item.metadata?.hasRealSourceHash === false || item.metadata?.recovered_via ? undefined : item.txHash,
            destinationTxHash: item.destinationTxHash ?? undefined,
            ubIntentId: item.metadata?.ub_intent_id || undefined,
            ubHeld:     !!item.metadata?.ub_held,
            merchant:   !!item.metadata?.merchant,
            autoConvert: !!item.metadata?.auto_convert,
            autoConvertChains: Array.isArray(item.metadata?.chains) ? item.metadata.chains : undefined,
          }))

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
          recoveredVia: item.metadata?.recovered_via || undefined,
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
            recoveredVia: 'ub',
            readyAt:    item.metadata?.eligible_at || undefined,
            status:     item.status === 'completed' ? 'success' : item.status === 'failed' ? 'failed' : 'pending',
            amount:     item.amount ?? 0,
            chain:      'Arc_Testnet',
            chainLabel: 'Unified Balance',
            timestamp:  new Date(item.createdAt).getTime(),
            sourceTxHash:      item.metadata?.init_tx_hash || undefined,
            destinationTxHash: item.metadata?.completed_tx_hash || undefined,
          }))

        const receiptItems = await loadChainReceiptItems()
        setDbActivity([...claimItems, ...ubClaimItems, ...bridgeItems, ...recoveryItems, ...receiptItems].sort((a, b) => b.timestamp - a.timestamp))
      } catch {
        // Even if the rest fails, a merchant still sees payments on other chains.
        setDbActivity(await loadChainReceiptItems())
      }
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
  const failedCount  = allItems.filter(i => i.status === 'failed').length

  const cardS = { background: 'var(--surface)', borderRadius: 16, border: '1px solid var(--border)' }
  // Merchant Ledger: UB chains only (their payments show in the Hub's Activity).
  const bringRows = isMerchant
    ? allChainRows.filter(c => UB_CLAIM_CHAINS.has(c.id === 'Polygon_Sepolia' ? 'Polygon_Amoy_Testnet' : c.id))
    : allChainRows

  // Desktop has no Activity tab (the list is always on the right), so a
  // link that opens the Hub on Activity lands on Transfer Funds instead.
  useEffect(() => {
    if (isDesktop && hubTab === 'activity') setHubTab('transfer')
  }, [isDesktop, hubTab])

  // Hub Activity list (status chips + rows). Mobile: the Activity tab.
  // Desktop: always visible in the right column, like Swap/Pay history.
  const renderActivity = (inPanel: boolean) => (
        <div style={inPanel ? { padding: 12 } : undefined}>

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
          <div style={inPanel ? { overflow: 'hidden' } : { ...cardS, overflow: 'hidden' }}>
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
              const receiptLabel = chainReceiptLabel(item)
              const statusColor = receiptLabel ? (item.chainReceipt === 'converted' ? 'var(--success)' : 'var(--brand)')
                : isPending ? 'var(--warning)' : isSuccess ? 'var(--success)' : 'var(--danger)'
              const statusLabel = receiptLabel ?? (isPending ? 'Processing...' : isSuccess ? 'Completed' : 'Failed')

              return (
                <div key={item.id}
                  onClick={() => {
                    if (isPending && item.route === 'ub') {
                      // UB claims have no `claims` row — open their own
                      // Track Progress (same screen layout as CCTP's).
                      setClaimChain(null)
                      setTrackUb(item)
                      setHubTab('bring')
                      window.scrollTo?.({ top: 0, behavior: 'smooth' })
                    } else if (isPending && item.type === 'claim' && !item.isRecovery) {
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
                      // Opens Track Progress inline under Bring Funds (no page change).
                      setClaimChain(null)
                      setTrackClaim(item.id)
                      setHubTab('bring')
                      window.scrollTo?.({ top: 0, behavior: 'smooth' })
                    } else if (isPending && !item.isRecovery) {
                      setHubTab('transfer')
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
                      {hubItemTitle(item)}
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
  )

  const hubKeypadLift = useSharedKeypadLift()
  const page = (
    <div className={isDesktop ? undefined : 'lg:max-w-[900px]'} style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)', paddingBottom: isDesktop ? 90 : 'calc(env(safe-area-inset-bottom, 0px) + 24px)' }}>
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
          <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.2px', margin: 0 }}>{isMerchant ? 'Merchant Hub' : 'Multichain Hub'}</h1>
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

        {/* Hero — ticket card: Available To Transfer (left) | Available To Bring (right) */}
        {/* Merchants: only Unified Balance (Ledger) chains count — no CCTP-only chains. */}
        {/* Glides up together with the Transfer / Bring form when the amount
            keypad opens, so the whole screen moves as one (useKeypadLift). */}
        <motion.div animate={{ y: -hubKeypadLift }} initial={false} transition={KEYPAD_SPRING}
          style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <HubHeroCard arcAvailable={arcBalance} scanning={scanning}
          claimAvailable={isMerchant ? bringRows.reduce((sum, c) => sum + (c.balance > 0.001 ? c.balance : 0), 0) : totalExternal}
          bringLabel={isMerchant ? 'In Ledger Chains' : undefined}
          balanceHidden={balanceHidden} onToggleHidden={toggleBalanceHidden} chains={bringRows} />

        {/* Tab strip */}
        <div role="tablist" style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 16,
          background: 'var(--surface)', border: '1px solid var(--border)' }}>
          {([
            { id: 'transfer', label: 'Transfer Funds' },
            { id: 'bring',    label: isMerchant ? 'Ledger' : 'Bring Funds' },
            ...(isDesktop ? [] : [{ id: 'activity', label: 'Activity', dot: pendingCount > 0 ? 'var(--warning)' : null }]),
            { id: 'recovery', label: 'Recover',  dot: failedCount > 0 ? 'var(--danger)' : null },
          ] as Array<{ id: HubTab; label: string; dot?: string | null }>).map(t => {
            const active = hubTab === t.id
            return (
              <button key={t.id} role="tab" aria-selected={active} onClick={() => { setHubTab(t.id); setClaimChain(null); setTrackUb(null); if (trackClaim) closeTracking() }} style={{
                flex: 1, position: 'relative', padding: '10px 4px', borderRadius: 12, border: 'none', cursor: 'pointer',
                fontSize: 13, fontWeight: 600,
                background: active ? 'var(--brand)' : 'transparent',
                color: active ? '#fff' : 'var(--text-secondary)',
                transition: 'background 0.15s, color 0.15s',
              }}>
                {t.label}
                {t.dot && <span style={{ position: 'absolute', top: 7, right: 8, width: 7, height: 7, borderRadius: 4, background: t.dot }} />}
              </button>
            )
          })}
        </div>
        </motion.div>

        {hubTab === 'transfer' && (
          <div style={{ margin: '0 -12px' }}>
            <Suspense fallback={<InlineSpinner />}>
              <TransferSheetBody key={transferKey} embedded onClose={() => setTransferKey(k => k + 1)} />
            </Suspense>
          </div>
        )}

        {hubTab === 'bring' && trackUb && (
          <HubUbTrackView item={trackUb}
            onBack={() => { setTrackUb(null); setHubTab('activity') }}
            onViewInHub={() => { setTrackUb(null); setHubTab('activity') }}
            onHome={() => navigate('/')} />
        )}

        {hubTab === 'bring' && !trackUb && trackClaim && (
          <div style={{ margin: '0 -12px' }}>
            <Suspense fallback={<InlineSpinner />}>
              <ClaimSheetBody key={`track-${trackClaim}`} embedded trackClaimId={trackClaim} onClose={closeTracking} merchantMode={isMerchant} />
            </Suspense>
          </div>
        )}

        {hubTab === 'bring' && !trackUb && !trackClaim && claimChain && (
          <div style={{ margin: '0 -12px' }}>
            <Suspense fallback={<InlineSpinner />}>
              <ClaimSheetBody key={claimChain} embedded initialChain={claimChain} onClose={() => setClaimChain(null)} merchantMode={isMerchant} />
            </Suspense>
          </div>
        )}

        {hubTab === 'bring' && !trackUb && !trackClaim && !claimChain && (() => {
          const chainCard = (
          // Merchants: shown inside the Ledger's "Chains" tab (already a card).
          <div style={isMerchant ? undefined : { ...cardS, borderRadius: 20, padding: isDesktop ? 20 : 18 }}>
            {/* Title + Refresh */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 44, height: 44, borderRadius: 14, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'color-mix(in srgb, var(--brand) 16%, transparent)', border: '1px solid color-mix(in srgb, var(--brand) 30%, transparent)' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v12M6 11l6 6 6-6M5 20h14"/></svg>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.3px' }}>{isMerchant ? 'Collect from chains' : 'Bring Funds to Arc'}</div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>{isMerchant ? 'Payments on these chains are collected to Arc automatically' : 'Move USDC from any chain to Arc Testnet'}</div>
              </div>
              <button onClick={() => { setScanning(true); setScanNonce(n => n + 1) }} disabled={scanning}
                style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 12, cursor: scanning ? 'default' : 'pointer',
                  background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  style={{ animation: scanning ? 'spin 0.8s linear infinite' : undefined }}>
                  <path d="M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5"/>
                </svg>
                Refresh
              </button>
            </div>

            {/* Chain list — every chain, balance on the right; empty ones dimmed */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
              {scanning && bringRows.length === 0 ? (
                <div style={{ padding: 18, textAlign: 'center', fontSize: 13, color: 'var(--text-secondary)' }}>Checking chains…</div>
              ) : bringRows.length === 0 ? (
                <div style={{ padding: 18, textAlign: 'center', fontSize: 13, color: 'var(--text-secondary)' }}>
                  No chains to show. Get test USDC from the faucet.
                </div>
              ) : bringRows.map(c => {
                const has = c.balance > 0.001
                const ub = UB_CLAIM_CHAINS.has(c.id === 'Polygon_Sepolia' ? 'Polygon_Amoy_Testnet' : c.id)
                return (
                  <button key={c.id} disabled={!has}
                    onClick={() => setClaimChain(c.id)}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 16, textAlign: 'left',
                      cursor: has ? 'pointer' : 'default', opacity: has ? 1 : 0.55,
                      background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)',
                      border: has ? '1px solid color-mix(in srgb, var(--brand) 35%, transparent)' : '1px solid var(--border)' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.label}</div>
                      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                        {ub && (
                          <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6,
                            color: 'var(--brand)', background: 'color-mix(in srgb, var(--brand) 14%, transparent)' }}>UB</span>
                        )}
                        {!isMerchant && (
                          <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6,
                            color: 'var(--success)', background: 'color-mix(in srgb, var(--success) 14%, transparent)' }}>CCTP</span>
                        )}
                      </div>
                    </div>
                    <span style={{ fontSize: 16, fontWeight: 800, color: has ? 'var(--text-primary)' : 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                      {has ? formatAmount(c.balance) : '0'} USDC
                    </span>
                  </button>
                )
              })}
            </div>

          </div>
          )
          // Merchants: payment requests, customers and arriving payments on
          // top; the chain list (collect from chains) below it.
          return isMerchant
            ? <MerchantLedger boxStyle={{ ...cardS, borderRadius: 20, padding: isDesktop ? 20 : 18 }}
                // Same real on-chain balance as the "In Ledger Chains" card above.
                ledgerBalance={scanning ? undefined : bringRows.reduce((sum, c) => sum + (c.balance > 0.001 ? c.balance : 0), 0)}
                ledgerChains={bringRows.filter(c => c.balance > 0.001).length}>{chainCard}</MerchantLedger>
            : chainCard
        })()}

        {hubTab === 'recovery' && (
          <div style={{ ...cardS, borderRadius: 20, padding: 20 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>Recover stuck funds</div>
            <p style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--text-secondary)', margin: '6px 0 16px' }}>
              {showRecovery
                ? 'Anything that didn’t finish is listed below — choose how to finish each one.'
                : failedCount > 0
                ? `${failedCount} move${failedCount === 1 ? '' : 's'} didn't finish. Burned USDC can still be minted — check each one and finish it.`
                : "If a transfer or claim doesn't arrive, you can finish it here."}
            </p>
            {!showRecovery && (
              <button onClick={() => setShowRecovery(true)} style={{ width: '100%', padding: '14px 0', borderRadius: 14,
                cursor: 'pointer', fontSize: 15, fontWeight: 700,
                background: failedCount > 0 ? 'var(--brand)' : 'transparent',
                color: failedCount > 0 ? '#fff' : 'var(--brand)',
                border: failedCount > 0 ? 'none' : '1px solid var(--brand)' }}>
                Check stuck funds
              </button>
            )}
          </div>
        )}

        {/* Recovery results render right here, below the card — no page change */}
        {hubTab === 'recovery' && showRecovery && <RecoveryPanel />}

        {hubTab === 'activity' && !isDesktop && renderActivity(false)}
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
                    {hubItemTitle(selectedItem)}
                  </div>
                  <div style={{ fontSize: 12, marginTop: 2,
                    color: selectedItem.status === 'success' ? 'var(--success)' : selectedItem.status === 'failed' ? 'var(--danger)' : 'var(--warning)',
                    fontWeight: 600 }}>
                    {chainReceiptLabel(selectedItem) ?? (selectedItem.status === 'success' ? 'Completed' : selectedItem.status === 'failed' ? 'Failed' : 'Processing...')}
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
                  { label: 'Type',   value: selectedItem.isRecovery ? '↩ Refund to Arc' : selectedItem.merchant ? '↓ Payment received' : selectedItem.type === 'claim' ? '↓ Claim to Arc' : '↑ Transfer out' },
                  ...(selectedItem.merchant && walletAddress ? [{ label: 'Paid to', value: `${walletAddress.slice(0, 10)}...${walletAddress.slice(-8)}`, copy: walletAddress }] : []),
                  ...(selectedItem.type === 'claim' && selectedItem.route ? [{ label: 'Route', value: selectedItem.route === 'ub' ? 'Unified Balance' : 'CCTP' }] : []),
                  ...(selectedItem.recoveredVia ? [{ label: 'Recovered', value: `Via ${selectedItem.recoveredVia.toUpperCase()}` }] : []),
                  { label: selectedItem.type === 'claim' ? 'From Chain' : 'To Chain',
                    value: selectedItem.chainLabel || selectedItem.chain || '—' },
                  ...(feeWasDeducted
                    ? [
                        { label: 'Claimed',  value: `$${formatAmount(selectedItem.claimedAmount!)} USDC` },
                        { label: 'Fee',       value: `-$${formatAmount(selectedItem.claimedAmount! - selectedItem.arrivedAmount!)} USDC` },
                        { label: 'Arrived',   value: `$${formatAmount(selectedItem.arrivedAmount!)} USDC` },
                      ]
                    : [{ label: 'Amount', value: `$${formatAmount(selectedItem.amount)} USDC` }]),
                  { label: 'Status', value: chainReceiptLabel(selectedItem) ?? (selectedItem.status === 'success' ? 'Completed ✓' : selectedItem.status === 'failed' ? 'Failed ✗' : 'Processing...') },
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
            animation: 'mpFadeIn 0.22s cubic-bezier(0.32, 0.72, 0, 1)',
          }}>
            <div onClick={e => e.stopPropagation()} style={{
              width: '100%', background: 'var(--surface)',
              borderRadius: '20px 20px 0 0',
              border: '1px solid var(--border)',
              padding: '8px 0 40px',
              animation: 'mpSheetUp 0.42s cubic-bezier(0.32, 0.72, 0, 1)',
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

  if (!isDesktop) return page

  // ── Desktop: Hub (left) + Multichain Activity (right), each scrolling on
  // its own — same 65/35 layout as Swap and Pay.
  return (
    <div style={{ display: 'flex', flex: 1, height: '100%', minHeight: 0, gap: 28, padding: '20px 24px 14px', boxSizing: 'border-box', background: 'var(--bg)' }}>
      <div style={{ flex: '65 1 0%', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{page}</div>
      <div style={{ flex: '35 1 0%', minWidth: 0, minHeight: 0 }}>
        <DesktopHistoryPanel title={isMerchant ? 'Merchant Activity' : 'Multichain Activity'} onViewAll={() => navigate('/activity?filter=bridge')}>
          {renderActivity(true)}
        </DesktopHistoryPanel>
      </div>
    </div>
  )
}
