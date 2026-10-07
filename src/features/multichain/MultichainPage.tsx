import { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { CHAIN_LOGO_FILE, chainLogoSrc } from '@/lib/chainLogos'
import { RecoveryPanel } from './MultichainRecoveryPage'
// Transfer and claim forms render inline under the Hub's tabs (no page change).
const TransferSheetBody = lazy(() => import('./MultichainTransferPage').then(m => ({ default: m.MultichainTransferPage })))
const ClaimSheetBody = lazy(() => import('./MultichainClaimPage').then(m => ({ default: m.MultichainClaimPage })))
// Fetch both flows' code as soon as the Hub opens, so switching tabs or
// tapping a chain never shows a loading spinner in between.
const preloadHubFlows = () => { import('./MultichainTransferPage').catch(() => {}); import('./MultichainClaimPage').catch(() => {}) }
function InlineSpinner() {
  return <div style={{ padding: 32, display: 'flex', justifyContent: 'center' }}><div style={{ width: 22, height: 22, borderRadius: '50%', border: '2px solid var(--brand)', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite' }}/></div>
}
import { UB_CLAIM_CHAINS } from '@/lib/ubClaim'
import { isGaslessBridgeAvailable } from '@/lib/gaslessBridge'
import { useMerchant } from '@/lib/merchant'
import { MerchantLedger } from '@/features/merchant/MerchantLedger'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore, useWalletStore, useUIStore } from '@/store'
import { formatAmount, timeAgo, copyToClipboard } from '@/lib/utils'
import { subscribeToWalletClaims, type Claim as ServerClaim } from '@/lib/claimService'
import { useSettingsStore } from '@/store/settingsStore'
import { explorerTxUrl, arcExplorerTxUrl, ARC_CHAIN_KEY } from '@/lib/chainExplorers'
import { readExternalBalances, readExternalChainBalance, EXTERNAL_BALANCE_EVENT } from '@/blockchain/BlockchainManager'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { motion } from 'framer-motion'
import { useSharedKeypadLift, KEYPAD_SPRING } from '@/hooks/useKeypadLift'
import { ReceiptPopup } from '@/components/ui/ReceiptPopup'
import { ChainScanner } from '@/components/ui/ChainScanner'
import { ChainScanSpinner, useScanningChain } from '@/components/ui/ChainScanSpinner'
import { DesktopHistoryPanel } from '@/components/ui/DesktopHistoryPanel'
import { HubPage, HubPageBack } from '@/components/multichain/HubPage'
import { UbProgressTracker, type UbTrackerProgress } from '@/components/multichain/UbProgressTracker'
import { TrackDetails, type TrackDetailRow } from '@/components/multichain/TrackDetails'
import { useCctpProgress, fetchCctpProgress } from '@/lib/cctpTracker'
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
type FlowFocus = 'none' | 'processing' | 'result'

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
        // SUPABASE REDUCTION: replaced direct supabase.from('ub_claim_intents')
        // with the /api/bridge-relay?ub_intent_status= proxy so the client
        // never needs the Supabase anon key for this read.
        const r = await fetch(`/api/bridge-relay?ub_intent_status=${encodeURIComponent(item.ubIntentId!)}`, { credentials: 'include' })
        const json = r.ok ? await r.json().catch(() => null) : null
        const st = json?.status as string | undefined
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

// A CCTP move's burn: claims burn on the external chain, transfers on Arc.
const cctpBurnChain = (item: ActivityItem) => (item.type === 'claim' ? item.chain : ARC_CHAIN_KEY)
// Pending moves the CCTP tracker can follow (UB claims and merchant rows have their own).
const isTrackableCctp = (item: ActivityItem) =>
  item.status === 'pending' && item.route !== 'ub' && !item.isRecovery && !item.chainReceipt && !item.autoConvert
  && !!item.sourceTxHash && /^0x[0-9a-fA-F]{64}$/.test(item.sourceTxHash)

// Track Progress for a CCTP transfer or claim, read live from Circle (not
// from a server row): Burned → Attested → Minting → Completed.
function HubCctpTrackView({ item, onBack, onHome, onDone }: {
  item: ActivityItem; onBack: () => void; onHome: () => void
  onDone: (id: string, mintTxHash?: string) => void
}) {
  const isClaim = item.type === 'claim'
  const chain = item.chainLabel || item.chain
  const from = isClaim ? chain : 'Arc'
  const to = isClaim ? 'Arc' : chain
  const p = useCctpProgress(cctpBurnChain(item), item.sourceTxHash, item.destinationTxHash)
  const done = p?.stage === 'done'
  useEffect(() => { if (done) onDone(item.id, p?.mintTxHash) }, [done]) // eslint-disable-line react-hooks/exhaustive-deps
  const progress: UbTrackerProgress = !p ? { stage: 'burning' }
    : p.stage === 'error' ? { stage: 'error', msg: p.msg } : { stage: p.stage }
  // Before Circle answers the status is unknown — keep the steps neutral.
  const loading = !p
  const when = new Date(item.timestamp)
  const src = item.sourceTxHash
  const mint = p?.mintTxHash || item.destinationTxHash
  const srcHref = isClaim ? explorerTxUrl(item.chain, src) : arcExplorerTxUrl(src)
  const mintHref = mint ? (isClaim ? arcExplorerTxUrl(mint) : explorerTxUrl(item.chain, mint)) : null
  const rows: TrackDetailRow[] = [
    { label: 'Type', value: isClaim ? '↓ Claim to Arc' : '↑ Transfer from Arc' },
    { label: 'Route', value: 'CCTP' },
    { label: 'From', value: from },
    { label: 'To', value: to },
    { label: 'Amount', value: `$${formatAmount(item.amount)} USDC` },
    { label: 'Date', value: when.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) },
    { label: 'Time', value: when.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) },
    ...(src ? [{ label: 'Burn Tx', value: `${src.slice(0, 10)}…${src.slice(-8)}`, copy: src, href: srcHref }] : []),
    ...(mint ? [{ label: 'Mint Tx', value: `${mint.slice(0, 10)}…${mint.slice(-8)}`, copy: mint, href: mintHref }] : []),
  ]
  // Same four steps as every other Track Progress screen.
  const steps = [
    { label: 'Bridging',  subtitle: `Burn confirmed on ${from}` },
    { label: 'Verifying', subtitle: p?.delayReason ? `Circle is holding it (${p.delayReason.replace(/_/g, ' ')})` : 'Circle attested the transfer' },
    { label: 'Settling',  subtitle: `Funds landing on ${to}` },
    { label: 'Completed', subtitle: 'Balance updated' },
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
          <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>${formatAmount(item.amount)} USDC</span> · {from} → {to} · You may safely leave this page at any time.
        </p>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <img src={chainLogoSrc(item.chain)} alt="" width={28} height={28} style={{ borderRadius: '50%' }}
              onError={e => { (e.currentTarget as HTMLImageElement).src = '/logos/chains/_fallback.svg' }} />
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{chain}</span>
          </div>
          <UbProgressTracker progress={progress} chainLabel={chain} steps={steps} loading={loading} />
        </div>
        <TrackDetails rows={rows} />
      </div>
      <div style={{ display: 'flex', gap: 12, padding: '16px 24px 24px' }}>
        <button onClick={onBack} style={{ flex: 1, padding: 16, borderRadius: 16, border: '1px solid var(--border)', background: 'transparent', fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', cursor: 'pointer' }}>
          View in Hub
        </button>
        <button onClick={onHome} style={{ flex: 1, padding: 16, borderRadius: 16, border: '1px solid color-mix(in srgb, black 12%, transparent)', fontSize: 13, fontWeight: 600, color: '#fff', background: 'var(--brand)', cursor: 'pointer' }}>
          Go Home
        </button>
      </div>
    </div>
  )
}

// One logo per distinct chain for the scanning animation.
const SCAN_LOGOS = [...new Set(Object.values(CHAIN_LOGO_FILE))].map(f => ({ src: `/logos/chains/${f}.svg`, alt: f }))

// ── Hero card — ticket style. Left: Available To Transfer (on Arc).
// Right: Available To Bring (USDC on other chains, with their logos).
function HubHeroCard({ arcAvailable, claimAvailable, scanning, scanChain = null, balanceHidden, onToggleHidden, chains, bringLabel = 'Available To Bring' }: {
  arcAvailable: number; claimAvailable: number; scanning: boolean; scanChain?: string | null; balanceHidden: boolean; onToggleHidden: () => void; bringLabel?: string
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
  // Wraps onto a second line on narrow phones rather than being cut off
  // ("AVAILABLE TO T…" at 320–360px).
  const label: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', lineHeight: 1.3, color: 'rgba(255,255,255,0.72)', textTransform: 'uppercase', overflowWrap: 'normal', wordBreak: 'normal' }
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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, maxWidth: '100%' }}>
          {scanning && <ChainScanSpinner chain={scanChain} size={22} />}
          <span style={{ ...amount(claimAvailable), minWidth: 0 }}>{bringText}</span>
        </div>
        <span style={sub}>{bringSub}</span>
      </div>

      {/* Ticket notches */}
      <div style={{ position: 'absolute', left: '50%', top: -9, width: 18, height: 18, marginLeft: -9, borderRadius: '50%', background: 'var(--bg)' }} />
      <div style={{ position: 'absolute', left: '50%', bottom: -9, width: 18, height: 18, marginLeft: -9, borderRadius: '50%', background: 'var(--bg)' }} />
    </div>
  )
}

