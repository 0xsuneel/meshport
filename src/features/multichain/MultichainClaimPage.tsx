/**
 * MultichainClaimPage — Single-action claim flow
 *
 * User flow (ONE action):
 *   1. Page loads → shows Arc balance + claimable funds per chain
 *   2. User selects chain(s) → Claim button updates total dynamically
 *   3. User enters 6-digit passcode (if set)
 *   4. Tap Claim → bridge + Arc credit happen automatically
 *   5. Done — Arc balance updated, activity recorded
 *
 * No deposit step. No wallet balance tab. No second confirmation.
 * 
 * MeshPort V2: Inspired by PayPal/Revolut/Cash App
 * "Sending money to friends" not "Managing blockchain infrastructure"
 */
import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, type CSSProperties } from 'react'
import { SHEET_SPRING, SHEET_BACKDROP, SHEET_EXIT } from '@/lib/motion'
import { createPortal } from 'react-dom'
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom'
import { fetchActivity, type ActivityRecord } from '@/lib/ActivityService'
import { notifyClaimArrived, requestPushPermission } from '@/lib/bridgeTracker'
import {
  ArrowLeft, RefreshCw, XCircle, Globe,
  Activity as ActivityIcon,
} from 'lucide-react'
import { PinKeypad } from '@/components/ui/PinKeypad'
import { AmountKeypad } from '@/components/ui/AmountKeypad'
import { useKeypadLift, KEYPAD_SPRING } from '@/hooks/useKeypadLift'
import { TravelingCheckmark } from '@/components/ui/TravelingCheckmark'
import { SuccessFlash } from '@/components/ui/SuccessFlash'
import { SuccessReceipt } from '@/components/ui/SuccessReceipt'
import { ChainScanner } from '@/components/ui/ChainScanner'
import { FlashAuthIcon } from '@/components/ui/FlashAuthIcon'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { UbProgressTracker } from '@/components/multichain/UbProgressTracker'
import { TrackDetails, type TrackDetailRow } from '@/components/multichain/TrackDetails'
import { slideStepVariants, MOBILE_SLIDE_TRANSITION, MOBILE_SLIDE_X, MOBILE_TAB_FADE_Y, MOBILE_TAB_FADE_TRANSITION, type NavDirection } from '@/lib/motion'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'
import { DesktopTransactionAuthDialog } from '@/components/ui/DesktopTransactionAuthDialog'
import { DesktopAmountInput } from '@/components/ui/DesktopAmountInput'
import { DesktopHistoryPanel, DesktopHistoryEmpty, DesktopHistorySkeleton, DesktopHistoryDetail } from '@/components/ui/DesktopHistoryPanel'
import { useAuthStore, useWalletStore, useUIStore } from '@/store'
import { supabase } from '@/lib/supabase'
import { formatAmount, timeAgo, copyToClipboard, trimTrailingZeros } from '@/lib/utils'
import { explorerTxUrl, arcExplorerTxUrl } from '@/lib/chainExplorers'
import {
  submitClaim,
  getClaim,
  subscribeToClaim,
  kickClaimWorker,
  fetchClaimsForWallet,
  CLAIM_STEPS,
  type Claim as ServerClaim,
} from '@/lib/claimService'
import { ClaimProgressTracker } from '@/components/multichain/ClaimProgressTracker'
import { isGaslessBridgeAvailable, quoteGaslessBridge, bringFundsGasless } from '@/lib/gaslessBridge'
import { relayedProviderFor } from '@/lib/relayedProvider'
import { useSettingsStore } from '@/store/settingsStore'
import { isChainEnabledForClaim, CHAIN_CLAIM_FEATURE_MAP } from '@/lib/featureFilters'
import { readExternalBalances, refreshScope, readExternalChainBalance } from '@/blockchain/BlockchainManager'
import { ARC_RPCS } from '@/lib/arc'
import { UB_CLAIM_CHAINS, runUbClaim, ubClaimEta } from '@/lib/ubClaim'
import { RPC_BY_CHAIN_NAME as BASE_RPC_BY_CHAIN_NAME } from '@/lib/chainRpcs'
import { sheetDrag } from '@/lib/sheetDrag'
import { revealFlow } from '@/lib/revealFlow'

// ─── MeshPort V2 Design System ────────────────────────────────────────────────
const COLORS = {
  bg: 'var(--bg)',
  surface: 'var(--surface)',
  surfaceSecondary: 'var(--surface)',
  primary: 'var(--brand)',
  success: 'var(--success)',
  error: 'var(--danger)',
  text: 'var(--text-primary)',
  muted: 'var(--text-secondary)',
  border: 'var(--border)',
}

const SPACING = {
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
}

const RADII = {
  card: 20,
  button: 16,
  input: 12,
}

// ─── Chain metadata ────────────────────────────────────────────────────────────
// All logos are local files under public/logos/chains/ — sourced from
// @web3icons/core (MIT licensed, actively maintained, verified authentic by
// cross-checking brand colors) and downloaded ahead of time so nothing here
// hotlinks an external URL. Pharos, EDGE, and Morph weren't in web3icons
// and now use official logomarks (public/logos/chains/pharos.svg,
// edge.svg, morph.svg) supplied directly instead.
const CHAIN_META: Record<string, { label: string; color: string; short: string; logo: string }> = {
  Ethereum_Sepolia:    { label: 'Ethereum',    color: '#627eea', short: 'ETH',  logo: '/logos/chains/ethereum.svg' },
  Base_Sepolia:        { label: 'Base',        color: '#0052FF', short: 'BASE', logo: '/logos/chains/base.svg' },
  Arbitrum_Sepolia:    { label: 'Arbitrum',    color: '#28A0F0', short: 'ARB',  logo: '/logos/chains/arbitrum.svg' },
  Optimism_Sepolia:    { label: 'OP Sepolia',  color: '#FF0420', short: 'OP',   logo: '/logos/chains/optimism.svg' },
  Polygon_Sepolia:     { label: 'Polygon',     color: '#7B3FE4', short: 'POL',  logo: '/logos/chains/polygon.svg' },
  Avalanche_Fuji:      { label: 'Avalanche',   color: '#E84142', short: 'AVAX', logo: '/logos/chains/avalanche.svg' },
  HyperEVM_Testnet:    { label: 'HyperEVM',    color: '#00C4FF', short: 'HYPE', logo: '/logos/chains/hyperevm.svg' },
  Sei_Testnet:         { label: 'Sei',         color: '#9D3BE0', short: 'SEI',  logo: '/logos/chains/sei.svg' },
  Sonic_Testnet:       { label: 'Sonic',       color: '#FF6B2B', short: 'S',    logo: '/logos/chains/sonic.svg' },
  Unichain_Sepolia:    { label: 'Unichain',    color: '#FF007A', short: 'UNI',  logo: '/logos/chains/unichain.svg' },
  World_Chain_Sepolia: { label: 'World Chain', color: '#1B1B1B', short: 'WLD',  logo: '/logos/chains/world.svg' },
  // Added to bring Claim up to parity with Transfer's 21-chain list — these
  // 10 were completely missing, meaning funds could be sent TO these chains
  // but never claimed back FROM them.
  Linea_Sepolia:       { label: 'Linea',       color: '#121212', short: 'LINEA', logo: '/logos/chains/linea.svg' },
  Ink_Testnet:         { label: 'Ink',         color: '#7132F5', short: 'INK',  logo: '/logos/chains/ink.svg' },
  Monad_Testnet:       { label: 'Monad',       color: '#836EF9', short: 'MON',  logo: '/logos/chains/monad.svg' },
  Morph_Testnet:       { label: 'Morph',       color: '#15A800', short: 'MORPH', logo: '/logos/chains/morph.svg' },
  Pharos_Testnet:      { label: 'Pharos',      color: '#0007B9', short: 'PHR',  logo: '/logos/chains/pharos.svg' },
  Plume_Testnet:       { label: 'Plume',       color: '#FF7A45', short: 'PLM',  logo: '/logos/chains/plume.svg' },
  XDC_Apothem:         { label: 'XDC',         color: '#0A8A5F', short: 'XDC',  logo: '/logos/chains/xdc.svg' },
  Codex_Testnet:       { label: 'Codex',       color: '#5B5FDE', short: 'CDX',  logo: '/logos/chains/codex.svg' },
  Edge_Testnet:        { label: 'EDGE',        color: '#FFB800', short: 'EDGE', logo: '/logos/chains/edge.svg' },
  Injective_Testnet:   { label: 'Injective',   color: '#00D4FF', short: 'INJ',  logo: '/logos/chains/injective.svg' },
}

// Digit/decimal sanitizing for the desktop "Amount" native input (mirrors
// AmountKeypad's own internal sanitizer, which isn't exported) — max one
// '.', capped at 2 typed decimal places.
function sanitizeClaimAmount(raw: string): string {
  let cleaned = raw.replace(/[^\d.]/g, '')
  const firstDot = cleaned.indexOf('.')
  if (firstDot !== -1) cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '')
  const [intPart, decPart] = cleaned.split('.')
  if (decPart !== undefined) cleaned = intPart + '.' + decPart.slice(0, 2)
  return cleaned
}


function getMeta(id: string) {
  return CHAIN_META[id] ?? {
    label: id.replace(/_/g, ' ').replace(/Sepolia|Fuji|Testnet/g, '').trim(),
    color: 'var(--text-secondary)', short: id.slice(0, 4).toUpperCase(), logo: '/logos/chains/_fallback.svg',
  }
}

function ChainLogo({ chainId, size = 36 }: { chainId: string; size?: number }) {
  const m = getMeta(chainId)
  const [ok, setOk] = useState(true)
  const ringStyle = {
    boxShadow: `0 0 0 1px ${m.color}40, 0 2px 6px -2px ${m.color}55`,
  }
  if (m.logo && ok) {
    return (
      <img src={m.logo} alt={m.label} width={size} height={size}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover',
          display: 'block', flexShrink: 0, background: 'var(--surface)', ...ringStyle }}
        onError={() => setOk(false)} />
    )
  }
  return (
    <div style={{ width: size, height: size, borderRadius: '50%',
      background: `${m.color}22`, border: `1.5px solid ${m.color}55`,
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, ...ringStyle }}>
      <span style={{ fontWeight: 700, color: m.color, fontSize: size * 0.28 }}>{m.short}</span>
    </div>
  )
}

// ── Per-chain config for direct wallet balance queries ────────────────────────
const RPC_BY_CHAIN_NAME: Record<string, string[]> = {
  ...BASE_RPC_BY_CHAIN_NAME,
  'Arc Testnet': ARC_RPCS,
}

async function getWorkingRpc(chainName: string): Promise<string> {
  const rpcs = RPC_BY_CHAIN_NAME[chainName] ?? ARC_RPCS
  return rpcs[0]
}


const CIRCLE_SDK_CHAIN_ID: Record<string, string> = {
  Ethereum_Sepolia:    'Ethereum_Sepolia',
  Base_Sepolia:        'Base_Sepolia',
  Arbitrum_Sepolia:    'Arbitrum_Sepolia',
  Optimism_Sepolia:    'Optimism_Sepolia',
  Polygon_Sepolia:     'Polygon_Amoy_Testnet',
  Avalanche_Fuji:      'Avalanche_Fuji',
  HyperEVM_Testnet:    'HyperEVM_Testnet',
  Sei_Testnet:         'Sei_Testnet',
  Sonic_Testnet:       'Sonic_Testnet',
  Unichain_Sepolia:    'Unichain_Sepolia',
  World_Chain_Sepolia: 'World_Chain_Sepolia',
  Linea_Sepolia:       'Linea_Sepolia',
  Ink_Testnet:         'Ink_Testnet',
  Monad_Testnet:       'Monad_Testnet',
  Morph_Testnet:       'Morph_Testnet',
  Pharos_Testnet:      'Pharos_Testnet',
  Plume_Testnet:       'Plume_Testnet',
  XDC_Apothem:         'XDC_Apothem',
  Codex_Testnet:       'Codex_Testnet',
  Edge_Testnet:        'Edge_Testnet',
  Injective_Testnet:   'Injective_Testnet',
}

function toSdkChainId(internalId: string): string {
  return CIRCLE_SDK_CHAIN_ID[internalId] ?? internalId
}

// CCTP V2's depositForBurn requires maxFee < amount at the contract level,
// and real quoted fees on routes like Monad/Polygon Amoy have been seen
// running close to $1.40 — $2.00 leaves real headroom. Was three separate
// hardcoded `2.00`/`2.00` literals (the amount screen's desktop Confirm
// button, its mobile keypad onDone, and executeClaim's own defensive
// re-check) that could silently drift apart; one constant now, shared by
// the pre-claim fee estimate too.
const MIN_CLAIM_AMOUNT = 2.00

const _arcProviderCache = new Map<string, any>()

/** The claim adapter — for merchant auto-collect. */
export async function buildClaimAdapter(privateKey: string) {
  const { createEthersAdapterFromPrivateKey } = await import('@circle-fin/adapter-ethers-v6')
  return buildAdapter(createEthersAdapterFromPrivateKey, privateKey)
}

// Non-Arc chains go through relayedProviderFor: the Gateway deposit (and
// any Gateway/CCTP mint) is submitted by MeshPort's relayer, so the wallet
// needs no gas there. Arc pays its own gas in USDC.
async function buildAdapter(createFn: any, privateKey: string) {
  return createFn({
    privateKey,
    getProvider: async ({ chain }: { chain: any }) => {
      if (chain?.name !== 'Arc Testnet') return relayedProviderFor(chain)
      const rpcList = RPC_BY_CHAIN_NAME['Arc Testnet']
      const key = rpcList.join('|')
      if (!_arcProviderCache.has(key)) {
        const { JsonRpcProvider, FallbackProvider } = await import('ethers')
        const ps = rpcList.map((url: string) => new JsonRpcProvider(url))
        _arcProviderCache.set(key, ps.length > 1
          ? new FallbackProvider(ps.map((p: any, i: number) => ({ provider: p, priority: i, weight: 1, stallTimeout: 2000 })), undefined, { quorum: 1 })
          : ps[0])
      }
      return _arcProviderCache.get(key)!
    },
  })
}

// ─── Types ─────────────────────────────────────────────────────────────────────
interface ChainEntry {
  chainId:   string
  claimable: number
  pending:   number
}

interface ChainProgress {
  chainId:    string
  stage:      'waiting' | 'gas' | 'approving' | 'burning' | 'attesting' | 'minting' | 'done' | 'error'
  msg:        string
  txHash?:    string
  mintTxHash?: string
  pct:        number
}

type Step =
  | 'loading'
  | 'select'   // Page 1: choose chain + enter amount
  | 'confirm'  // Page 2: passcode -> processing -> done
  | 'failed'

// 'submitted' / 'tracking' are server-backed: the claim row already exists in
// Supabase and claim-worker is advancing it independently of this page.
type ConfirmPhase = 'processing' | 'submitted' | 'tracking' | 'done'

// ─── Main Component ────────────────────────────────────────────────────────────
// Rows for the "View details" panel under Track Progress.
function trackDetailRows(p: { route: string; chainId: string; amount: number; createdAt?: string; sourceTx?: string; mintTx?: string }): TrackDetailRow[] {
  const when = p.createdAt ? new Date(p.createdAt) : null
  const chainLabel = getMeta(p.chainId).label
  return [
    { label: 'Type', value: '↓ Claim to Arc' },
    { label: 'Route', value: p.route },
    { label: 'From Chain', value: chainLabel },
    ...(p.amount > 0 ? [{ label: 'Claimed', value: `$${formatAmount(p.amount)} USDC` }] : []),
    ...(when ? [
      { label: 'Date', value: when.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) },
      { label: 'Time', value: when.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) },
    ] : []),
    ...(p.sourceTx ? [{ label: 'Source Tx', value: `${p.sourceTx.slice(0, 10)}…${p.sourceTx.slice(-8)}`, copy: p.sourceTx, href: explorerTxUrl(p.chainId, p.sourceTx) }] : []),
    ...(p.mintTx ? [{ label: 'Arc Tx', value: `${p.mintTx.slice(0, 10)}…${p.mintTx.slice(-8)}`, copy: p.mintTx, href: arcExplorerTxUrl(p.mintTx) }] : []),
  ]
}

