/**
 * MultichainClaimPage - Single-action claim flow
 *
 * User flow (ONE action):
 *   1. Page loads → shows Arc balance + claimable funds per chain
 *   2. User selects chain(s) → Claim button updates total dynamically
 *   3. User enters 6-digit passcode (if set)
 *   4. Tap Claim → bridge + Arc credit happen automatically
 *   5. Done - Arc balance updated, activity recorded
 *
 * No deposit step. No wallet balance tab. No second confirmation.
 * 
 * MeshPort V2: Inspired by PayPal/Revolut/Cash App
 * "Sending money to friends" not "Managing blockchain infrastructure"
 */
import { backLayerPop } from '@/lib/backLayers'
import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from 'react'
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom'
import { fetchActivity, type ActivityRecord } from '@/lib/ActivityService'
import { notifyClaimArrived, requestPushPermission } from '@/lib/bridgeTracker'
import {
  ArrowLeft, RefreshCw, XCircle,
  Activity as ActivityIcon,
} from 'lucide-react'
import { ActionIcon } from '@/components/ui/ActionIcon'
import { PinSheet } from '@/components/ui/PinSheet'
import { AmountKeypad, sanitizeAmountInput } from '@/components/ui/AmountKeypad'
import { useKeypadLift, KEYPAD_SPRING } from '@/hooks/useKeypadLift'
import { TravelingCheckmark } from '@/components/ui/TravelingCheckmark'
import { SuccessFlash } from '@/components/ui/SuccessFlash'
import { SuccessReceipt } from '@/components/ui/SuccessReceipt'
import { ChainScanner } from '@/components/ui/ChainScanner'
import { FlashAuthIcon } from '@/components/ui/FlashAuthIcon'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { HubPush } from '@/components/multichain/HubPage'
import { MeshLoader } from '@/components/ui/MeshLoader'
import { EASE_OUT, MOBILE_TAB_FADE_Y, MOBILE_TAB_FADE_TRANSITION, type NavDirection } from '@/lib/motion'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { AmountField, quickAmounts } from '@/components/ui/AmountField'
import { useAuthStore, useWalletStore, useUIStore } from '@/store'
import type { WalletAccount } from '@/wallet'
import { supabase } from '@/lib/supabase'
import { formatAmount, copyToClipboard, trimTrailingZeros } from '@/lib/utils'
import { explorerTxUrl, arcExplorerTxUrl, ARC_CHAIN_KEY } from '@/lib/chainExplorers'
import {
  submitClaim,
  getClaim,
  subscribeToClaim,
  kickClaimWorker,
  type Claim as ServerClaim,
} from '@/lib/claimService'
import { isGaslessBridgeAvailable, canBringOverCctp, quoteGaslessBridge, bringFundsGasless } from '@/lib/gaslessBridge'
import { isSolanaChain } from '@/lib/solana'

import { relayedProviderFor } from '@/lib/relayedProvider'
import { useSettingsStore } from '@/store/settingsStore'
import { isChainEnabledForClaim, CHAIN_CLAIM_FEATURE_MAP } from '@/lib/featureFilters'
import { readExternalBalances, refreshScope, readExternalChainBalance, notifyExternalBalanceChanged, EXTERNAL_BALANCE_EVENT } from '@/blockchain/BlockchainManager'
import { fetchCctpProgress, useCctpProgress } from '@/lib/cctpTracker'
import { ARC_RPCS } from '@/lib/arc'
import { UB_CLAIM_CHAINS, runUbClaim, ubBringTime, ubClaimEta, estimateUbClaimFee } from '@/lib/ubClaim'
import { RPC_BY_CHAIN_NAME as BASE_RPC_BY_CHAIN_NAME } from '@/lib/chainRpcs'
import { revealFlow } from '@/lib/revealFlow'
import { refreshBalancesAfterTx } from '@/lib/balanceRefresh'
import { claimFeeSummary, type SignedClaimFee } from '@/lib/claimFees'
import { useLeaveGuard } from '@/lib/leaveGuard'
import { moveSteps, indexFromBringStage, indexFromClaimStatus, indexFromCctpStage } from '@/lib/moveSteps'
import { MoveProgress } from '@/components/multichain/MoveProgress'

// ─── MeshPort V2 Design System ────────────────────────────────────────────────
const COLORS = {
  bg: 'var(--bg)',
  surface: 'var(--surface)',
  surfaceSecondary: 'var(--surface)',
  primary: 'var(--brand)', primaryText: 'var(--brand-text)',
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
// All logos are local files under public/logos/chains/ - sourced from
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
  // Added to bring Claim up to parity with Transfer's 21-chain list - these
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
  // Not EVM: brought over CCTP by lib/solanaBridge.ts (MeshPort pays the SOL fee).
  Solana_Devnet:       { label: 'Solana',      color: '#9945FF', short: 'SOL',  logo: '/logos/chains/solana.svg' },
}

// Bring Funds timing on CCTP: Fast Transfer attests before source finality
// (docs.arc.io: attestation typically ~60 s), then the relayer mints on Arc.
const CCTP_BRING_TIME = '20–90 s'

/** Slow / Fast tag on a route button. */
function SpeedTag({ fast, on }: { fast: boolean; on: boolean }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, lineHeight: '14px', padding: '0 6px', borderRadius: 999, flexShrink: 0,
      color: on ? '#fff' : fast ? 'var(--success)' : 'var(--warning)',
      background: on ? 'rgba(255,255,255,0.2)' : `color-mix(in srgb, ${fast ? 'var(--success)' : 'var(--warning)'} 14%, transparent)` }}>
      {fast ? 'Fast' : 'Slow'}
    </span>
  )
}

// Decimal places a claim amount can be typed with - the same cap for the
// typed (desktop) input and the phone keypad. Claims are in whole cents:
// every chain's claimable balance is floored to 2 decimals and Max fills in
// 2 (the keypad used to allow 6 while the typed box stopped at 2).
const CLAIM_DECIMALS = 2


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
      <img decoding="async" src={m.logo} alt={m.label} width={size} height={size}
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

// Smallest Bring Funds amount, every route. Set by MeshPort's relayer: it
// takes nothing under 1 USDC (api/bridge-relay MIN_TOTAL_UNITS - dust
// deposits would let anyone burn its gas). At $1 the usual fees (MeshPort's
// relayer gas, at most 0.10, + Circle ~0.03 on CCTP) still leave ~$0.87 or
// more (see gaslessBridge's small-amount fee limits). One constant for the amount screen, the
// pre-claim estimate and executeClaim's own re-check.
const MIN_CLAIM_AMOUNT = 1.00

/** Bring: a Unified Balance fee above this (USD) picks CCTP and warns. */
const UB_HIGH_FEE_USD = 0.5

/** Unified Balance fee estimate error: the fee is more than the amount. */
const UB_FEE_TOO_HIGH = 'Fee is more than this amount'

const _arcProviderCache = new Map<string, any>()

/** The claim adapter - for merchant auto-collect. */
export async function buildClaimAdapter(signer: WalletAccount) {
  return buildAdapter(signer)
}