export function MultichainPage() {
  useEffect(() => { preloadHubFlows() }, [])
  const isDesktop   = useMediaQuery('(min-width: 980px)')
  // Phones narrower than ~400px (SE, small Androids): compact tab labels.
  const narrow      = useMediaQuery('(max-width: 399px)')
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
  // Logo of the chain being checked, shown in the spinner next to Available To Bring.
  const scanChain = useScanningChain(walletAddress, scanning)
  // Every scanned chain (incl. zero balance) for the Bring in list; balances first.
  const [allChainRows, setAllChainRows]   = useState<Array<{ id: string; label: string; balance: number }>>([])
  const [scanNonce, setScanNonce]         = useState(0)
  const [tab, setTab]                     = useState<TabType>('all')
  const location = useLocation()
  // Returning from the claim page (Back) reopens Bring in.
  // Tab comes from router state, or ?tab= (search results, old /multichain-* links).
  const initialQuery = new URLSearchParams(location.search)
  // Set by the inline Transfer / Bring flow: while it's processing (or
  // showing its result) the Hub's title bar stops being pinned so the flow can
  // fill the screen; while processing the page also can't be scrolled.
  const [flowFocus, setFlowFocus] = useState<FlowFocus>('none')
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
  // A pending CCTP transfer/claim opened from Activity, tracked live from Circle.
  const [trackCctp, setTrackCctp] = useState<ActivityItem | null>(null)
  // Moves the tracker has seen arrive, before the server row catches up.
  const [arrived, setArrived] = useState<Record<string, string | undefined>>({})
  const markArrived = (id: string, mintTxHash?: string) =>
    setArrived(prev => (id in prev ? prev : { ...prev, [id]: mintTxHash }))
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
    const applyOne = (chainId: string, balance: number) => {
      if (cancelled) return
      chainBalancesMapRef.current = { ...chainBalancesMapRef.current, [chainId]: balance }
      applyChainMap(chainBalancesMapRef.current)
    }
    const refreshOneChain = (chainId: string) => {
      readExternalChainBalance(chainId as any, walletAddress).then(b => applyOne(chainId, b)).catch(() => {})
    }
    // A bridge/deposit this app just sent moved funds on an external chain.
    const onExternal = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      if (d.chainId) applyOne(d.chainId, d.balance)
    }
    window.addEventListener(EXTERNAL_BALANCE_EVENT, onExternal)
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

    return () => { cancelled = true; clearInterval(iv); channel?.unsubscribe(); window.removeEventListener(EXTERNAL_BALANCE_EVENT, onExternal) }
  }, [walletAddress, processingClaims.map(c => `${c.id}:${c.status}`).join(','), settingsMap, settingsLoaded, scanNonce])

  // Load completed activity from DB — shared across all devices via Supabase
  useEffect(() => {
    if (!walletAddress) { setLoadingActivity(false); return }

    // Only the newest load may apply its result (the 30s refresh and a
    // claims change can overlap; an older response must not win).
    let seq = 0
    let disposed = false
    const loadActivity = () => import('@/lib/ActivityService').then(async ({ fetchActivity }) => {
      const mySeq = ++seq
      const current = () => !disposed && mySeq === seq
      try {
        // Transfers-out still come from the `activity` table — multichain
        // sends don't have a server-tracked state machine of their own.
        const bridges = await fetchActivity(walletAddress, { activityType: 'bridge', limit: 200, includePendingBridge: true })

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
          // Real row status — pending transfers stay trackable, failed ones show as failed.
          status:     item.status === 'failed' ? 'failed' : item.status === 'pending' ? 'pending' : 'success',
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
            chain:      ARC_CHAIN_KEY,
            chainLabel: 'Unified Balance',
            timestamp:  new Date(item.createdAt).getTime(),
            sourceTxHash:      item.metadata?.init_tx_hash || undefined,
            destinationTxHash: item.metadata?.completed_tx_hash || undefined,
          }))

        const receiptItems = await loadChainReceiptItems()
        if (!current()) return
        setDbActivity([...claimItems, ...ubClaimItems, ...bridgeItems, ...recoveryItems, ...receiptItems].sort((a, b) => b.timestamp - a.timestamp))
      } catch {
        // Even if the rest fails, a merchant still sees payments on other chains.
        const receipts = await loadChainReceiptItems()
        if (current()) setDbActivity(receipts)
      }
      finally { if (current()) setLoadingActivity(false) }
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

    return () => { disposed = true; clearInterval(interval) }
  }, [walletAddress, serverClaims.map(c => `${c.id}:${c.status}`).join(',')])

  // Use dbActivity as the single source of truth for activity
  // Arrival seen on-chain wins over a row that still says "pending".
  const allItems: ActivityItem[] = [...dbActivity]
    .map(i => (i.status === 'pending' && i.id in arrived
      ? { ...i, status: 'success' as const, destinationTxHash: i.destinationTxHash || arrived[i.id] }
      : i))
    .sort((a, b) => b.timestamp - a.timestamp)

  // Follow pending CCTP moves in the background while the Hub is open, so
  // the list flips to Completed on its own (no need to open each one).
  const trackableKey = dbActivity.filter(isTrackableCctp).map(i => i.id).join(',')
  useEffect(() => {
    const pending = dbActivity.filter(isTrackableCctp)
    if (!pending.length) return
    let stop = false
    const check = async () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      for (const it of pending) {
        if (stop) return
        const p = await fetchCctpProgress(cctpBurnChain(it), it.sourceTxHash!, it.destinationTxHash)
        if (!stop && p?.stage === 'done') markArrived(it.id, p.mintTxHash)
      }
    }
    void check()
    const iv = setInterval(check, 15_000)
    return () => { stop = true; clearInterval(iv) }
  }, [trackableKey]) // eslint-disable-line react-hooks/exhaustive-deps

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
  const isUbChain = (id: string) => UB_CLAIM_CHAINS.has(id === 'Polygon_Sepolia' ? 'Polygon_Amoy_Testnet' : id)
  // Only chains Bring Funds can actually move: the gasless router (CCTP) or
  // Unified Balance. Merchants: Unified Balance only.
  const bringRows = isMerchant
    ? allChainRows.filter(c => isUbChain(c.id))
    : allChainRows.filter(c => isGaslessBridgeAvailable(c.id) || isUbChain(c.id))

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
                    if (isTrackableCctp(item)) {
                      // Live Circle tracking for a pending CCTP transfer or claim
                      // (a pending transfer used to just open the empty Transfer form).
                      setClaimChain(null)
                      setTrackUb(null)
                      setTrackCctp(item)
                      setHubTab(item.type === 'claim' ? 'bring' : 'transfer')
                      window.scrollTo?.({ top: 0, behavior: 'smooth' })
                    } else if (isPending && item.route === 'ub') {
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
  const flowFocused = flowFocus !== 'none'
  // The Bring page keeps showing its chain while it slides away.
  const lastClaimChain = useRef(claimChain)
  if (claimChain) lastClaimChain.current = claimChain
  const sheetClaimChain = claimChain ?? lastClaimChain.current
  const page = (
    <div data-flow-scroller className={isDesktop ? undefined : 'lg:max-w-[900px]'} style={{ flex: 1, overflowY: flowFocus === 'processing' ? 'hidden' : 'auto', overscrollBehavior: flowFocus === 'processing' ? 'none' : undefined, background: 'var(--bg)', paddingBottom: isDesktop ? 90 : 'calc(env(safe-area-inset-bottom, 0px) + 24px)' }}>
      {/* Header */}
      <div data-scroll-header style={{ position: flowFocused ? 'relative' : 'sticky', top: 0, zIndex: 20, background: 'color-mix(in srgb, var(--bg) 95%, transparent)',
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
        <HubHeroCard arcAvailable={arcBalance} scanning={scanning} scanChain={scanChain}
          claimAvailable={isMerchant ? bringRows.reduce((sum, c) => sum + (c.balance > 0.001 ? c.balance : 0), 0) : totalExternal}
          bringLabel={isMerchant ? 'In Ledger Chains' : undefined}
          balanceHidden={balanceHidden} onToggleHidden={toggleBalanceHidden} chains={bringRows} />

        {/* Tab strip */}
        <div role="tablist" style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 16,
          background: 'var(--surface)', border: '1px solid var(--border)' }}>
          {([
            // Short labels on narrow phones so all four tabs stay on one line.
            { id: 'transfer', label: narrow ? 'Transfer' : 'Transfer Funds' },
            { id: 'bring',    label: isMerchant ? 'Ledger' : narrow ? 'Bring' : 'Bring Funds' },
            ...(isDesktop ? [] : [{ id: 'activity', label: 'Activity', dot: pendingCount > 0 ? 'var(--warning)' : null }]),
            { id: 'recovery', label: 'Recover',  dot: failedCount > 0 ? 'var(--danger)' : null },
          ] as Array<{ id: HubTab; label: string; dot?: string | null }>).map(t => {
            const active = hubTab === t.id
            return (
              <button key={t.id} role="tab" aria-selected={active} onClick={() => { setHubTab(t.id); setClaimChain(null); setTrackUb(null); setTrackCctp(null); if (trackClaim) closeTracking() }} style={{
                flex: 1, minWidth: 0, position: 'relative', padding: '10px 4px', borderRadius: 12, border: 'none', cursor: 'pointer',
                fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
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

        {trackCctp && (hubTab === 'transfer' || hubTab === 'bring') && (
          <HubCctpTrackView item={trackCctp}
            onBack={() => { setTrackCctp(null); setHubTab(isDesktop ? 'transfer' : 'activity') }}
            onHome={() => navigate('/')}
            onDone={markArrived} />
        )}

        {hubTab === 'transfer' && !trackCctp && (
          <div style={{ margin: '0 -12px', minHeight: flowFocused ? '100dvh' : undefined }}>
            <Suspense fallback={<InlineSpinner />}>
              <TransferSheetBody key={transferKey} embedded onClose={() => setTransferKey(k => k + 1)} onFocusChange={setFlowFocus} />
            </Suspense>
          </div>
        )}

        {hubTab === 'bring' && !trackCctp && trackUb && (
          <HubUbTrackView item={trackUb}
            onBack={() => { setTrackUb(null); setHubTab('activity') }}
            onViewInHub={() => { setTrackUb(null); setHubTab('activity') }}
            onHome={() => navigate('/')} />
        )}

        {hubTab === 'bring' && !trackCctp && !trackUb && trackClaim && (
          <div style={{ margin: '0 -12px', minHeight: flowFocused ? '100dvh' : undefined }}>
            <Suspense fallback={<InlineSpinner />}>
              <ClaimSheetBody key={`track-${trackClaim}`} embedded trackClaimId={trackClaim} onClose={closeTracking} merchantMode={isMerchant} onFocusChange={setFlowFocus} />
            </Suspense>
          </div>
        )}

        {hubTab === 'bring' && !trackCctp && !trackUb && !trackClaim && claimChain && isDesktop && (
          <div style={{ margin: '0 -12px', minHeight: flowFocused ? '100dvh' : undefined }}>
            <Suspense fallback={<InlineSpinner />}>
              <ClaimSheetBody key={claimChain} embedded initialChain={claimChain}
                initialBalance={bringRows.find(c => c.id === claimChain)?.balance}
                onClose={() => setClaimChain(null)} merchantMode={isMerchant} onFocusChange={setFlowFocus} />
            </Suspense>
          </div>
        )}

        {/* Phone: the chosen chain's Bring flow opens as a full page that
            slides in from the right over the chain list — form, processing,
            Track Progress and success all happen inside it. */}
        {!isDesktop && (
          <HubPage open={hubTab === 'bring' && !trackCctp && !trackUb && !trackClaim && !!claimChain}
            header={!flowFocused && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px 4px' }}>
                <HubPageBack onClick={() => setClaimChain(null)} />
                <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>{isMerchant ? 'Ledger' : 'Bring Funds'}</span>
              </div>
            )}>
            {sheetClaimChain && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '0 8px' }}>
                <Suspense fallback={<InlineSpinner />}>
                  <ClaimSheetBody key={sheetClaimChain} embedded pushScreens initialChain={sheetClaimChain}
                    initialBalance={bringRows.find(c => c.id === sheetClaimChain)?.balance}
                    onClose={() => setClaimChain(null)} merchantMode={isMerchant} onFocusChange={setFlowFocus} />
                </Suspense>
              </div>
            )}
          </HubPage>
        )}

        {hubTab === 'bring' && !trackCctp && !trackUb && !trackClaim && (!claimChain || !isDesktop) && (() => {
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
              <button onClick={() => { setScanning(true); setScanNonce(n => n + 1) }} disabled={scanning} aria-label="Refresh"
                style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderRadius: 12, cursor: scanning ? 'default' : 'pointer',
                  background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  style={{ animation: scanning ? 'spin 0.8s linear infinite' : undefined }}>
                  <path d="M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5"/>
                </svg>
                <span className="hidden min-[375px]:inline">Refresh</span>
              </button>
            </div>

            {/* Chain list — every chain, balance on the right; empty ones dimmed */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
              {/* Visible scan: the full scanner while nothing is listed yet,
                  a slim strip above the list while it refreshes. */}
              {scanning && bringRows.length > 0 && (
                <ChainScanner compact logos={SCAN_LOGOS} title="Refreshing…" subtitle="Checking every chain" />
              )}
              {scanning && bringRows.length === 0 ? (
                <ChainScanner logos={SCAN_LOGOS} subtitle={isMerchant ? 'Looking for payments on your ledger chains' : 'Finding USDC you can bring to Arc'} />
              ) : bringRows.length === 0 ? (
                <div style={{ padding: 18, textAlign: 'center', fontSize: 13, color: 'var(--text-secondary)' }}>
                  No chains to show. Get test USDC from the faucet.
                </div>
              ) : bringRows.map(c => {
                const has = c.balance > 0.001
                const ub = isUbChain(c.id)
                const cctp = !isMerchant && isGaslessBridgeAvailable(c.id)
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
                        {cctp && (
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
        // Tapping a Hub history card reopens the same receipt a live
        // transfer/claim ends on (see ReceiptPopup). Incoming claims and
        // merchant payments get the receiver version.
        const it = selectedItem
        const isClaimItem = it.type === 'claim'
        const externalExplorerUrl = (hash: string | undefined) => it.chain ? explorerTxUrl(it.chain, hash) : null
        // Recovered claims only know the Arc-side mint: both hashes hold that
        // same value, so there is no real source-chain burn to link.
        const isRecoveredClaim = isClaimItem && !!it.sourceTxHash && it.sourceTxHash === it.destinationTxHash
        const sourceHref      = isRecoveredClaim ? null : isClaimItem ? externalExplorerUrl(it.sourceTxHash) : arcExplorerTxUrl(it.sourceTxHash)
        const destinationHref = isClaimItem ? arcExplorerTxUrl(it.destinationTxHash) : externalExplorerUrl(it.destinationTxHash)
        const chainName = it.chainLabel || it.chain || '—'
        const feeWasDeducted = isClaimItem && it.claimedAmount != null && it.arrivedAmount != null
          && Math.abs(it.claimedAmount - it.arrivedAmount) > 0.000001
        const status = it.status === 'success' ? 'success' : it.status === 'failed' ? 'failed' : 'pending'
        const doneTitle = it.isRecovery ? 'Refunded to Arc' : it.merchant ? 'Payment Received' : isClaimItem ? 'Funds Arrived' : 'Transfer Complete'
        const title = status === 'success' ? doneTitle : status === 'failed' ? (isClaimItem ? 'Claim Failed' : 'Transfer Failed') : 'Processing…'
        const copyRow = (label: string, value: string) => async () => {
          const ok = await copyToClipboard(value)
          setRowCopied(label)
          showToastMessage(ok ? `${label} copied` : `Could not copy ${label.toLowerCase()}`, ok ? 'success' : 'error')
          setTimeout(() => setRowCopied(null), 1500)
        }
        const hashRow = (label: string, hash: string) => ({ label, value: `${hash.slice(0, 6)}…${hash.slice(-4)}`, onCopy: copyRow(label, hash), copied: rowCopied === label })
        const primaryHash = isClaimItem ? (it.destinationTxHash || it.sourceTxHash) : (it.sourceTxHash || it.destinationTxHash)
        const amountText = `${status === 'failed' ? '' : isClaimItem ? '+' : '-'}$${formatAmount(it.amount)} USDC`

        return (
          <ReceiptPopup
            onClose={() => setSelectedItem(null)}
            status={status}
            title={title}
            subtitle={<>
              <span style={{ display: 'block', fontSize: 20, fontWeight: 800, color: status === 'failed' ? 'var(--danger)' : isClaimItem ? 'var(--success)' : 'var(--text-primary)', marginBottom: 4 }}>{amountText}</span>
              {hubItemTitle(it)}
            </>}
            rows={[
              ...(feeWasDeducted
                ? [
                    { label: 'Claimed', value: `$${formatAmount(it.claimedAmount!)} USDC` },
                    { label: 'Arrived', value: `$${formatAmount(it.arrivedAmount!)} USDC`, positive: true },
                  ]
                : [{ label: isClaimItem ? 'Received' : 'Sent', value: `$${formatAmount(it.amount)} USDC`, positive: isClaimItem }]),
              { label: isClaimItem ? 'From' : 'To', value: chainName },
              ...(it.merchant && walletAddress ? [{ label: 'Paid to', value: `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`, onCopy: copyRow('Paid to', walletAddress), copied: rowCopied === 'Paid to' }] : []),
              ...(primaryHash && !isRecoveredClaim ? [hashRow('Transaction Hash', primaryHash)] : []),
              { label: 'Time', value: new Date(it.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) },
            ]}
            detailRows={[
              { label: 'Status', value: chainReceiptLabel(it) ?? (status === 'success' ? 'Confirmed' : status === 'failed' ? 'Failed' : 'Processing'), positive: status === 'success' },
              { label: 'Type', value: it.isRecovery ? 'Refund to Arc' : it.merchant ? 'Payment received' : isClaimItem ? 'Claim to Arc' : 'Transfer out' },
              ...(isClaimItem && it.route ? [{ label: 'Route', value: it.route === 'ub' ? 'Unified Balance' : 'CCTP' }] : []),
              ...(it.recoveredVia ? [{ label: 'Recovered', value: `Via ${it.recoveredVia.toUpperCase()}` }] : []),
              ...(feeWasDeducted ? [{ label: 'Fee', value: `-$${formatAmount(it.claimedAmount! - it.arrivedAmount!)} USDC` }] : []),
              ...(it.sourceTxHash && !isRecoveredClaim ? [hashRow(isClaimItem ? 'Source Tx (Burn)' : 'Source Tx (Arc)', it.sourceTxHash)] : []),
              ...(it.destinationTxHash ? [hashRow(isClaimItem ? 'Destination Tx (Arc Mint)' : 'Destination Tx (Arrival)', it.destinationTxHash)] : []),
              ...(it.type === 'transfer' && it.destinationAddress ? [hashRow('Sent To', it.destinationAddress)] : []),
            ]}
            links={[
              ...(sourceHref && it.sourceTxHash ? [{ title: isClaimItem ? `View Burn on ${chainName}` : 'View Burn on Arc', explorer: isClaimItem ? chainName : 'ArcScan', hash: it.sourceTxHash, href: sourceHref }] : []),
              ...(destinationHref && it.destinationTxHash ? [{ title: isClaimItem ? 'View Mint on Arc' : `View Mint on ${chainName}`, explorer: isClaimItem ? 'ArcScan' : chainName, hash: it.destinationTxHash, href: destinationHref }] : []),
            ]}
            linksNote={it.error && status === 'failed' ? it.error : undefined}
          />
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