export function MultichainClaimPage({ embedded = false, onClose, initialChain, trackClaimId, merchantMode = false, onFocusChange }: { embedded?: boolean; onClose?: () => void; initialChain?: string; trackClaimId?: string; merchantMode?: boolean; onFocusChange?: (f: 'none' | 'processing' | 'result') => void } = {}) {
  // Inside the Hub sheet the page always uses its phone layout.
  const isDesktopMq  = useMediaQuery('(min-width: 980px)')
  const isDesktop    = embedded ? false : isDesktopMq
  // The amount box and the passcode follow the real screen size even when
  // embedded in the Hub: on desktop they type with the keyboard (Swap-style
  // box) and authorise in a centred popup, never the phone keypad sheets.
  const desktopInput = isDesktopMq

  // Embedded in the Multichain Hub's bottom sheet: anything that would go
  // "back to the Hub" closes the sheet instead of changing page.
  const routerNavigate = useNavigate()
  const navigate = useCallback(((to: any, opts?: any) => {
    if (embedded && typeof to === 'string' && to.startsWith('/multichain') && !to.startsWith('/multichain-')) {
      onClose?.()
      // A tab switch inside the Hub (e.g. "View in Hub" → Activity) is passed on as router state.
      if (opts?.state?.tab) routerNavigate('/multichain', { state: opts.state, replace: true })
      return
    }
    return routerNavigate(to, opts)
  }) as ReturnType<typeof useNavigate>, [embedded, onClose, routerNavigate])
  const location      = useLocation()
  const privateKey = useAuthStore(s => s.privateKey)
  const walletAddress = useAuthStore(s => s.walletAddress)
  const storedPasscode = useAuthStore(s => s.passcode)
  const { balance, setBalance } = useWalletStore()
  // Admin Panel → Chains toggles. Each chain here is checked against its own
  // toggle so a disabled chain disappears from the claim list immediately
  // (this is a live subscription, so no rescan/reload is needed) and a
  // re-enabled chain reappears the same way.
  const settingsMap = useSettingsStore((s) => s.settings)
  const settingsLoaded = useSettingsStore((s) => s.loaded)
  const loadSettings = useSettingsStore((s) => s.load)
  // Must call this — isChainEnabledForClaim fails OPEN (every chain reads
  // as enabled) whenever a row isn't in the store yet, which is correct
  // while settings are still genuinely loading but was silently permanent
  // if nothing else had already triggered load() first. This page used to
  // only ever READ settingsMap/settingsLoaded reactively, assuming some
  // other already-mounted page (e.g. Home) had called load() before this
  // one mounted. Reached directly — a deep link, a page refresh while
  // already on /multichain-claim, or just being the first page opened in
  // the session — settingsLoaded stayed false for the entire session, and
  // every admin-disabled chain's balance was scanned and counted into
  // claimableTotal indefinitely instead of just for one brief render.
  useEffect(() => { loadSettings() }, [loadSettings])

  const [searchParams, setSearchParams] = useSearchParams()

  // Deep-link from the Hub's "Processing Claims" list ("Tap to view") —
  // jumps straight into the tracking screen for an already-submitted claim.
  //
  // Checked in two places: router `location.state` (set by the Hub's
  // navigate call) AND the `?claim=` URL param (set both by the Hub and by
  // this page itself once a claim starts being tracked — see the
  // URL-mirroring effect below). location.state is not reliable across a
  // hard refresh in every environment this app runs in; the URL is. This
  // is what was causing "Track Progress" to silently drop back to the
  // scan/select ("assets") screen on refresh instead of resuming.
  const trackClaimIdFromHub =
    trackClaimId ??
    ((location.state as any)?.trackClaimId as string | undefined) ??
    (searchParams.get('claim') || undefined)

  const [step,           setStep]          = useState<Step>(() => trackClaimIdFromHub ? 'confirm' : 'loading')
  const [confirmPhase,   setConfirmPhase]  = useState<ConfirmPhase>(() => trackClaimIdFromHub ? 'tracking' : 'processing')
  // The live view that was up before 'done' (processing/submitted or
  // tracking) — kept on screen underneath the success flash so the screen is
  // never blank while the flash's circle grows.
  const lastLivePhase = useRef<ConfirmPhase>(confirmPhase)
  if (confirmPhase !== 'done') lastLivePhase.current = confirmPhase
  // Inside the Hub the flow sits below the Hub's title bar, balance card and
  // tabs. While the claim processes (and on its result) the Hub unpins its
  // title bar and this view is scrolled to the very top of the screen; the Hub
  // locks scrolling while processing and frees it again once it's done.
  const flowRootRef = useRef<HTMLDivElement>(null)
  const focus = step === 'confirm'
    ? ((confirmPhase === 'processing' || confirmPhase === 'submitted') ? 'processing' : 'result')
    : step === 'failed' ? 'result' : 'none'
  useEffect(() => {
    if (!embedded) return
    onFocusChange?.(focus)
    if (focus !== 'none') revealFlow(flowRootRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded, focus])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => onFocusChange?.('none'), [])

  // ── Desktop-only: Claimed History (right column) ────────────────────────
  // Real data — claims are NOT written to the `activity` table by this
  // page's flow (they go through the server-owned `claims` table via
  // submitClaim()/claim-worker instead — see claimService.ts), so this
  // reads from fetchClaimsForWallet, the same source MultichainPage's hub
  // already uses for its own claims list. Skipped entirely on mobile;
  // re-fetched once a claim finishes so it shows up without a page reload.
  const [claimHistory, setClaimHistory] = useState<ServerClaim[]>([])
  const [claimHistoryLoaded, setClaimHistoryLoaded] = useState(false)
  const [claimHistDetail, setClaimHistDetail] = useState<ServerClaim | null>(null)
  useEffect(() => {
    if (!isDesktop || !walletAddress) return
    let cancelled = false
    fetchClaimsForWallet(walletAddress)
      .then(claims => { if (!cancelled) setClaimHistory(claims) })
      .finally(() => { if (!cancelled) setClaimHistoryLoaded(true) })
    return () => { cancelled = true }
  }, [isDesktop, walletAddress, confirmPhase === 'done'])

  // Device/browser back button on Track Progress → Multichain Hub, matching
  // the in-app back arrow. confirmPhase is component state, not a route, so
  // without this a back-press would just unwind normal browser history to
  // whatever page was open before this one — not necessarily the Hub, and
  // not consistent with what the visible back arrow already does here.
  useEffect(() => {
    // Inside the Hub, the Hub itself owns the device back button (it closes
    // this inline view) — see MultichainPage's sub-view history handling.
    if (embedded) return
    if (confirmPhase !== 'tracking') return
    window.history.pushState({ trackProgress: true }, '')
    const onPopState = () => { navigate('/multichain', { replace: true }) }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [confirmPhase, navigate, embedded])

  // Server-owned claim rows created for this session, keyed by source chain.
  // These are the single source of truth once populated — the worker keeps
  // advancing them via Supabase regardless of what this page/tab does.
  const [claimRecords,   setClaimRecords]  = useState<Array<{ chainId: string; claimId: string; initialClaim?: ServerClaim | null }>>([])
  const [claimsByStatus, setClaimsByStatus] = useState<Record<string, ServerClaim>>({})
  // Chains claimed via Unified Balance this session. UB claims have no
  // `claims` row, so Track Progress follows their live chainProgress instead.
  const [ubClaimChains,  setUbClaimChains] = useState<string[]>([])
  const [showPasscodeSheet, setShowPasscodeSheet] = useState(false)
  const [amountConfirmed, setAmountConfirmed] = useState(false)
  const [keypadOpen,     setKeypadOpen]    = useState(false)
  const amountBoxRef = useRef<HTMLDivElement>(null)
  const keypadLift = useKeypadLift(keypadOpen && !showPasscodeSheet, amountBoxRef, !isDesktop)
  const [isSubmitted,    setIsSubmitted]   = useState(false)
  const [chains,         setChains]        = useState<ChainEntry[]>([])
  const [claimableTotal, setClaimableTotal] = useState(0)
  const [selected,       setSelected]      = useState<string | null>(null)
  // Which way the chain-select <-> amount-entry slide should travel — set on
  // every navigation between the two so back mirrors forward instead of
  // always animating the same direction regardless of which way you went.
  const [direction,      setDirection]     = useState<NavDirection>('forward')
  // Same useReducedMotion() pattern already used in PageTransition.tsx/
  // AuthShell.tsx, applied here to the chain-select <-> amount-entry slide.
  const reduceMotion = useReducedMotion()
  const [claimAmounts,   setClaimAmounts]  = useState<Record<string, string>>({})
  // Route for the claim: CCTP (burn → mint) or Unified Balance (Gateway deposit → spend).
  // Merchants collect through Unified Balance only (Ledger shows UB chains).
  const [claimRoute, setClaimRoute] = useState<'cctp' | 'ub'>(merchantMode ? 'ub' : 'cctp')
  // Pre-claim fee estimate — shown on the amount screen, BEFORE the user
  // enters their passcode, so "You will receive" reflects what actually
  // lands instead of the raw claim amount. Previously the only fee number
  // anywhere on this page was claimFees below, which only populates DURING
  // execution (after the passcode) — the user had zero fee visibility
  // before committing, unlike the Send/Transfer page's Review step.
  // `forKey` is `${chainId}|${amount}` — lets the render check whether the
  // current amount/chain still matches what this estimate was computed for,
  // so a stale number from a just-edited amount never gets displayed as if
  // it were live.
  const [feeEstimate, setFeeEstimate] = useState<{
    loading: boolean
    error: string
    totalFee: number
    receiverGets: number
    forKey: string
    // Breakdown for the fee section. networkFee is the source-chain gas
    // MeshPort's relayer charges in USDC; bridgeFee is the most Circle's
    // CCTP fee can be (usually a little less).
    networkFee: number
    bridgeFee: number
  }>({ loading: false, error: '', totalFee: 0, receiverGets: 0, forKey: '', networkFee: 0, bridgeFee: 0 })
  const [passEntry,      setPassEntry]     = useState('')
  const [passError,      setPassError]     = useState('')
  const [error,          setError]         = useState('')
  const [txRecords,      setTxRecords]     = useState<ActivityRecord[]>([])
  const [chainProgress,  setChainProgress] = useState<ChainProgress[]>([])
  // Per-chain fee each gasless bring actually signed (MeshPort fee + CCTP
  // maxFee) —
  // summed for the success screen's "Total Fees" row, mirroring
  // MultichainTransferPage's own transfer success screen.
  const [claimFees,      setClaimFees]     = useState<Record<string, number>>({})
  const notifiedClaimIdsRef = useRef<Set<string>>(new Set())
  const sdkRef = useRef<{ AppKit: any; createEthersAdapterFromPrivateKey: any } | null>(null)

  // ─── Success screen — same full-screen flash → hero-card takeover
  // SwapPage/PaySendPage use for a completed action, reused here so a
  // completed claim feels identical: whole screen flashes brand color
  // with a big checkmark + "Claimed Successfully", holds briefly, then
  // that panel shrinks away while the traveling checkmark bridges into
  // the detailed hero card that fades in underneath.
  const [successPhase, setSuccessPhase] = useState<'flash' | 'collapsed'>('flash')
  const [hashCopied, setHashCopied] = useState(false)
  const { showToastMessage } = useUIStore()
  // Whether THIS claim's passcode came from a biometric check vs typed
  // manually — drives which icon (checkmark vs fingerprint/Face ID) shows
  // on the flash->hero success animation. Set from PinKeypad's onComplete
  // second argument, same as SwapPage/PaySendPage.
  const [paidViaBiometric, setPaidViaBiometric] = useState(false)
  useEffect(() => {
    if (confirmPhase !== 'done') { setSuccessPhase('flash'); return }
    const t = setTimeout(() => setSuccessPhase('collapsed'), 1500)
    return () => clearTimeout(t)
  }, [confirmPhase])

  // Gates FlashAuthIcon's own bio->check swap — flips true only once the
  // white circle below has actually finished its spring entrance
  // (onAnimationComplete), not on a guessed timer. Reset alongside
  // successPhase so a second claim in the same session gets a fresh flash
  // instead of starting pre-armed.
  const [flashCircleReady, setFlashCircleReady] = useState(false)
  useEffect(() => { if (successPhase === 'flash') setFlashCircleReady(false) }, [successPhase])

  // Wall-clock duration of the claim, measured start-to-finish, purely for
  // the success screen's "Completed in X Seconds" pill.
  const claimStartRef = useRef(0)
  const [claimElapsedSeconds, setClaimElapsedSeconds] = useState('0.00')
  useEffect(() => {
    if (confirmPhase === 'done' && claimStartRef.current) {
      setClaimElapsedSeconds((((performance.now() - claimStartRef.current)) / 1000).toFixed(2))
    }
  }, [confirmPhase])

  // Traveling checkmark: flash position -> hero card's own checkmark spot
  // (same manual getBoundingClientRect + transform technique SwapPage/
  // PaySendPage use, via the shared TravelingCheckmark component).
  const flashCheckRef = useRef<HTMLDivElement>(null)
  const heroCheckRef = useRef<HTMLDivElement>(null)
  // The receipt mounts a frame after successPhase flips (screens swap in
  // AnimatePresence "wait" mode), so the travel below waits for this.
  const [heroCheckEl, setHeroCheckEl] = useState<HTMLDivElement | null>(null)
  const heroCheckCallback = useCallback((el: HTMLDivElement | null) => { heroCheckRef.current = el; setHeroCheckEl(el) }, [])
  const lastFlashRectRef = useRef<DOMRect | null>(null)
  const [travelRect, setTravelRect] = useState<{ from: DOMRect; to: DOMRect } | null>(null)
  const [travelDone, setTravelDone] = useState(false)
  // Desktop's flash overlay used to portal straight to `document.body` with
  // `position:fixed; inset:0` — meaning it flashed the ENTIRE screen,
  // covering the Claimed History column too, not just the flow column the
  // rest of this page's desktop layout confines itself to. It was ported
  // to `document.body` in the first place because PageTransition's
  // motion.div (wraps every route) leaves a stray transform on itself,
  // which makes it the containing block for any `position:fixed`
  // descendant — so a naive non-portalled fixed overlay rendered sized/
  // positioned to that transformed ancestor instead of the viewport. The
  // portal still needs to happen for that reason, but on desktop the
  // overlay's rect is now pinned to this ref (the same flow-column
  // wrapper `flow` already renders inside further down) instead of the
  // full viewport, so it visually respects the two-column layout.
  const desktopColumnRef = useRef<HTMLDivElement>(null)
  const [flashColumnRect, setFlashColumnRect] = useState<DOMRect | null>(null)

  useLayoutEffect(() => {
    if (successPhase === 'flash' && flashCheckRef.current) {
      lastFlashRectRef.current = flashCheckRef.current.getBoundingClientRect()
    }
  })

  // Separate, dependency-gated effect — NOT folded into the unconditional
  // one above. That one has no dep array on purpose (it needs to keep
  // re-measuring flashCheckRef every render while flash is up), but
  // getBoundingClientRect() always returns a brand-new DOMRect object, so
  // calling setFlashColumnRect from an effect with no deps meant: render →
  // effect runs → setState with a "new" (referentially different, even if
  // numerically identical) rect → React sees a state change → re-render →
  // effect runs again → setState again → infinite loop (React error #185,
  // "Maximum update depth exceeded"). Gating on [successPhase, isDesktop]
  // makes it fire once per entry into the flash phase instead.
  useLayoutEffect(() => {
    if (successPhase !== 'flash' || !isDesktopMq) return
    // Embedded in the Hub on desktop: cover just the Hub's own screen (its
    // scroll area beside the sidebar), not the whole window.
    const target = isDesktop
      ? desktopColumnRef.current
      : (flowRootRef.current?.closest('[data-flow-scroller]') as HTMLElement | null) ?? flowRootRef.current
    if (target) setFlashColumnRect(target.getBoundingClientRect())
  }, [successPhase, isDesktop, isDesktopMq])

  // Measured in a layout effect (before paint) so the traveling checkmark is
  // already on screen in the receipt's very first frame — no frame where
  // the receipt shows an empty header circle.
  useLayoutEffect(() => {
    if (successPhase !== 'collapsed') { setTravelDone(false); setTravelRect(null); return }
    if (!heroCheckEl) return // receipt not mounted yet
    const from = lastFlashRectRef.current
    const to = heroCheckEl.getBoundingClientRect()
    if (!from) { setTravelDone(true); return }
    setTravelRect({ from, to })
    const t = setTimeout(() => setTravelDone(true), 520)
    return () => clearTimeout(t)
  }, [successPhase, heroCheckEl])

  const copyClaimHash = async (hash: string) => {
    if (!hash) return
    const ok = await copyToClipboard(hash)
    setHashCopied(true)
    showToastMessage(ok ? 'Transaction hash copied' : 'Could not copy hash', ok ? 'success' : 'error')
    setTimeout(() => setHashCopied(false), 1500)
  }

  useEffect(() => {
    // Pre-warm SDK chunks immediately on mount — not deferred to chain-select.
    // The dynamic import of app-kit + adapter-ethers-v6 is a separate JS chunk
    // that can take 500ms-1s to download and parse on a cold load. Kicking it
    // here means the chunk is already cached by the time the user picks a chain
    // and the fee estimate debounce fires, so the debounce delay is the ONLY
    // wait instead of debounce + a fresh chunk download.
    Promise.all([
      import('@circle-fin/app-kit'),
      import('@circle-fin/adapter-ethers-v6'),
    ]).then(([a, b]) => {
      sdkRef.current = {
        AppKit: a.AppKit,
        createEthersAdapterFromPrivateKey: b.createEthersAdapterFromPrivateKey,
      }
    }).catch(() => {})
  }, [])

  useEffect(() => { requestPushPermission() }, [])

  // Deep link from Hub → jump straight into the tracking screen for a claim
  // that's already being processed server-side (survives navigation/reload).
  //
  // BUG FIX: must only ever do this ONCE, on the actual mount — not every
  // time trackClaimIdFromHub's value changes. The URL-mirroring effect just
  // above now writes ?claim=<id> as soon as a claim is submitted (so a
  // refresh during the "Claim submitted!" countdown screen can resume too),
  // which changes trackClaimIdFromHub's value mid-session. Without this
  // guard, that change would re-run this effect and force confirmPhase
  // straight to 'tracking', hijacking the submitted countdown screen before
  // the user ever saw it — the exact bug the mirroring effect's own history
  // already describes. Gating on a ref (not the dependency array) means a
  // genuine fresh mount with ?claim= already in the URL (a hard refresh)
  // still resumes correctly — this only ignores changes that happen AFTER
  // the component is already up and running in the same session.
  const hasCheckedResumeRef = useRef(false)
  useEffect(() => {
    if (hasCheckedResumeRef.current) return
    hasCheckedResumeRef.current = true
    if (!trackClaimIdFromHub) return
    getClaim(trackClaimIdFromHub).then(claim => {
      if (!claim) {
        // Id was stale/invalid/expired (or arrived from a bad/old link) —
        // there's nothing to resume, so fall through to a normal scan
        // instead of leaving the screen stuck on an empty tracking view
        // forever. Also strip the dead ?claim= param so a further refresh
        // doesn't repeat the same dead end.
        const next = new URLSearchParams(searchParams)
        next.delete('claim')
        setSearchParams(next, { replace: true })
        setStep('loading')
        return
      }
      setClaimRecords([{ chainId: claim.sourceChain, claimId: claim.id, initialClaim: claim }])
      setStep('confirm')
      setConfirmPhase(claim.status === 'completed' ? 'done' : 'tracking')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackClaimIdFromHub])

  // Mirror the claim being tracked into the URL as soon as it's submitted
  // (not just once the user reaches the live tracking view) — so a hard
  // refresh during the "Claim submitted!" countdown screen can resume too,
  // not only a refresh from the tracking view itself.
  //
  // BUG FIX: this used to wait for confirmPhase === 'tracking' specifically,
  // because writing ?claim= any earlier changed trackClaimIdFromHub, which
  // re-ran the resume-effect below and forced confirmPhase straight to
  // 'tracking' — hijacking the "Claim submitted!" countdown screen the
  // instant it appeared, before the user ever saw it. That's now fixed at
  // the resume-effect itself (see its own comment): it only ever resumes
  // ONCE per mount, so this mirroring firing earlier in the SAME session no
  // longer re-triggers it. A refresh is a fresh mount, so it still resumes
  // correctly — straight to the live tracking view, which is the right
  // screen to land on after a refresh regardless of which sub-phase you
  // were on before it.
  useEffect(() => {
    const id = claimRecords[0]?.claimId
    if (!id || searchParams.get('claim') === id) return
    const next = new URLSearchParams(searchParams)
    next.set('claim', id)
    setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimRecords])

  // ── Server-truth subscription ──────────────────────────────────────────────
  // For every claim row created this session, subscribe to its realtime
  // updates. This is purely a UI reflection — claim-worker (Edge Function +
  // pg_cron) is what actually advances status, so it keeps running even if
  // every listener below is torn down (unmount, tab close, navigation).
  useEffect(() => {
    if (claimRecords.length === 0) return
    const unsubs = claimRecords.map(({ claimId }) =>
      subscribeToClaim(claimId, (claim) => {
        setClaimsByStatus(prev => ({ ...prev, [claim.id]: claim }))
      })
    )
    return () => unsubs.forEach(u => u())
  }, [claimRecords])

  // Optional acceleration: while someone's actively on this screen watching
  // a non-terminal claim, ask claim-worker to check it every few seconds
  // instead of waiting for pg_cron's next ~60s tick. Doesn't change what
  // decides anything — still only claims.status, delivered through the same
  // subscription above; this just makes the authoritative check itself run
  // sooner. Stops automatically once every tracked claim reaches a terminal
  // status, and tearing down this effect (navigating away, closing the tab)
  // simply stops the acceleration — claim-worker keeps going regardless via
  // pg_cron, same guarantee as always.
  useEffect(() => {
    if (claimRecords.length === 0) return
    const pending = claimRecords.filter(r => {
      const status = claimsByStatus[r.claimId]?.status
      return status !== 'completed' && status !== 'failed'
    })
    if (pending.length === 0) return
    // 8s — matches claim-worker's own SWEEP_INTERVAL_MS, and the RPC behind
    // kickClaimWorker (fetch_and_lock_due_claims) now enforces the same
    // staleness cutoff for single-claim kicks as it always did for the cron
    // sweep. A shorter client interval than that no longer buys anything: the
    // extra kicks just get skipped server-side as stale instead of actually
    // reprocessing the claim, so they'd be wasted requests, not faster
    // updates. (Previously this ran every 2s — the RPC didn't rate-limit
    // single-claim kicks yet, so it silently reprocessed the claim on every
    // one of those, inflating claims.attempts up to ~5x faster than
    // MAX_ATTEMPTS was calibrated for. Fixed server-side; this brings the
    // client back in line with that fix instead of relying on it as a
    // backstop.) The worker still decides everything; this just asks it to
    // check sooner than pg_cron's next ~60s tick.
    // Kick once immediately — otherwise a freshly-submitted claim just sits
    // in 'submitted' doing nothing until this interval's FIRST tick fires
    // at the 8s mark (setInterval doesn't fire on mount), which is exactly
    // the "checklist looks stuck for 5-10s before it starts pulsing" gap:
    // nothing is wrong with the checklist itself, claim-worker just hadn't
    // been asked to look at this claim yet.
    pending.forEach(r => kickClaimWorker(r.claimId))
    const iv = setInterval(() => {
      pending.forEach(r => kickClaimWorker(r.claimId))
    }, 8_000)
    return () => clearInterval(iv)
  }, [claimRecords, claimsByStatus])

  // PERF FIX (reported: "funds arrive first, Track Progress catches up
  // later") — arcDepositWatcher.ts already watches Arc in real time and
  // fires 'meshport:arc-deposit' (session-wide, see AppLayout.tsx) the
  // instant a deposit — including this claim's own CCTP mint — lands,
  // which is what makes the Home balance/Activity feel instant. The
  // checklist above only asked claim-worker to recheck on a fixed 5s
  // timer, so it could lag behind a mint that was already detected.
  // Kicking immediately on this event closes that gap: it's the exact
  // same kickClaimWorker() call the 5s timer above already makes (just
  // triggered by a real signal instead of a fixed clock), so it still
  // doesn't decide anything itself — claims.status is still written
  // authoritatively by claim-worker and delivered through the same
  // subscription above.
  useEffect(() => {
    if (claimRecords.length === 0) return
    const pending = claimRecords.filter(r => {
      const status = claimsByStatus[r.claimId]?.status
      return status !== 'completed' && status !== 'failed'
    })
    if (pending.length === 0) return
    const onDeposit = () => { pending.forEach(r => kickClaimWorker(r.claimId)) }
    window.addEventListener('meshport:arc-deposit', onDeposit)
    return () => window.removeEventListener('meshport:arc-deposit', onDeposit)
  }, [claimRecords, claimsByStatus])

  // Auto-advance the UI once the server-side state machine finishes —
  // works even if this page was just opened via the Hub deep link.
  useEffect(() => {
    if (claimRecords.length === 0) return
    const claims = claimRecords.map(r => claimsByStatus[r.claimId]).filter(Boolean) as ServerClaim[]
    if (claims.length < claimRecords.length) return

    if (claims.some(c => c.status === 'failed')) {
      setError(claims.find(c => c.status === 'failed')?.error ?? 'Claim failed')
      setStep('failed')
      return
    }
    if (claims.every(c => c.status === 'completed')) {
      import('@/lib/arcService').then(({ getUSDCBalance }) =>
        getUSDCBalance(walletAddress ?? '').then(setBalance).catch(() => {})
      )
      setChainProgress(prev => prev.length
        ? prev.map(p => ({ ...p, stage: 'done', pct: 100 }))
        : claims.map(c => ({ chainId: c.sourceChain, stage: 'done', pct: 100, msg: 'Done', mintTxHash: c.destinationTxHash ?? undefined, txHash: c.txHash })))
      setConfirmPhase(phase => (phase === 'submitted' || phase === 'tracking') ? 'done' : phase)

      // Notification now fires HERE — driven by the same Realtime
      // claims.status event as the UI transition above, instead of a
      // separate client-SDK completion signal that could arrive at a
      // different time than the actual server-confirmed status. Guarded on
      // TWO levels: the in-memory ref stops this effect from re-notifying
      // itself as it re-runs within the same mount, and `userNotifiedAt`
      // stops a fresh mount (e.g. refreshing this exact success screen,
      // which re-fetches claimsByStatus as already-'completed' and would
      // otherwise re-fire with an empty ref) from notifying again for a
      // claim that was already durably marked notified server-side.
      for (const c of claims) {
        if (c.userNotifiedAt) { notifiedClaimIdsRef.current.add(c.id); continue }
        if (!notifiedClaimIdsRef.current.has(c.id)) {
          notifiedClaimIdsRef.current.add(c.id)
          notifyClaimArrived(c.arrivedAmount ?? c.amount, c.sourceChain, undefined, undefined, c.id)
          // Mark it server-side too — without this, AppLayout.tsx's
          // catch-up check (which exists specifically to notify for claims
          // that complete while nobody's watching) has no way to know this
          // one was already handled live, and fires a second, duplicate
          // notification for it moments later using the gross amount
          // instead of this correct, arrived amount.
          supabase.rpc('mark_claim_notified', { p_claim_id: c.id }).then(({ error }) => {
            if (error) console.error('[claim-notify] mark failed:', c.id, error.message)
          })
        }
      }
    }
  }, [claimsByStatus, claimRecords, walletAddress, setBalance])

  // NOTE: a client-side balance-delta poller previously lived here
  // (checked getUSDCBalance() against a startBalance snapshot, same
  // `newBal >= before + expected*0.99` pattern that was removed from
  // server-side settlement for being unreliable under concurrent activity).
  // It's been removed — it was fully redundant with the effect above, which
  // already flips confirmPhase to 'done' the moment claims.status genuinely
  // reaches 'completed' via Realtime. claims.status is now the single
  // source of truth end-to-end; this page no longer has its own competing
  // notion of "arrived".
  //
  // A second, entirely separate polling loop also used to live here —
  // polling a `bridge_sessions` table (distinct from `claims`) every 15s
  // for statuses like 'burning'/'attesting'/'minting'. Nothing writes to
  // that table anymore (confirmed via full-codebase audit), and the result
  // was never even rendered anywhere — pure dead weight that was still a
  // second, disconnected notion of claim progress sitting in the codebase.
  // Removed along with its backing functions in bridgeTracker.ts.

  const getKey = useCallback(async (passcode?: string) => {
    const s0 = (await import('@/store')).useAuthStore.getState()
    let key = s0.privateKey, addr = s0.walletAddress
    if (key && addr) return { key, addr }

    // privateKey is deliberately never persisted to disk (see store/index.ts
    // partialize + App.tsx) — it's re-derived from the mnemonic, or for
    // social-auto accounts fetched fresh from the server, on every app
    // load/reload. That restore is async and, for the server-fetch path,
    // a real network round trip — it can easily take longer than a short
    // fixed poll on a slow connection. This used to only poll raw store
    // state for 8 x 400ms (3.2s total) and give up with "Wallet not
    // available" → Claim Failed, even while restoration was still quietly
    // in progress in the background. Instead, actively await the same
    // shared, single-flight restorePrivateKey() used everywhere else in
    // the app (it no-ops instantly if a restore is already in flight or
    // already done), then fall back to a more generous poll.
    //
    // BUG FIX (transaction-speed/reliability audit): this used to call
    // restorePrivateKey() with NO passcode. For a local (create/import-seed/
    // import-privkey) wallet whose sessionStorage-cached key has already
    // gone cold (session cache cleared on 'offline', or just an old tab),
    // restoreWallet.ts's own decrypt step (step 3) needs a passcode to try
    // and had none here — `pendingRawPasscode` is only ever stashed by the
    // passcode SETUP/CHANGE screens, never by this page's own passcode-
    // confirm sheet. The result: a claim on a cold session silently fell
    // through every restore path, burned the full ~10s poll below, and
    // failed with "Wallet unavailable" — even though the user had just
    // typed their correct passcode into the sheet one line above this call.
    // handlePasscodeConfirm now passes that verified passcode through.
    if (addr && !key) {
      try {
        const { restorePrivateKey } = await import('@/lib/restoreWallet')
        await restorePrivateKey(passcode)
      } catch {}
      const s1 = (await import('@/store')).useAuthStore.getState()
      key = s1.privateKey; addr = s1.walletAddress
    }

    // Remaining fallback: addr itself not hydrated yet (auth store persist
    // rehydration hasn't landed on first render) or restore is genuinely
    // still settling. 20 x 500ms = 10s — generous enough to cover a slow
    // network restore without leaving the scan screen spinning forever.
    for (let i = 0; i < 20 && !(key && addr); i++) {
      await new Promise(r => setTimeout(r, 500))
      const s = (await import('@/store')).useAuthStore.getState()
      key = s.privateKey; addr = s.walletAddress
    }
    return (key && addr) ? { key, addr } : null
  }, [])

  const loadSdk = useCallback(async () => {
    const [{ AppKit }, { createEthersAdapterFromPrivateKey }] = await Promise.all([
      import('@circle-fin/app-kit'),
      import('@circle-fin/adapter-ethers-v6'),
    ])
    return { AppKit, createEthersAdapterFromPrivateKey }
  }, [])

  // ── Pre-claim fee estimate ───────────────────────────────────────────────
  // The gasless relayer's quote — read-only, signs nothing.
  const fetchClaimFeeEstimate = useCallback(async (chainId: string, amount: number) => {
    const key = `${chainId}|${amount}`
    setFeeEstimate(prev => ({ ...prev, loading: true, error: '' }))
    // Gasless chains: the relayer's own quote — the exact fees the claim
    // will sign, so what's shown here is what's charged.
    if (isGaslessBridgeAvailable(chainId)) {
      try {
        const q = await quoteGaslessBridge(chainId, amount)
        const totalFee = q.networkFee + q.bridgeFee
        setFeeEstimate({ loading: false, error: '', totalFee, receiverGets: Math.max(0, amount - totalFee), forKey: key, networkFee: q.networkFee, bridgeFee: q.bridgeFee })
      } catch (e: any) {
        setFeeEstimate({ loading: false, error: e?.message || 'Fee estimate unavailable', totalFee: 0, receiverGets: 0, forKey: key, networkFee: 0, bridgeFee: 0 })
      }
      return
    }
    setFeeEstimate({ loading: false, error: 'Not available for this chain', totalFee: 0, receiverGets: 0, forKey: key, networkFee: 0, bridgeFee: 0 })
  }, [])

  // Debounced trigger — fires ~600ms after the user stops typing/adjusting
  // the amount, same cadence MultichainTransferPage.tsx uses for its own
  // Review-step estimate. Skipped below MIN_CLAIM_AMOUNT: an estimate for an
  // amount that can't actually be claimed is just noise, and some routes'
  // real fees approach the claim amount itself at these small sizes anyway
  // (see MIN_CLAIM_AMOUNT's own comment).
  useEffect(() => {
    if (step !== 'select' || !selected) return
    const amt = parseFloat(claimAmounts[selected] ?? '0') || 0
    if (amt < MIN_CLAIM_AMOUNT) {
      setFeeEstimate({ loading: false, error: '', totalFee: 0, receiverGets: 0, forKey: '', networkFee: 0, bridgeFee: 0 })
      return
    }
    const t = setTimeout(() => { fetchClaimFeeEstimate(selected, amt) }, 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, selected, claimAmounts[selected ?? ''], fetchClaimFeeEstimate])

  // SDK modules are already pre-warmed on mount (see the useEffect above
  // that populates sdkRef on load), so this secondary kick on chain-select
  // is retained purely as a belt-and-suspenders guarantee — if the mount
  // pre-warm was a cache hit (same session, second claim) the call is a
  // no-op; if mount failed for any reason, selecting a chain recovers it.
  useEffect(() => {
    if (step === 'select' && selected) { loadSdk().catch(() => {}) }
  }, [step, selected, loadSdk])

  // ── Manual refresh cooldown ──────────────────────────────────────────────
  // 20s client-side rate limit on the header's Refresh button — independent
  // of (and shorter than) the underlying 90s cache TTL, since a manual tap
  // now always forces a genuine bypass (see scan()'s force param below) and
  // this is what actually protects the RPC providers from being hammered by
  // repeat clicks, not a silent cache hit the user can't see or control.
  const REFRESH_COOLDOWN_MS = 20_000
  const [refreshCooldownUntil, setRefreshCooldownUntil] = useState(0)
  const [refreshCooldownNow, setRefreshCooldownNow] = useState(0)
  useEffect(() => {
    if (refreshCooldownUntil <= Date.now()) return
    const iv = setInterval(() => setRefreshCooldownNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [refreshCooldownUntil])
  const refreshCooldownSecsLeft = Math.max(0, Math.ceil((refreshCooldownUntil - (refreshCooldownNow || Date.now())) / 1000))

  const scan = useCallback(async (force?: boolean) => {
    // Deep-linking into an existing claim's Track Progress (from the Hub's
    // "Tap to view") has nothing to do with scanning for NEW claimable
    // balances. Previously this ran unconditionally on every mount and
    // finished with an unconditional setStep('select') — racing against the
    // trackClaimIdFromHub effect below, which sets step to 'confirm'. Since
    // both are async and whichever resolves last wins, this multi-chain scan
    // (several RPC calls) would often finish after the single getClaim()
    // fetch and silently stomp the correct step back to the selection
    // screen — exactly the "Track Progress flashes then redirects to Claim
    // Funds" bug. Skip the scan entirely in this case.
    if (trackClaimIdFromHub) return

    setStep('loading'); setError('')
    const wallet = await getKey()
    if (!wallet) { setError('Wallet not available'); setStep('failed'); return }
    // BUG FIX (2026-09-21): the manual refresh button called this same scan()
    // with no way to bypass readExternalBalances' own 90s cache (raised from
    // 20s after a real Alchemy 429 incident — see externalBalanceReader.ts's
    // own CACHE_TTL_MS comment). Clicking Refresh twice within that window
    // silently served the SAME cached result both times — the button looked
    // broken even though it technically ran. refreshScope({kind:'external'})
    // is the API this codebase already built for exactly this ("all is
    // reserved for launch / login / wallet-import / explicit manual
    // refresh" — see BlockchainManager.ts's own refreshScope comment) —
    // invalidating just the external-balance cache entries before the read
    // below, so a forced scan is always genuinely fresh.
    if (force) refreshScope({ kind: 'external', wallet: wallet.addr })
    try {
      // Admin-disabled chains must never contribute to claimableTotal —
      // same isChainEnabledForClaim filter Home's scanExternalBalances and
      // the Hub's totalExternal already apply *before* summing. This used
      // to filter only for the chainsWithFunds list further down, so the
      // "Available to Claim" total here still included disabled chains'
      // balances even though the list underneath correctly hid them —
      // that mismatch is exactly why this total never matched Home/Hub.
      const { chains: scanResults } = await readExternalBalances(wallet.addr, settingsMap, settingsLoaded)

      const list: ChainEntry[] = scanResults.map(r => ({
        chainId:   r.chainId,
        claimable: Math.floor(r.balance * 100) / 100,
        pending:   0,
      }))

      const total = list.reduce((s, c) => s + c.claimable, 0)

      setChains(list)
      setClaimableTotal(Math.floor(total * 100) / 100)

    } catch (e) {
      setChains(
        Object.keys(CHAIN_META)
          .filter(id => isChainEnabledForClaim(settingsMap, id))
          .map(id => ({ chainId: id, claimable: 0, pending: 0 }))
      )
    }
    setStep('select')
  }, [getKey, trackClaimIdFromHub, settingsMap, settingsLoaded])

  const handleManualRefresh = useCallback(() => {
    if (Date.now() < refreshCooldownUntil) return
    setRefreshCooldownUntil(Date.now() + REFRESH_COOLDOWN_MS)
    scan(true)
  }, [refreshCooldownUntil, scan])

  // ── Reactive live updates — INSTANT-detect a real external-chain credit ──
  // BUG FIX (2026-09-21): this page previously only ever scanned external
  // balances once on mount (plus the manual refresh button above) — no
  // polling, no live updates at all. If funds arrived on an external chain
  // while this exact page was open, "Available to Claim" just sat there
  // until the user manually refreshed. Same reactive pattern now applied
  // consistently across every page that shows this figure (Home's card,
  // the Hub page, and this one): a Realtime subscription on claims/activity
  // for this wallet, patching ONLY the one chain that actually changed via
  // readExternalChainBalance — not a full rescan — the moment a claim or
  // transfer genuinely completes.
  useEffect(() => {
    if (!walletAddress) return
    let cancelled = false
    const refreshOneChain = (chainId: string) => {
      readExternalChainBalance(chainId as any, walletAddress).then(balance => {
        if (cancelled) return
        setChains(prev => {
          const next = prev.some(c => c.chainId === chainId)
            ? prev.map(c => c.chainId === chainId ? { ...c, claimable: Math.floor(balance * 100) / 100 } : c)
            : [...prev, { chainId, claimable: Math.floor(balance * 100) / 100, pending: 0 }]
          setClaimableTotal(Math.floor(next.reduce((s, c) => s + c.claimable, 0) * 100) / 100)
          return next
        })
      }).catch(() => {})
    }
    let channel: any
    import('@/lib/supabase').then(({ supabase }) => {
      if (cancelled) return
      channel = supabase
        .channel('multichain-claim-page-balance-' + walletAddress.slice(2, 10).toLowerCase())
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
    return () => { cancelled = true; channel?.unsubscribe() }
  }, [walletAddress])

  useEffect(() => {
    scan()
    const loadTxRecords = async () => {
      const addr = (walletAddress || '').toLowerCase()
      if (!addr) { console.warn('[MultichainClaim] no walletAddress'); return }
      try {
        const rows = await fetchActivity(addr, { limit: 50, includePendingBridge: true })
        setTxRecords(rows)
      } catch(e: any) {
        console.error('[MultichainClaim] txRecords error:', e?.message)
      }
    }
    loadTxRecords()
  }, [scan])

  const selectedTotal = useMemo(() => {
    if (!selected) return 0
    return parseFloat(claimAmounts[selected] ?? '0') || 0
  }, [selected, claimAmounts])

  // Falls back to the real server-confirmed amount(s) when selectedTotal is
  // 0 — which is always the case when this screen is reached via the Hub's
  // "Tap to view" deep-link (trackClaimIdFromHub), since that path jumps
  // straight to tracking/done and never populates the local chain-selection
  // state selectedTotal depends on. Without this fallback, Track Progress,
  // the processing screen, and the final "Claim Successful!" screen all
  // showed "$0.00 USDC" for any claim reached this way, even though the
  // real claim amount was known and correct server-side the whole time.
  const displayTotal = useMemo(() => {
    if (selectedTotal > 0) return selectedTotal
    const known = Object.values(claimsByStatus)
    if (known.length > 0) return known.reduce((s, c) => s + (Number(c.arrivedAmount ?? c.amount) || 0), 0)
    return selectedTotal
  }, [selectedTotal, claimsByStatus])

  const selectChain = (id: string) => {
    if (!chains.find(c => c.chainId === id)?.claimable) return
    setDirection('forward')
    setSelected(id)
    setClaimAmounts(prev => ({ ...prev, [id]: '' }))
    setError('')
    setAmountConfirmed(false)
    setKeypadOpen(false)
  }

  // Deep link from Multichain Hub → Bring in (?chain=<id>): open that chain's
  // amount step directly once balances are loaded. Back then returns to the Hub.
  const openedFromHubRef = useRef(false)
  const deepLinkChain = initialChain ?? searchParams.get('chain')
  useEffect(() => {
    if (!deepLinkChain || openedFromHubRef.current || step !== 'select') return
    if (!chains.some(c => c.chainId === deepLinkChain && c.claimable > 0)) return
    openedFromHubRef.current = true
    selectChain(deepLinkChain)
    if (!initialChain) {
      const next = new URLSearchParams(searchParams)
      next.delete('chain')
      setSearchParams(next, { replace: true })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkChain, step, chains])

  const leaveAmountStep = () => {
    setError(''); setAmountConfirmed(false); setKeypadOpen(false)
    if (openedFromHubRef.current) { navigate('/multichain', { state: { tab: 'bring' } }); return }
    setDirection('back'); setSelected(null)
  }

  const executeClaim = useCallback(async (passcode?: string) => {
    if (selectedTotal <= 0) return
    setError('')
    const wallet = await getKey(passcode)
    if (!wallet) { setError('Wallet unavailable'); setStep('failed'); return }

    const selChains = chains
      .filter(c => selected === c.chainId && c.claimable > 0)
      .filter(c => (parseFloat(claimAmounts[c.chainId] ?? '0') || 0) >= 1.00)

    if (selChains.length === 0) {
      setError('Please enter an amount of at least $1.00')
      setStep('failed')
      return
    }

    setChainProgress(selChains.map(c => ({ chainId: c.chainId, stage: 'waiting', msg: 'Queued', pct: 0 })))
    setIsSubmitted(false)
    setClaimRecords([])
    setClaimsByStatus({})
    setConfirmPhase('processing')
    setStep('confirm')
    claimStartRef.current = performance.now()
    setClaimFees({})

    const setChain = (chainId: string, stage: ChainProgress['stage'], msg: string, pct: number, extra?: Partial<ChainProgress>) =>
      setChainProgress(prev => prev.map(p =>
        p.chainId === chainId ? { ...p, stage, msg, pct, ...extra } : p
      ))

    try {

      const depositedChains: Array<{ chainId: string; amount: number }> = []

      const claimOneChain = async (chain: typeof selChains[0]) => {
        const inputAmt    = parseFloat((claimAmounts[chain.chainId] ?? '').replace(/[^0-9.]/g, '')) || 0
        const claimAmount = Math.min(inputAmt, chain.claimable ?? 0)

        // MIN_CLAIM_AMOUNT (module-level, shared with the amount screen's own
        // gate and the pre-claim fee estimate) — see its doc comment.
        if (claimAmount < MIN_CLAIM_AMOUNT) {
          // Previously just `return`ed here with zero feedback — the
          // chain's progress card stayed on whatever it last showed
          // (usually nothing), silently doing nothing with no
          // explanation. Surface it the same way a real failure would be.
          setChain(chain.chainId, 'error', `Minimum $${trimTrailingZeros(MIN_CLAIM_AMOUNT.toFixed(2))} to claim`, 0)
          return
        }

        try {
          setChain(chain.chainId, 'approving', `Approving ${formatAmount(claimAmount)} USDC…`, 25)

          // ── Unified Balance route (Gateway): deposit on source → spend to Arc ──
          const sdkId = toSdkChainId(chain.chainId)
          if ((claimRoute === 'ub' || !isGaslessBridgeAvailable(chain.chainId)) && UB_CLAIM_CHAINS.has(sdkId)) {
            const { AppKit, createEthersAdapterFromPrivateKey } = sdkRef.current ?? await loadSdk()
            const kit = new AppKit({ clientKey: import.meta.env.VITE_KIT_KEY, disableErrorReporting: true } as any)
            const adapter = await buildAdapter(createEthersAdapterFromPrivateKey, wallet.key)
            setUbClaimChains(prev => prev.includes(chain.chainId) ? prev : [...prev, chain.chainId])
            runUbClaim({
              kit, adapter, walletAddr: wallet.addr, sdkChainId: sdkId,
              chainLabel: getMeta(chain.chainId).label, amount: claimAmount,
              onStep: (stage, msg, pct, extra) => {
                setChain(chain.chainId, stage, msg, pct, extra)
                if (stage === 'attesting') {
                  setIsSubmitted(true)
                  setConfirmPhase(phase => phase === 'processing' ? 'submitted' : phase)
                }
                // UB has no server row — the arrival on Arc is the success signal.
                if (stage === 'done') {
                  setConfirmPhase(phase => (phase === 'processing' || phase === 'submitted' || phase === 'tracking') ? 'done' : phase)
                }
              },
            }).catch((e: any) => {
              const msg = String(e?.shortMessage ?? e?.message ?? 'Claim failed').slice(0, 160)
              setChain(chain.chainId, 'error', msg, 0)
              // Failed before the deposit went through → nothing moved; show the failed screen.
              // After the deposit, the funds sit in Unified Balance and Track Progress explains it.
              setChainProgress(prev => {
                const cp = prev.find(p => p.chainId === chain.chainId)
                if (!cp?.txHash) { setError(msg); setTimeout(() => setStep('failed'), 300) }
                return prev
              })
            })
            return { chainId: chain.chainId, amount: claimAmount }
          }

          // Burn confirmed on-chain — record the claim and show "Claim
          // Submitted" right away.
          const handOffBurn = (cid: string, txHash: string, amount: number) => {
            submitClaim({ walletAddress: wallet.addr, sourceChain: cid, amount, txHash }).then(res => {
              if (res.success && res.claimId) {
                setClaimRecords(prev =>
                  prev.some(r => r.chainId === cid) ? prev : [...prev, { chainId: cid, claimId: res.claimId! }]
                )
                // Show the "Claim Submitted" screen (with View in Hub /
                // Track Progress buttons) the instant submission is
                // confirmed — previously there was an extra artificial
                // 550ms pause here on top of submitClaim()'s own network
                // latency, making the buttons appear noticeably late.
                setConfirmPhase(phase => phase === 'processing' ? 'submitted' : phase)
              }
            })
          }

          // ── Gasless route (MeshPortBridgeRouter) ──
          // One signature, no gas on the source chain: the relayer submits it,
          // MeshPort's fee is taken in the same transaction, and Circle's
          // forwarder mints on Arc. The only CCTP route — chains without a
          // router (VITE_BRIDGE_ROUTERS) aren't offered.
          if (!isGaslessBridgeAvailable(chain.chainId)) throw new Error('Bring Funds is not available for this chain')
          const r = await bringFundsGasless({
            chainId: chain.chainId, amountUsdc: claimAmount, privateKey: wallet.key, walletAddress: wallet.addr,
            onStatus: msg => setChain(chain.chainId, 'burning', msg, 45),
          })
          setClaimFees(prev => ({ ...prev, [chain.chainId]: r.fee + r.maxFee }))
          setIsSubmitted(true)
          setChain(chain.chainId, 'attesting', 'Burn confirmed — Circle processing…', 65, { txHash: r.txHash })
          // The claim is the burned amount: MeshPort's fee was taken before the burn.
          handOffBurn(chain.chainId, r.txHash, Math.max(0, claimAmount - r.fee))
          return { chainId: chain.chainId, amount: claimAmount }

        } catch (e: any) {
          setChain(chain.chainId, 'error', (e?.message ?? 'Claim failed').slice(0, 80), 0)
          return null
        }
      }

      for (const chain of selChains) {
        const result = await claimOneChain(chain)
        if (result) depositedChains.push(result)
      }

      if (depositedChains.length === 0) {
        const failedSummary = selChains
          .map(c => {
            const cp = chainProgress.find(p => p.chainId === c.chainId)
            return `${getMeta(c.chainId).label}: ${cp?.msg ?? 'failed'}`
          }).join('\n')
        setError(failedSummary)
        setStep('failed'); return
      }

    } catch (e: any) {
      const msg = e?.shortMessage ?? e?.message ?? 'Claim failed'
      console.error('[Claim] error:', e)
      setError(msg)
      setChainProgress(prev => prev.map(p => p.stage !== 'done' ? { ...p, stage: 'error', msg: 'Failed', pct: 0 } : p))
      setStep('failed')
    }
  }, [selectedTotal, chains, selected, claimAmounts, getKey, loadSdk, claimRoute])

  const handleClaimTap = useCallback(async () => {
    if (selectedTotal <= 0) return
    if (storedPasscode) {
      setPassEntry('')
      setPassError('')
      setShowPasscodeSheet(true)
      return
    }
    setConfirmPhase('processing')
    setStep('confirm')
    await executeClaim()
  }, [selectedTotal, storedPasscode, executeClaim])

  const handlePasscodeConfirm = useCallback(async () => {
    if (passEntry.length < 6) { setPassError('Enter your 6-digit passcode'); return }
    // PERF FIX (transaction-speed audit): kick off private-key restore
    // concurrently with verifyPasscode below instead of after it — see
    // PaySendPage.tsx's own verifyAndSend for the full reasoning (two
    // independent PBKDF2 derives from the same passcode, otherwise run
    // back-to-back). `silent: true` so a wrong PIN doesn't flip on the
    // wallet-recovery banner before "Incorrect passcode" below even shows.
    import('@/lib/restoreWallet').then(({ restorePrivateKey }) => restorePrivateKey(passEntry, { silent: true })).catch(() => {})
    const { verifyPasscode } = await import('@/lib/security')
    if (!await verifyPasscode(passEntry, storedPasscode!)) {
      setPassError('Incorrect passcode'); setPassEntry(''); return
    }
    const enteredPasscode = passEntry
    setPassError(''); setPassEntry('')
    setShowPasscodeSheet(false)
    setConfirmPhase('processing')
    setStep('confirm')
    // Passed through to getKey() as an authoritative fallback (see its own
    // BUG FIX comment) — never used for the speculative restore above (that
    // one is already in flight/done via the shared single-flight guard).
    await executeClaim(enteredPasscode)
  }, [passEntry, storedPasscode, executeClaim])

  const selectedChain = chains.find(c => c.chainId === selected)

  // ─── Receive summary / estimate readiness (shared by both render spots
  // below — the reordered desktop pre-confirm position and the original
  // mobile/post-confirm position) ─────────────────────────────────────────
  const claimAmt = parseFloat(claimAmounts[selected ?? ''] ?? '0') || 0
  const claimEstimateIsLive = feeEstimate.forKey === `${selected}|${claimAmt}`
  const showClaimEstimateRow = claimAmt >= MIN_CLAIM_AMOUNT
  const estimateReady = showClaimEstimateRow && claimEstimateIsLive && !feeEstimate.loading && !feeEstimate.error
  const canConfirm = claimAmt >= MIN_CLAIM_AMOUNT && claimAmt <= (selectedChain?.claimable ?? 0) && estimateReady
  // Route (CCTP vs Unified Balance) — UB only for chains Gateway supports.
  const selectedSdkId = selected ? toSdkChainId(selected) : ''
  const ubAvailable = UB_CLAIM_CHAINS.has(selectedSdkId)
  // CCTP here is the gasless router; a chain without one is Unified Balance only.
  const cctpAvailable = !!selected && isGaslessBridgeAvailable(selected)
  const effectiveRoute: 'cctp' | 'ub' = !ubAvailable ? 'cctp' : !cctpAvailable ? 'ub' : claimRoute
  const reviewEnabled = claimAmt >= MIN_CLAIM_AMOUNT && claimAmt <= (selectedChain?.claimable ?? 0) && (effectiveRoute === 'ub' || estimateReady)
  // BUG FIX (live report): previously showed the raw, fee-less amount here
  // the instant it was typed while the fee row below still said
  // "Estimating…" -- two numbers appearing at different times, one of
  // which (the fee-less one) was never actually correct. Now both the
  // receive amount and the fee show "Calculating…"/blank together and
  // flip to real numbers together, once the estimate for this exact amount
  // actually succeeds.
  const claimReceiveLabel = !showClaimEstimateRow
    ? `$${formatAmount(claimAmt)} on Arc`
    : estimateReady
    ? `at least $${formatAmount(feeEstimate.receiverGets)} on Arc`
    : 'Calculating…'
  const feeRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 11, color: COLORS.muted, fontVariantNumeric: 'tabular-nums' }
  const fmtFee = (n: number) => `$${trimTrailingZeros(n.toFixed(4))} USDC`
  const receiveSummaryCard = (
    <div style={{
      width: '100%', background: COLORS.surfaceSecondary, border: `1px solid ${COLORS.border}`,
      borderRadius: RADII.input, padding: `${SPACING.sm}px ${SPACING.md}px`, marginTop: SPACING.sm,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, color: COLORS.muted }}>You will receive</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: COLORS.text }}>{claimReceiveLabel}</span>
      </div>
      {showClaimEstimateRow && (
        <div style={{ marginTop: 6, paddingTop: 6, borderTop: `1px solid ${COLORS.border}`, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {(!claimEstimateIsLive || feeEstimate.loading) ? (
            <div style={feeRowStyle}><span>Fees</span><span>Calculating…</span></div>
          ) : feeEstimate.error ? (
            <div style={{ ...feeRowStyle, color: COLORS.error }}><span>Fees</span><span style={{ textAlign: 'right' }}>{feeEstimate.error}</span></div>
          ) : (
            <>
              <div style={feeRowStyle}>
                <span>Network gas</span>
                <span>{fmtFee(feeEstimate.networkFee)}</span>
              </div>
              <div style={feeRowStyle}>
                <span>Circle bridge fee</span>
                <span>up to {fmtFee(feeEstimate.bridgeFee)}</span>
              </div>
              <div style={{ ...feeRowStyle, color: COLORS.text, fontWeight: 600 }}>
                <span>Total fees</span>
                <span>up to {fmtFee(feeEstimate.totalFee)}</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )

  const chainsWithFunds  = chains
    .filter(c => c.claimable > 0 || c.pending > 0)
    // Merchants: Unified Balance chains only (no CCTP-only chains).
    .filter(c => !merchantMode || UB_CLAIM_CHAINS.has(toSdkChainId(c.chainId)))
    // Only chains Bring Funds can actually move: a gasless router, or Unified Balance.
    .filter(c => isGaslessBridgeAvailable(c.chainId) || UB_CLAIM_CHAINS.has(toSdkChainId(c.chainId)))
    // `chains` only ever contains enabled chains to begin with — scan()
    // above reads via readExternalBalances, which is already settings-aware
    // and never even fetches a disabled chain's balance. This filter is now
    // just a safety net; disabledClaimChains below is what actually
    // surfaces disabled chains in the list.
    .filter(c => isChainEnabledForClaim(settingsMap, c.chainId))
    // Highest balance first — makes the biggest claimable amounts the most
    // prominent/easiest to act on instead of showing in arbitrary chain
    // config order.
    .sort((a, b) => (b.claimable + b.pending) - (a.claimable + a.pending))

  // Admin-disabled Claim chains — shown in the list too (dimmed,
  // unclickable, with a reason) instead of silently disappearing, so
  // someone with funds sitting on a chain that just got disabled can see
  // why it's temporarily unavailable instead of wondering where it went.
  // Never counted in claimableTotal — that total is summed in scan() from
  // readExternalBalances, which skips disabled chains entirely and never
  // reads their balance in the first place, so there's nothing of theirs
  // to (mis)count here.
  const disabledClaimChains = Object.keys(CHAIN_META)
    .filter(id => !isChainEnabledForClaim(settingsMap, id))
    .filter(id => !merchantMode || UB_CLAIM_CHAINS.has(toSdkChainId(id)))
    .filter(id => isGaslessBridgeAvailable(id) || UB_CLAIM_CHAINS.has(toSdkChainId(id)))
    .map(id => ({
      chainId: id,
      // Lets an admin set a specific reason per chain by putting text in
      // that chain's chains_claim toggle row (the `value` column — same
      // free-text field maintenance_mode already uses for its message).
      // Falls back to a generic reason when nothing's been set.
      reason: settingsMap[CHAIN_CLAIM_FEATURE_MAP[id]]?.value || 'Upgrading — coming soon',
    }))

  // ─── Render ──────────────────────────────────────────────────────────────────

  // Held in a variable (not returned directly) so the exact same JSX renders
  // either as the whole page (mobile) or as the left column of the desktop
  // 2-column layout below — never duplicated.
  // Desktop: no root-level overflow-hidden — each screen already has its
  // own bounded height + inner scroll container (mobile's proven
  // pattern), and the desktop column wrapping `flow` already has its own
  // overflowY:'auto'. Hard-clipping here too (on top of that) was cutting
  // off the bottom of tall content — the Success screen's summary card +
  // buttons — with no way to reach it, since this was the innermost clip
  // boundary. Mobile keeps overflow-hidden, unchanged.
  const flow = (
    <div ref={flowRootRef} style={{ background: COLORS.bg, display: 'flex', flexDirection: 'column', height: '100%',
      // Inside the Hub: clip only sideways (the step slide-ins) — never
      // vertically, so the amount form can glide up over the Hub's balance
      // card and tabs when the keypad opens, like Transfer.
      ...(isDesktop ? { overflow: 'visible' } : embedded ? { overflowX: 'clip', overflowY: 'visible' } : { overflow: 'hidden' }) }}>

      {/* LOADING STATE — chains scroll horizontally through a fixed scan
          line, like a barcode scanner, using real chain logos rather than
          a generic spinner. Purely decorative/illustrative (not literally
          tied to per-chain completion) — same idea as the Hub's chain list,
          just the enabled set for Claim specifically.

          Wrapped in the AnimatePresence below (shared with the chain-select
          screen) so finishing the scan crossfades smoothly into the results
          instead of instantly cutting from one screen to the other — that
          instant, un-animated unmount/mount swap was the "flicker" when the
          scan ended. */}
      <AnimatePresence initial={false} mode="wait">
      {step === 'loading' && (
        <motion.div
          key="loading"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.25, ease: 'easeInOut' }}
          style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: SPACING.lg }}
        >
          {deepLinkChain ? (
            // Opened from a chain card in the Hub, which already scanned —
            // just a short "opening <chain>" state while its balance loads.
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <div style={{ position: 'relative', width: 64, height: 64, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {/* CSS animation, not framer: this sits under the
                    AnimatePresence initial={false} below, which blocks every
                    descendant motion element's first animation — so a framer
                    spin here never started and the ring looked frozen. */}
                <span aria-hidden className="mp-ring-spin"
                  style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '2.5px solid transparent', borderTopColor: 'var(--brand)', borderRightColor: 'color-mix(in srgb, var(--brand) 40%, transparent)' }} />
                <ChainLogo chainId={deepLinkChain} size={46} />
              </div>
              <p style={{ fontSize: 15, fontWeight: 700, color: COLORS.text, margin: 0 }}>Opening {getMeta(deepLinkChain).label}…</p>
            </div>
          ) : (
          <div style={{ width: '100%', maxWidth: 360, padding: `0 ${SPACING.md}px`, boxSizing: 'border-box' }}>
            <ChainScanner
              logos={Object.keys(CHAIN_META).filter(id => isChainEnabledForClaim(settingsMap, id)).map(id => ({ src: getMeta(id).logo, alt: getMeta(id).label }))}
              subtitle="Finding your available funds…" />
          </div>
          )}
        </motion.div>
      )}

      {/* CHAIN SELECTION - MeshPort V2 Premium Cards */}
      {step === 'select' && !selectedChain && (
        <motion.div
          key="select"
          {...(direction === 'back'
            ? (reduceMotion
                ? { initial: false, animate: { opacity: 1 }, exit: { opacity: 0 } }
                : { ...slideStepVariants('back'), exit: { opacity: 0 } })
            : { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } })}
          transition={direction === 'back' ? MOBILE_SLIDE_TRANSITION : { duration: 0.25, ease: 'easeInOut' }}
          style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
        >
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `${SPACING.sm}px ${SPACING.md}px`, background: COLORS.bg, borderBottom: `1px solid ${COLORS.border}`, flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm }}>
              {!isDesktop && (
                <button onClick={() => navigate('/multichain')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: COLORS.text, display: 'flex', alignItems: 'center' }}>
                  <ArrowLeft className="w-5 h-5"/>
                </button>
              )}
              <span style={{ fontSize: 18, fontWeight: 700, color: COLORS.text }}>Claim Funds</span>
            </div>
            <button
              onClick={handleManualRefresh}
              disabled={refreshCooldownSecsLeft > 0}
              title={refreshCooldownSecsLeft > 0 ? `Refresh again in ${refreshCooldownSecsLeft}s` : 'Refresh'}
              style={{
                background: 'none', border: 'none', padding: 2, color: COLORS.text, display: 'flex', alignItems: 'center', gap: 4,
                cursor: refreshCooldownSecsLeft > 0 ? 'default' : 'pointer',
                opacity: refreshCooldownSecsLeft > 0 ? 0.5 : 1,
              }}
            >
              <RefreshCw className="w-5 h-5"/>
              {refreshCooldownSecsLeft > 0 && (
                <span style={{ fontSize: 11, fontWeight: 700, color: COLORS.muted }}>{refreshCooldownSecsLeft}s</span>
              )}
            </button>
          </div>

          {/* Body */}
          <div style={{ flex: 1, overflowY: 'auto', padding: `${SPACING.md}px ${SPACING.md}px ${SPACING.xl}px`, minHeight: 0 }}>
            {/* Available Total Card */}
            <motion.div
              initial={{ opacity: 0, y: MOBILE_TAB_FADE_Y }} animate={{ opacity: 1, y: 0 }} transition={MOBILE_TAB_FADE_TRANSITION}
              style={{
                background: COLORS.surface,
                borderRadius: 18,
                padding: `${SPACING.lg - 2}px ${SPACING.lg}px`,
                marginBottom: SPACING.lg,
                border: `1px solid ${COLORS.border}`,
              }}
            >
              <p style={{ fontSize: 12, color: COLORS.muted, margin: '0 0 8px', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}>Available to Claim</p>
              <p style={{ fontSize: 36, fontWeight: 700, color: claimableTotal > 0 ? COLORS.success : COLORS.text, margin: '0 0 4px', letterSpacing: '-0.5px' }}>
                ${formatAmount(claimableTotal)}
              </p>
              <p style={{ fontSize: 12, color: COLORS.muted, margin: 0 }}>Across {chainsWithFunds.length} chain{chainsWithFunds.length !== 1 ? 's' : ''}</p>
            </motion.div>

            {(chainsWithFunds.length > 0 || disabledClaimChains.length > 0) ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.md }}>
                {chainsWithFunds.map((c, i) => {
                  const m = getMeta(c.chainId)
                  const isSelectable = c.claimable > 0
                  return (
                    <motion.div
                      key={c.chainId}
                      initial={{ opacity: 0, y: MOBILE_TAB_FADE_Y }} animate={{ opacity: isSelectable ? 1 : 0.5, y: 0 }}
                      transition={MOBILE_TAB_FADE_TRANSITION}
                      whileTap={isSelectable ? { scale: 0.98 } : {}}
                      whileHover={isSelectable ? { borderColor: COLORS.primary, y: -2 } : {}}
                      onClick={() => isSelectable && selectChain(c.chainId)}
                      style={{
                        background: COLORS.surface,
                        border: `1px solid ${COLORS.border}`,
                        borderRadius: 18,
                        padding: `${SPACING.lg - 2}px ${SPACING.lg}px`,
                        display: 'flex',
                        alignItems: 'center',
                        gap: SPACING.lg,
                        cursor: isSelectable ? 'pointer' : 'default',
                        transition: 'all 0.2s ease',
                      }}
                    >
                      <ChainLogo chainId={c.chainId} size={40}/>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
                          <p style={{ fontSize: 15, fontWeight: 600, color: COLORS.text, margin: 0 }}>
                            {m.label}
                          </p>
                        </div>
                        <p style={{ fontSize: 13, color: COLORS.muted, margin: 0 }}>
                          {c.claimable > 0 ? `$${formatAmount(c.claimable)} available` : 'No balance'}
                        </p>
                      </div>
                      {isSelectable && (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={COLORS.primary} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M9 18l6-6-6-6"/>
                        </svg>
                      )}
                    </motion.div>
                  )
                })}
                {/* Admin-disabled chains — dimmed, unclickable, reason
                    shown in place of a balance. Sorted after every enabled
                    chain (funded or not) so they never push real, actionable
                    balances further down the list. */}
                {disabledClaimChains.map((c, i) => {
                  const m = getMeta(c.chainId)
                  return (
                    <motion.div
                      key={c.chainId}
                      initial={{ opacity: 0, y: MOBILE_TAB_FADE_Y }} animate={{ opacity: 0.45, y: 0 }}
                      transition={MOBILE_TAB_FADE_TRANSITION}
                      style={{
                        background: COLORS.surface,
                        border: `1px solid ${COLORS.border}`,
                        borderRadius: 18,
                        padding: `${SPACING.lg - 2}px ${SPACING.lg}px`,
                        display: 'flex',
                        alignItems: 'center',
                        gap: SPACING.lg,
                        cursor: 'not-allowed',
                      }}
                    >
                      <ChainLogo chainId={c.chainId} size={40}/>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: 15, fontWeight: 600, color: COLORS.text, margin: '0 0 4px' }}>
                          {m.label}
                        </p>
                        <p style={{ fontSize: 13, color: COLORS.muted, margin: 0 }}>
                          {c.reason}
                        </p>
                      </div>
                    </motion.div>
                  )
                })}
              </div>
            ) : (
              <motion.div
                initial={{ opacity: 0, y: MOBILE_TAB_FADE_Y }} animate={{ opacity: 1, y: 0 }} transition={MOBILE_TAB_FADE_TRANSITION}
                style={{ textAlign: 'center', padding: `${SPACING.xl * 2}px ${SPACING.md}px`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 200 }}
              >
                <Globe className="w-12 h-12 mx-auto mb-3" style={{ color: COLORS.muted, opacity: 0.5 }}/>
                <p style={{ fontSize: 15, color: COLORS.muted, margin: 0 }}>No funds available yet</p>
                <p style={{ fontSize: 12, color: COLORS.muted, margin: '4px 0 0', opacity: 0.7 }}>Transfer USDC to start claiming</p>
              </motion.div>
            )}
          </div>
        </motion.div>
      )}

      {/* AMOUNT ENTRY SCREEN (same page as chain selection) */}
      {step === 'select' && selectedChain && (
        <motion.div
          key="amount-step"
          {...(reduceMotion ? { initial: false, animate: { opacity: 1, x: 0 } } : slideStepVariants(direction))}
          transition={MOBILE_SLIDE_TRANSITION}
          onClick={() => { if (keypadOpen) setKeypadOpen(false) }}
          style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
        >
          {/* Header — hidden inside the Hub (the form has its own Back) */}
          {!embedded && <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.md, padding: `${SPACING.sm}px ${SPACING.md}px`, background: COLORS.bg, borderBottom: `1px solid ${COLORS.border}`, flexShrink: 0 }}>
            {!isDesktop && (
              <button onClick={e => { e.stopPropagation(); leaveAmountStep() }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: COLORS.text, display: 'flex', alignItems: 'center' }}>
                <ArrowLeft className="w-5 h-5"/>
              </button>
            )}
            <ChainLogo chainId={selectedChain.chainId} size={28}/>
            <span style={{ fontSize: 16, fontWeight: 700, color: COLORS.text }}>{getMeta(selectedChain.chainId).label}</span>
          </div>}

          {/* Bring Funds form (Arc Bridge layout, MeshPort brand):
              From → Amount → Route → Destination → Back / Review & Claim.
              Review & Claim goes to the same passcode + claim flow as before. */}
          {/* Inside the Hub the page itself scrolls — this box must not clip, so
              the lifted form can slide up over the Hub's balance card and tabs
              exactly like Transfer does. */}
          <div style={{ flex: 1, minHeight: 0, overflowY: embedded ? 'visible' : 'auto', padding: `${SPACING.lg}px ${SPACING.lg}px`, paddingBottom: SPACING.xl }}>
            {/* Glides up with the keypad (same as Transfer) so the amount stays in view. */}
            <motion.div animate={{ y: -keypadLift }} initial={false} transition={KEYPAD_SPRING}
              style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 22, padding: isDesktop ? 20 : 18, display: 'flex', flexDirection: 'column', gap: 16 }}>

              {/* Title */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 44, height: 44, borderRadius: 14, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'color-mix(in srgb, var(--brand) 16%, transparent)', border: '1px solid color-mix(in srgb, var(--brand) 30%, transparent)' }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v12M6 11l6 6 6-6M5 20h14"/></svg>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 19, fontWeight: 800, color: COLORS.text, letterSpacing: '-0.3px' }}>Bring Funds to Arc</div>
                  <div style={{ fontSize: 13, color: COLORS.muted, marginTop: 2 }}>Move USDC from any chain to Arc Testnet</div>
                </div>
              </div>

              {/* From */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 16,
                background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)', border: `1px solid ${COLORS.border}` }}>
                <ChainLogo chainId={selectedChain.chainId} size={32}/>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: COLORS.muted }}>From</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{getMeta(selectedChain.chainId).label}</div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 12, color: COLORS.muted }}>Available</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: COLORS.text, fontVariantNumeric: 'tabular-nums' }}>{formatAmount(selectedChain.claimable)} USDC</div>
                </div>
              </div>

              {/* Amount */}
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text, marginBottom: 8 }}>Amount (USDC)</div>
                {desktopInput ? (
                  <div ref={amountBoxRef}>
                    <DesktopAmountInput
                      value={claimAmounts[selected!] ?? ''}
                      onChange={v => { setClaimAmounts(prev => ({ ...prev, [selected!]: sanitizeClaimAmount(v) })); setError('') }}
                      onMax={() => {
                        setClaimAmounts(prev => ({ ...prev, [selected!]: parseFloat(selectedChain.claimable.toFixed(2)).toString() }))
                        setError('')
                      }}
                      invalid={!!error || (claimAmt > 0 && claimAmt < MIN_CLAIM_AMOUNT)}
                      ariaLabel="Amount in USDC"
                    />
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, gap: 8, fontSize: 12.5 }}>
                      <span style={{ color: COLORS.muted }}>Available: {formatAmount(selectedChain.claimable)} USDC</span>
                      {claimAmt > 0 && claimAmt < MIN_CLAIM_AMOUNT && (
                        <span style={{ fontWeight: 700, color: COLORS.error }}>Minimum ${trimTrailingZeros(MIN_CLAIM_AMOUNT.toFixed(2))}</span>
                      )}
                    </div>
                  </div>
                ) : (
                  <div ref={amountBoxRef}
                    onClick={e => { e.stopPropagation(); setAmountConfirmed(false); setKeypadOpen(true) }}
                    style={{ padding: '14px 16px', borderRadius: 16, cursor: 'pointer',
                      background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)',
                      border: `1.5px solid ${keypadOpen ? COLORS.primary : error ? COLORS.error : COLORS.border}` }}>
                    <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: '-0.5px', lineHeight: 1.15, fontVariantNumeric: 'tabular-nums',
                      color: claimAmounts[selected!] ? COLORS.text : 'color-mix(in srgb, var(--text-primary) 25%, transparent)' }}>
                      {claimAmounts[selected!] || '0.00'}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6, gap: 8 }}>
                      <span style={{ fontSize: 13, color: COLORS.muted }}>USDC</span>
                      {claimAmt > 0 && claimAmt < MIN_CLAIM_AMOUNT ? (
                        <span style={{ fontSize: 12, fontWeight: 700, color: COLORS.error }}>Minimum ${trimTrailingZeros(MIN_CLAIM_AMOUNT.toFixed(2))}</span>
                      ) : (
                        <button
                          onClick={e => {
                            e.stopPropagation()
                            setClaimAmounts(prev => ({ ...prev, [selected!]: parseFloat(selectedChain.claimable.toFixed(2)).toString() }))
                            setError('')
                          }}
                          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 13, fontWeight: 600, color: COLORS.primary }}>
                          Max: {formatAmount(selectedChain.claimable)}
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {!desktopInput && !amountConfirmed && !keypadOpen && !claimAmt && (
                  <p style={{ fontSize: 12, color: COLORS.muted, margin: '6px 0 0' }}>Tap the amount to enter a value</p>
                )}
              </div>

              {/* Route */}
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text, marginBottom: 8 }}>Route</div>
                <div style={{ display: 'flex', gap: 10 }}>
                  {([
                    { id: 'ub' as const,   name: 'Unified Balance', text: `Gateway · ${ubClaimEta(selectedSdkId).replace('minutes', 'min').replace('minute', 'min')}`, show: ubAvailable,
                      icon: <path d="M13 2L4 14h7l-1 8 9-12h-7z"/> },
                    { id: 'cctp' as const, name: 'CCTP',            text: 'Gasless · one signature', show: !merchantMode && cctpAvailable,
                      icon: <path d="M4 8h14l-3-3M20 16H6l3 3"/> },
                  ]).filter(r => r.show).map(r => {
                    const on = effectiveRoute === r.id
                    return (
                      <button key={r.id} onClick={() => setClaimRoute(r.id)}
                        style={{ flex: 1, minWidth: 0, height: 68, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 10,
                          textAlign: 'left', padding: '0 12px', borderRadius: 16, cursor: 'pointer',
                          background: on ? 'color-mix(in srgb, var(--brand) 14%, transparent)' : 'color-mix(in srgb, var(--text-primary) 5%, transparent)',
                          border: on ? '1.5px solid var(--brand)' : `1px solid ${COLORS.border}` }}>
                        <span style={{ width: 32, height: 32, borderRadius: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          background: on ? 'color-mix(in srgb, var(--brand) 22%, transparent)' : 'color-mix(in srgb, var(--text-primary) 7%, transparent)' }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={on ? 'var(--brand)' : 'var(--text-secondary)'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{r.icon}</svg>
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'block', fontSize: 14, fontWeight: 700, color: on ? 'var(--brand)' : COLORS.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
                          <span style={{ display: 'block', fontSize: 11.5, color: COLORS.muted, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.text}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
                {effectiveRoute === 'ub' && (
                  <div style={{ fontSize: 12, lineHeight: 1.45, color: COLORS.muted, marginTop: 8 }}>
                    Your USDC goes into your Unified Balance, then to your Arc wallet. Circle's Gateway fee is taken when it's sent to Arc. If you leave before it finishes, finish it from Multichain Hub → Recover.
                  </div>
                )}
              </div>

              {/* Destination */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderRadius: 16,
                background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)', border: `1px solid ${COLORS.border}` }}>
                <span style={{ fontSize: 14, color: COLORS.muted }}>Destination</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: COLORS.text }}>Arc Testnet</span>
              </div>

              {/* Fee summary (unchanged) — CCTP only; the UB route's fee comes from Gateway at send time */}
              {effectiveRoute === 'cctp' && receiveSummaryCard}

              {error && <p role="alert" style={{ fontSize: 13, color: COLORS.error, margin: 0, textAlign: 'center' }}>{error}</p>}

              {/* Back / Review & Claim */}
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={e => { e.stopPropagation(); leaveAmountStep() }}
                  className="active:scale-[.98] transition-all"
                  style={{ flex: 1, padding: '14px 0', borderRadius: 16, fontSize: 15, fontWeight: 600, cursor: 'pointer',
                    color: COLORS.muted, background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)', border: `1px solid ${COLORS.border}` }}>
                  Back
                </button>
                <button
                  onClick={e => {
                    e.stopPropagation()
                    const amt = parseFloat(claimAmounts[selected!] ?? '0') || 0
                    if (amt < MIN_CLAIM_AMOUNT) { setError(`Minimum $${trimTrailingZeros(MIN_CLAIM_AMOUNT.toFixed(2))}`); return }
                    if (amt > selectedChain.claimable) { setError('Exceeds available balance'); return }
                    if (effectiveRoute === 'cctp' && !estimateReady) return
                    setAmountConfirmed(true)
                    setKeypadOpen(false)
                    handleClaimTap()
                  }}
                  disabled={!reviewEnabled}
                  className="active:scale-[.98] transition-all"
                  style={{ flex: 1, padding: '14px 0', borderRadius: 16, fontSize: 15, fontWeight: 700, border: 'none', color: '#fff',
                    background: COLORS.primary, cursor: reviewEnabled ? 'pointer' : 'not-allowed', opacity: reviewEnabled ? 1 : 0.45 }}>
                  Review &amp; Claim
                </button>
              </div>
            </motion.div>
          </div>

          {/* Amount Keypad — mobile only; Done just closes it (Review & Claim is on the card). */}
          {!desktopInput && (
            <div className="keypad-eraser-fix" onClick={e => e.stopPropagation()}>
              <AmountKeypad
                open={keypadOpen && !showPasscodeSheet}
                value={claimAmounts[selected!] ?? ''}
                onChange={v => { setClaimAmounts(prev => ({ ...prev, [selected!]: v })); setError('') }}
                balance={selectedChain.claimable}
                token="USDC"
                quickAmounts={[10, 25, 50, 100]}
                doneLabel="Done"
                doneEnabled={true}
                error={claimAmt > 0 && claimAmt < MIN_CLAIM_AMOUNT ? `Minimum $${trimTrailingZeros(MIN_CLAIM_AMOUNT.toFixed(2))}` : ''}
                onClose={() => setKeypadOpen(false)}
                onDone={() => {
                  const amt = parseFloat(claimAmounts[selected!] ?? '0') || 0
                  if (amt > selectedChain.claimable) { setError('Exceeds available balance'); return }
                  setAmountConfirmed(true)
                  setKeypadOpen(false)
                }}
              />
            </div>
          )}

          {/* Passcode Sheet / Dialog — opens on this same page, no navigation */}
          <AnimatePresence>
            {showPasscodeSheet && (() => {
              const passContent = (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 4 }}>
                    <p style={{ fontSize: 18, fontWeight: 700, color: COLORS.text, margin: 0 }}>Enter Passcode</p>
                    <button
                      onClick={() => { setShowPasscodeSheet(false); setPassEntry(''); setPassError('') }}
                      aria-label="Dismiss"
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer', padding: 4,
                        color: COLORS.muted, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="6 9 12 15 18 9"/>
                      </svg>
                    </button>
                  </div>
                  <div style={{ textAlign: 'center', marginBottom: 28 }}>
                    <p style={{ fontSize: 12, color: COLORS.muted, margin: '6px 0 0' }}>
                      {passError
                        ? <span role="alert" style={{ color: COLORS.error }}>Incorrect passcode. Try again.</span>
                        : `Confirm claim of $${formatAmount(selectedTotal)} USDC`}
                    </p>
                  </div>
                  <div style={{ width: '100%' }}>
                    <PinKeypad
                      value={passEntry}
                      onChange={v => { setPassEntry(v); setPassError('') }}
                      length={6}
                      error={!!passError}
                      shake={!!passError}
                      onComplete={(_, viaBiometric) => { setPaidViaBiometric(!!viaBiometric); handlePasscodeConfirm() }}
                    />
                  </div>
                  {passError && <p role="alert" style={{ fontSize: 12, color: COLORS.error, textAlign: 'center', marginTop: 16 }}>{passError}</p>}
                </>
              )

              if (desktopInput) {
                return (
                  <DesktopTransactionAuthDialog
                    onClose={() => { setShowPasscodeSheet(false); setPassEntry(''); setPassError('') }}
                    title="Authorize Claim"
                    amountLabel={`$${formatAmount(selectedTotal)} USDC`}
                    subLabel={`From ${selectedChain ? getMeta(selectedChain.chainId).label : 'Multichain'}`}
                  >
                    {passError && <p role="alert" style={{ fontSize: 12, color: COLORS.error, textAlign: 'center', marginBottom: 16 }}>Incorrect passcode. Try again.</p>}
                    <PinKeypad
                      value={passEntry}
                      onChange={v => { setPassEntry(v); setPassError('') }}
                      length={6}
                      error={!!passError}
                      shake={!!passError}
                      onComplete={(_, viaBiometric) => { setPaidViaBiometric(!!viaBiometric); handlePasscodeConfirm() }}
                    />
                  </DesktopTransactionAuthDialog>
                )
              }
              return (
                <>
                  <motion.div
                    key="pass-backdrop"
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    transition={SHEET_BACKDROP.transition}
                    onClick={() => { setShowPasscodeSheet(false); setPassEntry(''); setPassError('') }}
                    style={{ position: 'fixed', top: 0, bottom: 0, left: 0, right: 0, maxWidth: 430, margin: '0 auto', zIndex: 60, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)' }}
                  />
                  <motion.div {...sheetDrag('mc-pass', () => { setShowPasscodeSheet(false); setPassEntry(''); setPassError('') })}
                    key="pass-sheet"
                    initial={{ y: '100%' }} animate={{ y: 0 }} exit={SHEET_EXIT}
                    transition={SHEET_SPRING}
                    style={{
                      position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 70,
                      maxWidth: 430, margin: '0 auto',
                      background: COLORS.surface, borderRadius: '24px 24px 0 0',
                      borderTop: `1px solid ${COLORS.border}`, padding: `${SPACING.md}px ${SPACING.xl}px ${SPACING.xl * 1.5}px`,
                      display: 'flex', flexDirection: 'column', alignItems: 'center',
                    }}
                  >
                    <div style={{ width: 36, height: 4, borderRadius: 2, background: 'color-mix(in srgb, var(--text-primary) 18%, transparent)', margin: '4px 0 18px' }} />
                    {passContent}
                  </motion.div>
                </>
              )
            })()}
          </AnimatePresence>
        </motion.div>
      )}

      {/* ── PAGE 2: processing -> done, same page ── */}
      {step === 'confirm' && (
        <motion.div
          key="confirm-step"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.25, ease: 'easeInOut' }}
          style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
        >
          {/* PROCESSING -> SUBMITTED — one continuous screen. The icon and
              title update (spinner/"Processing claim" -> paper-plane/"Claim
              Submitted") and the extra text + countdown + buttons fade in
              underneath, but the stepper itself never resets or swaps out —
              it's the same checklist throughout, not two separate screens. */}
          {/* Success flash (portaled), drawn over the live view underneath.
              It stays until the receipt's check circle has mounted, so the
              live view is never uncovered in between. */}
          {confirmPhase === 'done' && (successPhase === 'flash' || !heroCheckEl) && (
            <SuccessFlash title="Claimed Successfully" checkRef={flashCheckRef} viaBiometric={paidViaBiometric} circleReady={flashCircleReady} onCircleReady={() => setFlashCircleReady(true)} rect={isDesktopMq ? flashColumnRect : null} radius={RADII.card} />
          )}
          <AnimatePresence mode="wait">
          {(confirmPhase === 'processing' || confirmPhase === 'submitted'
            || (confirmPhase === 'done' && successPhase === 'flash' && lastLivePhase.current !== 'tracking')) && (() => {
            const isSubmittedNow = confirmPhase === 'submitted' || confirmPhase === 'done'
            // Stage order: waiting -> gas -> approving -> burning ->
            // attesting (submitClaim fires here) -> minting -> done/error.
            const stage = chainProgress[0]?.stage ?? 'waiting'
            const errored     = stage === 'error'
            const gasDone     = !errored && ['approving', 'burning', 'attesting', 'minting', 'done'].includes(stage)
            const approveDone = !errored && ['burning', 'attesting', 'minting', 'done'].includes(stage)

            const steps = [
              { label: 'Gas funded',    subtitle: 'MeshPort covered the network fee', done: gasDone,     active: !gasDone },
              { label: 'USDC approved', subtitle: 'Spending permission confirmed',  done: approveDone, active: gasDone && !approveDone },
              { label: 'Submitted',     subtitle: 'Broadcasting to the network',    done: isSubmittedNow, active: approveDone && !isSubmittedNow },
            ]

            return (
            <motion.div
              key="claiming-step"
              // Leaving for the receipt (under the flash): go at once, no fade.
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: confirmPhase === 'done' ? 0 : 0.25 } }}
              transition={{ duration: 0.25 }}
              style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
            >
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: `${SPACING.xl}px ${SPACING.md}px`, gap: SPACING.md, overflowY: 'auto', minHeight: 0 }}>

                {/* Title row + amount/route card — compact, so the whole
                    screen fits without scrolling on a phone. The stepper
                    below still never resets; only its title and the notes
                    change once the claim is submitted. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px' }}>
                  <span style={{ fontSize: 17, fontWeight: 700, color: COLORS.text }}>{isSubmittedNow ? 'Claim Submitted' : 'Bringing funds'}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, padding: '5px 10px', borderRadius: 999, background: 'color-mix(in srgb, var(--brand) 18%, transparent)', color: 'var(--accent-text)' }}>To Arc</span>
                </div>
                {(() => {
                  const doneCount = steps.filter(x => x.done).length
                  const pct = Math.round((doneCount / steps.length) * 100)
                  const firstChain = chainProgress[0]?.chainId
                  const fromLabel = chainProgress.length === 1 && firstChain ? getMeta(firstChain).label : `${chainProgress.length} chains`
                  return (
                    <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 22, padding: 16, textAlign: 'center' }}>
                      <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.5px', color: COLORS.text }}>{formatAmount(displayTotal)} USDC</div>
                      <div style={{ fontSize: 13, color: COLORS.muted, marginTop: 4 }}>{fromLabel} → Arc</div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 14 }}>
                        {firstChain ? <ChainLogo chainId={firstChain} size={32} /> : null}
                        <div style={{ flex: 1, maxWidth: 170, height: 6, borderRadius: 4, background: 'var(--border)', overflow: 'hidden' }}>
                          <motion.div initial={false} animate={{ width: `${errored ? pct : Math.max(pct, 8)}%` }} transition={{ duration: 0.5 }}
                            style={{ height: '100%', background: errored ? 'var(--danger)' : COLORS.primary }} />
                        </div>
                        <img src="/logos/chains/arc.svg" alt="Arc" width={32} height={32} style={{ width: 32, height: 32, borderRadius: '50%', display: 'block', flexShrink: 0, background: 'var(--surface)' }} />
                      </div>
                      <span style={{ display: 'block', marginTop: 8, fontSize: 12, fontWeight: 600, color: errored ? 'var(--danger)' : 'var(--accent-text)' }}>{pct}%</span>
                      <p style={{ fontSize: 14, fontWeight: 600, margin: '6px 0 0', color: errored ? 'var(--danger)' : COLORS.text }}>
                        {errored ? 'Something went wrong' : steps.find(x => x.active)?.subtitle ?? (isSubmittedNow ? 'Handed off to MeshPort' : 'Processing…')}
                      </p>
                    </div>
                  )
                })()}

                {/* Stepper — same checklist throughout, never resets */}
                <div style={{
                  background: COLORS.surface, border: `1px solid ${COLORS.border}`,
                  borderRadius: 22, padding: '14px 18px 16px 16px',
                }}>
                  <p style={{ fontSize: 12, fontWeight: 700, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 12px' }}>Progress</p>
                  {steps.map((s, i) => {
                    const isLast = i === steps.length - 1
                    return (
                      <div key={s.label} style={{ display: 'flex', gap: 12 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                          <div style={{
                            width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: s.done ? 'color-mix(in srgb, var(--success) 15%, transparent)' : s.active ? 'color-mix(in srgb, var(--brand) 15%, transparent)' : 'color-mix(in srgb, var(--text-primary) 4%, transparent)',
                            border: s.done ? `1.5px solid ${COLORS.success}` : s.active ? `1.5px solid ${COLORS.primary}` : '1.5px solid var(--border)',
                          }}>
                            {s.done ? (
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={COLORS.success} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12"/>
                              </svg>
                            ) : s.active ? (
                              <motion.div
                                animate={{ scale: [1, 1.5, 1], opacity: [1, 0.5, 1] }}
                                transition={{ duration: 1.1, repeat: Infinity }}
                                style={{ width: 7, height: 7, borderRadius: '50%', background: COLORS.primary }}
                              />
                            ) : null}
                          </div>
                          {!isLast && (
                            <div style={{ width: 1.5, flex: 1, minHeight: 22, margin: '2px 0', background: s.done ? COLORS.success : 'var(--border)' }}/>
                          )}
                        </div>
                        <div style={{ paddingBottom: isLast ? 0 : 18 }}>
                          <p style={{ fontSize: 14, fontWeight: 500, margin: '0 0 2px', color: s.done ? COLORS.success : s.active ? COLORS.text : COLORS.muted }}>
                            {s.label}
                          </p>
                          <p style={{ fontSize: 12, margin: 0, color: COLORS.muted }}>{s.subtitle}</p>
                        </div>
                      </div>
                    )
                  })}
                </div>

                {isSubmittedNow ? (
                  <motion.div
                    initial={{ opacity: 0, y: MOBILE_TAB_FADE_Y }} animate={{ opacity: 1, y: 0 }} transition={{ ...MOBILE_TAB_FADE_TRANSITION, delay: 0.1 }}
                    style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--accent-text)', padding: '10px 12px', borderRadius: 14,
                      background: 'color-mix(in srgb, var(--brand) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--brand) 30%, transparent)' }}>
                    ✓ Safe to leave — MeshPort finishes this claim on its servers and you'll get a notification.
                  </motion.div>
                ) : null}
              </div>

              {/* Pinned action bar — always visible. Before submission the
                  wallet is still signing on this device, so only a note;
                  after it, the claim runs server-side and the user can go. */}
              <div style={{ flexShrink: 0, padding: `${SPACING.md}px ${SPACING.md}px calc(env(safe-area-inset-bottom, 0px) + ${SPACING.lg}px)`, borderTop: `1px solid ${COLORS.border}`, background: 'var(--bg)' }}>
                {isSubmittedNow ? (
                  <div style={{ display: 'flex', gap: SPACING.sm }}>
                    <button
                      onClick={() => navigate('/multichain', { state: { tab: 'activity' } })}
                      style={{ flex: 1, minWidth: 0, padding: 14, borderRadius: 999, border: `1.5px solid ${COLORS.primary}`, background: 'transparent', fontSize: 14.5, fontWeight: 700, color: 'var(--accent-text)', cursor: 'pointer' }}
                    >
                      View in Hub
                    </button>
                    <button
                      onClick={() => setConfirmPhase('tracking')}
                      style={{ flex: 1, minWidth: 0, padding: 14, borderRadius: 999, border: 'none', fontSize: 14.5, fontWeight: 700, color: '#fff', background: COLORS.primary, cursor: 'pointer' }}
                    >
                      Track Progress
                    </button>
                  </div>
                ) : (
                  <p style={{ fontSize: 12, color: COLORS.muted, textAlign: 'center', margin: 0 }}>
                    Please wait — don't close this screen until the claim is submitted.
                  </p>
                )}
              </div>
            </motion.div>
            )
          })()}

          {/* TRACKING — same page, driven entirely by Supabase Realtime */}
          {(confirmPhase === 'tracking'
            || (confirmPhase === 'done' && successPhase === 'flash' && lastLivePhase.current === 'tracking')) && (
            <motion.div
              key="claim-tracking-step"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: confirmPhase === 'done' ? 0 : 0.25 } }}
              transition={{ duration: 0.25 }}
              style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', padding: `${SPACING.md}px ${SPACING.md}px`, flexShrink: 0 }}>
                {!isDesktop && (
                  <button onClick={() => navigate('/multichain', { state: { tab: 'bring' } })} style={{ position: 'absolute', left: SPACING.md, background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: COLORS.text, display: 'flex', alignItems: 'center' }}>
                    <ArrowLeft className="w-5 h-5"/>
                  </button>
                )}
                <span style={{ fontSize: 17, fontWeight: 700, color: COLORS.text }}>Track Progress</span>
              </div>

              <div style={{ flex: 1, overflowY: 'auto', padding: `${SPACING.md}px ${SPACING.md}px ${SPACING.xl}px`, display: 'flex', flexDirection: 'column', gap: SPACING.md }}>
                <p style={{ fontSize: 13, color: COLORS.muted, margin: 0, textAlign: 'center' }}>
                  <span style={{ fontWeight: 600, color: COLORS.text }}>${formatAmount(displayTotal)} USDC</span> · You may safely leave this page at any time.
                </p>
                {claimRecords.map(({ chainId, claimId, initialClaim }) => (
                  <div key={claimId}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm, marginBottom: SPACING.sm }}>
                      <ChainLogo chainId={chainId} size={28}/>
                      <span style={{ fontSize: 14, fontWeight: 600, color: COLORS.text }}>{getMeta(chainId).label}</span>
                    </div>
                    <ClaimProgressTracker claimId={claimId} initialClaim={initialClaim}/>
                    <div style={{ marginTop: SPACING.sm }}>
                      <TrackDetails rows={trackDetailRows({
                        route: 'CCTP', chainId,
                        amount: initialClaim?.amount ?? Number(claimAmounts[chainId] || 0),
                        createdAt: initialClaim?.createdAt,
                        sourceTx: initialClaim?.txHash,
                      })} />
                    </div>
                  </div>
                ))}
                {ubClaimChains.map(chainId => {
                  const cp = chainProgress.find(p => p.chainId === chainId)
                  if (!cp) return null
                  return (
                    <div key={`ub-${chainId}`}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm, marginBottom: SPACING.sm }}>
                        <ChainLogo chainId={chainId} size={28}/>
                        <span style={{ fontSize: 14, fontWeight: 600, color: COLORS.text }}>{getMeta(chainId).label}</span>
                      </div>
                      <UbProgressTracker progress={cp} chainLabel={getMeta(chainId).label} />
                      <div style={{ marginTop: SPACING.sm }}>
                        <TrackDetails rows={trackDetailRows({
                          route: 'Unified Balance', chainId,
                          amount: Number(claimAmounts[chainId] || 0),
                          sourceTx: cp.txHash,
                          mintTx: cp.mintTxHash,
                        })} />
                      </div>
                    </div>
                  )
                })}
                {claimRecords.length === 0 && ubClaimChains.length === 0 && (
                  <p style={{ fontSize: 13, color: COLORS.muted, margin: 0, textAlign: 'center' }}>Preparing your claim…</p>
                )}
              </div>

              <div style={{ flexShrink: 0, display: 'flex', gap: SPACING.sm, padding: `${SPACING.md}px ${SPACING.xl}px ${SPACING.xl}px` }}>
                <button onClick={() => navigate('/multichain', { state: { tab: 'activity' } })} style={{ flex: 1, padding: `${SPACING.md}px`, borderRadius: RADII.button, border: `1px solid ${COLORS.border}`, background: 'transparent', fontSize: 13, fontWeight: 600, color: COLORS.muted, cursor: 'pointer' }}>
                  View in Hub
                </button>
                <button onClick={() => navigate('/')} style={{ flex: 1, padding: `${SPACING.md}px`, borderRadius: RADII.button, border: '1px solid color-mix(in srgb, black 12%, transparent)', fontSize: 13, fontWeight: 600, color: '#fff', background: COLORS.primary, cursor: 'pointer' }}>
                  Go Home
                </button>
              </div>
            </motion.div>
          )}

          {/* DONE - full-screen flash → hero-card takeover, identical
              mechanic to SwapPage's completed-swap screen: the whole
              screen flashes brand color with a big checkmark + "Claimed
              Successfully", holds briefly, then that panel shrinks away
              while the traveling checkmark bridges into the detailed hero
              card that fades in underneath. */}
          {confirmPhase === 'done' && successPhase === 'collapsed' && (() => {
            // Prefer a real Arc mint hash; fall back to the source-chain burn
            // hash only for the display row (it is not paired with an explorer
            // link here, so a wrong-chain link can't result).
            const txHash = chainProgress.find(p => p.mintTxHash)?.mintTxHash
              ?? chainProgress.find(p => p.txHash)?.txHash
              ?? ''
            const shortHash = txHash ? `${txHash.slice(0, 6)}...${txHash.slice(-4)}` : '—'
            const fromChainIds = chainProgress.length ? chainProgress.map(p => p.chainId) : (selected ? [selected] : [])
            const timeLabel = new Date().toLocaleString('en-US', {
              month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
            })
            const fmtAmount = `${formatAmount(displayTotal)} USDC`
            // All per-chain fees each gasless bring signed rolled into one
            // number for the "Total Fees" row — same treatment
            // MultichainTransferPage's transfer success screen gives its own
            // totalFeesLabel.
            const totalFeesLabel = `${trimTrailingZeros(Object.values(claimFees).reduce((sum, f) => sum + f, 0).toFixed(4))} USDC`
            // Process checklist — same stages Track Progress shows
            // (Submitted excluded there too, already confirmed on the
            // screen before it), all rendered as already-done since this
            // only ever mounts after the claim has actually succeeded.
            const processSteps = CLAIM_STEPS.filter(s => s.key !== 'submitted')

            return (
            <motion.div key="done-step" style={{ flex: 1, position: 'relative', minHeight: 0 }}>
              {/* `minHeight: 0` is required here — without it this flex item
                  (a child of confirm-step's height:100% flex column) grows
                  to fit its own content instead of being capped to the
                  available space, so the child below's `height:'100%';
                  overflowY:'auto'` never actually gets a shorter box to
                  scroll inside. On mobile `flow`'s own `overflow:'hidden'`
                  then just clips whatever doesn't fit — hiding the bottom
                  of the success screen (including the buttons) with no way
                  to reach it, which is what read as "not scrolling". The
                  sibling 'claiming-step' above already has this same
                  minHeight:0 discipline; this just brings 'done-step' in
                  line with it. */}

              {travelRect && !travelDone && (
                <TravelingCheckmark from={travelRect.from} to={travelRect.to} toStroke="var(--success)" />
              )}

              {successPhase === 'collapsed' && (() => {
                const fromLabel = fromChainIds.length === 1 ? getMeta(fromChainIds[0]).label : `${fromChainIds.length} chains`
                const links = chainProgress.flatMap(p => {
                  const label = getMeta(p.chainId).label
                  const burnHref = explorerTxUrl(p.chainId, p.txHash)
                  // ONLY link the mint when there's a genuine Arc-side mint
                  // hash — p.txHash is the SOURCE-chain burn hash, which
                  // doesn't exist on Arc's explorer. claim-worker fills
                  // destination_tx_hash (→ p.mintTxHash) once the mint lands.
                  const mintHref = arcExplorerTxUrl(p.mintTxHash)
                  return [
                    ...(burnHref && p.txHash ? [{ title: `View Burn on ${label}`, explorer: label, hash: p.txHash, href: burnHref }] : []),
                    ...(mintHref && p.mintTxHash ? [{ title: 'View Mint on Arc Explorer', explorer: 'ArcScan', hash: p.mintTxHash, href: mintHref }] : []),
                  ]
                })
                const mintPending = chainProgress.some(p => !p.mintTxHash)
                return (
                <SuccessReceipt
                  actions={[
                    { label: 'View in Hub', onClick: () => navigate('/multichain', { state: { tab: 'activity' } }) },
                    { label: 'Done', onClick: () => navigate('/'), primary: true },
                  ]}
                  title="Funds Arrived"
                  subtitle={<>{fmtAmount} from {fromLabel} is now on Arc</>}
                  pill={`Completed in ${claimElapsedSeconds} Seconds`}
                  rows={[
                    { label: 'Claimed', value: fmtAmount, positive: true },
                    { label: fromChainIds.length === 1 ? 'From' : 'From Chains', value: fromLabel },
                    { label: 'Destination', value: 'Arc Testnet' },
                    ...(txHash ? [{ label: 'Transaction Hash', value: shortHash, onCopy: () => copyClaimHash(txHash), copied: hashCopied }] : []),
                    { label: 'Time', value: timeLabel },
                  ]}
                  steps={processSteps.map(s => s.subtitle)}
                  detailRows={[
                    { label: 'Status', value: 'Confirmed', positive: true },
                    { label: 'From', value: fromLabel },
                    { label: 'To', value: 'Arc Testnet' },
                    { label: 'Total Fees', value: totalFeesLabel },
                  ]}
                  links={links}
                  linksNote={mintPending && links.length > 0 ? 'The Arc mint link appears once the mint lands on Arc.' : undefined}
                  onPrimary={() => navigate('/')}
                  checkRef={heroCheckCallback}
                  revealed={travelDone}
                  checkContent={paidViaBiometric && travelDone
                    ? <FlashAuthIcon key="landing-toggle" viaBiometric loop size={34} color="var(--success)" />
                    : undefined}
                />
                )
              })()}
            </motion.div>
            )
          })()}
          </AnimatePresence>
        </motion.div>
      )}

      {/* FAILED STATE */}
      {step === 'failed' && (
        <motion.div
          key="failed-step"
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }}
          style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: `0 ${SPACING.xl}px` }}
        >
          <motion.div
            initial={{ scale: 0.5 }} animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 180, damping: 16 }}
            style={{ width: 80, height: 80, borderRadius: '50%', background: 'color-mix(in srgb, var(--danger) 12%, transparent)', border: '2px solid color-mix(in srgb, var(--danger) 35%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: SPACING.lg }}
          >
            <XCircle className="w-10 h-10" style={{ color: COLORS.error }}/>
          </motion.div>
          <p style={{ fontSize: 18, fontWeight: 700, color: COLORS.error, margin: '0 0 8px', textAlign: 'center' }}>Claim Failed</p>
          {error && <p role="alert" style={{ fontSize: 13, color: COLORS.muted, margin: '0 0 28px', textAlign: 'center', maxWidth: '100%' }}>{error}</p>}
          <div style={{ display: 'flex', gap: SPACING.sm, width: '100%' }}>
            <button onClick={() => { setStep('select'); setError(''); setPassEntry(''); setSelected(null); setConfirmPhase('processing'); setIsSubmitted(false); setShowPasscodeSheet(false); setAmountConfirmed(false); setClaimRecords([]); setClaimsByStatus({}); setSearchParams(new URLSearchParams(), { replace: true }) }} style={{ flex: 1, padding: `${SPACING.lg}px`, borderRadius: RADII.button, border: 'none', fontSize: 14, fontWeight: 600, color: '#fff', background: COLORS.primary, cursor: 'pointer' }}>
              Try Again
            </button>
            <button onClick={() => navigate('/multichain', { state: { tab: 'bring' } })} style={{ flex: 1, padding: `${SPACING.lg}px`, borderRadius: RADII.button, border: `1px solid ${COLORS.border}`, background: 'transparent', fontSize: 14, fontWeight: 600, color: COLORS.muted, cursor: 'pointer' }}>
              Back
            </button>
          </div>
        </motion.div>
      )}
      </AnimatePresence>

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        @keyframes caretBlink {
          0%, 50% { opacity: 1; }
          50.01%, 100% { opacity: 0; }
        }
        .keypad-eraser-fix button:has(svg) {
          background: none;
          border-radius: 0;
        }
        button:hover {
          opacity: 0.9;
          transition: opacity 0.2s ease;
        }
        button:active {
          opacity: 0.8;
        }
      `}</style>
    </div>
  )

  if (!isDesktop) return flow

  // ── Desktop: flow (left) + Claimed History (right), independently scrollable ──
  // Fills the full available content width (no maxWidth cap) at a fixed
  // 65/35 grow split, same treatment as Swap/Multichain Transfer. Bottom
  // padding trimmed so both columns reach down close to the viewport's
  // bottom edge.
  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, gap: 28, padding: '20px 24px 14px', boxSizing: 'border-box' }}>
      <div style={{ flex: '65 1 0%', minWidth: 0, minHeight: 0, overflowY: 'auto' }} ref={desktopColumnRef}>{flow}</div>
      <div style={{ flex: '35 1 0%', minWidth: 0, minHeight: 0 }}>
        <DesktopHistoryPanel title="Recent History" onViewAll={() => navigate('/multichain', { state: { tab: 'activity' } })}>
          {!claimHistoryLoaded ? (
            <DesktopHistorySkeleton />
          ) : claimHistory.length === 0 ? (
            <DesktopHistoryEmpty label="Funds you claim from other chains will show up here" />
          ) : (
            claimHistory.map((c, i) => {
              const failed = c.status === 'failed'
              const pending = !failed && c.status !== 'completed'
              const chainLabel = (c.sourceChain || 'Unknown chain').replace(/_/g, ' ')
              const statusColor = failed ? 'var(--danger)' : pending ? 'var(--warning)' : 'var(--success)'
              return (
                <div key={c.id} onClick={() => setClaimHistDetail(c)} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', cursor: 'pointer',
                  borderTop: i > 0 ? '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' : 'none',
                }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                    background: `color-mix(in srgb, ${statusColor} 12%, transparent)`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                      <path d="M12 2L2 12M2 12H8M2 12V6" stroke={statusColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      From {chainLabel}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 1 }}>
                      {failed ? <span style={{ color: 'var(--danger)' }}>Failed</span>
                        : pending ? <span style={{ color: 'var(--warning)' }}>In progress</span>
                        : timeAgo(c.completedAt || c.createdAt)}
                    </div>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: statusColor, flexShrink: 0 }}>
                    +{formatAmount(c.arrivedAmount ?? c.amount)} USDC
                  </div>
                </div>
              )
            })
          )}
        </DesktopHistoryPanel>
      </div>
      <AnimatePresence>
        {claimHistDetail && (() => {
          const c = claimHistDetail
          const failed = c.status === 'failed'
          const pending = !failed && c.status !== 'completed'
          const chainLabel = (c.sourceChain || 'Unknown chain').replace(/_/g, ' ')
          const statusColor = failed ? 'var(--danger)' : pending ? 'var(--warning)' : 'var(--success)'
          const burnHref = explorerTxUrl(c.sourceChain, c.txHash)
          // Mint link only from the real Arc mint hash — never c.txHash, which
          // is the source-chain burn hash (an Arc-explorer link to it 404s).
          const mintHref = arcExplorerTxUrl(c.destinationTxHash)
          return (
            <DesktopHistoryDetail
              onClose={() => setClaimHistDetail(null)}
              title="Claim Details"
              icon={<svg width="20" height="20" viewBox="0 0 14 14" fill="none"><path d="M12 2L2 12M2 12H8M2 12V6" stroke={statusColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
              iconColor={statusColor}
              amountLabel={`+${formatAmount(c.arrivedAmount ?? c.amount)} USDC`}
              amountColor={statusColor}
              rows={[
                { label: 'From', value: chainLabel },
                { label: 'Time', value: failed ? '—' : timeAgo(c.completedAt || c.createdAt) },
                { label: 'Status', value: failed ? 'Failed' : pending ? 'In progress' : 'Completed' },
                ...(c.txHash ? [{ label: 'Tx Hash', value: `${c.txHash.slice(0, 8)}…${c.txHash.slice(-6)}` }] : []),
              ]}
              explorerLinks={[
                ...(burnHref ? [{ label: `View Burn on ${chainLabel}`, href: burnHref }] : []),
                ...(mintHref ? [{ label: 'View Mint on Arc', href: mintHref }] : []),
              ]}
            />
          )
        })()}
      </AnimatePresence>
    </div>
  )
}