// Non-Arc chains go through relayedProviderFor: the Gateway deposit (and
// any Gateway/CCTP mint) is submitted by MeshPort's relayer, so the wallet
// needs no gas there. Arc pays its own gas in USDC.
// Signs through the wallet frame (src/wallet) - same providers as before.
async function buildAdapter(signer: WalletAccount) {
  const { createWalletAdapter } = await import('@/wallet')
  return createWalletAdapter({
    account: signer,
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
  /** Unified Balance: the signed spend is with MeshPort's server. */
  handedOff?: boolean
}

type Step =
  | 'loading'
  | 'select'   // Page 1: choose chain + enter amount
  | 'confirm'  // Page 2: passcode -> processing -> done
  | 'failed'

// 'submitted' / 'tracking' are server-backed: the claim row already exists in
// Supabase and claim-worker is advancing it independently of this page.
type ConfirmPhase = 'processing' | 'submitted' | 'tracking' | 'done'
// Hub Bring page: HubPush (ScreenPush) slides the next screen in over a
// picture of the old one, so the screens themselves swap at once - rendered
// directly, with no AnimatePresence holding the old one on screen (under
// mode="wait" the push showed the OLD step sliding in) and no enter fade of
// their own (that would be a second animation inside the push).
const INSTANT_STEP = { initial: false } as const
function PushIf({ on, screenKey, back, children }: { on: boolean; screenKey: string; back: boolean; children: ReactNode }) {
  return on ? <HubPush screenKey={screenKey} back={back}>{children}</HubPush> : <>{children}</>
}
/** Swaps the steps: at once inside a push (see PushIf); otherwise a quick
 *  cross-fade, the old one popped out of the layout as the new one fades in. */
function StepSwap({ push, children }: { push: boolean; children: ReactNode }) {
  return push ? <>{children}</> : <AnimatePresence initial={false} mode="popLayout">{children}</AnimatePresence>
}

// ─── Main Component ────────────────────────────────────────────────────────────

export function MultichainClaimPage({ embedded = false, onClose, initialChain, initialBalance, trackClaimId, merchantMode = false, onFocusChange, pushScreens = false }: { embedded?: boolean; onClose?: () => void; initialChain?: string; initialBalance?: number; trackClaimId?: string; merchantMode?: boolean; onFocusChange?: (f: 'none' | 'processing' | 'result') => void
  /** Hub on a phone (inside its Bring page): screens swap at once, and the
   *  processing and Track Progress screens slide in from the right. */
  pushScreens?: boolean } = {}) {
  // Only ever rendered inside the Hub (MultichainPage), so the page always
  // uses its phone layout; on desktop its screens open in the Hub's
  // right-hand panel (isDesktopMq).
  const isDesktopMq  = useMediaQuery('(min-width: 980px)')
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
  const signer = useAuthStore(s => s.signer)
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
  // Must call this - isChainEnabledForClaim fails OPEN (every chain reads
  // as enabled) whenever a row isn't in the store yet, which is correct
  // while settings are still genuinely loading but was silently permanent
  // if nothing else had already triggered load() first. This page used to
  // only ever READ settingsMap/settingsLoaded reactively, assuming some
  // other already-mounted page (e.g. Home) had called load() before this
  // one mounted. Reached directly - a deep link, a page refresh while
  // already on /multichain-claim, or just being the first page opened in
  // the session - settingsLoaded stayed false for the entire session, and
  // every admin-disabled chain's balance was scanned and counted into
  // claimableTotal indefinitely instead of just for one brief render.
  useEffect(() => { loadSettings() }, [loadSettings])

  const [searchParams, setSearchParams] = useSearchParams()

  // Deep-link from the Hub's "Processing Claims" list ("Tap to view") -
  // jumps straight into the tracking screen for an already-submitted claim.
  //
  // Checked in two places: router `location.state` (set by the Hub's
  // navigate call) AND the `?claim=` URL param (set both by the Hub and by
  // this page itself once a claim starts being tracked - see the
  // URL-mirroring effect below). location.state is not reliable across a
  // hard refresh in every environment this app runs in; the URL is. This
  // is what was causing "Track Progress" to silently drop back to the
  // scan/select ("assets") screen on refresh instead of resuming.
  const trackClaimIdFromHub =
    trackClaimId ??
    ((location.state as any)?.trackClaimId as string | undefined) ??
    (searchParams.get('claim') || undefined)

  // Opened from a Hub chain row that already knows the balance: start right
  // on the amount form (like Transfer) - no "opening…" spinner, no slide-in.
  // The balance scan still runs, quietly, in the background.
  const prefilledFromHub = !trackClaimIdFromHub && !!initialChain && (initialBalance ?? 0) > 0
  const [step,           setStep]          = useState<Step>(() => trackClaimIdFromHub ? 'confirm' : prefilledFromHub ? 'select' : 'loading')
  const [confirmPhase,   setConfirmPhase]  = useState<ConfirmPhase>(() => trackClaimIdFromHub ? 'tracking' : 'processing')
  // The live view that was up before 'done' (processing/submitted or
  // tracking) - kept on screen underneath the success flash so the screen is
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
  // After the passcode the bring is on its way: hold Back / sidebar until
  // MeshPort's server has it ('submitted'), or until it lands when this
  // device has to finish it.
  useLeaveGuard(step === 'confirm' && confirmPhase === 'processing', 'Bring')
  useEffect(() => {
    if (!embedded) return
    onFocusChange?.(focus)
    if (focus !== 'none') revealFlow(flowRootRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded, focus])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => onFocusChange?.('none'), [])

  // Device/browser back button on Track Progress → Multichain Hub, matching
  // the in-app back arrow. confirmPhase is component state, not a route, so
  // without this a back-press would just unwind normal browser history to
  // whatever page was open before this one - not necessarily the Hub, and
  // not consistent with what the visible back arrow already does here.
  useEffect(() => {
    // Inside the Hub, the Hub itself owns the device back button (it closes
    // this inline view) - see MultichainPage's sub-view history handling.
    if (embedded) return
    if (confirmPhase !== 'tracking') return
    window.history.pushState({ trackProgress: true }, '')
    const onPopState = () => { if (backLayerPop()) return; navigate('/multichain', { replace: true }) }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [confirmPhase, navigate, embedded])

  // Server-owned claim rows created for this session, keyed by source chain.
  // These are the single source of truth once populated - the worker keeps
  // advancing them via Supabase regardless of what this page/tab does.
  const [claimRecords,   setClaimRecords]  = useState<Array<{ chainId: string; claimId: string; initialClaim?: ServerClaim | null }>>([])
  const [claimsByStatus, setClaimsByStatus] = useState<Record<string, ServerClaim>>({})
  // Chains claimed via Unified Balance this session. UB claims have no
  // `claims` row, so Track Progress follows their live chainProgress instead.
  const [ubClaimChains,  setUbClaimChains] = useState<string[]>([])
  // Last non-error stage of the first chain - lets the stepper mark the step
  // that actually failed instead of the first one.
  const lastClaimStageRef = useRef<string>('waiting')
  // The claims row this screen follows (Bring over CCTP), and Circle's view
  // of its burn - Circle's forwarder mints on Arc before the row's worker
  // pass catches up, so the checklist moves on as soon as Circle says so.
  const trackRec = claimRecords[0]
  const trackClaimRow: ServerClaim | null = trackRec ? (claimsByStatus[trackRec.claimId] ?? trackRec.initialClaim ?? null) : null
  const trackRowFinal = trackClaimRow?.status === 'completed' || trackClaimRow?.status === 'failed'
  const bringIris = useCctpProgress(trackClaimRow && !trackRowFinal ? trackClaimRow.sourceChain : undefined, trackClaimRow && !trackRowFinal ? trackClaimRow.txHash : undefined)
  const [showPasscodeSheet, setShowPasscodeSheet] = useState(false)
  const [amountConfirmed, setAmountConfirmed] = useState(false)
  const [keypadOpen,     setKeypadOpen]    = useState(false)
  const amountBoxRef = useRef<HTMLDivElement>(null)
  const keypadLift = useKeypadLift(keypadOpen && !showPasscodeSheet, amountBoxRef, true)
  // When the amount keypad closes, bring Back / Bring into view: the page
  // scrolls up once the form has glided back down, so the buttons are never
  // left hidden below the fold.
  const actionsRef = useRef<HTMLDivElement>(null)
  const keypadWasOpen = useRef(false)
  useEffect(() => {
    const open = keypadOpen && !showPasscodeSheet
    if (open) { keypadWasOpen.current = true; return }
    if (!keypadWasOpen.current || showPasscodeSheet) return
    keypadWasOpen.current = false
    const t = setTimeout(() => actionsRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 380)
    return () => clearTimeout(t)
  }, [keypadOpen, showPasscodeSheet])
  const [isSubmitted,    setIsSubmitted]   = useState(false)
  const [chains,         setChains]        = useState<ChainEntry[]>(() => prefilledFromHub
    ? [{ chainId: initialChain!, claimable: Math.floor((initialBalance ?? 0) * 100) / 100, pending: 0 }] : [])
  const [claimableTotal, setClaimableTotal] = useState(0)
  const [selected,       setSelected]      = useState<string | null>(() => prefilledFromHub ? initialChain! : null)
  // Which way the chain-select <-> amount-entry slide should travel - set on
  // every navigation between the two so back mirrors forward instead of
  // always animating the same direction regardless of which way you went.
  const [direction,      setDirection]     = useState<NavDirection>('forward')
  // Same useReducedMotion() pattern already used in PageTransition.tsx/
  // AuthShell.tsx, applied here to the chain-select <-> amount-entry slide.
  const reduceMotion = useReducedMotion()
  const [claimAmounts,   setClaimAmounts]  = useState<Record<string, string>>({})
  // Route for the claim: CCTP (burn → mint) or Unified Balance (Gateway deposit → spend).
  // Merchants: CCTP only (gasless - MeshPort's relayer pays the gas).
  const [claimRoute, setClaimRoute] = useState<'cctp' | 'ub'>('cctp')
  // Pre-claim fee estimate - shown on the amount screen, BEFORE the user
  // enters their passcode, so "You will receive" reflects what actually
  // lands instead of the raw claim amount. Previously the only fee number
  // anywhere on this page was claimFees below, which only populates DURING
  // execution (after the passcode) - the user had zero fee visibility
  // before committing, unlike the Send/Transfer page's Review step.
  // `forKey` is `${chainId}|${amount}` - lets the render check whether the
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
  // Per chain, what each gasless bring signed: MeshPort's fee and the cap
  // on Circle's CCTP fee - see lib/claimFees for how the success screen
  // turns these into the fees actually paid.
  const [claimFees,      setClaimFees]     = useState<Record<string, SignedClaimFee>>({})
  const notifiedClaimIdsRef = useRef<Set<string>>(new Set())
  const sdkRef = useRef<{ AppKit: any } | null>(null)

  // ─── Success screen - same full-screen flash → hero-card takeover
  // SwapPage/PaySendPage use for a completed action, reused here so a
  // completed claim feels identical: whole screen flashes brand color
  // with a big checkmark + "Claimed Successfully", holds briefly, then
  // that panel shrinks away while the traveling checkmark bridges into
  // the detailed hero card that fades in underneath.
  const [successPhase, setSuccessPhase] = useState<'flash' | 'collapsed'>('flash')
  const [hashCopied, setHashCopied] = useState(false)
  const { showToastMessage } = useUIStore()
  // Whether THIS claim's passcode came from a biometric check vs typed
  // manually - drives which icon (checkmark vs fingerprint/Face ID) shows
  // on the flash->hero success animation. Set from PinKeypad's onComplete
  // second argument, same as SwapPage/PaySendPage.
  const [paidViaBiometric, setPaidViaBiometric] = useState(false)
  useEffect(() => {
    if (confirmPhase !== 'done') { setSuccessPhase('flash'); return }
    const t = setTimeout(() => setSuccessPhase('collapsed'), 1500)
    return () => clearTimeout(t)
  }, [confirmPhase])

  // Gates FlashAuthIcon's own bio->check swap - flips true only once the
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
  // Desktop: the flash overlay (portaled to `document.body`, as
  // PageTransition's motion.div leaves a stray transform that would capture
  // a fixed overlay) is pinned to the Hub's right-hand panel's rect instead
  // of the full viewport.
  const [flashColumnRect, setFlashColumnRect] = useState<DOMRect | null>(null)

  useLayoutEffect(() => {
    if (successPhase === 'flash' && flashCheckRef.current) {
      lastFlashRectRef.current = flashCheckRef.current.getBoundingClientRect()
    }
  })

  // Separate, dependency-gated effect - NOT folded into the unconditional
  // one above. That one has no dep array on purpose (it needs to keep
  // re-measuring flashCheckRef every render while flash is up), but
  // getBoundingClientRect() always returns a brand-new DOMRect object, so
  // calling setFlashColumnRect from an effect with no deps meant: render →
  // effect runs → setState with a "new" (referentially different, even if
  // numerically identical) rect → React sees a state change → re-render →
  // effect runs again → setState again → infinite loop (React error #185,
  // "Maximum update depth exceeded"). Gating on [successPhase, isDesktopMq]
  // makes it fire once per entry into the flash phase instead.
  useLayoutEffect(() => {
    if (successPhase !== 'flash' || !isDesktopMq) return
    // Embedded in the Hub on desktop: cover just the Hub's own screen (its
    // scroll area beside the sidebar), not the whole window.
    const target = (flowRootRef.current?.closest('[data-hub-page], [data-flow-scroller]') as HTMLElement | null) ?? flowRootRef.current
    if (target) setFlashColumnRect(target.getBoundingClientRect())
  }, [successPhase, isDesktopMq])

  // Measured in a layout effect (before paint) so the traveling checkmark is
  // already on screen in the receipt's very first frame - no frame where
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
    // Pre-warm SDK chunks immediately on mount - not deferred to chain-select.
    // The dynamic import of app-kit + adapter-ethers-v6 is a separate JS chunk
    // that can take 500ms-1s to download and parse on a cold load. Kicking it
    // here means the chunk is already cached by the time the user picks a chain
    // and the fee estimate debounce fires, so the debounce delay is the ONLY
    // wait instead of debounce + a fresh chunk download.
    Promise.all([
      import('@circle-fin/app-kit'),
      import('@circle-fin/adapter-ethers-v6'),
    ]).then(([a]) => {
      sdkRef.current = { AppKit: a.AppKit }
    }).catch(() => {})
  }, [])

  useEffect(() => { requestPushPermission() }, [])

  // Deep link from Hub → jump straight into the tracking screen for a claim
  // that's already being processed server-side (survives navigation/reload).
  //
  // BUG FIX: must only ever do this ONCE, on the actual mount - not every
  // time trackClaimIdFromHub's value changes. The URL-mirroring effect just
  // above now writes ?claim=<id> as soon as a claim is submitted (so a
  // refresh during the "Claim submitted!" countdown screen can resume too),
  // which changes trackClaimIdFromHub's value mid-session. Without this
  // guard, that change would re-run this effect and force confirmPhase
  // straight to 'tracking', hijacking the submitted countdown screen before
  // the user ever saw it - the exact bug the mirroring effect's own history
  // already describes. Gating on a ref (not the dependency array) means a
  // genuine fresh mount with ?claim= already in the URL (a hard refresh)
  // still resumes correctly - this only ignores changes that happen AFTER
  // the component is already up and running in the same session.
  const hasCheckedResumeRef = useRef(false)
  useEffect(() => {
    if (hasCheckedResumeRef.current) return
    hasCheckedResumeRef.current = true
    if (!trackClaimIdFromHub) return
    getClaim(trackClaimIdFromHub).then(claim => {
      if (!claim) {
        // Id was stale/invalid/expired (or arrived from a bad/old link) -
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
  // (not just once the user reaches the live tracking view) - so a hard
  // refresh during the "Claim submitted!" countdown screen can resume too,
  // not only a refresh from the tracking view itself.
  //
  // BUG FIX: this used to wait for confirmPhase === 'tracking' specifically,
  // because writing ?claim= any earlier changed trackClaimIdFromHub, which
  // re-ran the resume-effect below and forced confirmPhase straight to
  // 'tracking' - hijacking the "Claim submitted!" countdown screen the
  // instant it appeared, before the user ever saw it. That's now fixed at
  // the resume-effect itself (see its own comment): it only ever resumes
  // ONCE per mount, so this mirroring firing earlier in the SAME session no
  // longer re-triggers it. A refresh is a fresh mount, so it still resumes
  // correctly - straight to the live tracking view, which is the right
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
  // updates. This is purely a UI reflection - claim-worker (Edge Function +
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
  // decides anything - still only claims.status, delivered through the same
  // subscription above; this just makes the authoritative check itself run
  // sooner. Stops automatically once every tracked claim reaches a terminal
  // status, and tearing down this effect (navigating away, closing the tab)
  // simply stops the acceleration - claim-worker keeps going regardless via
  // pg_cron, same guarantee as always.
  useEffect(() => {
    if (claimRecords.length === 0) return
    const pending = claimRecords.filter(r => {
      const status = claimsByStatus[r.claimId]?.status
      return status !== 'completed' && status !== 'failed'
    })
    if (pending.length === 0) return
    // 8s - matches claim-worker's own SWEEP_INTERVAL_MS, and the RPC behind
    // kickClaimWorker (fetch_and_lock_due_claims) now enforces the same
    // staleness cutoff for single-claim kicks as it always did for the cron
    // sweep. A shorter client interval than that no longer buys anything: the
    // extra kicks just get skipped server-side as stale instead of actually
    // reprocessing the claim, so they'd be wasted requests, not faster
    // updates. (Previously this ran every 2s - the RPC didn't rate-limit
    // single-claim kicks yet, so it silently reprocessed the claim on every
    // one of those, inflating claims.attempts up to ~5x faster than
    // MAX_ATTEMPTS was calibrated for. Fixed server-side; this brings the
    // client back in line with that fix instead of relying on it as a
    // backstop.) The worker still decides everything; this just asks it to
    // check sooner than pg_cron's next ~60s tick.
    // Kick once immediately - otherwise a freshly-submitted claim just sits
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
  // later") - arcDepositWatcher.ts already watches Arc in real time and
  // fires 'meshport:arc-deposit' (session-wide, see AppLayout.tsx) the
  // instant a deposit - including this claim's own CCTP mint - lands,
  // which is what makes the Home balance/Activity feel instant. The
  // checklist above only asked claim-worker to recheck on a fixed 5s
  // timer, so it could lag behind a mint that was already detected.
  // Kicking immediately on this event closes that gap: it's the exact
  // same kickClaimWorker() call the 5s timer above already makes (just
  // triggered by a real signal instead of a fixed clock), so it still
  // doesn't decide anything itself - claims.status is still written
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

  // Circle's forwarder mints on Arc seconds after attestation, but the row
  // only flips to 'completed' on claim-worker's next pass - the progress
  // checklist (MoveProgress) already moves on from Circle, so the success
  // screen and balances follow the same signal.
  const [mintedOnArc, setMintedOnArc] = useState<Record<string, true>>({})
  useEffect(() => {
    const pending = claimRecords
      .map(r => claimsByStatus[r.claimId])
      .filter((c): c is ServerClaim => !!c && !!c.txHash && c.status !== 'completed' && c.status !== 'failed' && !mintedOnArc[c.id])
    if (pending.length === 0) return
    let stop = false
    const check = () => {
      for (const c of pending) {
        fetchCctpProgress(c.sourceChain, c.txHash!).then(p => {
          if (stop || p?.stage !== 'done') return
          setMintedOnArc(prev => prev[c.id] ? prev : { ...prev, [c.id]: true })
          kickClaimWorker(c.id)
        })
      }
    }
    check()
    const iv = setInterval(check, 3_000)
    return () => { stop = true; clearInterval(iv) }
  }, [claimRecords, claimsByStatus, mintedOnArc])

  // Auto-advance the UI once the server-side state machine finishes -
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
    if (claims.every(c => c.status === 'completed' || mintedOnArc[c.id])) {
      // Retried while the chain still shows the pre-claim balance.
      refreshBalancesAfterTx(walletAddress)
      setChainProgress(prev => prev.length
        ? prev.map(p => ({ ...p, stage: 'done', pct: 100 }))
        : claims.map(c => ({ chainId: c.sourceChain, stage: 'done', pct: 100, msg: 'Done', mintTxHash: c.destinationTxHash ?? undefined, txHash: c.txHash })))
      setConfirmPhase(phase => (phase === 'submitted' || phase === 'tracking') ? 'done' : phase)

      // Notification now fires HERE - driven by the same Realtime
      // claims.status event as the UI transition above, instead of a
      // separate client-SDK completion signal that could arrive at a
      // different time than the actual server-confirmed status. Guarded on
      // TWO levels: the in-memory ref stops this effect from re-notifying
      // itself as it re-runs within the same mount, and `userNotifiedAt`
      // stops a fresh mount (e.g. refreshing this exact success screen,
      // which re-fetches claimsByStatus as already-'completed' and would
      // otherwise re-fire with an empty ref) from notifying again for a
      // claim that was already durably marked notified server-side.
      // Notify once the row is final - it carries the exact arrived amount.
      for (const c of claims) {
        if (c.status !== 'completed') continue
        if (c.userNotifiedAt) { notifiedClaimIdsRef.current.add(c.id); continue }
        if (!notifiedClaimIdsRef.current.has(c.id)) {
          notifiedClaimIdsRef.current.add(c.id)
          notifyClaimArrived(c.arrivedAmount ?? c.amount, c.sourceChain, undefined, undefined, c.id)
          // Mark it server-side too - without this, AppLayout.tsx's
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
  }, [claimsByStatus, claimRecords, walletAddress, setBalance, mintedOnArc])

  // NOTE: a client-side balance-delta poller previously lived here
  // (checked getUSDCBalance() against a startBalance snapshot, same
  // `newBal >= before + expected*0.99` pattern that was removed from
  // server-side settlement for being unreliable under concurrent activity).
  // It's been removed - it was fully redundant with the effect above, which
  // already flips confirmPhase to 'done' the moment claims.status genuinely
  // reaches 'completed' via Realtime. claims.status is now the single
  // source of truth end-to-end; this page no longer has its own competing
  // notion of "arrived".
  //
  // A second, entirely separate polling loop also used to live here -
  // polling a `bridge_sessions` table (distinct from `claims`) every 15s
  // for statuses like 'burning'/'attesting'/'minting'. Nothing writes to
  // that table anymore (confirmed via full-codebase audit), and the result
  // was never even rendered anywhere - pure dead weight that was still a
  // second, disconnected notion of claim progress sitting in the codebase.
  // Removed along with its backing functions in bridgeTracker.ts.

  const getKey = useCallback(async (passcode?: string) => {
    const s0 = (await import('@/store')).useAuthStore.getState()
    let key = s0.signer, addr = s0.walletAddress
    if (key && addr) return { signer: key, addr }

    // The signer is deliberately never persisted to disk (see store/index.ts
    // partialize + App.tsx) - it's re-derived from the mnemonic, or for
    // social-auto accounts fetched fresh from the server, on every app
    // load/reload. That restore is async and, for the server-fetch path,
    // a real network round trip - it can easily take longer than a short
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
    // and had none here - `pendingRawPasscode` is only ever stashed by the
    // passcode SETUP/CHANGE screens, never by this page's own passcode-
    // confirm sheet. The result: a claim on a cold session silently fell
    // through every restore path, burned the full ~10s poll below, and
    // failed with "Wallet unavailable" - even though the user had just
    // typed their correct passcode into the sheet one line above this call.
    // handlePasscodeConfirm now passes that verified passcode through.
    if (addr && !key) {
      try {
        const { restorePrivateKey } = await import('@/lib/restoreWallet')
        await restorePrivateKey(passcode)
      } catch {}
      const s1 = (await import('@/store')).useAuthStore.getState()
      key = s1.signer; addr = s1.walletAddress
    }

    // Remaining fallback: addr itself not hydrated yet (auth store persist
    // rehydration hasn't landed on first render) or restore is genuinely
    // still settling. 20 x 500ms = 10s - generous enough to cover a slow
    // network restore without leaving the scan screen spinning forever.
    for (let i = 0; i < 20 && !(key && addr); i++) {
      await new Promise(r => setTimeout(r, 500))
      const s = (await import('@/store')).useAuthStore.getState()
      key = s.signer; addr = s.walletAddress
    }
    return (key && addr) ? { signer: key, addr } : null
  }, [])

  const loadSdk = useCallback(async () => {
    const [{ AppKit }] = await Promise.all([
      import('@circle-fin/app-kit'),
      import('@circle-fin/adapter-ethers-v6'),
    ])
    return { AppKit }
  }, [])

  // ── Pre-claim fee estimate ───────────────────────────────────────────────
  // The gasless relayer's quote - read-only, signs nothing.
  const fetchClaimFeeEstimate = useCallback(async (chainId: string, amount: number) => {
    const key = `${chainId}|${amount}`
    setFeeEstimate(prev => ({ ...prev, loading: true, error: '' }))
    // Gasless chains: the relayer's own quote - the exact fees the claim
    // will sign, so what's shown here is what's charged.
    // Solana: Circle's fee only - MeshPort pays the SOL network fee.
    if (isSolanaChain(chainId)) {
      try {
        const { quoteSolanaToArc } = await import('@/lib/solanaBridge')
        const q = await quoteSolanaToArc(BigInt(Math.round(amount * 1e6)))
        const bridgeFee = Number(q.maxFee) / 1e6
        setFeeEstimate({ loading: false, error: '', totalFee: bridgeFee, receiverGets: Math.max(0, amount - bridgeFee), forKey: key, networkFee: 0, bridgeFee })
      } catch (e: any) {
        setFeeEstimate({ loading: false, error: e?.message || 'Fee estimate unavailable', totalFee: 0, receiverGets: 0, forKey: key, networkFee: 0, bridgeFee: 0 })
      }
      return
    }
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

  // Debounced trigger - fires ~600ms after the user stops typing/adjusting
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
  // is retained purely as a belt-and-suspenders guarantee - if the mount
  // pre-warm was a cache hit (same session, second claim) the call is a
  // no-op; if mount failed for any reason, selecting a chain recovers it.
  useEffect(() => {
    if (step === 'select' && selected) { loadSdk().catch(() => {}) }
  }, [step, selected, loadSdk])

  // ── Manual refresh cooldown ──────────────────────────────────────────────
  // 20s client-side rate limit on the header's Refresh button - independent
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

  const scan = useCallback(async (force?: boolean, quiet?: boolean) => {
    // Deep-linking into an existing claim's Track Progress (from the Hub's
    // "Tap to view") has nothing to do with scanning for NEW claimable
    // balances. Previously this ran unconditionally on every mount and
    // finished with an unconditional setStep('select') - racing against the
    // trackClaimIdFromHub effect below, which sets step to 'confirm'. Since
    // both are async and whichever resolves last wins, this multi-chain scan
    // (several RPC calls) would often finish after the single getClaim()
    // fetch and silently stomp the correct step back to the selection
    // screen - exactly the "Track Progress flashes then redirects to Claim
    // Funds" bug. Skip the scan entirely in this case.
    if (trackClaimIdFromHub) return

    // `quiet`: the amount form is already showing - refresh balances
    // without flipping to the loading screen or touching the step.
    if (!quiet) { setStep('loading'); setError('') }
    const wallet = await getKey()
    if (!wallet) { if (!quiet) { setError('Wallet not available'); setStep('failed') } return }
    // BUG FIX (2026-09-21): the manual refresh button called this same scan()
    // with no way to bypass readExternalBalances' own 90s cache (raised from
    // 20s after a real Alchemy 429 incident - see externalBalanceReader.ts's
    // own CACHE_TTL_MS comment). Clicking Refresh twice within that window
    // silently served the SAME cached result both times - the button looked
    // broken even though it technically ran. refreshScope({kind:'external'})
    // is the API this codebase already built for exactly this ("all is
    // reserved for launch / login / wallet-import / explicit manual
    // refresh" - see BlockchainManager.ts's own refreshScope comment) -
    // invalidating just the external-balance cache entries before the read
    // below, so a forced scan is always genuinely fresh.
    if (force) refreshScope({ kind: 'external', wallet: wallet.addr })
    try {
      // Admin-disabled chains must never contribute to claimableTotal -
      // same isChainEnabledForClaim filter Home's scanExternalBalances and
      // the Hub's totalExternal already apply *before* summing. This used
      // to filter only for the chainsWithFunds list further down, so the
      // "Available to Claim" total here still included disabled chains'
      // balances even though the list underneath correctly hid them -
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
      // Quiet refresh: keep the balance the form already shows.
      if (!quiet) setChains(
        Object.keys(CHAIN_META)
          .filter(id => isChainEnabledForClaim(settingsMap, id))
          .map(id => ({ chainId: id, claimable: 0, pending: 0 }))
      )
    }
    if (!quiet) setStep('select')
  }, [getKey, trackClaimIdFromHub, settingsMap, settingsLoaded])

  const handleManualRefresh = useCallback(() => {
    if (Date.now() < refreshCooldownUntil) return
    setRefreshCooldownUntil(Date.now() + REFRESH_COOLDOWN_MS)
    scan(true)
  }, [refreshCooldownUntil, scan])

  // ── Reactive live updates - INSTANT-detect a real external-chain credit ──
  // BUG FIX (2026-09-21): this page previously only ever scanned external
  // balances once on mount (plus the manual refresh button above) - no
  // polling, no live updates at all. If funds arrived on an external chain
  // while this exact page was open, "Available to Claim" just sat there
  // until the user manually refreshed. Same reactive pattern now applied
  // consistently across every page that shows this figure (Home's card,
  // the Hub page, and this one): a Realtime subscription on claims/activity
  // for this wallet, patching ONLY the one chain that actually changed via
  // readExternalChainBalance - not a full rescan - the moment a claim or
  // transfer genuinely completes.
  useEffect(() => {
    if (!walletAddress) return
    let cancelled = false
    const onExternal = (e: Event) => {
      const d = (e as CustomEvent).detail || {}
      if (d.chainId) applyOne(d.chainId, d.balance)
    }
    window.addEventListener(EXTERNAL_BALANCE_EVENT, onExternal)
    const refreshOneChain = (chainId: string) => {
      readExternalChainBalance(chainId as any, walletAddress).then(b => applyOne(chainId, b)).catch(() => {})
    }
    function applyOne(chainId: string, balance: number) {
      if (cancelled) return
      setChains(prev => {
        const next = prev.some(c => c.chainId === chainId)
          ? prev.map(c => c.chainId === chainId ? { ...c, claimable: Math.floor(balance * 100) / 100 } : c)
          : [...prev, { chainId, claimable: Math.floor(balance * 100) / 100, pending: 0 }]
        setClaimableTotal(Math.floor(next.reduce((s, c) => s + c.claimable, 0) * 100) / 100)
        return next
      })
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
    return () => { cancelled = true; channel?.unsubscribe(); window.removeEventListener(EXTERNAL_BALANCE_EVENT, onExternal) }
  }, [walletAddress])

  useEffect(() => {
    scan(false, prefilledFromHub)
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
  // 0 - which is always the case when this screen is reached via the Hub's
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
  const openedFromHubRef = useRef(prefilledFromHub)
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

  // Try Again after a failed claim: the same chain's amount screen again. When
  // the page came from the Hub (or that chain has nothing left to claim), back
  // to the Hub's Bring tab - never this page's own old chain list.
  const retryClaim = () => {
    const sameChain = selected && chains.some(c => c.chainId === selected && c.claimable > 0) ? selected : null
    setError(''); setPassEntry(''); setConfirmPhase('processing'); setIsSubmitted(false); setShowPasscodeSheet(false)
    setAmountConfirmed(false); setClaimRecords([]); setClaimsByStatus({}); setChainProgress([])
    if (!sameChain && (embedded || openedFromHubRef.current)) { navigate('/multichain', { state: { tab: 'bring' } }); return }
    setSelected(sameChain)
    setStep('select')
    setSearchParams(new URLSearchParams(), { replace: true })
  }

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
      // Each chain's failure reason, for the Claim Failed screen. (chainProgress
      // in this callback is the value from when the claim started, so reading
      // it back only ever said "failed".)
      const chainErrors: Record<string, string> = {}

      const claimOneChain = async (chain: typeof selChains[0]) => {
        const inputAmt    = parseFloat((claimAmounts[chain.chainId] ?? '').replace(/[^0-9.]/g, '')) || 0
        const claimAmount = Math.min(inputAmt, chain.claimable ?? 0)

        // MIN_CLAIM_AMOUNT (module-level, shared with the amount screen's own
        // gate and the pre-claim fee estimate) - see its doc comment.
        if (claimAmount < MIN_CLAIM_AMOUNT) {
          // Previously just `return`ed here with zero feedback - the
          // chain's progress card stayed on whatever it last showed
          // (usually nothing), silently doing nothing with no
          // explanation. Surface it the same way a real failure would be.
          chainErrors[chain.chainId] = `Minimum $${trimTrailingZeros(MIN_CLAIM_AMOUNT.toFixed(2))} to claim`
          setChain(chain.chainId, 'error', chainErrors[chain.chainId], 0)
          return
        }

        // Failed history (lib/failure.ts): only when NOTHING left the source
        // chain. After the burn / Unified Balance deposit the claim is
        // finished through Recover - never shown as plain "Failed".
        const noteNothingMoved = (err: unknown, route: 'ub' | 'cctp') => {
          import('@/lib/failure').then(({ classifyFailure, recordFailure }) => recordFailure({
            feature: 'bring', walletAddress: wallet.addr, amount: claimAmount, token: 'USDC',
            sourceChain: chain.chainId, destinationChain: ARC_CHAIN_KEY, failure: classifyFailure(err),
            metadata: { route, claim_failed_before_burn: true },
          })).catch(() => {})
        }
        let burned = false

        try {
          setChain(chain.chainId, 'approving', `Preparing ${formatAmount(claimAmount)} USDC…`, 25)

          // ── Unified Balance route (Gateway): deposit on source → spend to Arc ──
          const sdkId = toSdkChainId(chain.chainId)
          if (!merchantMode && (claimRoute === 'ub' || !canBringOverCctp(chain.chainId)) && UB_CLAIM_CHAINS.has(sdkId)) {
            const { AppKit } = sdkRef.current ?? await loadSdk()
            const kit = new AppKit({ disableErrorReporting: true } as any)
            const adapter = await buildAdapter(wallet.signer)
            setUbClaimChains(prev => prev.includes(chain.chainId) ? prev : [...prev, chain.chainId])
            runUbClaim({
              kit, adapter, walletAddr: wallet.addr, sdkChainId: sdkId,
              chainLabel: getMeta(chain.chainId).label, amount: claimAmount,
              onStep: (stage, msg, pct, extra) => {
                setChain(chain.chainId, stage, msg, pct, extra)
                if (stage === 'attesting') notifyExternalBalanceChanged(chain.chainId, wallet.addr, { spent: claimAmount })
                // Submitted only once MeshPort's server holds the signed spend.
                // Finishing on this device (hand-off failed) keeps the screen
                // in "keep open" until the USDC lands.
                if (stage === 'attesting' && extra?.handedOff) {
                  setIsSubmitted(true)
                  setConfirmPhase(phase => phase === 'processing' ? 'submitted' : phase)
                }
                // UB has no server row - the arrival on Arc is the success signal.
                if (stage === 'done') {
                  setConfirmPhase(phase => (phase === 'processing' || phase === 'submitted' || phase === 'tracking') ? 'done' : phase)
                  // Refresh the Arc balance immediately (mint just landed) and drop
                  // the stale external aggregate so the Hub hero card updates at once.
                  refreshBalancesAfterTx(walletAddress)
                  refreshScope({ kind: 'external', wallet: walletAddress, chains: [chain.chainId] })
                  notifyExternalBalanceChanged(chain.chainId, walletAddress)
                }
              },
            }).catch((e: any) => {
              const msg = String(e?.shortMessage ?? e?.message ?? 'Claim failed').slice(0, 160)
              setChain(chain.chainId, 'error', msg, 0)
              // Failed before the deposit went through → nothing moved; show the failed screen.
              // After the deposit, the funds sit in Unified Balance and Track Progress explains it.
              setChainProgress(prev => {
                const cp = prev.find(p => p.chainId === chain.chainId)
                if (!cp?.txHash) { setError(msg); setTimeout(() => setStep('failed'), 300); noteNothingMoved(e, 'ub') }
                return prev
              })
            })
            return { chainId: chain.chainId, amount: claimAmount }
          }

          // Burn confirmed on-chain - record the claim and show "Claim
          // Submitted" right away.
          const handOffBurn = (cid: string, txHash: string, amount: number, meshportFee = 0) => {
            submitClaim({ walletAddress: wallet.addr, sourceChain: cid, amount, txHash, meshportFee }).then(res => {
              if (res.success && res.claimId) {
                setClaimRecords(prev =>
                  prev.some(r => r.chainId === cid) ? prev : [...prev, { chainId: cid, claimId: res.claimId! }]
                )
                // Show the "Claim Submitted" screen (with View in Hub /
                // Track Progress buttons) the instant submission is
                // confirmed - previously there was an extra artificial
                // 550ms pause here on top of submitClaim()'s own network
                // latency, making the buttons appear noticeably late.
                setConfirmPhase(phase => phase === 'processing' ? 'submitted' : phase)
              }
            })
          }

          // ── Solana (lib/solanaBridge.ts) ──
          // The account's Solana wallet signs one burn with Circle's
          // forwarding hook; MeshPort pays the SOL fee and Circle mints on
          // Arc. Then the same as a gasless bring: a claim that claim-worker
          // follows to the mint (Activity "Bring", notification, Recover).
          if (isSolanaChain(chain.chainId)) {
            const [{ bringSolanaToArc }, { getSolanaAddress, signSolanaTransaction }] = await Promise.all([
              import('@/lib/solanaBridge'), import('@/wallet/solana'),
            ])
            setChain(chain.chainId, 'approving', 'Signing the USDC transfer…', 25)
            const r = await bringSolanaToArc({
              owner: await getSolanaAddress(), arcRecipient: wallet.addr,
              amount: BigInt(Math.round(claimAmount * 1e6)), sign: signSolanaTransaction,
            })
            burned = true
            setClaimFees(prev => ({ ...prev, [chain.chainId]: { meshport: 0, circleCap: Number(r.maxFee) / 1e6 } }))
            setIsSubmitted(true)
            setChain(chain.chainId, 'attesting', 'Burn confirmed - Circle processing…', 65, { txHash: r.signature })
            notifyExternalBalanceChanged(chain.chainId, wallet.addr, { spent: claimAmount })
            // No MeshPort fee: the whole amount was burned (Circle's fee comes out on Arc).
            handOffBurn(chain.chainId, r.signature, claimAmount, 0)
            return { chainId: chain.chainId, amount: claimAmount }
          }

          // ── Gasless route (MeshPortBridgeRouter) ──
          // One signature, no gas on the source chain: the relayer submits it,
          // MeshPort's fee is taken in the same transaction, and Circle's
          // forwarder mints on Arc. The only CCTP route - chains without a
          // router (VITE_BRIDGE_ROUTERS) aren't offered.
          if (!isGaslessBridgeAvailable(chain.chainId)) throw new Error('Bring Funds is not available for this chain')
          const r = await bringFundsGasless({
            chainId: chain.chainId, amountUsdc: claimAmount, signer: wallet.signer, walletAddress: wallet.addr,
            // 'Getting fee…' / 'Signing…' → still authorizing; 'Submitting…'
            // means the authorization is signed and MeshPort's relayer is
            // sending the burn (it pays the gas in that transaction).
            onStatus: msg => msg === 'Submitting…' || msg === 'Confirming…'
              ? setChain(chain.chainId, 'burning', msg === 'Confirming…' ? `Waiting for ${getMeta(chain.chainId).label} to confirm the burn…` : 'Signed - MeshPort is sending the transfer…', 45)
              : setChain(chain.chainId, 'approving', msg === 'Signing…' ? 'Signing the USDC transfer…' : 'Getting fee…', 25),
          })
          burned = true
          setClaimFees(prev => ({ ...prev, [chain.chainId]: { meshport: r.fee, circleCap: r.maxFee } }))
          setIsSubmitted(true)
          setChain(chain.chainId, 'attesting', 'Burn confirmed - Circle processing…', 65, { txHash: r.txHash })
          notifyExternalBalanceChanged(chain.chainId, wallet.addr, { spent: claimAmount })
          // The claim is the burned amount: MeshPort's fee was taken before the burn.
          handOffBurn(chain.chainId, r.txHash, Math.max(0, claimAmount - r.fee), r.fee)
          return { chainId: chain.chainId, amount: claimAmount }

        } catch (e: any) {
          const msg = String(e?.shortMessage ?? e?.message ?? 'Claim failed').slice(0, 160)
          chainErrors[chain.chainId] = msg
          console.error('[Claim]', chain.chainId, e)
          if (!burned) noteNothingMoved(e, 'cctp')
          setChain(chain.chainId, 'error', msg.slice(0, 80), 0)
          return null
        }
      }

      for (const chain of selChains) {
        const result = await claimOneChain(chain)
        if (result) depositedChains.push(result)
      }

      if (depositedChains.length === 0) {
        const failedSummary = selChains
          .map(c => `${getMeta(c.chainId).label}: ${chainErrors[c.chainId] ?? 'failed'}`)
          .join('\n')
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
  }, [selectedTotal, chains, selected, claimAmounts, getKey, loadSdk, claimRoute, merchantMode])

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
    // concurrently with verifyPasscode below instead of after it - see
    // PaySendPage.tsx's own verifyAndSend for the full reasoning (two
    // independent PBKDF2 derives from the same passcode, otherwise run
    // back-to-back). `silent: true` so a wrong PIN doesn't flip on the
    // wallet-recovery banner before "Incorrect passcode" below even shows.
    import('@/lib/restoreWallet').then(({ restorePrivateKey }) => restorePrivateKey(passEntry, { silent: true })).catch(() => {})
    const { verifyPasscode } = await import('@/lib/security')
    if (!await verifyPasscode(passEntry, storedPasscode!)) {
      setPassError('Incorrect passcode. Try again.'); setPassEntry(''); return
    }
    const enteredPasscode = passEntry
    setPassError(''); setPassEntry('')
    setShowPasscodeSheet(false)
    setConfirmPhase('processing')
    setStep('confirm')
    // Passed through to getKey() as an authoritative fallback (see its own
    // BUG FIX comment) - never used for the speculative restore above (that
    // one is already in flight/done via the shared single-flight guard).
    await executeClaim(enteredPasscode)
  }, [passEntry, storedPasscode, executeClaim])

  const selectedChain = chains.find(c => c.chainId === selected)

  // ─── Receive summary / estimate readiness (shared by both render spots
  // below - the reordered desktop pre-confirm position and the original
  // mobile/post-confirm position) ─────────────────────────────────────────
  const claimAmt = parseFloat(claimAmounts[selected ?? ''] ?? '0') || 0
  // More than this chain has: warn, and don't show what "would" arrive.
  const claimOver = !!selectedChain && claimAmt > selectedChain.claimable
  const claimEstimateIsLive = feeEstimate.forKey === `${selected}|${claimAmt}`
  const showClaimEstimateRow = claimAmt >= MIN_CLAIM_AMOUNT
  const estimateReady = showClaimEstimateRow && claimEstimateIsLive && !feeEstimate.loading && !feeEstimate.error
  // Route (CCTP vs Unified Balance) - UB only for chains Gateway supports.
  const selectedSdkId = selected ? toSdkChainId(selected) : ''
  // Merchants never get the Unified Balance route - CCTP only.
  const ubAvailable = !merchantMode && UB_CLAIM_CHAINS.has(selectedSdkId)
  // CCTP here is the gasless router; a chain without one is Unified Balance only.
  const cctpAvailable = !!selected && canBringOverCctp(selected)
  const effectiveRoute: 'cctp' | 'ub' = !ubAvailable ? 'cctp' : !cctpAvailable ? 'ub' : claimRoute
  const reviewEnabled = claimAmt >= MIN_CLAIM_AMOUNT && claimAmt <= (selectedChain?.claimable ?? 0) && (effectiveRoute === 'ub' || estimateReady)
  // Unified Balance route: Circle Gateway's fee quote for this exact claim
  // (read-only, signs nothing), fetched ~600ms after the amount settles.
  const [ubFee, setUbFee] = useState<{ forKey: string; loading: boolean; error: string; needsUnlock: boolean
    gatewayFee: number; forwarderFee: number; otherFee: number; total: number; receiveAtLeast: number; approx?: boolean }>(
    { forKey: '', loading: false, error: '', needsUnlock: false, gatewayFee: 0, forwarderFee: 0, otherFee: 0, total: 0, receiveAtLeast: 0 })
  const ubFeeKey = `${selected}|${claimAmt}`
  useEffect(() => {
    // Quoted whichever route is picked, so the switch can show both fees.
    if (step !== 'select' || !selected || !ubAvailable || claimAmt < MIN_CLAIM_AMOUNT) return
    let cancelled = false
    setUbFee(prev => ({ ...prev, loading: true, error: '', needsUnlock: false, forKey: ubFeeKey }))
    const t = setTimeout(async () => {
      try {
        const { signer, walletAddress } = useAuthStore.getState()
        // Never prompts here: without an unlocked key the fees are shown on the next screen.
        if (!signer || !walletAddress) { if (!cancelled) setUbFee(prev => ({ ...prev, loading: false, needsUnlock: true })); return }
        const { AppKit } = sdkRef.current ?? await loadSdk()
        const kit = new AppKit({ disableErrorReporting: true } as any)
        const adapter = await buildAdapter(signer)
        const r = await estimateUbClaimFee({ kit, adapter, walletAddr: walletAddress, fromChain: selectedSdkId, amount: claimAmt })
        if (!cancelled) setUbFee({ approx: false, ...r, forKey: ubFeeKey, loading: false, error: '', needsUnlock: false })
      } catch (e: any) {
        console.warn('[bring] Unified Balance fee estimate failed', e)
        // Raw SDK errors are long and technical - keep the card readable.
        if (!cancelled) setUbFee(prev => ({ ...prev, loading: false, error: /too small/i.test(e?.message ?? '') ? UB_FEE_TOO_HIGH : "Couldn't load fees - shown on the next screen" }))
      }
    }, 600)
    return () => { cancelled = true; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, selected, ubAvailable, claimAmt, selectedSdkId])
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
    ? `At least $${formatAmount(feeEstimate.receiverGets)} on Arc`
    : 'Calculating…'
  const feeRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 11, color: COLORS.muted, fontVariantNumeric: 'tabular-nums' }
  const fmtFee = (n: number) => `$${trimTrailingZeros(n.toFixed(4))} USDC`
  // Sits inside the amount card, under the amount it applies to.
  const receiveSummaryCard = (
    <div style={{ width: '100%', marginTop: 12, paddingTop: 12, borderTop: `1px solid ${COLORS.border}` }}>
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
                <span>Up to {fmtFee(feeEstimate.bridgeFee)}</span>
              </div>
              <div style={{ ...feeRowStyle, color: COLORS.text, fontWeight: 600 }}>
                <span>Total fees</span>
                <span>Up to {fmtFee(feeEstimate.totalFee)}</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )

  const ubFeeLive = ubFee.forKey === ubFeeKey && !ubFee.loading
  // Unified Balance fee bigger than the amount (Ethereum: Circle charges the
  // gas to move USDC out of Ethereum, ~$1+): nothing would arrive. Bring is
  // refused up front - it used to go ahead, deposit, then fail to send,
  // leaving the USDC stuck in the Unified Balance on that chain.
  const ubFeeTooHigh = ubFeeLive && !ubFee.needsUnlock
    && (ubFee.error === UB_FEE_TOO_HIGH || (!ubFee.error && ubFee.receiveAtLeast <= 0))
  const bringEnabled = reviewEnabled && !(effectiveRoute === 'ub' && ubFeeTooHigh)
  // Unified Balance fee above UB_HIGH_FEE_USD (Circle's gas to move USDC out
  // of that chain - Ethereum ~$1.1): CCTP costs cents, so Bring picks CCTP
  // and says why. Every Unified Balance chain, Bring only. The person can
  // still pick Unified Balance (unless its fee is more than the amount) -
  // a deliberate pick for this chain + amount is never switched back.
  const ubFeeHigh = ubFeeLive && !ubFee.needsUnlock && !ubFee.error && ubFee.total > UB_HIGH_FEE_USD
  const ubPickedFor = useRef('')
  useEffect(() => {
    if (effectiveRoute === 'ub' && cctpAvailable && selected
      && (ubFeeTooHigh || (ubFeeHigh && ubPickedFor.current !== ubFeeKey))) setClaimRoute('cctp')
     
  }, [effectiveRoute, ubFeeTooHigh, ubFeeHigh, cctpAvailable, selected, ubFeeKey])
  const pickRoute = (id: 'ub' | 'cctp') => {
    if (id === 'ub') ubPickedFor.current = ubFeeKey
    setClaimRoute(id)
  }
  const cctpFeeText = claimEstimateIsLive && !feeEstimate.loading && !feeEstimate.error ? `up to ${fmtFee(feeEstimate.totalFee)}` : 'a few cents'
  // Short money for the one-line fee warning: $1.1, $0.03 (never "$0" for a real fee).
  const shortFee = (n: number) => n > 0 && n < 0.01 ? '<$0.01' : `$${trimTrailingZeros(n.toFixed(2))}`
  const cctpFeeShort = claimEstimateIsLive && !feeEstimate.loading && !feeEstimate.error ? shortFee(feeEstimate.totalFee) : 'a few cents'
  const ubHighWarning = (ubFeeHigh || ubFeeTooHigh) && cctpAvailable && selected
    ? `Unified Balance fee is high: Circle charges ${ubFee.approx ? 'up to' : 'about'} ${fmtFee(ubFee.total)} to move USDC out of ${getMeta(selected).label}'s Unified Balance${ubFeeTooHigh ? ' - more than this amount' : ''}. CCTP costs ${cctpFeeText}${effectiveRoute === 'cctp' ? ', so CCTP is selected.' : '.'}`
    : ''
  const ubSummaryCard = (
    <div style={{ width: '100%', marginTop: 12, paddingTop: 12, borderTop: `1px solid ${COLORS.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, color: COLORS.muted }}>You will receive</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: COLORS.text }}>
          {!showClaimEstimateRow ? `$${formatAmount(claimAmt)} on Arc`
            : ubFeeLive && !ubFee.error && !ubFee.needsUnlock ? `At least $${formatAmount(ubFee.receiveAtLeast)} on Arc`
            : ubFeeLive ? 'Shown on the next screen' : 'Calculating…'}
        </span>
      </div>
      {showClaimEstimateRow && (
        <div style={{ marginTop: 6, paddingTop: 6, borderTop: `1px solid ${COLORS.border}`, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {!ubFeeLive ? (
            <div style={feeRowStyle}><span>Fees</span><span>Calculating…</span></div>
          ) : ubFee.needsUnlock ? (
            <div style={feeRowStyle}><span>Fees</span><span>Shown on the next screen</span></div>
          ) : ubFeeTooHigh ? (
            <div style={{ ...feeRowStyle, color: COLORS.error }}>
              <span>Fees</span>
              <span style={{ textAlign: 'right' }}>
                {ubFee.total > 0 ? `About ${fmtFee(ubFee.total)} - more than this amount.` : 'More than this amount.'}
                {cctpAvailable ? ' Switch to CCTP, or bring more.' : ' Bring a larger amount.'}
              </span>
            </div>
          ) : ubFee.error ? (
            <div style={{ ...feeRowStyle, color: COLORS.error }}><span>Fees</span><span style={{ textAlign: 'right' }}>{ubFee.error}</span></div>
          ) : (
            <>
              <div style={feeRowStyle}><span>Circle Gateway fee</span><span>{ubFee.approx ? 'Up to ' : ''}{fmtFee(ubFee.gatewayFee)}</span></div>
              {ubFee.forwarderFee > 0 && <div style={feeRowStyle}><span>Forwarding fee</span><span>{fmtFee(ubFee.forwarderFee)}</span></div>}
              {ubFee.otherFee > 0 && <div style={feeRowStyle}><span>Other fees</span><span>{fmtFee(ubFee.otherFee)}</span></div>}
              <div style={{ ...feeRowStyle, color: COLORS.text, fontWeight: 600 }}><span>Total fees</span><span>Up to {fmtFee(ubFee.total)}</span></div>
            </>
          )}
        </div>
      )}
    </div>
  )

  const chainsWithFunds  = chains
    .filter(c => c.claimable > 0 || c.pending > 0)
    // Only chains Bring Funds can actually move: a gasless router, or Unified
    // Balance. Merchants: gasless router (CCTP) chains only.
    .filter(c => canBringOverCctp(c.chainId) || (!merchantMode && UB_CLAIM_CHAINS.has(toSdkChainId(c.chainId))))
    // `chains` only ever contains enabled chains to begin with - scan()
    // above reads via readExternalBalances, which is already settings-aware
    // and never even fetches a disabled chain's balance. This filter is now
    // just a safety net; disabledClaimChains below is what actually
    // surfaces disabled chains in the list.
    .filter(c => isChainEnabledForClaim(settingsMap, c.chainId))
    // Highest balance first - makes the biggest claimable amounts the most
    // prominent/easiest to act on instead of showing in arbitrary chain
    // config order.
    .sort((a, b) => (b.claimable + b.pending) - (a.claimable + a.pending))

  // Admin-disabled Claim chains - shown in the list too (dimmed,
  // unclickable, with a reason) instead of silently disappearing, so
  // someone with funds sitting on a chain that just got disabled can see
  // why it's temporarily unavailable instead of wondering where it went.
  // Never counted in claimableTotal - that total is summed in scan() from
  // readExternalBalances, which skips disabled chains entirely and never
  // reads their balance in the first place, so there's nothing of theirs
  // to (mis)count here.
  const disabledClaimChains = Object.keys(CHAIN_META)
    .filter(id => !isChainEnabledForClaim(settingsMap, id))
    .filter(id => canBringOverCctp(id) || (!merchantMode && UB_CLAIM_CHAINS.has(toSdkChainId(id))))
    .map(id => ({
      chainId: id,
      // Lets an admin set a specific reason per chain by putting text in
      // that chain's chains_claim toggle row (the `value` column - same
      // free-text field maintenance_mode already uses for its message).
      // Falls back to a generic reason when nothing's been set.
      reason: settingsMap[CHAIN_CLAIM_FEATURE_MAP[id]]?.value || 'Upgrading - coming soon',
    }))

  // ─── Render ──────────────────────────────────────────────────────────────────

  // Hub Bring page: which screen is showing, for the slide-in between them.
  // Chain list → amount → processing each push; loading swaps in place to
  // whatever it was loading, and the result (success or failure) stays on
  // the screen it came from.
  const lastPushKey = useRef(selected ? 'amount' : 'select')
  const pushKey = step === 'loading' ? lastPushKey.current
    : step === 'select' ? (selectedChain ? 'amount' : 'select')
    : step === 'confirm' && confirmPhase !== 'done' ? 'proc'
    : lastPushKey.current
  lastPushKey.current = pushKey

  // Held in a variable (not returned directly) so the exact same JSX renders
  // either as the whole page (mobile) or as the left column of the desktop
  // 2-column layout below - never duplicated.
  // Desktop: no root-level overflow-hidden - each screen already has its
  // own bounded height + inner scroll container (mobile's proven
  // pattern), and the desktop column wrapping `flow` already has its own
  // overflowY:'auto'. Hard-clipping here too (on top of that) was cutting
  // off the bottom of tall content - the Success screen's summary card +
  // buttons - with no way to reach it, since this was the innermost clip
  // boundary. Mobile keeps overflow-hidden, unchanged.
  const flow = (
    <div ref={flowRootRef} style={{ background: COLORS.bg, display: 'flex', flexDirection: 'column', height: '100%',
      // Inside the Hub: clip only sideways (the step slide-ins) - never
      // vertically, so the amount form can glide up over the Hub's balance
      // card and tabs when the keypad opens, like Transfer.
      // position: relative - the step leaving a cross-fade is popped out of
      // the layout (StepSwap) and positioned against this.
      position: 'relative', overflowX: 'clip', overflowY: 'visible' }}>

      {/* LOADING STATE - chains scroll horizontally through a fixed scan
          line, like a barcode scanner, using real chain logos rather than
          a generic spinner. Purely decorative/illustrative (not literally
          tied to per-chain completion) - same idea as the Hub's chain list,
          just the enabled set for Claim specifically.

          Wrapped in the AnimatePresence below (shared with the chain-select
          screen) so finishing the scan crossfades smoothly into the results
          instead of instantly cutting from one screen to the other - that
          instant, un-animated unmount/mount swap was the "flicker" when the
          scan ended. */}
      <PushIf on={pushScreens} screenKey={pushKey} back={direction === 'back'}>
      <StepSwap push={pushScreens}>
      {step === 'loading' && (
        <motion.div
          key="loading"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={MOBILE_TAB_FADE_TRANSITION}
          {...(pushScreens ? INSTANT_STEP : {})}
          style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: SPACING.lg }}
        >
          {deepLinkChain ? (
            // Opened from a chain card in the Hub, which already scanned -
            // just a short "opening <chain>" state while its balance loads.
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <div style={{ position: 'relative', width: 64, height: 64, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {/* CSS animation, not framer: this sits under the
                    AnimatePresence initial={false} below, which blocks every
                    descendant motion element's first animation - so a framer
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
          // In place: a quick fade (in the Hub, the push slides it in).
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={MOBILE_TAB_FADE_TRANSITION}
          {...(pushScreens ? INSTANT_STEP : {})}
          style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
        >
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `${SPACING.sm}px ${SPACING.md}px`, background: COLORS.bg, borderBottom: `1px solid ${COLORS.border}`, flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm }}>
              <button onClick={() => navigate('/multichain')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: COLORS.text, display: 'flex', alignItems: 'center' }}>
                <ArrowLeft className="w-5 h-5"/>
              </button>
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
              initial={pushScreens ? false : { opacity: 0, y: MOBILE_TAB_FADE_Y }} animate={{ opacity: 1, y: 0 }} transition={MOBILE_TAB_FADE_TRANSITION}
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
                      initial={pushScreens ? false : { opacity: 0, y: MOBILE_TAB_FADE_Y }} animate={{ opacity: isSelectable ? 1 : 0.5, y: 0 }}
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
                {/* Admin-disabled chains - dimmed, unclickable, reason
                    shown in place of a balance. Sorted after every enabled
                    chain (funded or not) so they never push real, actionable
                    balances further down the list. */}
                {disabledClaimChains.map((c, i) => {
                  const m = getMeta(c.chainId)
                  return (
                    <motion.div
                      key={c.chainId}
                      initial={pushScreens ? false : { opacity: 0, y: MOBILE_TAB_FADE_Y }} animate={{ opacity: 0.45, y: 0 }}
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
                initial={pushScreens ? false : { opacity: 0, y: MOBILE_TAB_FADE_Y }} animate={{ opacity: 1, y: 0 }} transition={MOBILE_TAB_FADE_TRANSITION}
                style={{ textAlign: 'center', padding: `${SPACING.xl * 2}px ${SPACING.md}px`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 200 }}
              >
                <div style={{ opacity: 0.5, marginBottom: 12 }}><ActionIcon name="hub" size={48} color={COLORS.muted} /></div>
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
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={MOBILE_TAB_FADE_TRANSITION}
          onClick={() => { if (keypadOpen) setKeypadOpen(false) }}
          {...(pushScreens ? INSTANT_STEP : {})}
          style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
        >
          {/* Header - hidden inside the Hub (the form has its own Back) */}
          {!embedded && <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.md, padding: `${SPACING.sm}px ${SPACING.md}px`, background: COLORS.bg, borderBottom: `1px solid ${COLORS.border}`, flexShrink: 0 }}>
            <button onClick={e => { e.stopPropagation(); leaveAmountStep() }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: COLORS.text, display: 'flex', alignItems: 'center' }}>
              <ArrowLeft className="w-5 h-5"/>
            </button>
            <ChainLogo chainId={selectedChain.chainId} size={28}/>
            <span style={{ fontSize: 16, fontWeight: 700, color: COLORS.text }}>{getMeta(selectedChain.chainId).label}</span>
          </div>}

          {/* Bring Funds form (Arc Bridge layout, MeshPort brand):
              From → Amount → Route → Destination → Back / Review & Claim.
              Review & Claim goes to the same passcode + claim flow as before. */}
          {/* Inside the Hub the page itself scrolls - this box must not clip, so
              the lifted form can slide up over the Hub's balance card and tabs
              exactly like Transfer does. */}
          <div style={{ flex: 1, minHeight: 0, overflowY: embedded ? 'visible' : 'auto', padding: `${SPACING.lg}px ${SPACING.lg}px`, paddingBottom: SPACING.xl }}>
            {/* Glides up with the keypad (same as Transfer) so the amount stays in view. */}
            {/* Bring Funds (full page): From → To, the amount with its fees,
                the route, then one Bring button. Glides up with the keypad
                (same as Transfer) so the amount stays in view. */}
            <motion.div animate={{ y: -keypadLift }} initial={false} transition={KEYPAD_SPRING}
              style={{ display: 'flex', flexDirection: 'column', gap: 18, minHeight: '100%' }}>

              {/* From → To: two compact cards. Tapping From goes back to pick another chain. */}
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 28px minmax(0, 1fr)', alignItems: 'center', gap: 6 }}>
                <button onClick={e => { e.stopPropagation(); leaveAmountStep() }} aria-label={`From ${getMeta(selectedChain.chainId).label} - choose another chain`}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 10px', borderRadius: 16, cursor: 'pointer', textAlign: 'left',
                    background: COLORS.surface, border: `1px solid ${COLORS.border}`, color: COLORS.text, minWidth: 0 }}>
                  <ChainLogo chainId={selectedChain.chainId} size={28}/>
                  <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
                    <span style={{ fontSize: 11, color: COLORS.muted }}>From</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 14, fontWeight: 700, minWidth: 0 }}>
                      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{getMeta(selectedChain.chainId).label}</span>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={COLORS.muted} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M6 9l6 6 6-6"/></svg>
                    </span>
                    <span style={{ fontSize: 11.5, color: COLORS.muted, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{formatAmount(selectedChain.claimable)} USDC</span>
                  </span>
                </button>
                <div aria-hidden="true" style={{ width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'color-mix(in srgb, var(--brand) 14%, transparent)', color: 'var(--brand-text)' }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 10px', borderRadius: 16, minWidth: 0,
                  background: 'color-mix(in srgb, var(--brand) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--brand) 30%, transparent)' }}>
                  <img decoding="async" src="/logos/chains/arc.svg" alt="" width={28} height={28} style={{ borderRadius: '50%', flexShrink: 0 }}/>
                  <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
                    <span style={{ fontSize: 11, color: COLORS.muted }}>To</span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: COLORS.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Arc</span>
                    <span style={{ fontSize: 11.5, color: COLORS.muted, whiteSpace: 'nowrap' }}>Your wallet</span>
                  </span>
                </div>
              </div>

              {/* Amount, with what arrives and the fees right under it */}
              <div style={{ padding: '16px 18px', borderRadius: 22, background: COLORS.surface,
                border: `1.5px solid ${claimOver || error ? COLORS.error : keypadOpen ? COLORS.primary : COLORS.border}` }}>
                <span style={{ fontSize: 13, color: COLORS.muted }}>Amount (USDC)</span>
                {/* Same field on desktop (typed in) and mobile (opens the keypad). */}
                <div style={{ marginTop: 8 }}>
                  <AmountField
                    value={claimAmounts[selected!] ?? ''}
                    onChange={v => { setClaimAmounts(prev => ({ ...prev, [selected!]: sanitizeAmountInput(v, CLAIM_DECIMALS) })); setError('') }}
                    onTap={desktopInput ? undefined : () => { setAmountConfirmed(false); setKeypadOpen(true) }}
                    editing={keypadOpen}
                    boxRef={amountBoxRef}
                    onMax={() => {
                      setClaimAmounts(prev => ({ ...prev, [selected!]: parseFloat(selectedChain.claimable.toFixed(2)).toString() }))
                      setError('')
                    }}
                    invalid={!!error || claimOver || (claimAmt > 0 && claimAmt < MIN_CLAIM_AMOUNT)}
                    ariaLabel="Amount in USDC"
                    token={{ label: 'USDC', logo: '/logos/tokens/usdc.png' }}
                    quick={quickAmounts([10, 50, 100], '$', v => { setClaimAmounts(prev => ({ ...prev, [selected!]: v })); setError('') }, selectedChain.claimable)}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, gap: 8, fontSize: 12.5 }}>
                    <span style={{ color: COLORS.muted }}>Available: {formatAmount(selectedChain.claimable)} USDC</span>
                    {claimOver ? (
                      <span style={{ fontWeight: 700, color: COLORS.error }}>Insufficient balance · Max {formatAmount(selectedChain.claimable)}</span>
                    ) : claimAmt > 0 && claimAmt < MIN_CLAIM_AMOUNT && (
                      <span style={{ fontWeight: 700, color: COLORS.error }}>Minimum ${trimTrailingZeros(MIN_CLAIM_AMOUNT.toFixed(2))}</span>
                    )}
                  </div>
                </div>
                {!desktopInput && !amountConfirmed && !keypadOpen && !claimAmt && (
                  <p style={{ fontSize: 12, color: COLORS.muted, margin: '6px 0 0' }}>Tap the amount to enter a value</p>
                )}
                {!claimOver && (effectiveRoute === 'cctp' ? receiveSummaryCard : ubSummaryCard)}
              </div>

              {/* Route: a two-way switch, with one line on how the chosen one works */}
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.text, marginBottom: 8 }}>How should it travel?</div>
                {ubAvailable && cctpAvailable && (
                  <div role="radiogroup" aria-label="Route" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 4, padding: 4, borderRadius: 16,
                    background: COLORS.surface, border: `1px solid ${COLORS.border}` }}>
                    {([['ub', 'Unified Balance'], ['cctp', 'CCTP']] as const).map(([id, name]) => {
                      const on = effectiveRoute === id
                      // Each route's fee under its name; Unified Balance is
                      // marked and can't be picked when Circle's fee from this
                      // chain is more than the amount.
                      const tooHigh = id === 'ub' && ubFeeTooHigh
                      const feeLine = !showClaimEstimateRow ? ''
                        : id === 'ub'
                          ? (!ubFeeLive ? 'Fee …' : ubFee.needsUnlock ? '' : tooHigh ? (ubFee.total > 0 ? `Fee ${fmtFee(ubFee.total).replace(' USDC', '')} · too high` : 'Fee too high')
                            : ubFeeHigh ? `Fee ${ubFee.approx ? 'up to ' : ''}${fmtFee(ubFee.total).replace(' USDC', '')} · high`
                            : ubFee.error ? '' : `Fee ${ubFee.approx ? 'up to ' : ''}${fmtFee(ubFee.total).replace(' USDC', '')}`)
                          : (!claimEstimateIsLive || feeEstimate.loading ? 'Fee …' : feeEstimate.error ? '' : `Fee up to ${fmtFee(feeEstimate.totalFee).replace(' USDC', '')}`)
                      return (
                        <button key={id} role="radio" aria-checked={on} aria-disabled={tooHigh} onClick={() => { if (!tooHigh) pickRoute(id) }}
                          style={{ minHeight: 42, padding: '6px 6px', borderRadius: 12, border: 'none', cursor: tooHigh ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: on ? 700 : 600,
                            background: on ? 'var(--brand)' : 'transparent', color: on ? '#fff' : COLORS.muted, opacity: tooHigh ? 0.75 : 1,
                            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1 }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 5, maxWidth: '100%' }}>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                            <SpeedTag fast={id === 'cctp'} on={on} />
                          </span>
                          <span style={{ fontSize: 11, fontWeight: 500, color: on ? 'rgba(255,255,255,0.85)' : COLORS.muted }}>
                            {id === 'ub' ? ubBringTime(selectedSdkId) : CCTP_BRING_TIME}
                          </span>
                          {feeLine && (
                            <span style={{ fontSize: 11, fontWeight: 500, color: tooHigh ? COLORS.error : (id === 'ub' && ubFeeHigh) ? 'var(--warning)' : on ? 'rgba(255,255,255,0.85)' : COLORS.muted }}>{feeLine}</span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: ubAvailable && cctpAvailable ? 10 : 0, padding: '0 4px' }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--brand-text)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
                    {effectiveRoute === 'ub' ? <path d="M13 2L4 14h7l-1 8 9-12h-7z"/> : <path d="M4 8h14l-3-3M20 16H6l3 3"/>}
                  </svg>
                  <p style={{ margin: 0, fontSize: 13, lineHeight: 1.45, color: COLORS.muted, alignSelf: 'center' }}>
                    {/* One short line - the long version pushed the fee warning and
                        the Bring button off shorter screens. */}
                    {effectiveRoute === 'ub'
                      ? <><b style={{ color: COLORS.text, fontWeight: 600 }}>Via Unified Balance</b> · finish in Recover if you leave</>
                      : <><b style={{ color: COLORS.text, fontWeight: 600 }}>Burn & mint</b> · fast, gasless, arrives on Arc</>}
                  </p>
                </div>
              </div>

              {/* High Unified Balance fee: one line, with a one-tap switch to CCTP
                  while Unified Balance is picked. The full sentence stays as the
                  accessible description. */}
              {ubHighWarning && (
                <div role="status" aria-label={ubHighWarning} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 8px 8px 12px', borderRadius: 12, fontSize: 13, lineHeight: 1.35,
                  color: COLORS.text, background: 'color-mix(in srgb, var(--warning) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)' }}>
                  <span aria-hidden style={{ color: 'var(--warning)', fontWeight: 700 }}>!</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {effectiveRoute === 'ub'
                      ? <>Fee {shortFee(ubFee.total)} is high · CCTP {cctpFeeShort}</>
                      : <>Unified Balance fee {shortFee(ubFee.total)} is high · using CCTP</>}
                  </span>
                  {effectiveRoute === 'ub' && (
                    <button onClick={e => { e.stopPropagation(); pickRoute('cctp') }}
                      style={{ flexShrink: 0, minHeight: 30, padding: '0 12px', borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
                        background: 'var(--warning)', color: '#1A1205' }}>
                      Use CCTP
                    </button>
                  )}
                </div>
              )}

              {error && <p role="alert" style={{ fontSize: 13, color: COLORS.error, margin: 0, textAlign: 'center' }}>{error}</p>}

              {/* Bring - stays at the bottom of the screen while the page scrolls */}
              <div ref={actionsRef} style={{ position: 'sticky', bottom: 0, zIndex: 2, marginTop: 'auto', paddingTop: 10, paddingBottom: 4, background: COLORS.bg, scrollMarginBottom: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <button
                  onClick={e => {
                    e.stopPropagation()
                    const amt = parseFloat(claimAmounts[selected!] ?? '0') || 0
                    if (amt < MIN_CLAIM_AMOUNT) { setError(`Minimum $${trimTrailingZeros(MIN_CLAIM_AMOUNT.toFixed(2))}`); return }
                    if (amt > selectedChain.claimable) { setError('Exceeds available balance'); return }
                    if (effectiveRoute === 'cctp' && !estimateReady) return
                    if (effectiveRoute === 'ub' && ubFeeTooHigh) return
                    setAmountConfirmed(true)
                    setKeypadOpen(false)
                    handleClaimTap()
                  }}
                  disabled={!bringEnabled}
                  className="active:scale-[.98] transition-all"
                  style={{ width: '100%', height: 56, borderRadius: 18, fontSize: 16, fontWeight: 700, border: 'none', color: '#fff',
                    background: COLORS.primary, cursor: bringEnabled ? 'pointer' : 'not-allowed', opacity: bringEnabled ? 1 : 0.45 }}>
                  {claimAmt > 0 ? `Bring ${formatAmount(claimAmt)} USDC` : 'Bring'}
                </button>
              </div>
            </motion.div>
          </div>

          {/* Amount Keypad - mobile only; Done just closes it (Review & Claim is on the card). */}
          {!desktopInput && (
            <div className="keypad-eraser-fix" onClick={e => e.stopPropagation()}>
              <AmountKeypad
                // The amount field above has its own Max.
                showMax={false}
                open={keypadOpen && !showPasscodeSheet}
                value={claimAmounts[selected!] ?? ''}
                onChange={v => { setClaimAmounts(prev => ({ ...prev, [selected!]: v })); setError('') }}
                balance={selectedChain.claimable}
                token="USDC"
                decimals={CLAIM_DECIMALS}
                doneLabel="Done"
                doneEnabled={true}
                error={claimOver ? 'Insufficient balance' : claimAmt > 0 && claimAmt < MIN_CLAIM_AMOUNT ? `Minimum $${trimTrailingZeros(MIN_CLAIM_AMOUNT.toFixed(2))}` : ''}
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

          {/* Passcode - the app's passcode step (PinSheet), on this same page,
              no navigation: phone = bottom sheet, desktop = the authorize
              dialog in the right-hand panel. */}
          <PinSheet open={showPasscodeSheet} id="mc-pass"
            onClose={() => { setShowPasscodeSheet(false); setPassEntry(''); setPassError('') }}
            title={desktopInput ? 'Authorize Claim' : 'Confirm claim'}
            subtitle={desktopInput ? `From ${selectedChain ? getMeta(selectedChain.chainId).label : 'Multichain'}` : `Confirm claim of $${formatAmount(selectedTotal)} USDC`}
            amountLabel={`$${formatAmount(selectedTotal)} USDC`} placement="panel"
            card={{ label: 'Claiming from', name: selectedChain ? getMeta(selectedChain.chainId).label : 'Multichain', detail: 'To your Arc balance', amount: `$${formatAmount(selectedTotal)}`, unit: 'USDC' }}
            bioVerb="Claim"
            value={passEntry} onChange={v => { setPassEntry(v); setPassError('') }} error={passError || undefined}
            onComplete={(_, viaBiometric) => { setPaidViaBiometric(!!viaBiometric); handlePasscodeConfirm() }} />
        </motion.div>
      )}

      {/* ── PAGE 2: processing -> done, same page ── */}
      {step === 'confirm' && (
        <motion.div
          key="confirm-step"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={MOBILE_TAB_FADE_TRANSITION}
          {...(pushScreens ? INSTANT_STEP : {})}
          style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
        >
          {/* PROCESSING -> SUBMITTED - one continuous screen. The icon and
              title update (spinner/"Processing claim" -> paper-plane/"Claim
              Submitted") and the extra text + countdown + buttons fade in
              underneath, but the stepper itself never resets or swaps out -
              it's the same checklist throughout, not two separate screens. */}
          {/* Success flash (portaled), drawn over the live view underneath.
              It stays until the receipt's check circle has mounted, so the
              live view is never uncovered in between. */}
          {confirmPhase === 'done' && (successPhase === 'flash' || !heroCheckEl) && (
            <SuccessFlash title="Claimed Successfully" checkRef={flashCheckRef} viaBiometric={paidViaBiometric} circleReady={flashCircleReady} onCircleReady={() => setFlashCircleReady(true)} rect={isDesktopMq ? flashColumnRect : null} radius={RADII.card} />
          )}
          <AnimatePresence mode="wait">
          {/* PROCESSING → SUBMITTED → (Track Progress) - the one Multichain
              progress page (MoveProgress). It never swaps to another screen:
              Track Progress folds it down to the remaining steps in place, a
              claim opened from the Hub (?claim=) lands here too, and the
              success flash + receipt take over once the last step is done. */}
          {(confirmPhase === 'processing' || confirmPhase === 'submitted' || confirmPhase === 'tracking'
            || (confirmPhase === 'done' && successPhase === 'flash')) && (() => {
            const cp0 = chainProgress[0]
            const stage = cp0?.stage ?? 'waiting'
            const errored = stage === 'error'
            if (!errored && cp0) lastClaimStageRef.current = stage
            const reached = errored ? lastClaimStageRef.current : stage
            const chainId = cp0?.chainId ?? trackRec?.chainId
            // Same route decision claimOneChain makes.
            const isUbRoute = !!cp0 && (ubClaimChains.includes(cp0.chainId)
              || (!merchantMode && (claimRoute === 'ub' || !canBringOverCctp(cp0.chainId)) && UB_CLAIM_CHAINS.has(toSdkChainId(cp0.chainId))))
            const route = isUbRoute ? 'ub' : 'cctp'
            const srcLabel = chainId ? getMeta(chainId).label : 'source chain'
            const steps = moveSteps({
              kind: 'bring', route, from: srcLabel, to: 'Arc', amount: formatAmount(displayTotal || trackClaimRow?.amount || 0),
              fastFinality: isUbRoute && !!chainId && ubClaimEta(toSdkChainId(chainId)) === 'under a minute',
            })
            let current = cp0 ? indexFromBringStage(route, reached, cp0.handedOff) : 1
            if (!isUbRoute && trackClaimRow) current = Math.max(current, indexFromClaimStatus(trackClaimRow.status))
            if (!isUbRoute && bringIris && bringIris.stage !== 'error') current = Math.max(current, indexFromCctpStage(bringIris.stage))
            if (confirmPhase === 'done') current = steps.length
            const failed = errored ? (cp0?.msg || 'Something went wrong')
              : trackClaimRow?.status === 'failed' ? (trackClaimRow.error || 'This bring needs attention – finish it from Multichain Hub → Recover.')
              : null
            const safe = confirmPhase === 'submitted' || confirmPhase === 'tracking' || (isUbRoute && !!cp0?.handedOff)
            const srcTx = cp0?.txHash || trackClaimRow?.txHash || undefined
            const mintTx = cp0?.mintTxHash || trackClaimRow?.destinationTxHash || undefined
            const srcLink = srcTx && chainId ? { hash: srcTx, href: explorerTxUrl(chainId, srcTx) } : undefined
            const mintLink = mintTx ? { hash: mintTx, href: arcExplorerTxUrl(mintTx) } : undefined
            return (
            <motion.div
              key="claiming-step"
              // Leaving for the receipt (under the flash): go at once, no fade.
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: confirmPhase === 'done' ? { duration: 0 } : MOBILE_TAB_FADE_TRANSITION }}
              transition={MOBILE_TAB_FADE_TRANSITION}
              {...(pushScreens ? INSTANT_STEP : {})}
              style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto', padding: '0 12px 12px' }}
            >
              <MoveProgress
                kind="bring" route={route} fromLabel={chainProgress.length > 1 ? `${chainProgress.length} chains` : srcLabel} toLabel="Arc"
                amount={displayTotal || trackClaimRow?.amount || 0}
                steps={steps} current={current} failed={failed} safe={safe} timeSteps
                loading={!cp0 && !trackClaimRow}
                txs={isUbRoute ? [srcLink, undefined, undefined, mintLink] : [undefined, srcLink, undefined, mintLink]}
                holdText="Please wait – don't close this screen until the bring is submitted."
                onViewHub={() => navigate('/multichain', { state: { tab: 'activity' } })}
              />
            </motion.div>
            )
          })()}

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
            const shortHash = txHash ? `${txHash.slice(0, 6)}...${txHash.slice(-4)}` : '-'
            const fromChainIds = chainProgress.length ? chainProgress.map(p => p.chainId) : (selected ? [selected] : [])
            const timeLabel = new Date().toLocaleString('en-US', {
              month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
            })
            const fmtAmount = `${formatAmount(displayTotal)} USDC`
            // Fees actually paid: MeshPort's fee, plus Circle's CCTP fee as
            // taken (burned − arrived) once the funds are on Arc - until
            // then only its cap is known, shown as "up to" (it used to be
            // added in as if the whole cap had been charged).
            const fees = claimFeeSummary(claimFees, Object.values(claimsByStatus))
            const usdc = (n: number) => `${trimTrailingZeros(n.toFixed(4))} USDC`
            const hasFees = Object.keys(claimFees).length > 0
            const totalFeesLabel = fees.final
              ? usdc(fees.meshport + fees.circle)
              : `${usdc(fees.meshport + fees.circle)} + up to ${usdc(fees.circleCap)}`
            const circleFeeLabel = fees.final ? usdc(fees.circle) : `Up to ${usdc(fees.circle + fees.circleCap)} (final once it arrives)`
            // Process checklist - the same four steps the progress page
            // showed, all done (this only mounts once the bring landed).
            const doneUb = fromChainIds.some(id => ubClaimChains.includes(id))
            const processSteps = moveSteps({
              kind: 'bring', route: doneUb ? 'ub' : 'cctp',
              from: fromChainIds.length === 1 ? getMeta(fromChainIds[0]).label : `${fromChainIds.length} chains`, to: 'Arc',
              amount: formatAmount(displayTotal),
            })

            return (
            <motion.div key="done-step" style={{ flex: 1, position: 'relative', minHeight: 0 }}>
              {/* `minHeight: 0` is required here - without it this flex item
                  (a child of confirm-step's height:100% flex column) grows
                  to fit its own content instead of being capped to the
                  available space, so the child below's `height:'100%';
                  overflowY:'auto'` never actually gets a shorter box to
                  scroll inside. On mobile `flow`'s own `overflow:'hidden'`
                  then just clips whatever doesn't fit - hiding the bottom
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
                  // hash - p.txHash is the SOURCE-chain burn hash, which
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
                    { label: 'Done', onClick: () => navigate('/multichain'), primary: true },
                  ]}
                  title="Funds Arrived"
                  subtitle={<>From {fromLabel}, now in your Arc wallet</>}
                  pill={`Completed in ${claimElapsedSeconds} Seconds`}
                  rows={[
                    { label: 'Claimed', value: fmtAmount, positive: true },
                    ...(txHash ? [{ label: 'Transaction Hash', value: shortHash, onCopy: () => copyClaimHash(txHash), copied: hashCopied }] : []),
                    { label: 'Time', value: timeLabel },
                  ]}
                  steps={processSteps.map(s => s.done)}
                  detailRows={[
                    ...(hasFees ? [
                      { label: 'MeshPort Fee', value: usdc(fees.meshport) },
                      { label: 'Circle Fee', value: circleFeeLabel },
                    ] : []),
                    { label: 'Total Fees', value: hasFees ? totalFeesLabel : usdc(0) },
                  ]}
                  links={links}
                  linksNote={mintPending && links.length > 0 ? 'The Arc mint link appears once the mint lands on Arc.' : undefined}
                  onPrimary={() => navigate('/multichain')}
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
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={MOBILE_TAB_FADE_TRANSITION}
          {...(pushScreens ? INSTANT_STEP : {})}
          style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: `0 ${SPACING.xl}px` }}
        >
          <motion.div
            initial={{ scale: 0.5 }} animate={{ scale: 1 }}
            transition={{ duration: 0.32, ease: EASE_OUT }}
            style={{ width: 80, height: 80, borderRadius: '50%', background: 'color-mix(in srgb, var(--danger) 12%, transparent)', border: '2px solid color-mix(in srgb, var(--danger) 35%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: SPACING.lg }}
          >
            <XCircle className="w-10 h-10" style={{ color: COLORS.error }}/>
          </motion.div>
          <p style={{ fontSize: 18, fontWeight: 700, color: COLORS.error, margin: '0 0 8px', textAlign: 'center' }}>Claim Failed</p>
          {error && <p role="alert" style={{ fontSize: 13, color: COLORS.muted, margin: '0 0 28px', textAlign: 'center', maxWidth: '100%' }}>{error}</p>}
          <div style={{ display: 'flex', gap: SPACING.sm, width: '100%' }}>
            <button onClick={retryClaim} style={{ flex: 1, padding: `${SPACING.lg}px`, borderRadius: RADII.button, border: 'none', fontSize: 14, fontWeight: 600, color: '#fff', background: COLORS.primary, cursor: 'pointer' }}>
              Try Again
            </button>
            <button onClick={() => navigate('/multichain', { state: { tab: 'bring' } })} style={{ flex: 1, padding: `${SPACING.lg}px`, borderRadius: RADII.button, border: `1px solid ${COLORS.border}`, background: 'transparent', fontSize: 14, fontWeight: 600, color: COLORS.muted, cursor: 'pointer' }}>
              Back
            </button>
          </div>
        </motion.div>
      )}
      </StepSwap>
      </PushIf>

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

  return flow
}
