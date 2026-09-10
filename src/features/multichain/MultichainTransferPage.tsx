import React, { useState, useRef, useEffect, useLayoutEffect, type ReactNode, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { PinKeypad } from '@/components/ui/PinKeypad'
import { AmountKeypad } from '@/components/ui/AmountKeypad'
import { TravelingCheckmark } from '@/components/ui/TravelingCheckmark'
import { FlashAuthIcon } from '@/components/ui/FlashAuthIcon'
import {
  ArrowLeft, QrCode, Lock, CheckCircle, XCircle, AlertCircle, Loader2, ChevronDown, Clock,
  Check, Copy, Zap, FileText, Globe, ExternalLink, Home, RotateCcw, ArrowUpFromLine, Receipt,
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useWalletStore, useAuthStore, useUIStore } from '@/store'
import { awardTransactionPoints } from '@/lib/rewards'
import { notifyRewardMultichain } from '@/lib/notifications'
import { formatAmount, shortenAddress, midShortenAddress, timeAgo, copyToClipboard, trimTrailingZeros } from '@/lib/utils'
import { saveResumableOperation, getResumableOperation, clearResumableOperation } from '@/lib/resumableOperation'
import { useSettingsStore } from '@/store/settingsStore'
import { isChainEnabledForTransfer, resolveChainMechanism } from '@/lib/featureFilters'
import { ARC_EXPLORER, explorerTxUrl, arcExplorerTxUrl } from '@/lib/chainExplorers'
import { ARC_RPCS, ARC_NETWORK } from '@/lib/arc'
import { RPC_BY_CHAIN_NAME, chainSupportsForwarder } from '@/lib/chainRpcs'
import { logTestEvent, newRunId, type TestService } from '@/lib/multichainTestLog'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'
import { DesktopTransactionAuthDialog } from '@/components/ui/DesktopTransactionAuthDialog'
import { DesktopHistoryPanel, DesktopHistoryEmpty, DesktopHistorySkeleton, DesktopHistoryDetail } from '@/components/ui/DesktopHistoryPanel'
import { fetchActivity, type ActivityRecord } from '@/lib/ActivityService'

// Digit/decimal sanitizing for the desktop "Amount" native input (mirrors
// AmountKeypad's own internal sanitizer, which isn't exported) — max one
// '.', capped at 2 typed decimal places.
function sanitizeMultichainAmount(raw: string): string {
  let cleaned = raw.replace(/[^\d.]/g, '')
  const firstDot = cleaned.indexOf('.')
  if (firstDot !== -1) cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '')
  const [intPart, decPart] = cleaned.split('.')
  if (decPart !== undefined) cleaned = intPart + '.' + decPart.slice(0, 2)
  return cleaned
}

// ── Module-level caches — survive re-renders, reset only on full page reload ──
// Caching the three heavy SDK packages eliminates the 500ms–1s dynamic-import
// penalty from the signing hot-path on every bridge attempt.
interface SdkModules {
  AppKit: any
  KitError: any
  createEthersAdapterFromPrivateKey: any
  JsonRpcProvider: any
  FallbackProvider: any
}
let _sdkModules: SdkModules | null = null
let _sdkLoading = false
const _sdkCallbacks: Array<() => void> = []

/** Load (or return cached) SDK modules. Safe to call from multiple places. */
async function loadSdkModules(): Promise<SdkModules> {
  if (_sdkModules) return _sdkModules
  if (_sdkLoading) {
    // Already in-flight — wait for it to finish
    return new Promise(res => _sdkCallbacks.push(() => res(_sdkModules!)))
  }
  _sdkLoading = true
  const [{ AppKit, KitError }, { createEthersAdapterFromPrivateKey }, { JsonRpcProvider, FallbackProvider }] = await Promise.all([
    import('@circle-fin/app-kit'),
    import('@circle-fin/adapter-ethers-v6'),
    import('ethers'),
  ])
  _sdkModules = { AppKit, KitError, createEthersAdapterFromPrivateKey, JsonRpcProvider, FallbackProvider }
  _sdkLoading = false
  _sdkCallbacks.splice(0).forEach(cb => cb())   // wake up any waiters
  return _sdkModules
}

// JsonRpcProvider cache — one provider instance per RPC URL per session.
// Avoids repeated eth_chainId auto-detect on each approve/burn call.
const _providerCache = new Map<string, any>()

function getCachedProvider(rpcUrl: string, JsonRpcProvider: any, chainId?: number) {
  if (!_providerCache.has(rpcUrl)) {
    // Pin the network when the SDK tells us the chain ID up front — same
    // reasoning as ARC_NETWORK below: skips the eth_chainId auto-detect
    // call (and its endless 1s retry loop on failure) for a chain ID we
    // already know isn't going to change mid-session.
    // toAbsoluteRpcUrl is a no-op for the absolute URLs the SDK normally
    // hands back here — cheap defense in depth against the same
    // "unsupported protocol" failure a relative URL causes (see
    // toAbsoluteRpcUrl below for the full explanation).
    const url = toAbsoluteRpcUrl(rpcUrl)
    _providerCache.set(rpcUrl, chainId
      ? new JsonRpcProvider(url, { chainId, name: 'chain-' + chainId }, { staticNetwork: true })
      : new JsonRpcProvider(url))
  }
  return _providerCache.get(rpcUrl)
}

// ── Resolve a possibly-relative RPC URL to an absolute one ──────────────────
// ARC_RPCS is deliberately relative ('/api/arc-rpc' — a same-origin proxy,
// see arc.ts) so the real upstream RPC URL/key never ships in client JS.
// fetch() and viem's http() transport both resolve a relative URL against
// the page origin automatically, which is why arcTransport()/arcRpcJson()
// in arc.ts work fine with it as-is.
//
// ethers' JsonRpcProvider does NOT do that: its fetch layer derives the
// protocol via `req.url.split(':')[0]`, and for a relative path like
// '/api/arc-rpc' (no colon) that whole string becomes the "protocol",
// which fails ethers' http/https check with
// `unsupported protocol /api/arc-rpc (...code=UNSUPPORTED_OPERATION)`.
//
// THIS was the actual, original cause of the bridge failures — a plain
// JsonRpcProvider throws it directly; wrapped in FallbackProvider (the
// prior code path) it got caught internally, marked the provider
// permanently dead, and resurfaced later as ethers' generic "no runners?!"
// once every provider was exhausted, which is what made it look like an
// intermittent connectivity issue rather than every single Arc call via
// ethers failing outright. Resolving to an absolute URL up front fixes it
// at the source instead of just tolerating the downstream symptom.
function toAbsoluteRpcUrl(url: string): string {
  if (/^[a-z]+:\/\//i.test(url)) return url // already absolute
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin + (url.startsWith('/') ? url : '/' + url)
  }
  return url
}

// Arc has no single reliable RPC endpoint, so when the Circle SDK doesn't
// hand us a specific rpcEndpoint for it, fail over across ARC_RPCS instead
// of pinning to one hardcoded URL.
//
// BUG FIX: this used to ALWAYS wrap ARC_RPCS in an ethers FallbackProvider,
// even though ARC_RPCS today only has one entry ('/api/arc-rpc'). Ethers'
// FallbackProvider marks a config with `_lastFatalError` the first time its
// initial getBlockNumber() sync throws (a single rate limit / cold start /
// transient network blip on that one proxied endpoint) and NEVER clears
// that flag. With only one config, that single bad response permanently
// exhausts every "runner" FallbackProvider has to try, and every future
// call — including reads deep inside kit.bridge()/estimateBridge() —
// throws ethers' own internal `"no runners?!"` error for the rest of the
// session. Because this provider is cached at module scope (see
// _providerCache below), the poisoning survives across retries: clicking
// "Try Again" reuses the same dead instance and fails identically, and only
// a full page reload actually recovers.
//
// A FallbackProvider only earns its name when there's more than one
// endpoint to fail over BETWEEN. With a single URL there's nothing to fall
// back to, so skip FallbackProvider entirely in that case and hand back a
// plain JsonRpcProvider instead — its failures are per-call and
// recoverable, not permanent. If ARC_RPCS ever grows to multiple entries,
// this automatically goes back to using FallbackProvider across them.
const _ARC_FALLBACK_KEY = '__arc_fallback__'
function getArcFallbackProvider(JsonRpcProvider: any, FallbackProvider: any) {
  if (!_providerCache.has(_ARC_FALLBACK_KEY)) {
    const providers = ARC_RPCS.map(url => new JsonRpcProvider(toAbsoluteRpcUrl(url), ARC_NETWORK, { staticNetwork: true }))
    // quorum: 1 — treat this purely as failover, not multi-node consensus
    _providerCache.set(_ARC_FALLBACK_KEY, providers.length === 1
      ? providers[0]
      : new FallbackProvider(providers, undefined, { quorum: 1 }))
  }
  return _providerCache.get(_ARC_FALLBACK_KEY)
}

// Non-Arc destination chains had NO fallback at all before this: getProvider
// trusted whatever single endpoint the Circle SDK handed back
// (sdkChain.rpcEndpoints[0]) and had nowhere to go if that one endpoint was
// slow or rate-limited — this mattered specifically for non-forwarder
// chains, where `adapter` submits the destination mint itself and a stalled
// destination RPC stalled the whole transfer with nothing to fail over to.
// RPC_BY_CHAIN_NAME (shared with MultichainClaimPage.tsx via chainRpcs.ts —
// see that file for why it's shared rather than copied) gives each
// destination chain the same multi-endpoint failover Arc already had.
function getDestFallbackProvider(
  sdkChain: any,
  fallbackRpcUrl: string | undefined,
  JsonRpcProvider: any,
  FallbackProvider: any,
) {
  const chainName: string = sdkChain?.name ?? ''
  const urls = RPC_BY_CHAIN_NAME[chainName] ?? (fallbackRpcUrl ? [fallbackRpcUrl] : [])
  if (urls.length === 0) return undefined

  const cacheKey = `__dest_fallback__${chainName || urls[0]}`
  if (!_providerCache.has(cacheKey)) {
    const providers = urls.map(url => sdkChain?.chainId
      ? new JsonRpcProvider(toAbsoluteRpcUrl(url), { chainId: sdkChain.chainId, name: 'chain-' + sdkChain.chainId }, { staticNetwork: true })
      : new JsonRpcProvider(toAbsoluteRpcUrl(url)))
    // quorum: 1 — failover only, not multi-node consensus (same reasoning
    // as getArcFallbackProvider above).
    _providerCache.set(cacheKey, providers.length === 1
      ? providers[0]
      : new FallbackProvider(providers, undefined, { quorum: 1 }))
  }
  return _providerCache.get(cacheKey)
}


// e.g. ARC_RPCS grows to multiple entries in the future and a
// FallbackProvider gets fatally poisoned again — evict it so the next call
// builds a fresh instance instead of retrying against the same dead one.
// Cheap to call defensively; a no-op if nothing's cached.
function resetArcFallbackProvider() {
  _providerCache.delete(_ARC_FALLBACK_KEY)
}

type MCStep = 'form' | 'review' | 'confirm' | 'broadcasting' | 'success' | 'failed'
type BridgeStepStatus = 'pending' | 'active' | 'done' | 'error'

interface BridgeStepState {
  name: string
  label: string
  status: BridgeStepStatus
  message: string
  txHash?: string
  startedAt?: number
  completedAt?: number
  // true only when a real SDK event confirmed this step; false/undefined
  // means it was marked 'done' by the auto-advance timer's time-based
  // guess, not an actual confirmation. See startStepTimer / handleEvent.
  verified?: boolean
}

interface FeeEstimate {
  bridgeFee: number
  networkFee: number
  forwarderFee: number
  totalFee: number
  receiverGets: number
  loading: boolean
  error: string
}

// Circle Gateway's estimateSpend() only prices the SPEND leg (unified
// balance -> destination) — it has no visibility into the DEPOSIT leg that
// has to happen first (Arc USDC -> the Gateway Wallet contract), which is
// itself a normal Arc transaction and therefore needs Arc gas. Arc's
// native gas token is USDC (same fact PaySendPage.tsx's own feeReserve is
// built on), so that deposit's gas has to come out of the exact same
// balance being sent — reserving nothing for it here is exactly what let
// someone type an amount right up to their full balance, have the deposit
// itself succeed, and then have nothing left over once the spend step's
// own (correctly estimated) fee tried to come out of what's left.
// A flat conservative reserve, not a live estimate: depositWithPermit is
// a more complex contract call than the simple 21000-gas native transfer
// estimateTransferFee() prices, and this only needs to be safely
// sufficient, not exact — any leftover just makes receiverGets a touch
// more conservative than reality.
const UB_DEPOSIT_GAS_RESERVE = 0.05 // USDC

// Gateway attestations expire 10 minutes after issuance if unused (per
// Circle's "Unified Balance Kit: Production Safeguards and Recovery
// Patterns for spend()"). The resumable-retry path below fires
// synchronously right after a spend() failure, so in practice this rarely
// matters today — but it's the correct guard if a delayed/manual "resume"
// ever gets added later. Deliberately time-based rather than checking
// `trace.expirationBlock`: that field isn't documented as belonging to a
// specific chain (source vs destination), and guessing wrong would be worse
// than not checking at all. Buffered to 8 of the 10 minutes so a slow
// network round-trip on the retry call itself doesn't get raced against the
// real expiry.
const GATEWAY_ATTESTATION_EXPIRY_SAFETY_MS = 8 * 60 * 1000

// ── Defensive guard: top-level `amount` must equal the sum of `allocations` ──
// Circle's kit validates this itself and throws a clear error when it
// doesn't match (see "Select source blockchains" in the App Kit docs), but
// that validation error surfaces from deep inside the SDK call, mixed in
// with every other possible spend/estimate failure — indistinguishable from
// a genuine on-chain issue without reading the message text. Both UB call
// sites here build `amount` and `allocations` from the same local variable,
// so today they can never actually diverge — this is intentionally
// redundant with the SDK's own check, there purely so that if a future edit
// ever computes them separately and lets them drift, it fails loudly and
// immediately at the call site (with the two actual numbers in the message)
// instead of surfacing as an opaque SDK rejection.
function assertAllocationsMatchAmount(amount: string, allocations: Array<{ amount: string }>, context: string) {
  const target = parseFloat(amount)
  const sum = allocations.reduce((s, a) => s + (parseFloat(a.amount) || 0), 0)
  // Compare in integer micro-USDC (6dp) to sidestep float rounding noise.
  if (Math.round(target * 1e6) !== Math.round(sum * 1e6)) {
    throw new Error(`[${context}] amount/allocations mismatch: amount=${amount}, allocations sum=${sum.toFixed(6)}`)
  }
}

interface SuccessInfo {
  sentAmount: number
  receiverGets: number
  totalFees: number
  completionTime: number // seconds
  // Best hash to surface as "the" transaction on the success card — the real
  // destination mint hash when we have one, otherwise the Arc-side burn/deposit
  // hash. Not safe to pair with the DESTINATION chain's explorer (it may be an
  // Arc hash); use `mintTxHash` for that.
  txHash: string
  // The genuine destination-chain mint/spend tx hash, ONLY when one actually
  // exists. Empty for every forwarder transfer: per Arc's docs, when Circle's
  // Forwarding Service submits the mint there is no locally-signed hash and the
  // mint step's `data` is undefined. The "View on {chain} Explorer" link is
  // gated on this so it never points at a tx that isn't on that chain.
  mintTxHash?: string
  burnTxHash?: string  // source-chain (Arc burn/deposit) tx hash — for the "View on Arc Explorer" link
}

// ── Official chain logos — URL-based, from the provided CHAIN_LOGOS map ──────
// Falls back to a colored circle with ticker text if the image fails to load.
// ── Official chain logos — local files under public/logos/chains/, sourced
// from @web3icons/core (MIT licensed) and downloaded ahead of time, plus a
// few supplied directly for chains web3icons didn't cover.
// Falls back to a colored circle with ticker text if the image fails to load.
const CHAIN_LOGOS: Record<string, string> = {
  eth         : '/logos/chains/ethereum.svg',
  base        : '/logos/chains/base.svg',
  arb         : '/logos/chains/arbitrum.svg',
  pol         : '/logos/chains/polygon.svg',
  op          : '/logos/chains/optimism.svg',
  avax        : '/logos/chains/avalanche.svg',
  hyperevm    : '/logos/chains/hyperevm.svg',
  sei         : '/logos/chains/sei.svg',
  sonic       : '/logos/chains/sonic.svg',
  unichain    : '/logos/chains/unichain.svg',
  world       : '/logos/chains/world.svg',
  linea       : '/logos/chains/linea.svg',
  ink         : '/logos/chains/ink.svg',
  monad       : '/logos/chains/monad.svg',
  morph       : '/logos/chains/morph.svg',
  pharos      : '/logos/chains/pharos.svg',
  plume       : '/logos/chains/plume.svg',
  xdc         : '/logos/chains/xdc.svg',
  codex       : '/logos/chains/codex.svg',
  edge        : '/logos/chains/edge.svg',
  injective   : '/logos/chains/injective.svg',
}

// Fallback bg colors per chain for when logo fails to load
const CHAIN_FALLBACK: Record<string, { bg: string; text: string; label: string }> = {
  eth:       { bg: '#343434', text: '#fff',    label: 'ETH'  },
  base:      { bg: '#0052FF', text: '#fff',    label: 'BASE' },
  arb:       { bg: '#213147', text: '#28A0F0', label: 'ARB'  },
  pol:       { bg: '#7B3FE4', text: '#fff',    label: 'POL'  },
  op:        { bg: '#FF0420', text: '#fff',    label: 'OP'   },
  avax:      { bg: '#E84142', text: '#fff',    label: 'AVAX' },
  hyperevm:  { bg: '#020B22', text: '#fbbf24', label: 'HYPE' },
  sei:       { bg: '#9d2235', text: '#fff',    label: 'SEI'  },
  sonic:     { bg: 'var(--surface)', text: '#FC5501', label: 'SON'  },
  unichain:  { bg: '#FF007A', text: '#fff',    label: 'UNI'  },
  world:     { bg: '#191919', text: '#fff',    label: 'WLD'  },
  linea:     { bg: '#000000', text: '#fff',    label: 'LIN'  },
  ink:       { bg: '#1a1a2e', text: 'var(--text-secondary)', label: 'INK'  },
  monad:     { bg: '#200052', text: '#fff',    label: 'MON'  },
  morph:     { bg: '#020B22', text: 'var(--text-secondary)', label: 'MRPH' },
  pharos:    { bg: '#020B22', text: 'var(--text-secondary)', label: 'PHR'  },
  plume:     { bg: '#020B22', text: 'var(--text-secondary)', label: 'PLME' },
  xdc:       { bg: '#1a3a5c', text: '#fff',    label: 'XDC'  },
  codex:     { bg: '#5B5FDE22', text: '#5B5FDE', label: 'CDX'  },
  edge:      { bg: '#FFB80022', text: '#FFB800', label: 'EDGE' },
  injective: { bg: '#00d4ff22', text: '#00d4ff', label: 'INJ' },
}

// Point at parameter t (0-1) along a quadratic bezier — used to position
// the animated dot/trail on the transfer-progress journey path so its
// motion follows the actual curve instead of a straight line.
function quadBezierPoint(t: number, p0: [number, number], p1: [number, number], p2: [number, number]): [number, number] {
  const mt = 1 - t
  const x = mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0]
  const y = mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1]
  return [x, y]
}

// Chain logo img component — official URL with fallback
function ChainLogoImg({ id, size = 32 }: { id: string; size?: number }) {
  const [ok, setOk] = React.useState(true)
  const url = CHAIN_LOGOS[id]
  const fb  = CHAIN_FALLBACK[id] ?? { bg: '#1c1c1c', text: '#fff', label: id.slice(0,4).toUpperCase() }
  if (!url || !ok) {
    return (
      <div style={{
        width: size, height: size, borderRadius: size * 0.3125,
        background: fb.bg, display: 'flex', alignItems: 'center',
        justifyContent: 'center', flexShrink: 0, overflow: 'hidden',
      }}>
        <span style={{ fontSize: size * 0.28, fontWeight: 800, color: fb.text, lineHeight: 1 }}>
          {fb.label}
        </span>
      </div>
    )
  }
  return (
    <img
      src={url}
      alt={id}
      width={size}
      height={size}
      style={{ width: size, height: size, borderRadius: size * 0.3125,
               objectFit: 'cover', display: 'block', flexShrink: 0 }}
      onError={() => setOk(false)}
    />
  )
}

// Small pill shown next to a chain wherever it's picked or displayed —
// ub===true routes through Circle Gateway (unified balance, <500ms per
// Circle's own docs: developers.circle.com/gateway/references/supported-blockchains),
// everything else still goes through the CCTP flow (20-90s Circle
// attestation). Surfacing this distinction is the whole point: users
// choosing a destination chain should be able to see up front which ones
// are the fast path.
function ChainSpeedBadge({ ub }: { ub: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-bold flex-shrink-0"
      style={ub
        ? { background: 'color-mix(in srgb, var(--success) 14%, transparent)', color: 'var(--success)', border: '1px solid rgba(34,197,94,0.3)' }
        : { background: 'color-mix(in srgb, var(--text-secondary) 12%, transparent)', color: 'var(--text-secondary)', border: '1px solid color-mix(in srgb, var(--text-secondary) 25%, transparent)' }
      }
    >
      {ub ? 'UB' : 'CCTP'}
    </span>
  )
}

const ALL_CHAINS = [
  { id: 'eth',       name: 'Ethereum',    testnet: 'Ethereum Sepolia',    sdk: 'Ethereum_Sepolia',     emoji: 'Ξ',  gasToken: 'ETH',  minGas: 0.001, time: '<30s',  bg: 'rgba(98,126,234,0.15)', tc: '#818cf8', ub: true,  popular: true,  layer: 'L1' },
  { id: 'base',      name: 'Base',        testnet: 'Base Sepolia',        sdk: 'Base_Sepolia',          emoji: '🔵', gasToken: 'ETH',  minGas: 0.0001, time: '<10s', bg: 'rgba(0,82,255,0.15)',   tc: '#38bdf8', ub: true,  popular: true,  layer: 'L2' },
  { id: 'arb',       name: 'Arbitrum',    testnet: 'Arbitrum Sepolia',    sdk: 'Arbitrum_Sepolia',      emoji: '🔷', gasToken: 'ETH',  minGas: 0.0001, time: '<10s', bg: 'rgba(27,74,221,0.15)',  tc: '#60a5fa', ub: true,  popular: true,  layer: 'L2' },
  { id: 'pol',       name: 'Polygon',     testnet: 'Polygon PoS Amoy',    sdk: 'Polygon_Amoy_Testnet',  emoji: '⬡',  gasToken: 'POL',  minGas: 0.01,  time: '<10s',  bg: 'rgba(130,71,229,0.15)', tc: '#a78bfa', ub: true,  popular: true,  layer: 'L2' },
  { id: 'op',        name: 'Optimism',    testnet: 'OP Sepolia',          sdk: 'Optimism_Sepolia',      emoji: '🔴', gasToken: 'ETH',  minGas: 0.0001, time: '<10s', bg: 'rgba(255,4,32,0.12)',   tc: '#f87171', ub: true,  popular: true,  layer: 'L2' },
  { id: 'avax',      name: 'Avalanche',   testnet: 'Avalanche Fuji',      sdk: 'Avalanche_Fuji',        emoji: '🔺', gasToken: 'AVAX', minGas: 0.01,  time: '<15s',  bg: 'rgba(232,65,66,0.12)',  tc: '#f87171', ub: true,  popular: true,  layer: 'L1' },
  { id: 'hyperevm',  name: 'HyperEVM',    testnet: 'HyperEVM Testnet',    sdk: 'HyperEVM_Testnet',      emoji: '⚡', gasToken: 'HYPE', minGas: 0.01,  time: '<10s',  bg: 'rgba(250,204,21,0.12)', tc: '#fbbf24', ub: true,  popular: false, layer: 'L2' },
  { id: 'sei',       name: 'Sei',         testnet: 'Sei Testnet',         sdk: 'Sei_Testnet',           emoji: '🌊', gasToken: 'SEI',  minGas: 0.1,   time: '<10s',  bg: 'rgba(157,34,53,0.15)',  tc: '#22d3ee', ub: true,  popular: false, layer: 'L1' },
  { id: 'sonic',     name: 'Sonic',       testnet: 'Sonic Testnet',       sdk: 'Sonic_Testnet',         emoji: '🎵', gasToken: 'S',    minGas: 0.01,  time: '<8s',   bg: 'rgba(139,92,246,0.12)', tc: '#a78bfa', ub: true,  popular: false, layer: 'L1' },
  { id: 'unichain',  name: 'Unichain',    testnet: 'Unichain Sepolia',    sdk: 'Unichain_Sepolia',      emoji: '🦄', gasToken: 'ETH',  minGas: 0.0001, time: '<8s',  bg: 'rgba(255,0,122,0.12)',  tc: '#f472b6', ub: true,  popular: false, layer: 'L2' },
  { id: 'world',     name: 'World Chain', testnet: 'World Chain Sepolia', sdk: 'World_Chain_Sepolia',   emoji: '🌍', gasToken: 'ETH',  minGas: 0.0001, time: '<10s', bg: 'rgba(16,185,129,0.12)', tc: '#34d399', ub: true,  popular: false, layer: 'L2' },
  { id: 'linea',     name: 'Linea',       testnet: 'Linea Sepolia',       sdk: 'Linea_Sepolia',         emoji: '📐', gasToken: 'ETH',  minGas: 0.0001, time: '<15s', bg: 'rgba(18,18,18,0.5)',    tc: 'var(--text-secondary)', ub: false, popular: false, layer: 'L2' },
  { id: 'ink',       name: 'Ink',         testnet: 'Ink Testnet',         sdk: 'Ink_Testnet',           emoji: '🖊️', gasToken: 'ETH',  minGas: 0.0001, time: '<15s', bg: 'rgba(100,116,139,0.12)',tc: 'var(--text-secondary)', ub: false, popular: false, layer: 'L2' },
  { id: 'monad',     name: 'Monad',       testnet: 'Monad Testnet',       sdk: 'Monad_Testnet',         emoji: '🔮', gasToken: 'MON',  minGas: 0.01,  time: '<12s',  bg: 'rgba(32,0,82,0.4)',     tc: 'var(--text-secondary)', ub: false, popular: false, layer: 'L1' },
  { id: 'morph',     name: 'Morph',       testnet: 'Morph Testnet',       sdk: 'Morph_Testnet',         emoji: '🔄', gasToken: 'ETH',  minGas: 0.0001, time: '<15s', bg: 'rgba(100,116,139,0.12)',tc: 'var(--text-secondary)', ub: false, popular: false, layer: 'L2' },
  { id: 'pharos',    name: 'Pharos',      testnet: 'Pharos Atlantic',     sdk: 'Pharos_Testnet',        emoji: '🏛️', gasToken: 'PTT',  minGas: 0.01,  time: '<15s',  bg: 'rgba(100,116,139,0.12)',tc: 'var(--text-secondary)', ub: false, popular: false, layer: 'L1' },
  { id: 'plume',     name: 'Plume',       testnet: 'Plume Testnet',       sdk: 'Plume_Testnet',         emoji: '🪶', gasToken: 'PLUME',minGas: 0.01,  time: '<15s',  bg: 'rgba(100,116,139,0.12)',tc: 'var(--text-secondary)', ub: false, popular: false, layer: 'L1' },
  { id: 'xdc',       name: 'XDC',         testnet: 'XDC Apothem',         sdk: 'XDC_Apothem',           emoji: '💠', gasToken: 'XDC',  minGas: 1,     time: '<15s',  bg: 'rgba(26,58,92,0.4)',    tc: 'var(--text-secondary)', ub: false, popular: false, layer: 'L1' },
  { id: 'codex',     name: 'Codex',       testnet: 'Codex Testnet',       sdk: 'Codex_Testnet',         emoji: '📖', gasToken: 'CDX',  minGas: 0.01,  time: '<15s',  bg: 'rgba(100,116,139,0.12)',tc: 'var(--text-secondary)', ub: false, popular: false, layer: 'L2' },
  { id: 'edge',      name: 'EDGE',        testnet: 'EDGE Testnet',        sdk: 'Edge_Testnet',          emoji: '⚙️', gasToken: 'EDGE', minGas: 0.01,  time: '<15s',  bg: 'rgba(100,116,139,0.12)',tc: 'var(--text-secondary)', ub: false, popular: false, layer: 'L1' },
  { id: 'injective', name: 'Injective',   testnet: 'Injective Testnet',   sdk: 'Injective_Testnet',     emoji: '💉', gasToken: 'INJ',  minGas: 0.01,  time: '<15s',  bg: 'rgba(0,212,255,0.08)',  tc: '#00d4ff', ub: false, popular: false, layer: 'L1' },
] as const

type ChainId = typeof ALL_CHAINS[number]['id']

// Approve/Burn happen ON Arc (source of the transfer), but Mint happens on
// the DESTINATION chain — a real bug existed here where every step's
// explorer link pointed at Arc's own explorer regardless of which chain the
// transaction actually happened on. ARC_EXPLORER/explorerTxUrl/
// arcExplorerTxUrl now come from src/lib/chainExplorers.ts — this used to be
// a local copy that drifted out of sync with three other copies elsewhere
// in the app (and with the SDK's own values); see that file for details.

// Circle's Crosschain Forwarding Service (useForwarder:true) automates the
// destination-chain mint + pays destination gas, but it only covers an
// explicit allow-list of chains — it is NOT available for every CCTP-enabled
// destination. Routing every chain through useForwarder:true regardless of
// this list is what silently broke Plume (and would equally break Pharos,
// XDC, Codex, Edge, Injective, Morph): estimateBridge doesn't throw for an
// unsupported route (see fetchFeeEstimate/handleSend below), it just returns
// a null/error fee entry that we were papering over — so the estimate looked
// fine right up until kit.bridge() had no forwarder available to submit the
// mint, and the transfer stalled after the burn.
// FORWARDER_SUPPORTED_SDK_CHAINS and chainSupportsForwarder now live in
// src/lib/chainRpcs.ts (imported above) so the Claim direction
// (src/lib/backgroundBridge.ts) can share the exact same list instead of
// having no way to check it at all.

const SPEEDS = [
  { id: 'fast',     label: 'Fast',     emoji: '⚡', time: '<30s',   desc: 'Get there in < 30 seconds'      },
  { id: 'standard', label: 'Standard', emoji: '🕐', time: '~2 min', desc: 'Usually arrives in ~2 minutes'  },
  { id: 'economy',  label: 'Economy',  emoji: '🐢', time: '~10 min', desc: 'Usually arrives in ~10 minutes' },
] as const
type SpeedId = typeof SPEEDS[number]['id']

function isEVMAddress(v: string) { return /^0x[0-9a-fA-F]{40}$/.test(v) }
function isSolanaAddress(v: string) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) }

const STEP_DEFS = [
  { key: 'approve',     label: 'Approve',       pendingMsg: 'Waiting for approval…',           activeMsg: 'Approval transaction submitted…' },
  { key: 'burn',        label: 'Burn',          pendingMsg: 'Waiting for burn…',                activeMsg: 'Burn transaction submitted…' },
  { key: 'attestation', label: 'Attestation',   pendingMsg: 'Waiting for Circle to attest…',   activeMsg: 'Waiting for Circle attestation (20–90s)…' },
  { key: 'mint',        label: 'Mint',          pendingMsg: 'Waiting for mint…',                activeMsg: 'Mint transaction submitted…' },
]

function makeDefaultSteps(destName: string): BridgeStepState[] {
  return STEP_DEFS.map((d, i) => ({
    name: d.key,
    label: i === 3 ? `Mint on ${destName}` : d.label,
    status: 'pending' as BridgeStepStatus,
    message: d.pendingMsg,
  }))
}

// Circle Gateway (unified balance) path — used instead of the 4-step CCTP
// flow above for chains with ub===true (see CHAINS below). Gateway is a
// deposit-once/spend-anywhere model: USDC already sitting in the unified
// balance is available on every ub-supported chain in <500ms (per Circle's
// own docs), so a transfer from Arc is really "move Arc USDC into the
// unified balance" (~0.5s, Arc's own confirmation time) then "spend it out
// to the destination" (<500ms) — two fast, deterministic steps, not the
// CCTP burn/attest/mint cycle with its unpredictable 20-90s attestation
// wait. That's why this only needs 2 steps instead of 4, and why the
// step-advancement TIMER the CCTP path relies on (to paper over that CCTP
// wait) isn't used here — both legs resolve directly, so steps just flip
// active/done as each call actually completes.
const UB_STEP_DEFS = [
  { key: 'deposit', label: 'Approving USDC',           pendingMsg: 'Waiting for approval…', activeMsg: 'Moving USDC to Unified Balance…' },
  { key: 'spend',   label: 'Transferred to Destination', pendingMsg: 'Waiting to send…',       activeMsg: 'Sending from Unified Balance…' },
]

function makeUBSteps(destName: string): BridgeStepState[] {
  return UB_STEP_DEFS.map((d, i) => ({
    name: d.key,
    label: i === 1 ? `Transferred to ${destName}` : d.label,
    status: 'pending' as BridgeStepStatus,
    message: d.pendingMsg,
  }))
}

// ── Success-screen building blocks — mirrors MultichainClaimPage's own
// success screen exactly (same sparkle glyph, same row/step components,
// same flash→hero travel mechanic) so a completed transfer looks and
// behaves just like a completed claim ────────────────────────────────────
const TRANSFER_SPARKLE_PATH = 'M12 0 L14.2 9.8 L24 12 L14.2 14.2 L12 24 L9.8 14.2 L0 12 L9.8 9.8 Z'
function TransferSparkle({ size, style }: { size: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ position: 'absolute', ...style }}>
      <path d={TRANSFER_SPARKLE_PATH} fill="rgba(255,255,255,0.55)" />
    </svg>
  )
}

// One row of the Transaction details card (icon-in-circle + label on the
// left, value on the right), with an optional copy button and an optional
// bottom divider for every row but the last.
function TransferDetailRow({ icon, label, value, mono, onCopy, copied, showDivider, last }: {
  icon: ReactNode; label: string; value: ReactNode; mono?: boolean
  onCopy?: () => void; copied?: boolean; showDivider?: boolean; last?: boolean
}) {
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10.6,
        paddingTop: 'clamp(7.4px, 1.591vh, 10.6px)',
        paddingBottom: last ? 'clamp(6.7px, 1.432vh, 9.6px)' : 'clamp(7.4px, 1.591vh, 10.6px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'clamp(9.6px, 2.44vw, 11.6px)', minWidth: 0 }}>
          <div style={{
            width: 'clamp(29.7px, 7.83vw, 34px)', height: 'clamp(29.7px, 7.83vw, 34px)', borderRadius: '50%', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', color: 'var(--brand)',
          }}>
            {icon}
          </div>
          <span style={{ fontSize: 'clamp(13.8px, 3.5vw, 15.3px)', color: 'var(--text-secondary)' }}>{label}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6.4, minWidth: 0 }}>
          <span style={{
            fontSize: 'clamp(13.3px, 3.4vw, 14.8px)', fontWeight: mono ? 500 : 700, color: 'color-mix(in srgb, var(--text-primary) 100%, white 12%)',
            fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{value}</span>
          {onCopy && (
            <button onClick={onCopy} title="Copy" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, flexShrink: 0, color: 'var(--text-secondary)', display: 'flex' }}>
              {copied ? <Check className="w-3.5 h-3.5" style={{ color: 'var(--success)' }} /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </div>
      {showDivider && <div style={{ height: 1, background: 'var(--border)' }} />}
    </div>
  )
}

// One row of the "Process" checklist shown inside the success screen's
// "More details" expansion — the actual bridge steps this transfer went
// through (approve/burn/attestation/mint for CCTP chains, or the 2-step
// Gateway path for ub chains), always shown done since this only ever
// renders after the transfer already succeeded.
function TransferProcessStep({ text, last }: { text: ReactNode; last?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10.6, paddingBottom: last ? 0 : 'clamp(10.6px, 2.34vh, 14.8px)' }}>
      <div style={{
        width: 21.2, height: 21.2, borderRadius: '50%', flexShrink: 0, marginTop: 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--brand)', color: '#fff',
      }}>
        <Check className="w-3 h-3" strokeWidth={3} />
      </div>
      <span style={{ fontSize: 'clamp(13.8px, 3.6vw, 15.3px)', color: 'var(--text-primary)', lineHeight: 1.4 }}>{text}</span>
    </div>
  )
}

export function MultichainTransferPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  // Pre-fill address if returning from scanner
  useEffect(() => {
    const scanned = searchParams.get('scannedAddress')
    if (scanned) handleAddressChange(scanned)
  }, [])
  const { balance } = useWalletStore()
  const storedPasscode = useAuthStore(s => s.passcode)
  const privateKey = useAuthStore(s => s.privateKey)
  const senderAddress = useAuthStore(s => s.walletAddress)
  const { showToastMessage } = useUIStore()

  const [step, setStep] = useState<MCStep>('form')

  // ─── Resume an in-flight transfer after a refresh ───────────────────────
  // The burn is irreversible the moment it confirms (funds have already
  // left Arc) — a refresh right after that must never look like nothing
  // happened, or someone could reasonably retry and double-send. There's no
  // reliable way to rebuild the full multi-step bridge UI (fee estimate,
  // per-step timestamps, etc.) from just a tx hash after a fresh mount, so
  // this deliberately shows a plain "checking" state and a toast with the
  // real outcome — reusing the same `activity` (type 'bridge') row this
  // page already writes the moment the burn confirms — rather than trying
  // to fake the detailed step-by-step screen.
  const [resumingTransfer, setResumingTransfer] = useState(false)
  useEffect(() => {
    const marker = getResumableOperation('multichain_transfer')
    if (!marker) return
    const ctx = marker.context as Record<string, any>
    setResumingTransfer(true)

    let cancelled = false
    let attempts = 0
    const wallet = (ctx.walletAddress as string | undefined) || senderAddress
    const poll = async () => {
      if (cancelled || !wallet) return
      attempts++
      try {
        const records = await fetchActivity(wallet, { activityType: 'bridge', limit: 20 })
        const match = records.find(r => (r.txHash || '').toLowerCase() === marker.txHash.toLowerCase())
        if (cancelled) return
        if (match) {
          if (match.status === 'completed') {
            clearResumableOperation('multichain_transfer')
            setResumingTransfer(false)
            showToastMessage(`Your transfer of ${trimTrailingZeros(Number(ctx.amount ?? 0).toFixed(4))} USDC to ${ctx.destinationChain || 'the destination chain'} completed.`, 'success')
            return
          }
          if (match.status === 'failed') {
            clearResumableOperation('multichain_transfer')
            setResumingTransfer(false)
            showToastMessage('Your last transfer failed — see Activity for details.', 'error')
            return
          }
        }
      } catch {}
      if (attempts >= 10) {
        // Still pending after a reasonable window — CCTP attestation can
        // genuinely take a few minutes, so this is expected, not an error.
        // Stop polling rather than doing so forever in the background;
        // the marker (and the real activity row) are both still there for
        // the next visit or an explicit Activity check.
        setResumingTransfer(false)
        showToastMessage('Still confirming your last transfer — check Activity for the latest status.', 'info')
        return
      }
      setTimeout(poll, 3000)
    }
    poll()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Success screen — same full-screen flash → hero-card takeover
  // MultichainClaimPage uses for a completed claim, reused here so a
  // completed transfer feels identical: whole screen flashes brand color
  // with a big checkmark + "Transfer Successful", holds briefly, then that
  // panel shrinks away while the traveling checkmark bridges into the
  // detailed hero card that fades in underneath.
  const [successPhase, setSuccessPhase] = useState<'flash' | 'collapsed'>('flash')
  const [showProcessDetails, setShowProcessDetails] = useState(false)
  const [hashCopied, setHashCopied] = useState(false)
  // Whether THIS transfer's passcode came from a biometric check vs typed
  // manually — drives which icon (checkmark vs fingerprint/Face ID) shows
  // on the flash->hero success animation. Set from PinKeypad's onComplete
  // second argument, same as MultichainClaimPage/PaySendPage.
  const [paidViaBiometric, setPaidViaBiometric] = useState(false)
  useEffect(() => {
    if (step !== 'success') { setSuccessPhase('flash'); return }
    const t = setTimeout(() => setSuccessPhase('collapsed'), 1500)
    return () => clearTimeout(t)
  }, [step])

  // Gates FlashAuthIcon's own bio->check swap — flips true only once the
  // white circle below has actually finished its spring entrance
  // (onAnimationComplete), not on a guessed timer. Reset alongside
  // successPhase so a second transfer in the same session gets a fresh
  // flash instead of starting pre-armed.
  const [flashCircleReady, setFlashCircleReady] = useState(false)
  useEffect(() => { if (successPhase === 'flash') setFlashCircleReady(false) }, [successPhase])

  // Wall-clock duration of the transfer, measured start-to-finish, purely
  // for the success screen's "Completed in X Seconds" pill.
  const [transferElapsedSeconds, setTransferElapsedSeconds] = useState('0.00')
  useEffect(() => {
    if (step === 'success' && bridgeStartRef.current) {
      setTransferElapsedSeconds((((Date.now() - bridgeStartRef.current)) / 1000).toFixed(2))
    }
  }, [step])

  // Traveling checkmark: flash position -> hero card's own checkmark spot
  // (same manual getBoundingClientRect + transform technique
  // MultichainClaimPage/PaySendPage use, via the shared TravelingCheckmark
  // component).
  const flashCheckRef = useRef<HTMLDivElement>(null)
  const heroCheckRef = useRef<HTMLDivElement>(null)
  const lastFlashRectRef = useRef<DOMRect | null>(null)
  const [travelRect, setTravelRect] = useState<{ from: DOMRect; to: DOMRect } | null>(null)
  const [travelDone, setTravelDone] = useState(false)
  // Desktop's flash overlay used to portal straight to `document.body` with
  // `position:fixed; inset:0` — meaning it flashed the ENTIRE screen,
  // covering the Recent History column too, not just the flow column the
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
    if (isDesktop && successPhase === 'flash' && desktopColumnRef.current) {
      setFlashColumnRect(desktopColumnRef.current.getBoundingClientRect())
    }
  }, [successPhase, isDesktop])

  useEffect(() => {
    if (successPhase !== 'collapsed') { setTravelDone(false); setTravelRect(null); return }
    const from = lastFlashRectRef.current
    requestAnimationFrame(() => {
      const to = heroCheckRef.current?.getBoundingClientRect()
      if (from && to) {
        setTravelRect({ from, to })
        const t = setTimeout(() => setTravelDone(true), 520)
        return () => clearTimeout(t)
      } else {
        setTravelDone(true)
      }
    })
  }, [successPhase])

  const copyTransferHash = async (hash: string) => {
    if (!hash) return
    const ok = await copyToClipboard(hash)
    setHashCopied(true)
    showToastMessage(ok ? 'Transaction hash copied' : 'Could not copy hash', ok ? 'success' : 'error')
    setTimeout(() => setHashCopied(false), 1500)
  }

  // ── Desktop-only: Transfer History (right column) ────────────────────────
  // Real data — this wallet's own outgoing 'bridge' rows. fetchActivity's
  // 'bridge' filter also returns 'claim'/'withdraw' rows server-side (see
  // ActivityService.ts), so this filters back down to just 'bridge' client-
  // side — the same technique MultichainPage.tsx's hub already uses for its
  // own combined list. Skipped entirely on mobile; re-fetched once a
  // transfer actually succeeds so it shows up without a page reload.
  // (`isDesktop` is already declared above, at the top of this component.)
  const [transferHistory, setTransferHistory] = useState<ActivityRecord[]>([])
  const [transferHistoryLoaded, setTransferHistoryLoaded] = useState(false)
  const [transferHistDetail, setTransferHistDetail] = useState<ActivityRecord | null>(null)
  useEffect(() => {
    if (!isDesktop || !senderAddress) return
    let cancelled = false
    fetchActivity(senderAddress, { activityType: 'bridge', limit: 50 })
      .then(records => { if (!cancelled) setTransferHistory(records.filter(r => r.activityType === 'bridge')) })
      .finally(() => { if (!cancelled) setTransferHistoryLoaded(true) })
    return () => { cancelled = true }
  }, [isDesktop, senderAddress, step === 'success'])
  const [address, setAddress] = useState('')
  const [addrHint, setAddrHint] = useState<{ type: 'ok' | 'warn' | 'error' | ''; text: string }>({ type: '', text: 'Enter wallet address on destination chain' })
  const [amount, setAmount] = useState('')
  const [showAmountPad, setShowAmountPad] = useState(false)
  const [selectedChain, setSelectedChain] = useState<ChainId>('eth')
  // MeshPort always uses Fast transfer — no user-facing speed selector anymore.
  const selectedSpeed: SpeedId = 'fast'
  const [showAllChains,    setShowAllChains]    = useState(false)
  const [showChainPicker,  setShowChainPicker]  = useState(false)
  const [passEntry, setPassEntry] = useState('')
  const [passError, setPassError] = useState('')
  const [loading, setLoading] = useState(false)
  // See handleConfirm's own comment: guards the ENTIRE transfer attempt
  // against a duplicate submission, unlike `loading` which gets cleared
  // right after passcode verification, long before deposit()/spend() run.
  const isConfirmingRef = useRef(false)
  const [txHash, setTxHash] = useState('')
  const [txError, setTxError] = useState('')
  // True once initiateUBRecovery has successfully started the 7-day
  // trustless recovery for a failed UB transfer — drives the "your funds
  // are safe" messaging on the failed screen instead of (or alongside) the
  // existing "Retry anyway" flow. See the outer catch block below and
  // lib/ubFundRecovery.ts.
  const [ubRecoveryInitiated, setUbRecoveryInitiated] = useState(false)
  const [bridgeSteps, setBridgeSteps] = useState<BridgeStepState[]>(makeDefaultSteps('Destination'))
  const [feeEstimate, setFeeEstimate] = useState<FeeEstimate>({ bridgeFee: 0, networkFee: 0, forwarderFee: 0, totalFee: 0, receiverGets: 0, loading: false, error: '' })
  // Which (address, amount, chain, speed) combination `feeEstimate` above
  // was actually fetched for — lets canContinue tell a fresh fee apart from
  // a stale one left over from a previous amount/chain, instead of trusting
  // whatever number happens to be sitting in state.
  const [feeEstimateKey, setFeeEstimateKey] = useState('')
  // Mirrors feeEstimate.totalFee so the silent background poll (see the
  // review-step effect) can compare "did the live fee just change" without
  // reading from a stale closure.
  const lastTotalFeeRef = useRef(0)
  const [successInfo, setSuccessInfo] = useState<SuccessInfo | null>(null)
  const [gasWarning, setGasWarning] = useState('')
  const [ticker, setTicker] = useState(0)
  // Set when the fee is re-checked immediately before signing (see
  // handleConfirm) and turns out to have moved since the person last saw
  // it on Review — surfaced as a banner there instead of silently signing
  // against the old number.
  const [feeChangedNotice, setFeeChangedNotice] = useState('')

  const bridgeStartRef = useRef<number>(0)
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Ref holds the mint txHash synchronously — avoids stale-closure bug when
  // reading `txHash` state immediately after the bridge.mint event fires.
  const finalTxHashRef = useRef('')
  // Set the moment the CCTP burn is known to have landed on Arc — either from
  // the `bridge.burn` SDK event or from the resolved result's burn step. Once
  // this is set, the USDC has irreversibly left the wallet and Circle's
  // attestation + forwarder mint WILL still complete on their own, even if
  // kit.bridge() then throws (timeout, RPC blip, a later step erroring). The
  // failed screen reads this to show "still on the way", not "nothing moved",
  // regardless of whether the auto-advance timer had marked the burn step
  // done yet when the failure surfaced.
  const burnTxHashRef = useRef('')
  // Set the moment a UB deposit succeeds — `targetDepositAmount` itself is
  // block-scoped inside the UB branch below and unreachable from the outer
  // catch, but the fund-recovery initiation (see initiateUBRecovery in the
  // catch block) needs exactly this: how much actually made it into Unified
  // Balance, regardless of what happens to the spend leg afterward.
  const ubDepositedAmountRef = useRef<string | null>(null)
  // True once a UB deposit has landed in this component's lifetime and has
  // NOT yet been resolved (full transfer completed, or recovery started, or
  // the user backed out to start a new transfer). handleConfirm's normal
  // reset deliberately leaves this alone, so a "Retry" after a post-deposit
  // failure re-enters the UB branch, sees this set, and RESUMES from the
  // spend leg instead of depositing a second time on top of funds that were
  // never lost — the double-deposit "Try Again" trap.
  const ubDepositCompletedRef = useRef(false)
  // Guards initiateUBRecovery so a deposit that fails its spend more than
  // once (first attempt + a manual retry) can't kick off two parallel 7-day
  // recoveries for the same Unified Balance funds.
  const ubRecoveryStartedRef = useRef(false)

  // Clear all UB deposit/recovery bookkeeping. Called only at genuine
  // "this is a brand-new transfer" boundaries (navigating back to the form,
  // or a transfer that fully completed) — NOT on a retry, which needs the
  // prior deposit remembered so it can resume.
  const resetUBTransientState = () => {
    ubDepositedAmountRef.current = null
    ubDepositCompletedRef.current = false
    ubRecoveryStartedRef.current = false
  }

  // ── Wavy-tank processing visual ──────────────────────────────────────────────
  // The old version only recomputed level/percent on React re-renders, which
  // only happen once a second (the `ticker` interval) — so the water level,
  // the "42%" text, and the progress bar all visibly jumped once a second
  // instead of moving continuously. Now a single requestAnimationFrame loop
  // recomputes progress every frame (~60fps) straight from bridgeSteps'
  // real timestamps and writes directly to the DOM (path `d`, text content,
  // bar width) — bypassing React state entirely for these three elements so
  // there's nothing to wait on and nothing to jump.
  const tankFromPathRef = useRef<SVGPathElement | null>(null)
  const tankToPathRef = useRef<SVGPathElement | null>(null)
  const tankPercentRef = useRef<HTMLSpanElement | null>(null)
  const tankBarRef = useRef<HTMLDivElement | null>(null)
  const tankRafRef = useRef<number | null>(null)
  // Kept in sync with the latest bridgeSteps every render so the rAF loop
  // (which only (re)starts when `step` changes) always reads live step
  // statuses/timestamps instead of a stale snapshot from when broadcasting began.
  const bridgeStepsLiveRef = useRef(bridgeSteps)
  useEffect(() => { bridgeStepsLiveRef.current = bridgeSteps }, [bridgeSteps])

  const wavePath = (levelPct: number, phase: number) => {
    const h = 100, w = 64
    const y = h - (Math.max(0, Math.min(100, levelPct)) / 100) * h
    let d = `M0 ${h} L0 ${y.toFixed(1)} `
    const amp = 2.5, freq = 0.15
    for (let x = 0; x <= w; x += 4) {
      const yy = y + Math.sin(x * freq + phase) * amp
      d += `L${x} ${yy.toFixed(1)} `
    }
    d += `L${w} ${h} Z`
    return d
  }

  useEffect(() => {
    if (step !== 'broadcasting') {
      if (tankRafRef.current) cancelAnimationFrame(tankRafRef.current)
      tankRafRef.current = null
      return
    }
    // Destination doesn't change mid-flight once broadcasting has started,
    // so it's safe to compute the per-chain step thresholds once here
    // rather than every frame — same numbers the step-advancement timer
    // (startStepTimer) itself runs on, so this visual and the moment a
    // step actually flips to "done" stay in agreement.
    const thresholds = getStepThresholds(chain)
    const stepStartMs: Record<string, number> = { approve: 0, burn: thresholds.approve, attestation: thresholds.burn, mint: thresholds.attestation }
    const ubExpectedSec = parseInt(chain.time.replace(/\D/g, ''), 10) || 15

    const computeLivePercent = () => {
      const steps = bridgeStepsLiveRef.current
      const total = steps.length || 1
      const doneCount = steps.filter(s => s.status === 'done').length
      const active = steps.find(s => s.status === 'active')
      const activeIdx = steps.findIndex(s => s.status === 'active')
      let pct = (doneCount / total) * 100
      if (active?.startedAt) {
        const elapsedSec = (Date.now() - active.startedAt) / 1000
        const expectedSec = chain.ub
          ? (activeIdx === 0 ? 1 : ubExpectedSec)
          : (() => {
              const key = STEP_KEYS[activeIdx]
              const durationMs = (thresholds[key] ?? thresholds.mint) - (stepStartMs[key] ?? 0)
              return Math.max(1, durationMs / 1000)
            })()
        const withinSlice = Math.min(0.9, elapsedSec / expectedSec)
        pct += withinSlice * (100 / total)
      }
      return Math.min(100, pct)
    }

    const tick = (ts: number) => {
      const phase = ts / 1000 * 1.6
      const errored = bridgeStepsLiveRef.current.some(s => s.status === 'error')
      const pct = computeLivePercent()
      const toLevel = pct
      const fromLevel = errored ? (100 - pct) : Math.max(0, 100 - pct)
      if (tankFromPathRef.current) tankFromPathRef.current.setAttribute('d', wavePath(fromLevel, phase))
      if (tankToPathRef.current) tankToPathRef.current.setAttribute('d', wavePath(toLevel, phase))
      if (tankPercentRef.current) tankPercentRef.current.textContent = `${Math.round(pct)}%`
      if (tankBarRef.current) tankBarRef.current.style.width = `${pct}%`
      tankRafRef.current = requestAnimationFrame(tick)
    }
    tankRafRef.current = requestAnimationFrame(tick)
    return () => { if (tankRafRef.current) cancelAnimationFrame(tankRafRef.current) }
  }, [step])

  // ── Pre-warm SDK imports as soon as confirm screen appears ───────────────────
  // By the time the user clicks "Confirm & Pay" the three heavy packages are
  // already parsed and cached — eliminates the 500ms–1s import delay from signing.
  useEffect(() => {
    if (step === 'confirm') loadSdkModules()
  }, [step])

  const numAmount = parseFloat(amount) || 0
  const settingsMap = useSettingsStore((s) => s.settings)
  const settingsLoaded = useSettingsStore((s) => s.loaded)
  // Applies the Admin Panel's optional per-chain UB/CCTP override (see
  // featureFilters.ts's resolveChainMechanism + supabase-chains-ub-cctp-
  // override.sql) at this ONE spot — every `chain.ub` / `ch.ub` read
  // elsewhere in this file traces back to objects that came from
  // ENABLED_CHAINS, so overriding it here is enough for the whole flow to
  // respect it without touching any of those individual call sites. Only
  // ever recomputes `ub` for chains that statically support it in the first
  // place (`c.ub === true`) — CCTP-only chains (`c.ub === false`) are left
  // exactly as-is, since they have no UB path to override. Defaults
  // reproduce today's exact behavior until the Admin Panel toggles are used.
  const ENABLED_CHAINS = ALL_CHAINS
    .filter(c => isChainEnabledForTransfer(settingsMap, c.id))
    .map(c => c.ub ? { ...c, ub: resolveChainMechanism(settingsMap, c.id) === 'ub' } : c)
  const chain = ENABLED_CHAINS.find(c => c.id === selectedChain)
    ?? (() => {
      // Same resolution as ENABLED_CHAINS above, applied here too — this
      // fallback only runs if the selected chain isn't in ENABLED_CHAINS
      // (e.g. it was just disabled for Transfer entirely while already
      // selected). Without this, `chain.ub` would briefly reflect the raw,
      // unresolved default instead of the admin's actual UB/CCTP choice for
      // that chain — a real way the two could end up mixed, even if a rare
      // one to hit in practice.
      const c = ALL_CHAINS.find(c => c.id === selectedChain)!
      return c.ub ? { ...c, ub: resolveChainMechanism(settingsMap, c.id) === 'ub' } : c
    })()
  const popularChains = ENABLED_CHAINS.filter(c => c.popular)
  const moreChains = ENABLED_CHAINS.filter(c => !c.popular)
  const visibleChains = showAllChains ? ENABLED_CHAINS : popularChains

  // If the admin disables the currently-selected chain, fall back to the
  // first chain that's still enabled.
  useEffect(() => {
    if (!settingsLoaded) return
    if (ENABLED_CHAINS.length === 0) return
    if (!ENABLED_CHAINS.find(c => c.id === selectedChain)) setSelectedChain(ENABLED_CHAINS[0].id)
  }, [settingsLoaded, settingsMap])

  // ── Ticker for elapsed time display ──────────────────────────────────────────
  const startTicker = () => {
    if (tickerRef.current) clearInterval(tickerRef.current)
    tickerRef.current = setInterval(() => setTicker(t => t + 1), 1000)
  }
  const stopTicker = () => {
    if (tickerRef.current) { clearInterval(tickerRef.current); tickerRef.current = null }
  }

  // ── Time-based step progression timer ────────────────────────────────────────
  // The Arc SDK only reliably emits `bridge.approve`. Burn, attestation, and mint
  // events may never fire. Without this timer, the UI stays stuck on step 1.
  //
  // The timer advances steps based on REALISTIC timing for CCTP v2 FAST mode
  // with forwarder enabled. If real events fire, they take priority and update
  // txHashes. If they don't, the timer keeps the UI moving forward.
  const stepTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Cumulative ms thresholds — when reached, advance to the NEXT step.
  //
  // Previously this was one flat set of numbers (2.5s/5.5s/18s/24s) applied
  // identically to every destination chain — Ethereum (~12s block time) and
  // Base (~2s block time) both got the same "mint confirmed" timing, which
  // is wrong for the same reason a flat "~5s" arrival estimate would be
  // wrong (see estLabel's own comment on this below). Only the approve/burn
  // legs are legitimately chain-independent, because both happen on the
  // *source* chain, which is always Arc Testnet here regardless of
  // destination. Attestation is Circle's Iris API under FAST mode — also
  // chain-independent (Circle's documented ~8-20s window, not
  // destination-specific). Mint is the one leg that actually happens on the
  // destination chain, so it's the one leg that should use that chain's own
  // finality time — the same `chain.time` field already driving the UB
  // estimate and the ring's expectedSec math below, instead of a fixed
  // guess that's only ever correct by coincidence.
  const ARC_APPROVE_MS = 2500   // Arc Testnet tx confirmation (source-chain, chain-independent)
  const ARC_BURN_MS    = 3000   // Arc Testnet tx confirmation (source-chain, chain-independent)
  const IRIS_ATTESTATION_MS = 12500 // Circle Iris API, FAST mode (~8-20s documented window, chain-independent)

  const parseChainTimeMs = (time: string): number => {
    const digits = parseInt(time.replace(/\D/g, ''), 10)
    return (digits || 15) * 1000
  }

  const getStepThresholds = (destChain: typeof chain): Record<string, number> => {
    const mintMs = parseChainTimeMs(destChain.time) // destination-chain finality — the only leg that actually varies
    const approve = ARC_APPROVE_MS
    const burn = approve + ARC_BURN_MS
    const attestation = burn + IRIS_ATTESTATION_MS
    const mint = attestation + mintMs
    return { approve, burn, attestation, mint }
  }
  const STEP_DONE_MESSAGE: Record<string, string> = {
    approve:     'Approval confirmed ✓',
    burn:        'Burn confirmed ✓',
    attestation: 'Attestation received ✓',
    mint:        'Mint confirmed ✓',
  }
  const STEP_KEYS = ['approve', 'burn', 'attestation', 'mint']

  const startStepTimer = () => {
    if (stepTimerRef.current) clearInterval(stepTimerRef.current)
    const startMs = Date.now()
    // Captured once per transfer, not re-read every tick: `chain` reflects
    // whichever destination this specific transfer is going to, and that
    // shouldn't change mid-flight even if the user navigates around after.
    const thresholds = getStepThresholds(chain)
    stepTimerRef.current = setInterval(() => {
      const elapsed = Date.now() - startMs
      setBridgeSteps(prev => {
        // Find current active step
        const activeIdx = prev.findIndex(s => s.status === 'active')
        if (activeIdx === -1) return prev
        const activeKey = prev[activeIdx].name
        const threshold = thresholds[activeKey]
        if (!threshold || elapsed < threshold) return prev

        // Time to advance
        const nextIdx = activeIdx + 1
        if (nextIdx >= prev.length) return prev   // last step — let final reconciliation handle it

        const nextKey = prev[nextIdx].name
        const nextDef = STEP_DEFS.find(d => d.key === nextKey)


        return prev.map((s, i) => {
          if (i === activeIdx) return { ...s, status: 'done', message: STEP_DONE_MESSAGE[s.name] || 'Completed ✓', completedAt: Date.now() }
          if (i === nextIdx)   return { ...s, status: 'active', message: nextDef?.activeMsg || 'Processing…', startedAt: Date.now() }
          return s
        })
      })
    }, 1000)
  }
  const stopStepTimer = () => {
    if (stepTimerRef.current) { clearInterval(stepTimerRef.current); stepTimerRef.current = null }
  }

  // ── Update a single step's state ─────────────────────────────────────────────
  const updateStep = (key: string, partial: Partial<BridgeStepState>) => {
    setBridgeSteps(prev => prev.map(s => s.name === key ? { ...s, ...partial } : s))
  }

  // ── Address validation ────────────────────────────────────────────────────────
  const handleAddressChange = (val: string) => {
    setAddress(val)
    setGasWarning('')
    if (!val) { setAddrHint({ type: '', text: 'Enter wallet address on destination chain' }); return }
    if (/\.arc/i.test(val)) { setAddrHint({ type: 'error', text: '⚠ .arc usernames not supported — enter wallet address' }); return }
    if (isEVMAddress(val)) { setAddrHint({ type: 'ok', text: `🔗 EVM address — will receive on ${chain.name}` }); return }
    if (isSolanaAddress(val)) { setAddrHint({ type: 'ok', text: '◎ Solana address detected' }); return }
    if (val.startsWith('0x') && val.length < 42) { setAddrHint({ type: 'warn', text: `Address: ${val.length}/42 characters` }); return }
    if (val.length > 10) { setAddrHint({ type: 'error', text: '⚠ Invalid address format' }); return }
    setAddrHint({ type: '', text: 'Keep typing…' })
  }

  const MIN_AMOUNT = 3
  // Conservative static reserve used anywhere we need a "roughly how much
  // fee will this cost" number WITHOUT calling the SDK — the Max button and
  // the AmountKeypad's max-amount math use this instead of the live fee
  // estimate. The live estimate (the actual forwarder service fee) is only
  // ever fetched once the user reaches Review — see the review-step effect
  // below.
  const feeReserveEstimate = Math.max(0.15, balance * 0.002)

  // Basic form validity. Deliberately does NOT depend on any fee estimate —
  // fees are no longer fetched while the user is on the amount-entry form at
  // all, so Continue only needs to know the typed amount/address are sane.
  const formValid = (isEVMAddress(address) || isSolanaAddress(address)) && numAmount >= MIN_AMOUNT && numAmount <= balance
  const canContinue = formValid

  // If a silent background refresh (see the Review polling effect below)
  // finds the forwarder fee moved meaningfully since the last time it was
  // shown, surface a brief notice — the numbers on Review update themselves
  // regardless, this is just letting the person know why the total moved.
  // Auto-clears after a few seconds rather than blocking anything.
  const notifyIfFeeChanged = (fresh: FeeEstimate, silent: boolean) => {
    if (!silent) return
    const prevTotal = lastTotalFeeRef.current
    if (prevTotal <= 0) return
    const delta = Math.abs(fresh.totalFee - prevTotal)
    if (delta > Math.max(0.0002, prevTotal * 0.02)) {
      setFeeChangedNotice(`Fees updated (${trimTrailingZeros(prevTotal.toFixed(4))} → ${trimTrailingZeros(fresh.totalFee.toFixed(4))} USDC)`)
      setTimeout(() => setFeeChangedNotice(''), 6000)
    }
  }

  // ── Fetch live fee estimate from SDK ─────────────────────────────────────────
  // Only ever called once the user reaches the Review step (see the effect
  // below) — never while typing an amount, never after the passcode is
  // entered. Returns the freshly-fetched estimate (or null if it couldn't be
  // fetched at all).
  // `silent` skips the loading spinner — used for the periodic background
  // refresh while Review is open, so numbers update in place instead of
  // flashing "Fetching fees…" every poll.
  const fetchFeeEstimate = async (silent = false): Promise<FeeEstimate | null> => {
    if (!numAmount || !address || !senderAddress) return null
    const requestKey = `${address}|${numAmount}|${selectedChain}|${selectedSpeed}`
    // Use privateKey if available, otherwise try to restore from mnemonic
    let activeKey = privateKey
    if (!activeKey) {
      try {
        const { restorePrivateKey } = await import('@/lib/restoreWallet')
        await restorePrivateKey(undefined)
        activeKey = useAuthStore.getState().privateKey
      } catch {}
    }
    if (!activeKey) return null
    if (!silent) setFeeEstimate(f => ({ ...f, loading: true, error: '' }))
    try {
      const { AppKit, createEthersAdapterFromPrivateKey, JsonRpcProvider, FallbackProvider } = await loadSdkModules()

      const kit = new AppKit({ clientKey: import.meta.env.VITE_KIT_KEY, disableErrorReporting: true } as any)
      const adapter = createEthersAdapterFromPrivateKey({
        privateKey: activeKey,
        getProvider: ({ chain: sdkChain }: any) => {
          const rpcUrl: string | undefined = sdkChain?.rpcEndpoints?.[0]
          // The SDK always hands us a single default endpoint for Arc
          // (rpc.testnet.arc.network) — trusting it directly meant we never
          // failed over across ARC_RPCS when that one endpoint was rate
          // limited. Force the fallback list for Arc regardless of what the
          // SDK provides; only use its endpoint for non-Arc chains.
          const isArc = sdkChain?.name?.toLowerCase?.().includes('arc') || /arc[.-]/i.test(rpcUrl ?? '')
          if (isArc) return getArcFallbackProvider(JsonRpcProvider, FallbackProvider)
          return getDestFallbackProvider(sdkChain, rpcUrl, JsonRpcProvider, FallbackProvider)
            ?? (rpcUrl ? getCachedProvider(rpcUrl, JsonRpcProvider, sdkChain?.chainId) : getArcFallbackProvider(JsonRpcProvider, FallbackProvider))
        },
      })

      // ── Gateway (unified balance) path ──────────────────────────────────
      // This used to fall through to kit.estimateBridge() below regardless
      // of chain.ub — meaning every UB transfer still paid CCTP's slower
      // estimate-call latency on the Review screen before the (correctly
      // fast) UB execution ever started. That's the actual reason UB felt
      // as slow as CCTP end-to-end even though the execution step itself
      // was already fast — the estimate step never got branched.
      if (chain.ub) {
        // Cap the amount we ask the SDK to estimate so there's still room
        // left in `balance` for Arc's own deposit gas (Arc gas = USDC) —
        // estimating on the full numAmount let this diverge from what
        // handleConfirm can actually deposit once the gas reserve is
        // carved out.
        const ubTargetAmount = Math.min(numAmount, Math.max(0, balance - UB_DEPOSIT_GAS_RESERVE))

        // `from` takes an allocations object, not a bare adapter array —
        // `[{ adapter }]` silently satisfied the `any`-typed call but isn't
        // the shape the SDK actually expects (see "Select source
        // blockchains" in the App Kit docs).
        assertAllocationsMatchAmount(ubTargetAmount.toFixed(6), [{ amount: ubTargetAmount.toFixed(6) }], 'estimateSpend')
        const est: any = await kit.unifiedBalance.estimateSpend({
          amount: ubTargetAmount.toFixed(6),
          from: {
            adapter,
            allocations: [{ amount: ubTargetAmount.toFixed(6), chain: 'Arc_Testnet' }],
          },
          to: { chain: chain.sdk as any, recipientAddress: address, useForwarder: true },
          token: 'USDC',
        })
        let providerFee = 0, gasFee = 0, kitFee = 0, forwarderFee = 0
        for (const f of est?.fees ?? []) {
          const amt = parseFloat(f.amount) || 0
          if (f.type === 'provider') providerFee += amt
          else if (f.type === 'gasFee') gasFee += amt
          else if (f.type === 'kit') kitFee += amt
          else if (f.type === 'forwarder') forwarderFee += amt
        }
        // Circle's Unified Balance fee model (docs.arc.io/app-kit/concepts/
        // unified-balance-fees) treats these four fee types in two
        // fundamentally different ways — they must NOT be summed into one
        // "spendFee" the way this used to work:
        //   - Gateway protocol fee ('provider') and burn-intent gas
        //     ('gasFee') are deducted from the Unified Balance IN ADDITION
        //     to the spend amount. They never touch what gets minted on
        //     the destination chain, so they must not reduce receiverGets
        //     — but the wallet/balance DOES need extra room for them on
        //     top of the spend amount.
        //   - The custom/kit fee ('kit') and Forwarding Service fee
        //     ('forwarder') are carved OUT of the spend amount itself
        //     before minting, so they DO reduce what the recipient
        //     receives — but since they come out of the spend amount
        //     that's already reserved, they need no extra balance on top.
        // The old code lumped all four together and used that single
        // number for both receiverGets and the required-balance check,
        // which simultaneously overstated the balance requirement (kit/
        // forwarder don't need extra balance) and understated
        // receiverGets (provider/gas don't come out of the destination
        // amount) — the exact contradiction between the preview and the
        // balance check that was reported.
        const balanceOnlyFee = providerFee + gasFee
        const spendReducingFee = kitFee + forwarderFee
        // totalFee is what's needed ON TOP of the spend amount: the
        // Gateway protocol fee + burn gas (drawn from the Unified Balance
        // alongside the spend), plus UB_DEPOSIT_GAS_RESERVE — a completely
        // separate cost (Arc's own gas for the deposit transaction, paid
        // from the sender's Arc wallet, never touches the Unified Balance
        // spend accounting or the destination amount at all).
        const totalFee = balanceOnlyFee + UB_DEPOSIT_GAS_RESERVE
        // receiverGets is based on ubTargetAmount (what's actually going to
        // be deposited/spent), not the raw numAmount — otherwise this
        // preview overstates what the recipient gets whenever the gas
        // reserve had to cap the deposit below what the user typed. Only
        // the spend-reducing fees come off it; provider/gas fees are paid
        // from the balance separately and never touch this figure.
        const receiverGets = Math.max(0, ubTargetAmount - spendReducingFee)

        const fresh: FeeEstimate = {
          bridgeFee:    providerFee + kitFee,
          networkFee:   gasFee + UB_DEPOSIT_GAS_RESERVE,
          forwarderFee,
          totalFee,
          receiverGets,
          loading: false,
          error: '',
        }
        notifyIfFeeChanged(fresh, silent)
        setFeeEstimate(fresh)
        setFeeEstimateKey(requestKey)
        lastTotalFeeRef.current = totalFee
        return fresh
      }

      // Only route through Circle's forwarder for chains it actually covers —
      // otherwise we submit the destination mint ourselves via `adapter`
      // (same private key, reused across chains) after funding it with a
      // little native gas via /api/relay-gas. See FORWARDER_SUPPORTED_SDK_CHAINS.
      const useForwarder = chainSupportsForwarder(chain.sdk)
      const estimate = await kit.estimateBridge({
        from: { adapter, chain: 'Arc_Testnet' },
        to: useForwarder
          ? { chain: chain.sdk as any, recipientAddress: address, useForwarder: true }
          : { chain: chain.sdk as any, recipientAddress: address, adapter, useForwarder: false },
        amount: numAmount.toFixed(6),
        token: 'USDC',
        config: { transferSpeed: selectedSpeed === 'fast' ? 'FAST' : 'SLOW', batchTransactions: false },
      })

      // Parse fees from EstimateResult
      // estimate.fees[].type is 'kit' | 'provider' | 'forwarder' per the
      // installed @circle-fin/provider-cctp-v2 SDK (gas fees live separately
      // in estimate.gasFees, NOT as a 'gasFee' entry in this array — that
      // branch never matched anything). 'kit' only appears when
      // config.customFee is set, which this app never does, so it's normally
      // 0 — included here for correctness/future-proofing, not because it
      // explained any observed discrepancy.
      let bridgeFee = 0, networkFee = 0, forwarderFee = 0
      if (estimate?.fees) {
        for (const f of estimate.fees) {
          const amt = parseFloat(f.amount) || 0
          if (f.type === 'provider' || f.type === 'kit') bridgeFee += amt
          else if (f.type === 'forwarder') forwarderFee += amt
        }
      }
      if (estimate?.gasFees) {
        for (const f of estimate.gasFees) networkFee += parseFloat(f.amount) || 0
      }

      const totalFee = bridgeFee + networkFee + forwarderFee
      const receiverGets = Math.max(0, numAmount - totalFee)

      const fresh: FeeEstimate = { bridgeFee, networkFee, forwarderFee, totalFee, receiverGets, loading: false, error: '' }
      notifyIfFeeChanged(fresh, silent)
      setFeeEstimate(fresh)
      setFeeEstimateKey(requestKey)
      lastTotalFeeRef.current = totalFee
      return fresh
    } catch (e: any) {
      // Same "no runners?!" defense as handleConfirm's catch below — this
      // estimate call runs on Review, BEFORE the user ever hits Confirm, so
      // if a poisoned Arc provider caused this failure, evict it now rather
      // than silently falling back to static fees here and letting the
      // real bridge attempt inherit the same wedged instance later.
      if (/no runners/i.test(e?.message || '')) resetArcFallbackProvider()
      // Fallback: estimate from chain config
      const bridgeFee = selectedSpeed === 'fast' ? 0.0013 : 0
      const networkFee = 0.01
      const forwarderFee = selectedSpeed === 'fast' ? 0.002 : 0.002
      const totalFee = bridgeFee + networkFee + forwarderFee
      const fresh: FeeEstimate = { bridgeFee, networkFee, forwarderFee, totalFee, receiverGets: Math.max(0, numAmount - totalFee), loading: false, error: '' }
      notifyIfFeeChanged(fresh, silent)
      setFeeEstimate(fresh)
      setFeeEstimateKey(requestKey)
      lastTotalFeeRef.current = totalFee
      return fresh
    }
  }

  // ── Check source-chain gas balance ───────────────────────────────────────────
  // Arc Testnet uses USDC as gas — balance check is already covered by the USDC balance check.
  // For destination chain, useForwarder=true means Circle pays destination gas.
  // We just ensure: balance >= amount + estimated fees.
  // On the form step no live fee has been fetched yet (by design — see
  // below), so this falls back to the same static reserve the Max button
  // uses. Once on Review/Confirm, feeEstimate.totalFee is the real,
  // SDK-fetched forwarder service fee and is used instead.
  const validateGasBalance = () => {
    const feeForCheck = (step === 'form') ? feeReserveEstimate : feeEstimate.totalFee
    const required = numAmount + feeForCheck
    if (balance < required) {
      setGasWarning(`Insufficient USDC balance. You need approximately ${trimTrailingZeros(required.toFixed(4))} USDC (amount + fees) but have ${trimTrailingZeros(balance.toFixed(4))} USDC.`)
      return false
    }
    setGasWarning('')
    return true
  }

  // ── Surface a rough balance warning on the form step ─────────────────────
  // Uses only the static reserve estimate — no SDK call, no live fee fetch.
  // The exact forwarder service fee is calculated once on Review instead.
  useEffect(() => {
    if (step !== 'form') return
    if (!formValid) { setGasWarning(''); return }
    validateGasBalance()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, formValid, numAmount, balance])

  // ── Fetch (and keep fresh) the live fee estimate while on Review ─────────
  // This is the ONLY place the forwarder service fee gets calculated. It
  // fires once on arrival at Review, then keeps polling quietly in the
  // background for as long as Review stays open, so a change in the
  // forwarder's live rate shows up automatically here — never after the
  // passcode sheet opens, and never re-fetched once the user has entered
  // their PIN (see handleConfirm).
  useEffect(() => {
    if (step !== 'review') return
    fetchFeeEstimate()
    const interval = setInterval(() => {
      fetchFeeEstimate(true)
    }, 20000)
    return () => clearInterval(interval)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, address, amount, selectedChain, selectedSpeed])

  // ── Navigate to review ────────────────────────────────────────────────────
  // No fee has been fetched yet at this point — Continue only checks
  // formValid. Landing on 'review' triggers the fee-fetch effect above,
  // which is where the forwarder service fee actually gets calculated.
  const handleContinue = () => {
    setStep('review')
  }

  // ── Main bridge execution ────────────────────────────────────────────────────
  const handleConfirm = async () => {
    // Re-entrancy lock for the FULL transfer, not just the passcode check.
    // `loading` alone isn't enough here — it gets reset to false the instant
    // passcode verification resolves (a few lines down), which is well
    // before deposit()/spend() even start. If onComplete fires a second
    // time in that multi-second window (e.g. a duplicate PinKeypad
    // auto-fire, a double biometric event), the `if (!loading)` guard at
    // the call site sees loading===false again and lets a second
    // handleConfirm() through. Both runs build byte-identical, deterministic
    // spendParams (same amount/address/allocations/chain) — the first
    // spend() succeeds, and Circle Gateway's replay protection (the burn
    // intent's transfer-spec hash can only ever be submitted once — see
    // developers.circle.com/gateway/concepts/technical-guide) then rejects
    // the second, identical submission with "Transfer spec has already
    // been used". That FATAL, non-resumable rejection is what was landing
    // real, already-successful transfers on "Transfer Status Unclear".
    // isConfirmingRef stays true for the whole attempt and is only released
    // in the outer finally below, closing that window entirely.
    if (isConfirmingRef.current) return
    isConfirmingRef.current = true

    // Show loading indicator immediately — user gets instant visual feedback
    setLoading(true)
    const t0 = Date.now()
    const testRunId = newRunId(`send-${chain.id}`)
    const testService: TestService = chain.ub ? 'ub' : 'cctp'
    logTestEvent({ runId: testRunId, flow: 'transfer', chainId: chain.id, service: testService, kind: 'note', label: 'handleConfirm started', data: { amount: numAmount, address } })

    try {

    // ── 1. Passcode verification (only blocking work that MUST happen first) ──
    if (storedPasscode) {
      const { verifyPasscode } = await import('@/lib/security')
      const ok = await verifyPasscode(passEntry, storedPasscode)
      if (!ok) { setLoading(false); setPassError('Incorrect passcode. Try again.'); setPassEntry(''); return }
    }
    setLoading(false)

    // Fees are never (re-)calculated at this point. The forwarder service
    // fee was already fetched — and kept fresh via polling — while the user
    // was on Review (see the review-step effect above); whatever is in
    // `feeEstimate` right now is what they saw and confirmed against. We
    // sign and broadcast against that number rather than firing another SDK
    // call from the passcode screen.
    if (!validateGasBalance()) {
      // validateGasBalance() only sets `gasWarning`, which is rendered on
      // the 'form' step — but by the time someone's entered their passcode
      // here on 'confirm', they're nowhere near that step. The function
      // would just silently `return`, leaving the passcode dots filled in
      // and nothing visibly happening — exactly the "why isn't this doing
      // anything" symptom. Surface the same message through `passError`,
      // which this screen already renders, and clear the passcode so they
      // can back out and adjust the amount.
      setPassError(`Insufficient balance for amount + fees. Need ${trimTrailingZeros((numAmount + feeEstimate.totalFee).toFixed(4))} USDC, have ${trimTrailingZeros(balance.toFixed(4))} USDC.`)
      setPassEntry('')
      return
    }

    // ── 2. Transition to broadcasting screen IMMEDIATELY ─────────────────────
    // All remaining work (key restore, SDK init, signing) happens AFTER the
    // user is already on the broadcasting screen seeing step 1 active.
    const freshSteps = chain.ub ? makeUBSteps(chain.name) : makeDefaultSteps(chain.name)
    setBridgeSteps(freshSteps)
    setTxHash(''); setTxError('')
    setSuccessInfo(null)
    finalTxHashRef.current = ''
    burnTxHashRef.current = ''
    // NOTE: ubDepositedAmountRef / ubDepositCompletedRef are deliberately NOT
    // cleared here. If this handleConfirm is a retry after a UB transfer that
    // deposited then failed its spend, the UB branch below needs to see the
    // prior deposit so it resumes from spend instead of depositing again.
    // They're cleared by resetUBTransientState() at real new-transfer
    // boundaries (form nav, full success) instead.
    if (!chain.ub) ubDepositedAmountRef.current = null
    setUbRecoveryInitiated(ubRecoveryStartedRef.current)
    bridgeStartRef.current = Date.now()
    setStep('broadcasting')
    startTicker()
    setBridgeSteps(prev => prev.map((s, i) => i === 0
      ? { ...s, status: 'active', message: 'Preparing transaction…', startedAt: Date.now() }
      : s))

    // ── 3. Start the time-based step advancement timer ───────────────────────
    // This is the KEY fix: the Arc SDK only reliably emits `bridge.approve`.
    // Without this timer, the UI stays stuck on step 1 forever even though the
    // bridge is progressing in the background. The timer auto-advances steps
    // based on realistic CCTP timings, regardless of whether events fire.
    // Gateway (chain.ub) path doesn't use this — see makeUBSteps above for why.
    if (!chain.ub) startStepTimer()

    try {
      // ── 4. Resolve private key (may need PBKDF2 — happens during broadcasting view) ──
      let activePrivateKey = privateKey

      // Fast path: decrypt from localStorage encrypted key (no network)
      if (!activePrivateKey && storedPasscode && senderAddress && passEntry) {
        try {
          const { getEncryptedKey, decryptPrivateKey } = await import('@/lib/security')
          const encKey = getEncryptedKey(senderAddress)
          if (encKey) {
            const decoded = await decryptPrivateKey(encKey, passEntry)
            if (decoded) {
              activePrivateKey = decoded
              useAuthStore.getState().setWallet(senderAddress as any, decoded, undefined, undefined)
            }
          }
        } catch {}
      }

      // Slow path: mnemonic re-derive or Supabase fetch
      if (!activePrivateKey) {
        const { restorePrivateKey } = await import('@/lib/restoreWallet')
        await restorePrivateKey(storedPasscode ? passEntry : undefined)
        activePrivateKey = useAuthStore.getState().privateKey
      }
      if (!activePrivateKey) throw new Error('Wallet key unavailable. Lock and unlock the app.')

      // ── 5. Load SDK modules (cached if pre-warmed) ────────────────────────
      const { AppKit, KitError, createEthersAdapterFromPrivateKey, JsonRpcProvider, FallbackProvider } = await loadSdkModules()

      const kit = new AppKit({ clientKey: import.meta.env.VITE_KIT_KEY, disableErrorReporting: true } as any)
      const adapter = createEthersAdapterFromPrivateKey({
        privateKey: activePrivateKey,
        getProvider: ({ chain: sdkChain }: any) => {
          const rpcUrl: string | undefined = sdkChain?.rpcEndpoints?.[0]
            || sdkChain?.rpcUrls?.default?.http?.[0]
          // Same fix as the estimate-side getProvider above: the SDK's own
          // default endpoint for Arc is trusted blindly here otherwise,
          // which skips ARC_RPCS failover entirely and was the direct cause
          // of "RPC endpoint error on Arc Testnet" bridge failures — every
          // retry hit the same rate-limited rpc.testnet.arc.network with no
          // failover to /api/arc-rpc or any other fallback.
          const isArc = sdkChain?.name?.toLowerCase?.().includes('arc') || /arc[.-]/i.test(rpcUrl ?? '')
          if (isArc) return getArcFallbackProvider(JsonRpcProvider, FallbackProvider)
          return getDestFallbackProvider(sdkChain, rpcUrl, JsonRpcProvider, FallbackProvider)
            ?? (rpcUrl ? getCachedProvider(rpcUrl, JsonRpcProvider, sdkChain?.chainId) : getArcFallbackProvider(JsonRpcProvider, FallbackProvider))
        },
      })

      // ── Gateway (unified balance) path ────────────────────────────────────
      // Chains with ub===true (see CHAINS below, kept in sync with Circle's
      // Gateway docs — developers.circle.com/gateway/references/
      // supported-blockchains) skip the whole CCTP flow below entirely:
      // deposit Arc USDC into the unified balance, then spend it straight to
      // the destination. Both legs resolve directly (no attestation wait to
      // paper over), so this returns as soon as the 2 steps above are done
      // rather than falling through into the 4-step CCTP block.
      // Same defensive extraction the CCTP path below already needs for
      // this SDK family — see its own getHash() comment: "Arc SDK: txHash
      // is at step.txHash OR step.data.txHash OR step.values.txHash", i.e.
      // the top-level field the type definitions promise isn't always
      // reliably populated at runtime. Applying the same fallback chain
      // here rather than trusting depositResult.txHash / spendResult.txHash
      // directly — if it wasn't the cause of transfers missing from
      // Activity, it's a no-op; if it was, this is the fix.
      const getUBHash = (r: any): string =>
        r?.txHash || r?.data?.txHash || r?.values?.txHash
          || r?.steps?.find((s: any) => s.name === 'mint')?.txHash
          || r?.steps?.find((s: any) => s.state === 'success' && s.txHash)?.txHash
          || ''

      if (chain.ub) {
        // Resume path: a prior attempt already deposited into Unified Balance
        // and then failed its spend. Do NOT deposit again — reuse what's
        // already there and go straight to the spend leg. This is what makes
        // "Retry" safe after a post-deposit failure instead of stacking a
        // second deposit on funds that were never lost.
        const resumingFromPriorDeposit = ubDepositCompletedRef.current && !!ubDepositedAmountRef.current
        let targetDepositAmount: number
        let depositHash = ''

        if (resumingFromPriorDeposit) {
          targetDepositAmount = parseFloat(ubDepositedAmountRef.current!)
          logTestEvent({ runId: testRunId, flow: 'transfer', chainId: chain.id, service: testService, kind: 'note', label: 'UB resume — reusing prior deposit, skipping deposit step', data: { targetDepositAmount } })
          setBridgeSteps(prev => prev.map(s => {
            if (s.name === 'deposit') return { ...s, status: 'done', verified: true, message: 'Already in Unified Balance', completedAt: Date.now() }
            if (s.name === 'spend')   return { ...s, status: 'active', message: UB_STEP_DEFS[1].activeMsg, startedAt: Date.now() }
            return s
          }))
        } else {
          setBridgeSteps(prev => prev.map(s => s.name === 'deposit'
            ? { ...s, status: 'active', message: UB_STEP_DEFS[0].activeMsg }
            : s))

          // Cap the deposit the same way fetchFeeEstimate caps its estimate —
          // leave room in `balance` for Arc's own deposit gas. Depositing the
          // raw numAmount (unadjusted) risked leaving nothing for that gas.
          targetDepositAmount = Math.min(numAmount, Math.max(0, balance - UB_DEPOSIT_GAS_RESERVE))
          if (targetDepositAmount <= 0) {
            throw new Error(
              `Insufficient USDC balance to cover the transfer plus Arc network gas. ` +
              `Available: ${trimTrailingZeros(balance.toFixed(4))} USDC.`
            )
          }

          const depositResult: any = await kit.unifiedBalance.deposit({
            from: { adapter, chain: 'Arc_Testnet' as any },
            amount: targetDepositAmount.toFixed(6),
            token: 'USDC',
            // Gasless EIP-2612 signature — same rationale as arc.ts's default
            // allowanceStrategy: avoids a separate on-chain approve tx before
            // the deposit can happen, which would add a full extra round trip
            // on top of what's supposed to be a sub-second step.
            allowanceStrategy: 'permit',
          })
          logTestEvent({ runId: testRunId, flow: 'transfer', chainId: chain.id, service: testService, kind: 'result', label: 'unifiedBalance.deposit result', data: depositResult })
          depositHash = getUBHash(depositResult)
          ubDepositedAmountRef.current = targetDepositAmount.toFixed(6)
          ubDepositCompletedRef.current = true

          setBridgeSteps(prev => prev.map(s => {
            if (s.name === 'deposit') return { ...s, status: 'done', verified: true, message: 'Moved to Unified Balance', txHash: depositHash, completedAt: Date.now() }
            if (s.name === 'spend')   return { ...s, status: 'active', message: UB_STEP_DEFS[1].activeMsg, startedAt: Date.now() }
            return s
          }))
        }

        // Fetch a guaranteed-fresh estimate rather than trusting
        // feeEstimate from React state — that state was computed against
        // numAmount on Review, but the deposit above may have used a
        // gas-adjusted (smaller) amount, so the net spend figure needs to
        // be recomputed against what was actually just deposited. Retry a
        // couple of times with backoff before giving up: the deposit has
        // already landed, so a transient estimate hiccup here must NOT
        // immediately dump the user on the failed screen — a plain retry of
        // just this call usually clears it.
        let freshEstimate = await fetchFeeEstimate(true)
        for (let attempt = 0; (!freshEstimate || freshEstimate.receiverGets <= 0) && attempt < 3; attempt++) {
          await new Promise(r => setTimeout(r, 1500 * (attempt + 1)))
          logTestEvent({ runId: testRunId, flow: 'transfer', chainId: chain.id, service: testService, kind: 'note', label: `UB spend estimate retry ${attempt + 1}`, data: {} })
          freshEstimate = await fetchFeeEstimate(true)
        }
        if (!freshEstimate || freshEstimate.receiverGets <= 0) {
          throw new Error(
            `Your USDC is safely in your Unified Balance, but the fee estimate for the ` +
            `send step keeps failing. Your funds are NOT lost — tap Retry to resume the ` +
            `send (it will not deposit again), or check your Unified Balance.`
          )
        }

        // Spend from the DEPOSITED amount minus the balance-only fees
        // (Gateway protocol fee + burn gas), not from freshEstimate.receiverGets.
        // receiverGets is the recipient-side figure — it's already had the
        // spend-reducing fees (kit/forwarder) carved out. Circle's spend()
        // carves those same fees out of whatever `amount` it's given
        // automatically, so passing receiverGets here subtracted the
        // kit/forwarder fees a second time, silently shorting the
        // recipient below what the preview promised. What spend() actually
        // needs headroom for is the balance-only fees (provider + gas),
        // which come out of the Unified Balance IN ADDITION to whatever
        // amount is passed in — that's the "insufficient total maxFee
        // across intents to cover forwarding fee"-style failure this
        // margin exists to avoid, not the kit/forwarder deduction.
        //
        // FIX: this margin used to be a single flat 0.0005 USDC for EVERY
        // chain — calibrated from one observed shortfall (0.000005 USDC)
        // that was almost certainly seen on Ethereum Sepolia, the most-used
        // route. A flat margin doesn't scale with how large the actual
        // fee is on a given destination. Confirmed in production: an
        // Avalanche Fuji transfer failed with exactly this error — AVAX's
        // live-fee drift between estimate and execution exceeded what a
        // flat 0.0005 covers, even though the same code path works fine on
        // Ethereum. Scaling the margin to a percentage of the fee just
        // estimated makes it track each chain's actual fee size instead of
        // assuming every chain drifts by the same absolute amount Ethereum
        // happened to. Floored at the old flat value (so already-working,
        // cheap/stable routes keep exactly the same protection they had),
        // capped so a single very-high-fee chain can't eat an unreasonable
        // chunk of the transfer.
        const spendFeeEstimate = Math.max(0, freshEstimate.totalFee - UB_DEPOSIT_GAS_RESERVE)
        const SPEND_SAFETY_MARGIN = Math.min(0.01, Math.max(0.0005, spendFeeEstimate * 0.03))
        const spendAmount = Math.max(0, targetDepositAmount - spendFeeEstimate - SPEND_SAFETY_MARGIN)
        const spendParams = {
          amount: spendAmount.toFixed(6),
          from: {
            adapter,
            allocations: [{ amount: spendAmount.toFixed(6), chain: 'Arc_Testnet' }],
          },
          to: { chain: chain.sdk as any, recipientAddress: address, useForwarder: true },
          token: 'USDC',
        }
        // Covers both the first spend() attempt and the resumable retry
        // below, since the retry only adds `config.retry` on top of these
        // same spendParams — amount/allocations never change between them.
        assertAllocationsMatchAmount(spendParams.amount, spendParams.from.allocations, 'unifiedBalance.spend')

        // spend() can fail after the burn-side of the forwarder transfer has
        // already gone out (e.g. "Forwarder transfer failed: ON_CHAIN_FAILURE"
        // while waiting on the mint). Circle's own recovery pattern for this
        // is NOT a separate "retrySpend" call (no such method exists on the
        // SDK) — it's re-calling spend() with the same params plus
        // config.retry, seeded from the attestation/signature Circle attaches
        // to a KitError when error.recoverability === 'RESUMABLE'. Handling
        // that here, right where spend() is called, means a resumable
        // failure resumes the SAME in-flight transfer instead of falling
        // through to the outer catch below, which would land on the
        // 'failed' screen and — since deposit already succeeded — make
        // "Try Again" restart from handleConfirm and submit a SECOND
        // deposit on top of Unified Balance funds that were never lost in
        // the first place.
        // UB FIX: this used to only be checked from the FIRST spend() call's
        // catch block (see the `else` branch below). The maxFee top-up retry
        // a few lines down calls spend() a second time and can fail with the
        // exact same RESUMABLE/ON_CHAIN_FAILURE signature — the burn already
        // went out on that attempt, Gateway hands back an attestation +
        // signature, and Circle's own recovery pattern is to resume with
        // them rather than give up. Before this fix, only the first
        // attempt's failure ever got a chance to resume; a resumable failure
        // on the top-up retry fell straight through to the outer catch,
        // landing on "Transfer Status Unclear" with "Retry anyway (may
        // double-send)" as the only way forward, even though resuming was
        // possible. Factored out so both call sites can attempt it.
        const tryResumeSpend = async (err: any, attemptStartedAt: number): Promise<any | null> => {
          const isKitError = KitError && err instanceof KitError
          const resumable = isKitError && err.recoverability === 'RESUMABLE'
          const trace = err?.cause?.trace
          if (!resumable || !trace?.attestation || !trace?.signature) {
            // UB FIX: this used to return null here with zero visibility —
            // every non-resumed failure looked identical in the logs to a
            // deliberately-non-resumable one, whether the SDK genuinely
            // reported non-RESUMABLE or the detection just missed a real
            // attestation/signature (wrong shape, different SDK version,
            // error wrapped/re-thrown before reaching here, etc). Logging
            // the actual reason turns "was this really unrecoverable?" from
            // a guess into something checkable in TestLogPanel.
            logTestEvent({ runId: testRunId, flow: 'transfer', chainId: chain.id, service: testService, kind: 'note', label: 'unifiedBalance.spend resume NOT attempted', data: {
              isKitError,
              recoverability: isKitError ? err.recoverability : undefined,
              hasTrace: !!trace,
              hasAttestation: !!trace?.attestation,
              hasSignature: !!trace?.signature,
              message: err?.message,
            } })
            return null
          }

          const elapsedMs = Date.now() - attemptStartedAt
          if (elapsedMs > GATEWAY_ATTESTATION_EXPIRY_SAFETY_MS) {
            logTestEvent({ runId: testRunId, flow: 'transfer', chainId: chain.id, service: testService, kind: 'error', label: 'unifiedBalance.spend resume SKIPPED — attestation likely expired', data: { elapsedMs } })
            err.message = `Deposit succeeded but the spend attempt failed and took too long to retry safely ` +
              `(the Gateway attestation may have expired). Check your Unified Balance before retrying — ` +
              `original error: ${err?.message || 'unknown error'}`
            throw err
          }

          setBridgeSteps(prev => prev.map(s => s.name === 'spend'
            ? { ...s, message: 'Resuming transfer…' }
            : s))
          try {
            // Arc's docs (unified-balance/select-source-blockchains) state
            // that resuming only the mint step "uses a separate retrySpend
            // flow and parameters, not a partial spend call". Prefer that
            // dedicated method when the installed SDK exposes it, and fall
            // back to re-calling spend() with config.retry (the pattern this
            // code has always used) when it doesn't — the retry seed
            // (attestation + signature off the KitError trace) is the same
            // either way.
            const ub: any = kit.unifiedBalance
            let result: any
            if (typeof ub?.retrySpend === 'function') {
              result = await ub.retrySpend({
                ...spendParams,
                retry: { attestation: trace.attestation, signature: trace.signature },
              })
              logTestEvent({ runId: testRunId, flow: 'transfer', chainId: chain.id, service: testService, kind: 'result', label: 'unifiedBalance.retrySpend — SUCCESS', data: result })
            } else {
              result = await ub.spend({
                ...spendParams,
                config: { retry: { attestation: trace.attestation, signature: trace.signature } },
              })
              logTestEvent({ runId: testRunId, flow: 'transfer', chainId: chain.id, service: testService, kind: 'result', label: 'unifiedBalance.spend resumed — SUCCESS', data: result })
            }
            return result
          } catch (resumeErr: any) {
            logTestEvent({ runId: testRunId, flow: 'transfer', chainId: chain.id, service: testService, kind: 'error', label: 'unifiedBalance.spend resume FAILED', data: { message: resumeErr?.message } })
            resumeErr.message = `Resume after ON_CHAIN_FAILURE also failed: ${resumeErr?.message || 'unknown error'}`
            throw resumeErr
          }
        }

        let spendResult: any
        const spendAttemptStartedAt = Date.now()
        try {
          spendResult = await kit.unifiedBalance.spend(spendParams)
        } catch (spendErr: any) {
          logTestEvent({ runId: testRunId, flow: 'transfer', chainId: chain.id, service: testService, kind: 'error', label: 'unifiedBalance.spend failed', data: { message: spendErr?.message } })

          // Gateway 400: "Insufficient total maxFee across intents to cover
          // forwarding fee. Required additional: 0.000051" — a pre-execution
          // validation rejection (no burn has happened yet, unlike the
          // RESUMABLE/ON_CHAIN_FAILURE case below), seen so far on
          // lower-volume forwarder destinations (Sei) where estimateSpend()'s
          // preflight forwarding-fee quote apparently runs lower than what
          // Gateway's own maxFee validation wants at execution time. Rather
          // than guess at a new fee-model formula for this, use the exact
          // number Gateway already hands back: top up `amount` by that much
          // (plus a small buffer, in case a second live quote at retry time
          // asks for slightly more than the first) and retry once. Bounded
          // by `headroom` — the gap SPEND_SAFETY_MARGIN already reserved
          // between spendAmount+spendFeeEstimate and targetDepositAmount —
          // so this can never spend more than what's actually sitting in
          // the Unified Balance.
          const maxFeeShortfallMatch = /insufficient total maxfee.*forwarding fee.*required additional:\s*([\d.]+)/i.exec(spendErr?.message || '')
          if (maxFeeShortfallMatch) {
            const shortfall = parseFloat(maxFeeShortfallMatch[1]) || 0
            const TOPUP_BUFFER = 0.00002
            const topUp = shortfall + TOPUP_BUFFER
            const headroom = targetDepositAmount - spendAmount - spendFeeEstimate
            if (shortfall > 0 && topUp <= headroom) {
              const bumpedAmount = (spendAmount + topUp).toFixed(6)
              const bumpedParams = {
                ...spendParams,
                amount: bumpedAmount,
                from: { adapter, allocations: [{ amount: bumpedAmount, chain: 'Arc_Testnet' }] },
              }
              assertAllocationsMatchAmount(bumpedParams.amount, bumpedParams.from.allocations, 'unifiedBalance.spend (maxFee top-up retry)')
              logTestEvent({ runId: testRunId, flow: 'transfer', chainId: chain.id, service: testService, kind: 'note', label: 'unifiedBalance.spend maxFee top-up retry', data: { shortfall, topUp, bumpedAmount } })
              const topUpAttemptStartedAt = Date.now()
              try {
                spendResult = await kit.unifiedBalance.spend(bumpedParams)
                logTestEvent({ runId: testRunId, flow: 'transfer', chainId: chain.id, service: testService, kind: 'result', label: 'unifiedBalance.spend maxFee top-up — SUCCESS', data: spendResult })
              } catch (topUpErr: any) {
                logTestEvent({ runId: testRunId, flow: 'transfer', chainId: chain.id, service: testService, kind: 'error', label: 'unifiedBalance.spend maxFee top-up FAILED', data: { message: topUpErr?.message } })
                // UB FIX: the top-up retry can itself fail with the burn
                // already gone out (RESUMABLE/ON_CHAIN_FAILURE) — try to
                // resume it the same way the first attempt's failure does
                // below, instead of unconditionally surfacing "Transfer
                // Status Unclear" for a failure that was actually resumable.
                const resumed = await tryResumeSpend(topUpErr, topUpAttemptStartedAt)
                if (resumed) {
                  spendResult = resumed
                } else {
                  topUpErr.message = `Retried with the fee shortfall Gateway reported, but it still failed: ${topUpErr?.message || 'unknown error'}`
                  throw topUpErr
                }
              }
            } else {
              // Either Gateway's own error text didn't parse to a usable
              // number, or the shortfall exceeds the margin we set aside —
              // topping up further would eat into the balance-only fee
              // reserve itself, which isn't safe to do blindly. Surface the
              // original error rather than attempt a top-up we can't afford.
              throw spendErr
            }
          } else {
            // Uses the same tryResumeSpend helper the maxFee top-up retry's
            // catch block now uses above — was inlined here separately
            // before, which is exactly why the top-up path never got the
            // same recovery chance in the first place.
            const resumed = await tryResumeSpend(spendErr, spendAttemptStartedAt)
            if (resumed) {
              spendResult = resumed
            } else {
              throw spendErr
            }
          }
        }

        logTestEvent({ runId: testRunId, flow: 'transfer', chainId: chain.id, service: testService, kind: 'result', label: 'unifiedBalance.spend result — SUCCESS', data: spendResult })
        const spendHash = getUBHash(spendResult)

        setBridgeSteps(prev => prev.map(s => s.name === 'spend'
          ? { ...s, status: 'done', verified: true, message: 'Arrived at destination', txHash: spendHash, completedAt: Date.now() }
          : s))

        finalTxHashRef.current = spendHash
        if (spendHash) setTxHash(spendHash)

        const completionSec = Math.round((Date.now() - bridgeStartRef.current) / 1000)
        setSuccessInfo({
          sentAmount:     targetDepositAmount,
          receiverGets:   freshEstimate.receiverGets,
          totalFees:      freshEstimate.totalFee,
          completionTime: completionSec,
          // UB spend always goes through Circle's forwarder, so spendHash is
          // normally empty — fall back to the deposit hash (a real Arc tx)
          // for the "Transaction Hash" row so it isn't just a dash.
          txHash:         spendHash || depositHash,
          mintTxHash:     spendHash || '',
          burnTxHash:     depositHash,
        })

        // Record in activity — same Activity.bridge() call the CCTP path
        // uses below, so a Gateway transfer shows up in history identically
        // to a CCTP one regardless of which rail actually moved the funds.
        // Gated on depositHash (not spendHash) — the deposit always exists
        // by this point since it already resolved above; the spend hash
        // going into the row's own fields is best-effort (undefined isn't
        // a crash), but recording is not skipped just because it's empty.
        try {
          const { walletAddress: bwa } = useAuthStore.getState()
          if (depositHash || spendHash) {
            import('@/lib/ActivityService').then(({ Activity }) => {
              Activity.bridge({
                walletAddress:      bwa ?? '',
                txHash:             depositHash || spendHash,
                destinationTxHash:  depositHash ? (spendHash || undefined) : undefined,
                amount:             numAmount,
                sourceChain:        'Arc_Testnet',
                destinationChain:   chain.sdk || chain.name || selectedChain,
                destinationAddress: address,
              }).catch((e: any) => console.error('[MultichainSend] Activity.bridge failed:', e?.message))
            }).catch(() => {})
          }
        } catch {}

        try {
          const { getUSDCBalance } = await import('@/lib/arcService')
          if (senderAddress) getUSDCBalance(senderAddress).then(b => useWalletStore.getState().setBalance(b)).catch(() => {})
        } catch {}

        try {
          const { user: u, walletAddress: wa } = useAuthStore.getState()
          const uid = u?.id && !u.id.startsWith('usr_') ? u.id : wa ? 'wallet_' + wa.toLowerCase().slice(2, 18) : null
          if (uid && wa && spendHash) {
            awardTransactionPoints({ userId: uid, walletAddress: wa, txHash: spendHash })
              .then(r => { if (r.pointsAwarded > 0) notifyRewardMultichain(r.pointsAwarded) })
              .catch((e: any) => console.error('[MultichainSend] awardTransactionPoints failed:', e?.message))
          }
        } catch {}

        logTestEvent({ runId: testRunId, flow: 'transfer', chainId: chain.id, service: testService, kind: 'result', label: 'SUCCESS', data: { spendHash } })
        stopTicker()
        // Transfer fully landed — the deposited funds now have a completed
        // forward path, so clear the "resume from prior deposit" bookkeeping.
        resetUBTransientState()
        setStep('success')
        clearResumableOperation('multichain_transfer')
        return
      }

      // Update step 0 message to indicate signing has started
      setBridgeSteps(prev => prev.map((s, i) => i === 0 && s.status === 'active'
        ? { ...s, message: STEP_DEFS[0].activeMsg }
        : s))

      // ── 6. Register SDK event listeners ───────────────────────────────────
      // These are best-effort: Arc Docs only documents `bridge.approve`. Other
      // events may or may not fire. When they do, they override the timer with
      // real txHashes. When they don't, the timer keeps the UI moving.

      // Shared handler factory
      const handleEvent = (doneKey: string) => (payload: any) => {
        const hash: string =
          payload?.values?.txHash || payload?.txHash || payload?.data?.txHash || ''

        if (doneKey === 'mint' && hash) finalTxHashRef.current = hash
        // Burn confirmed — funds have irreversibly left Arc. Record it
        // synchronously so the outer catch / failed screen can tell a
        // still-settling transfer apart from one where nothing moved.
        if (doneKey === 'burn' && hash) burnTxHashRef.current = hash

        // Write the activity row THE MOMENT the burn confirms, instead of
        // waiting for the entire bridge (through attestation + mint) to
        // finish before anything shows up in Activity/history at all.
        // This is the same signal that already drives the UI's own step
        // indicator (handleEvent is trusted for that already), just also
        // persisted now instead of only ever mutating local component
        // state. Written as 'pending' — the final block below (after
        // kit.bridge() fully resolves) finalizes this exact row via
        // markBridgeCompleted(), a PATCH, not a second insert, so this
        // can never create a duplicate row.
        if (doneKey === 'burn' && hash) {
          try {
            const { walletAddress: burnWa } = useAuthStore.getState()
            if (burnWa) {
              // Persist enough to resume this screen if the page gets
              // refreshed while still waiting on attestation/mint below —
              // the burn is irreversible at this point (funds have already
              // left Arc), so a refresh must never drop back to the empty
              // form as if nothing happened. Cleared once this reaches a
              // terminal state ('success' or 'failed') further down.
              saveResumableOperation('multichain_transfer', hash, {
                amount: numAmount, destinationChain: chain.sdk || chain.name || selectedChain,
                destinationAddress: address, walletAddress: burnWa,
              })
              import('@/lib/ActivityService').then(({ Activity }) => {
                Activity.bridge({
                  walletAddress:      burnWa,
                  txHash:             hash,
                  amount:             numAmount,
                  sourceChain:        'Arc_Testnet',
                  destinationChain:   chain.sdk || chain.name || selectedChain,
                  destinationAddress: address,
                  status:             'pending',
                }).catch((e: any) => console.error('[MultichainSend] early Activity.bridge (pending) failed:', e?.message))
              }).catch(() => {})
            }
          } catch {}
        }

        const nextKey = STEP_KEYS[STEP_KEYS.indexOf(doneKey) + 1]
        setBridgeSteps(prev => prev.map(s => {
          // Mark doneKey done + attach hash (overrides timer's no-hash done state)
          if (s.name === doneKey) {
            return { ...s, status: 'done', verified: true, message: STEP_DONE_MESSAGE[doneKey], txHash: hash || s.txHash, completedAt: s.completedAt || Date.now() }
          }
          // Skip-ahead activation: if event for step N+2 fires before N+1, activate it
          if (nextKey && s.name === nextKey && s.status === 'pending') {
            const def = STEP_DEFS.find(d => d.key === nextKey)
            return { ...s, status: 'active', message: def?.activeMsg || 'Processing…', startedAt: Date.now() }
          }
          return s
        }))
      }

      kit.on('bridge.approve',          handleEvent('approve'))
      kit.on('bridge.burn',             handleEvent('burn'))
      kit.on('bridge.fetchAttestation', handleEvent('attestation'))
      kit.on('bridge.attestation',      handleEvent('attestation'))
      kit.on('bridge.mint',             handleEvent('mint'))
      // Wildcard: was previously a no-op, silently discarding every payload.
      // That meant there was no way to tell, even from the console, which
      // steps had a REAL SDK event fire vs which were only ever advanced by
      // the client-side timer above — exactly the ambiguity a user hit when
      // "Burn confirmed" showed no txHash. Log it for real now.
      //
      // Deliberately does NOT log the raw `payload` object. Checked this
      // SDK's own shipped type definitions (@circle-fin/app-kit) and found
      // every documented event/bus payload shaped around tx status
      // (txHash/txId) — no evidence of credential data ever appearing here.
      // Logging only these specific known-safe fields (not the whole
      // object) means a future SDK version can't silently start including
      // something sensitive in a payload this code blindly forwards to the
      // console — the extraction stays correct by construction, not by
      // continuing to trust an `any`-typed third-party object every release.
      kit.on('*', (payload: any) => {
        const eventName = payload?.type || payload?.event || payload?.name || '(unknown)'
        const hash = payload?.values?.txHash || payload?.txHash || payload?.data?.txHash || undefined
        console.log('[Bridge event]', eventName, hash ? { txHash: hash } : '(no hash)')
        logTestEvent({ runId: testRunId, flow: 'transfer', chainId: chain.id, service: testService, kind: 'sdk-event', label: String(eventName), data: hash ? { txHash: hash } : undefined })
      })

      // ── 7. Run the bridge with timeout ────────────────────────────────────
      // 12 minutes, not 3. A CCTP transfer is burn -> Circle attestation ->
      // forwarder mint; per Arc's docs the attestation alone "typically takes
      // approximately 60 seconds but varies based on the source blockchain's
      // finality" and the forwarder waits under `maxFee` for destination gas
      // to come into range rather than erroring. 3 minutes routinely expired
      // on transfers that then completed fine — and this app's own
      // server-side settlement budget for the same wait is 40 minutes. The
      // timeout is a backstop against a genuinely wedged call, not a
      // per-step SLA. When it does fire after the burn already landed
      // (burnTxHashRef set), the outer catch routes to the "still settling"
      // screen, not "failed" — the burn is irreversible and the mint will
      // still complete on its own.
      const BRIDGE_TIMEOUT_MS = 12 * 60 * 1000
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(
          'Bridge is taking longer than expected. Your burn on Arc may have already ' +
          'gone through — check your destination balance before retrying to avoid a double spend.'
        )), BRIDGE_TIMEOUT_MS)
      )

      const transferSpeed = selectedSpeed === 'fast' ? 'FAST' : 'SLOW'

      // maxFee is a CAP the source-chain burn signs into the message — the
      // relayer must stay under it to submit the mint. With
      // useForwarder:true, that cap has to cover BOTH the CCTP protocol fee
      // AND the Forwarding Service's own cut (deducted at mint time), and
      // per Circle's docs both are dynamic and must be fetched immediately
      // before the transfer.
      //
      // CORRECTION (supersedes an earlier version of this comment/fix that
      // blamed a missing 'kit' fee type): tracing into the exact installed
      // @circle-fin/provider-cctp-v2@1.8.3 (what bridge-kit@1.10.2 actually
      // resolves to) shows result.fees[] only ever contains a 'kit' entry
      // when `config.customFee` is set — this app never sets it, so that
      // fix was harmless but not the real cause.
      //
      // The actual gap: when Circle's live fee-rate lookup
      // (fetchUsdcFastBurnFee / fetchForwardingFee, keyed by source+dest
      // CCTP domain) rejects for a route — which newer/lower-volume
      // forwarder destinations are more exposed to than long-established
      // ones — the SDK does NOT throw. `estimate()` still resolves, but
      // pushes `{ type: 'provider', amount: null, error }` with NO
      // forwarder entry at all. `parseFloat(null) || 0` silently turns that
      // into a $0 contribution, `feeTotal > 0` is false, and we fall back to
      // the static value anyway — so a failed lookup and a
      // successful-but-zero lookup were indistinguishable, and neither told
      // us whether the static fallback is actually enough for this route.
      //
      // Fix: (1) detect a null/error fee entry explicitly and retry the
      // estimate once — these lookups are more prone to transient failures
      // than outright unsupported-route errors; (2) if it still can't be
      // verified, use a fallback that scales with amount (mirroring the
      // SDK's own bps-based provider fee formula: ~14bps + 10% buffer) with
      // a higher floor, since maxFee is only a ceiling — signing a higher
      // cap costs nothing extra if the relayer's real fee is lower, it only
      // avoids under-provisioning.
      // BUG FIX: this floor used to be a flat 0.15 USDC / 20bps regardless
      // of destination chain. maxFee is a hard CAP signed into the burn
      // message — the relayer legally cannot submit the mint above it. On
      // an L1 destination (Ethereum is the only one in this app's chain
      // list) mint gas is routinely 10-50x an L2's, so that flat floor can
      // easily sit below what the relayer actually needs to spend, and
      // there is no way to raise a cap after it's signed short of a manual
      // retryBridge. When that happens the relayer doesn't error out — it
      // just waits for gas to fall back under the cap, which is very
      // plausibly what turned a normally-~5s mint into a multi-minute
      // stall on Ethereum Sepolia. Give L1 destinations real headroom.
      const isL1Destination = chain.layer === 'L1'
      let maxFee = String(Math.max(isL1Destination ? 1.0 : 0.15, numAmount * (isL1Destination ? 0.01 : 0.002)).toFixed(6))

      // Chains outside Circle's forwarder allow-list (e.g. Plume) have no
      // relayer to submit the destination mint, so `adapter` — the same key
      // that signs on Arc — has to submit it itself. That needs a little
      // native gas sitting on the destination chain first; top it up via the
      // gas-relay endpoint before attempting the bridge. Best-effort: if
      // funding fails (chain not configured server-side, relay underfunded,
      // etc.) we still attempt the bridge — the wallet may already hold gas
      // from a prior top-up — but we don't block the whole transfer on it.
      const useForwarder = chainSupportsForwarder(chain.sdk)

      const destTarget = useForwarder
        ? { chain: chain.sdk as any, recipientAddress: address, useForwarder: true }
        : { chain: chain.sdk as any, recipientAddress: address, adapter, useForwarder: false }

      // PERF: the gas top-up and the fee re-estimate below used to run
      // sequentially (await gas, THEN await estimate) even though neither
      // depends on the other's result — that serialized the full latency
      // of both network calls into the signing hot path on every single
      // transfer. Both still have to finish before kit.bridge() (the
      // top-up must land before `adapter` submits the mint on non-forwarder
      // chains; the estimate feeds maxFee below), so fire them together
      // and await both, instead of one after the other.
      const gasTopUpPromise: Promise<void> = useForwarder
        ? Promise.resolve()
        : fetch('/api/relay-gas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chainId: chain.sdk, userAddress: senderAddress }),
          }).then(() => undefined).catch((gasErr) => {
            // Best-effort: if funding fails (chain not configured server-side,
            // relay underfunded, etc.) we still attempt the bridge — the
            // wallet may already hold gas from a prior top-up.
            console.warn('[Bridge] relay-gas top-up failed, proceeding anyway:', gasErr)
          })

      const runEstimate = () => kit.estimateBridge({
        from: { adapter, chain: 'Arc_Testnet' },
        to: destTarget,
        amount: numAmount.toFixed(6),
        token: 'USDC',
        config: { transferSpeed, batchTransactions: false },
      })
      const estimatePromise: Promise<any> = (async () => {
        try {
          return await runEstimate()
        } catch (estErr) {
          console.error('[Bridge] estimateBridge failed once, retrying:', estErr)
          try {
            return await runEstimate()
          } catch (estErr2) {
            console.error('[Bridge] estimateBridge failed twice, falling back to scaled maxFee:', estErr2)
            return null
          }
        }
      })()

      const [estimate] = await Promise.all([estimatePromise, gasTopUpPromise])
      if (estimate) {
        const feeEntries: any[] = estimate?.fees ?? []
        const hadFailedLookup = feeEntries.some((f: any) => f.amount === null || f.error)
        const feeTotal = feeEntries
          .filter((f: any) => (f.type === 'provider' || f.type === 'forwarder' || f.type === 'kit') && f.amount !== null)
          .reduce((sum: number, f: any) => sum + (parseFloat(f.amount) || 0), 0)
        if (hadFailedLookup) {
          console.warn('[Bridge] fee estimate returned a null/error entry for this route — using the scaled fallback maxFee instead of the partial result:', feeEntries)
        } else if (feeTotal > 0) {
          // Pad the live number rather than signing it bare: feeTotal
          // reflects fee/gas conditions AT ESTIMATE TIME, not whenever the
          // relayer actually gets around to executing the mint — which on
          // a slow/congested route can be minutes later. maxFee is only
          // ever a ceiling, so padding it costs nothing if the relayer's
          // real fee comes in lower; it only prevents a cap that was
          // accurate a minute ago from being too tight by execution time.
          // L1 destinations get more headroom since Ethereum gas is both
          // higher and more volatile than the L2s here.
          const buffer = isL1Destination ? 1.5 : 1.15
          maxFee = (feeTotal * buffer).toFixed(6)
        }
      }

      // ── Safety clamp: maxFee MUST stay below the burn amount ────────────────
      // CCTPv2's depositForBurn rejects maxFee >= amount at the contract level
      // ("Max fee must be less than amount" — and Arc's docs note the burn
      // amount must exceed the CCTPv2 max fee, ~1.4 USDC, for Arc-sourced
      // transfers). The scaled fallback above (numAmount*0.01 for L1, or a
      // 1.5x pad on a live estimate) can land at or past the amount on a
      // small transfer to a high-fee L1 destination — which surfaces as an
      // opaque "Simulation failed: Transaction reverted" with no burn ever
      // reaching the chain, indistinguishable from a gas/balance problem.
      // Clamp to at most 90% of the amount (real margin, not barely under),
      // same ratio src/lib/backgroundBridge.ts already applies on the claim
      // direction. If even that can't leave a sane gap, the amount is just
      // too small for this route — fail early with an actionable message
      // instead of the SDK's opaque revert.
      const MAX_FEE_SAFETY_RATIO = 0.9
      const MIN_VIABLE_MARGIN = 0.05 // USDC
      const clampedMaxFee = Math.min(parseFloat(maxFee), numAmount * MAX_FEE_SAFETY_RATIO)
      if (numAmount - clampedMaxFee < MIN_VIABLE_MARGIN) {
        logTestEvent({ runId: testRunId, flow: 'transfer', chainId: chain.id, service: testService, kind: 'error', label: 'amount too small for route fee — aborting before bridge()', data: { amount: numAmount, estimatedMaxFee: maxFee } })
        throw new Error(
          `This amount ($${trimTrailingZeros(numAmount.toFixed(2))}) is too small for ${chain.name}'s current transfer fee ` +
          `(~$${trimTrailingZeros(parseFloat(maxFee).toFixed(2))}). Try sending a larger amount to this chain.`
        )
      }
      if (clampedMaxFee < parseFloat(maxFee)) {
        console.warn(`[Bridge] clamped maxFee from ${maxFee} to ${clampedMaxFee.toFixed(6)} (must stay below amount ${numAmount})`)
        logTestEvent({ runId: testRunId, flow: 'transfer', chainId: chain.id, service: testService, kind: 'note', label: 'maxFee clamped below amount', data: { from: maxFee, to: clampedMaxFee.toFixed(6), amount: numAmount } })
      }
      maxFee = clampedMaxFee.toFixed(6)

      let result = await Promise.race([
        kit.bridge({
          from: { adapter, chain: 'Arc_Testnet' },
          to: destTarget,
          amount: numAmount.toFixed(6),
          token: 'USDC',
          config: { transferSpeed, maxFee, batchTransactions: false },
        }),
        timeoutPromise,
      ])
      logTestEvent({ runId: testRunId, flow: 'transfer', chainId: chain.id, service: testService, kind: 'result', label: `kit.bridge() → state: ${result.state}`, data: { state: result.state, steps: (result as any).steps } })

      // Capture the burn hash off the resolved result the instant we have it —
      // BEFORE any retry or throw below. The `bridge.burn` event usually sets
      // burnTxHashRef already, but it's a best-effort SDK event; the resolved
      // result's own burn step is authoritative. Once this is set, the USDC
      // has left Arc and the transfer will settle on its own no matter what
      // the rest of this function does.
      {
        const rBurn = (result as any)?.steps?.find((s: any) => s.name === 'burn' && (s.state === 'success' || s.status === 'done' || s.status === 'success'))
        const rBurnHash = rBurn?.txHash || rBurn?.data?.txHash || rBurn?.values?.txHash || ''
        if (rBurnHash) burnTxHashRef.current = rBurnHash
      }

      if (result.state === 'error') {
        // Don't give up immediately — if the burn already succeeded and only
        // a later step (e.g. the forwarder's mint submission) failed, this is
        // an "actionable" failure per Circle's Bridge Kit recovery docs:
        // resuming continues from the failed step using the attestation
        // already signed, instead of re-doing the whole burn (and instead of
        // punting the user to a manual "retry anyway / may double-send" flow).
        //
        // Gate the retry on isRetryableError() — a definitively non-retryable
        // failure (e.g. the maxFee-vs-amount contract validation) fails the
        // exact same way a second time, so skip the redundant round trip.
        // Same pattern src/lib/backgroundBridge.ts already uses on the claim
        // direction. If the helper isn't available in the installed SDK,
        // fall back to always attempting (the prior behavior).
        const failedStep = result.steps.find((s: any) => s.state === 'error')
        const errForCheck = (failedStep as any)?.errorMessage || (failedStep as any)?.error || (result as any)?.error
        let shouldRetry = true
        try {
          const { isRetryableError } = await import('@circle-fin/app-kit')
          if (typeof isRetryableError === 'function' && errForCheck) shouldRetry = isRetryableError(errForCheck)
        } catch { /* helper unavailable — attempt anyway, same as before */ }

        if (shouldRetry) {
          try {
            const retried: any = await kit.retryBridge(result, { from: adapter, to: adapter })
            logTestEvent({ runId: testRunId, flow: 'transfer', chainId: chain.id, service: testService, kind: 'result', label: `kit.retryBridge() → state: ${retried?.state}`, data: { state: retried?.state, steps: retried?.steps } })
            if (retried) result = retried
          } catch (retryErr) {
            console.error('[Bridge] retryBridge failed:', retryErr)
          }
        } else {
          logTestEvent({ runId: testRunId, flow: 'transfer', chainId: chain.id, service: testService, kind: 'note', label: 'skipping retryBridge — error confirmed non-retryable', data: { error: String(errForCheck).slice(0, 200) } })
        }
      }

      // ── 8. Stop timer — actual results take over ─────────────────────────
      stopStepTimer()

      if (result.state === 'error') {
        const failed = result.steps.find((s: any) => s.state === 'error')
        const raw = (failed as any)?.errorMessage || (failed as any)?.error?.message || 'Bridge failed'
        // If the burn already landed, the funds are gone from Arc and the
        // mint may still complete on its own — say so, so the failed screen
        // shows the "status unclear / may have arrived" variant and steers
        // away from a blind retry that could double-send.
        throw new Error(burnTxHashRef.current
          ? `${raw} — but the burn on Arc already went through, so the transfer may still complete on its own. Check your destination balance before retrying.`
          : raw)
      }

      // ── 9. Extract real txHashes from the SDK result ──────────────────────
      const mintStep    = result.steps.find((s: any) => s.name === 'mint')
      const burnStep    = result.steps.find((s: any) => s.name === 'burn')
      const approveStep = result.steps.find((s: any) => s.name === 'approve')
      const attestStep  = result.steps.find((s: any) => s.name === 'fetchAttestation')

      // Arc SDK: txHash is at step.txHash OR step.data.txHash
      const getHash = (step: any): string =>
        step?.txHash || step?.data?.txHash || step?.values?.txHash || ''

      const stepHashMap: Record<string, string> = {
        approve:     getHash(approveStep),
        burn:        getHash(burnStep),
        attestation: '',
        mint:        getHash(mintStep),
      }


      // ── 10. Mark all steps done with their real hashes ────────────────────
      // Used to reset every step back to 'pending' here and replay through
      // active -> done one at a time with artificial delays, purely so each
      // of the 4 checklist circles visibly animated in sequence even if the
      // timer had pre-completed them all instantly. That replay ran AFTER
      // kit.bridge() already resolved — i.e. after the funds had actually
      // moved — and the progress ring reads its percentage straight from
      // this same bridgeSteps state, so the reset made the ring visibly
      // drop back down and re-fill right when the transfer was already
      // done, looking like it had restarted. The ring doesn't need a
      // step-by-step reveal the way 4 separate checklist circles did — one
      // direct update to the real, final state (same pattern the UB path
      // already uses) lets it ease smoothly to 100% via its own CSS
      // transition instead of replaying a fake sequence.
      setBridgeSteps(prev => prev.map(s => ({
        ...s,
        status: 'done' as BridgeStepStatus,
        verified: true,
        message: STEP_DONE_MESSAGE[s.name] || s.message,
        txHash: s.txHash || stepHashMap[s.name],
        completedAt: s.completedAt || Date.now(),
      })))

      // BUG FIX: this used to try getHash(burnStep) FIRST — meaning `txHash`
      // (used below on the success screen as "View on {destination chain}
      // Explorer") was usually the Arc-side BURN hash, not the destination
      // MINT hash. That hash only ever existed on Arc's explorer, so pairing
      // it with EXPLORER_BY_SDK[chain.sdk] (the destination chain's
      // explorer) produced a link to a transaction that never happened on
      // that chain — "transaction not found". The ActivityService comment
      // just below even already assumed finalHash was the mint hash; the
      // priority order here just never matched that. Mint is now tried
      // first (matching what "destination-chain arrival hash" actually
      // means), with burn kept separately as burnHash for its own,
      // correctly-paired Arc explorer link.
      const mintHash  = getHash(mintStep) || finalTxHashRef.current || ''
      const burnHash  = getHash(burnStep) || ''
      const finalHash = mintHash || burnHash || getHash(approveStep) || ''

      if (finalHash) setTxHash(finalHash)

      const completionSec = Math.round((Date.now() - bridgeStartRef.current) / 1000)

      setSuccessInfo({
        sentAmount:     numAmount,
        receiverGets:   feeEstimate.receiverGets || Math.max(0, numAmount - feeEstimate.totalFee),
        totalFees:      feeEstimate.totalFee,
        completionTime: completionSec,
        txHash:         finalHash,
        // Only a REAL mint hash here — never the burnHash fallback that
        // finalHash carries for forwarder transfers. getHash(mintStep) is
        // empty when Circle's forwarder submitted the mint.
        mintTxHash:     getHash(mintStep) || '',
        burnTxHash:     burnHash,
      })

      // Finalize the activity row that was already written early, the
      // moment the burn event fired (see handleEvent above) — this PATCHes
      // that exact row to 'completed' with the mint hash, rather than
      // attempting a second insert for the same transaction. If the burn
      // event never actually fired (best-effort SDK event, genuinely
      // absent this run), there's no early row to find, and
      // markBridgeCompleted() itself falls back to a full upsert — so this
      // is a superset of the old behavior, never a regression from it.
      try {
        const { walletAddress: bwa } = useAuthStore.getState()
        const srcChainName = 'Arc_Testnet'
        const dstChainName = chain.sdk || chain.name || selectedChain
        // The Arc-side departure hash (row's primary tx_hash) and the REAL
        // destination mint hash (destination_tx_hash) — the latter only when
        // one genuinely exists. finalHash falls back to burnHash for
        // forwarder transfers, so passing it as destination_tx_hash was
        // writing the Arc burn hash into the destination slot; a later
        // server-side reconcile (blockchain-indexer) can still backfill the
        // real mint hash once the forwarder's mint is observed on-chain.
        const departureHash = burnHash || finalHash
        const realMintHash = getHash(mintStep) || ''
        if (departureHash) {
          import('@/lib/ActivityService').then(({ Activity }) => {
            Activity.markBridgeCompleted({
              walletAddress:      bwa ?? '',
              txHash:             departureHash,
              destinationTxHash:  realMintHash || undefined,
              amount:             parseFloat(amount) || 0,
              sourceChain:        srcChainName,
              destinationChain:   dstChainName,
              destinationAddress: address,
            }).catch((e: any) => console.error('[MultichainSend] markBridgeCompleted failed:', e?.message))
          }).catch((e: any) => console.error('[MultichainSend] import ActivityService failed:', e?.message))
        }
        // Bridge tx on-chain — source of truth
      } catch {}

      // Refresh balance
      try {
        const { getUSDCBalance } = await import('@/lib/arcService')
        if (senderAddress) getUSDCBalance(senderAddress).then(b => useWalletStore.getState().setBalance(b)).catch(() => {})
      } catch {}

      // Award points — fire-and-forget, same as the Activity.bridge() call
      // above. This used to `await` the Supabase round-trip right before
      // setStep('success'), meaning the success screen didn't appear until
      // reward-point crediting finished — visible as a lag between the
      // transfer actually completing and the screen showing up, worse
      // whenever Supabase was briefly slow. Whether points were awarded has
      // nothing to do with whether the transfer succeeded; it can resolve
      // in the background and still notify once it does.
      try {
        const { user: u, walletAddress: wa } = useAuthStore.getState()
        const uid = u?.id && !u.id.startsWith('usr_') ? u.id : wa ? 'wallet_' + wa.toLowerCase().slice(2, 18) : null
        if (uid && wa && finalHash) {
          awardTransactionPoints({ userId: uid, walletAddress: wa, txHash: finalHash })
            .then(r => { if (r.pointsAwarded > 0) notifyRewardMultichain(r.pointsAwarded) })
            .catch((e: any) => console.error('[MultichainSend] awardTransactionPoints failed:', e?.message))
        }
      } catch {}

      logTestEvent({ runId: testRunId, flow: 'transfer', chainId: chain.id, service: testService, kind: 'result', label: 'SUCCESS', data: { finalHash } })
      stopTicker()
      resetUBTransientState()
      setStep('success')
      clearResumableOperation('multichain_transfer')

    } catch (err: any) {
      const msg = err?.shortMessage
        || err?.reason
        || err?.data?.message
        || err?.message
        || 'Transfer failed. Please try again.'
      console.error('[Bridge] Failed:', msg, err)
      logTestEvent({ runId: testRunId, flow: 'transfer', chainId: chain.id, service: testService, kind: 'error', label: 'FAILED', data: { message: msg } })

      // Defense in depth: "no runners?!" is ethers' FallbackProvider saying
      // every provider it was given is permanently marked dead (see
      // getArcFallbackProvider above for how that happens and why it's
      // normally avoided). If it ever surfaces anyway, evict the cached
      // provider now so the NEXT attempt (the user's "Try Again") builds a
      // fresh one instead of hitting the same wedged instance again.
      if (/no runners/i.test(msg)) resetArcFallbackProvider()
      stopStepTimer()
      stopTicker()
      setTxError(/no runners/i.test(msg) ? 'Connection to Arc Testnet dropped. Please try again.' : msg)
      setBridgeSteps(prev => prev.map(s => s.status === 'active' ? { ...s, status: 'error', message: 'Step failed' } : s))
      setStep('failed')
      // If the burn never happened, nothing irreversible occurred — safe to
      // drop the marker, exactly like a normal retry. If it DID happen (see
      // the "may still complete on its own" message above), deliberately
      // keep it: the transfer might still land via the forwarder, and a
      // later refresh should still be able to check on it rather than
      // losing track of a real, irreversible burn.
      if (!burnTxHashRef.current) clearResumableOperation('multichain_transfer')

      // UB transfers that got as far as depositing into Unified Balance
      // before failing have real USDC sitting there with no forward path —
      // start the 7-day trustless recovery back to the Arc wallet right
      // now rather than leaving it to "Retry anyway" as the only option.
      // Fire-and-forget: this must never throw into or block the failure
      // screen the user is already looking at. Safe to call even if spend
      // secretly succeeded despite the error (see ubFundRecovery.ts) — the
      // "Transfer Status Unclear" case gets this too, since there's no way
      // to be certain from here whether spend actually landed.
      // Guarded by ubRecoveryStartedRef so a deposit whose spend fails more
      // than once (first attempt + a manual retry) can't kick off two
      // parallel recoveries for the same funds. The ref is set SYNCHRONOUSLY,
      // before the async import, so a fast "Retry" tap in the gap before
      // setUbRecoveryInitiated() resolves still sees recovery as in-progress
      // and refuses to re-enter the deposit/spend path.
      if (chain.ub && ubDepositedAmountRef.current && !ubRecoveryStartedRef.current) {
        const { walletAddress: wAddr, privateKey: pKey } = useAuthStore.getState()
        if (wAddr && pKey) {
          ubRecoveryStartedRef.current = true
          import('@/lib/ubFundRecovery').then(({ initiateUBRecovery }) =>
            initiateUBRecovery({
              walletAddress: wAddr,
              privateKey: pKey,
              amount: ubDepositedAmountRef.current!,
              destinationChainLabel: chain.name,
            })
          ).then(ok => setUbRecoveryInitiated(ok)).catch(() => {})
        }
      }
    }
    } finally {
      // Released only once the whole attempt has fully settled (success,
      // failed, or unclear) — this is what actually closes the double-submit
      // window described above, rather than the early setLoading(false).
      isConfirmingRef.current = false
    }
  }

  // ── Step icon ─────────────────────────────────────────────────────────────────
  const StepIcon = ({ status }: { status: BridgeStepStatus }) => {
    if (status === 'done') return <CheckCircle className="w-3.5 h-3.5 text-text-primary" />
    if (status === 'active') return <Loader2 className="w-3 h-3 text-text-primary animate-spin" />
    if (status === 'error') return <XCircle className="w-3.5 h-3.5 text-text-primary" />
    return null
  }

  const stepBg = (s: BridgeStepStatus) =>
    s === 'done' ? 'bg-success' : s === 'active' ? 'bg-brand' : s === 'error' ? 'bg-danger' : 'bg-text-primary/10'

  const stepText = (s: BridgeStepStatus) =>
    s === 'done' ? 'text-text-primary' : s === 'active' ? 'text-[var(--brand)]' : s === 'error' ? 'text-danger' : 'text-text-muted'

  // ── Estimated time label + per-step timeout detection ────────────────────────
  const activeStep = bridgeSteps.find(s => s.status === 'active')
  const activeStepIdx = bridgeSteps.findIndex(s => s.status === 'active')
  // ticker triggers re-renders every second so the ring % and estLabel stay live
  //
  // UB's spend/arrival step reuses chain.time (the same per-chain estimate
  // already shown in the chain picker) rather than a flat "~5s" for every
  // destination. Gateway's own <500ms figure is how fast Circle's
  // attestation/signature is ready — it isn't a promise about how fast the
  // destination chain will actually have mined and confirmed the mint
  // transaction, which is still bounded by that chain's own block time.
  // Ethereum's ~12s blocks alone make a flat "~5s" wrong for that specific
  // destination regardless of which bridging method is used underneath.
  const estLabel = chain.ub
    ? (activeStepIdx === 0 ? '<1s' : activeStepIdx === 1 ? chain.time : '')
    : (ticker >= 0 && activeStepIdx === 2 ? '20–90s for attestation' : activeStepIdx >= 0 ? '~5s' : '')

  // ── Progress ring percentage ──────────────────────────────────────────────
  // Each step is an equal-width slice of the ring (100/N). The active
  // step's slice fills in gradually rather than jumping straight to its
  // boundary, using a diminishing-returns curve against a rough expected
  // duration for that step — capped at 90% of the slice so the ring never
  // visually claims a step finished before the real completion event
  // (kit.bridge()/kit.unifiedBalance.*  resolving) actually flips it to done.
  const ringPercent = (() => {
    const total = bridgeSteps.length || 1
    const doneCount = bridgeSteps.filter(s => s.status === 'done').length
    let pct = (doneCount / total) * 100
    if (activeStep?.startedAt) {
      const elapsedSec = (Date.now() - activeStep.startedAt) / 1000
      // Rough expected duration per step: UB steps use the same chain-aware
      // numbers estLabel already computes (parse the leading digits out of
      // chain.time, e.g. "<30s" -> 30). CCTP steps now use the exact same
      // per-chain thresholds the step-advancement timer itself runs on
      // (getStepThresholds), so the ring's fill speed and the moment a step
      // actually flips to "done" agree with each other — previously the
      // ring assumed a flat ~5s for approve/burn/mint regardless of which
      // step was active or which chain USDC was headed to, while the timer
      // underneath was already using real per-step, per-chain numbers.
      const expectedSec = chain.ub
        ? (activeStepIdx === 0 ? 1 : parseInt(chain.time.replace(/\D/g, ''), 10) || 15)
        : (() => {
            const t = getStepThresholds(chain)
            const stepStartMs: Record<string, number> = { approve: 0, burn: t.approve, attestation: t.burn, mint: t.attestation }
            const key = STEP_KEYS[activeStepIdx]
            const durationMs = (t[key] ?? t.mint) - (stepStartMs[key] ?? 0)
            return Math.max(1, durationMs / 1000)
          })()
      const withinSlice = Math.min(0.9, elapsedSec / expectedSec)
      pct += withinSlice * (100 / total)
    }
    return Math.min(100, Math.round(pct))
  })()
  const ringErrored = bridgeSteps.some(s => s.status === 'error')

  // Two-tier waiting UI. The first tier fires while a step is still well
  // inside Circle's own documented normal range (attestation is
  // "usually 20-90 seconds" per Circle's docs — see the label rendered
  // below) and is intentionally calm/informational, not a warning: a user
  // sitting at 45-60s on mint is not looking at a stuck transfer, they're
  // looking at a completely normal CCTP Fast Transfer. The second tier
  // only fires once a step has run well past that normal range, and is
  // the one that should actually read as "something may be off."
  const STEP_INFO_SECS: Record<string, number> = {
    approve:     20,
    burn:        20,
    attestation: 30,
    mint:        30,
  }
  const STEP_WARN_SECS: Record<string, number> = {
    approve:     60,
    burn:        60,
    attestation: 150,
    mint:        150,
  }
  const STEP_INFO_HINT: Record<string, string> = {
    approve:     'Waiting on your wallet to confirm the approval.',
    burn:        'Waiting on Arc Testnet to confirm the burn.',
    attestation: "Circle's attestation service is signing off on the burn. This step normally takes 20-90 seconds — nothing to worry about yet.",
    mint:        "Circle's relayer is submitting the mint on the destination chain. This is normal and usually resolves within a minute or two.",
  }
  const STEP_TIMEOUT_HINT: Record<string, string> = {
    approve:     'Wallet may be slow to sign. Check your RPC connection.',
    burn:        'Arc Testnet RPC may be congested. Check ArcScan for activity.',
    attestation: "This is past Circle's normal 20-90s attestation window. Your funds are safe on Arc — still waiting on Circle's network.",
    mint:        'Destination mint is taking longer than usual via the relayer. Your funds are not lost — still waiting on Circle to submit it.',
  }
  const activeStepElapsed = activeStep?.startedAt
    ? Math.floor((Date.now() - activeStep.startedAt) / 1000)
    : 0
  const stepInfoThreshold = activeStep ? (STEP_INFO_SECS[activeStep.name] ?? 20) : 20
  const stepWarnThreshold = activeStep ? (STEP_WARN_SECS[activeStep.name] ?? 120) : 120
  const showStepInfo = !!activeStep && activeStepElapsed > stepInfoThreshold && activeStepElapsed <= stepWarnThreshold
  const showStepTimeout = !!activeStep && activeStepElapsed > stepWarnThreshold
  const stepInfoHint = activeStep ? (STEP_INFO_HINT[activeStep.name] ?? '') : ''
  const stepTimeoutHint = activeStep ? (STEP_TIMEOUT_HINT[activeStep.name] ?? '') : ''

  // Held in a variable (not returned directly) so the exact same JSX renders
  // either as the whole page (mobile) or as the left column of the desktop
  // 2-column layout below — never duplicated.
  const flow = (
    <div className={`relative flex flex-col bg-bg ${isDesktop ? 'h-full' : 'h-screen'}`}>
      {/* Desktop-only compact "Success" header (same padding/size as
          MultichainClaimPage's own done-step header) — the success step
          had no header at all before, so its content started right at
          the column's top edge instead of level with DesktopHistoryPanel's
          own header row next to it. */}
      {isDesktop && step === 'success' && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', padding: '16px', flexShrink: 0 }}>
          {!isDesktop && (
            <button onClick={() => navigate('/')} style={{ position: 'absolute', left: 16, background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--text-primary)', display: 'flex', alignItems: 'center' }}>
              <ArrowLeft className="w-5 h-5"/>
            </button>
          )}
          <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>Success</span>
        </div>
      )}
      {!['broadcasting','success','failed'].includes(step) && (
        <div className="header-row sticky top-0 z-20 gap-3 px-5 pt-header pb-header">
          {!isDesktop && (
            <button onClick={() => { if (step === 'form') { navigate('/multichain') } else { resetUBTransientState(); setStep('form') } }} className="back-btn">
              <ArrowLeft className="w-5 h-5 text-text-primary" />
            </button>
          )}
          <div className="flex-1">
            <h1 className="text-xl font-bold text-text-primary">Multichain Transfer</h1>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-[10px] font-semibold text-[var(--brand)] bg-brand/10 border border-brand/20 rounded-full px-2 py-0.5">21 chains</span>
              <span className="text-[10px] text-text-secondary">•</span>
              <span className="text-[10px] text-text-secondary">CCTP + UB Gateway</span>
              <span className="text-[10px] text-text-secondary">•</span>
              <span className="text-[10px] text-text-secondary">USDC only</span>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 pb-3">
        <AnimatePresence mode="wait">

          {resumingTransfer && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', margin: '10px 2px',
              borderRadius: 12, background: 'color-mix(in srgb, var(--brand) 10%, transparent)',
              border: '1px solid color-mix(in srgb, var(--brand) 25%, transparent)',
            }}>
              <div style={{
                width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                border: '2px solid color-mix(in srgb, var(--brand) 30%, transparent)', borderTopColor: 'var(--brand)',
                animation: 'spin 0.8s linear infinite',
              }} />
              <span style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>Checking your last transfer…</span>
            </div>
          )}

          {/* ── FORM ─────────────────────────────────────────────────────── */}
          {step === 'form' && (
            <motion.div key="form" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} className="space-y-2.5 pt-1">

              {/* Recipient Wallet Address — explicit label above the input */}
              <div className="rounded-2xl overflow-hidden" style={{
                background:'var(--surface)',
                border: addrHint.type === 'ok' ? '1px solid color-mix(in srgb, var(--success) 40%, transparent)' : addrHint.type === 'error' ? '1px solid color-mix(in srgb, var(--danger) 40%, transparent)' : '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)'
              }}>
                <div className="px-4 pt-3.5 pb-3">
                  <p className="text-sm mb-2.5" style={{ color: 'var(--text-secondary)' }}>Recipient Wallet Address</p>
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'color-mix(in srgb, var(--brand) 18%, transparent)' }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
                      </svg>
                    </div>
                    <input
                      className="flex-1 bg-transparent text-text-primary text-[15px] focus:outline-none font-mono placeholder-text-secondary"
                      placeholder="0x... wallet address"
                      value={address} onChange={e => handleAddressChange(e.target.value)}
                      spellCheck={false} autoComplete="off"
                    />
                    <button
                      onClick={() => navigate('/scanner?mode=wallet&returnTo=/multichain-transfer')}
                      className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                      style={{background:'color-mix(in srgb, var(--text-primary) 5%, transparent)', border:'1px solid var(--border)'}}>
                      <QrCode className="w-4 h-4 text-text-secondary"/>
                    </button>
                  </div>
                </div>
                {addrHint.text ? (
                  <div className="px-4 py-2.5 flex items-center gap-2 text-xs" style={{
                    borderTop: '1px solid color-mix(in srgb, var(--text-primary) 5%, transparent)',
                    color: addrHint.type === 'ok' ? 'var(--success)' : addrHint.type === 'error' ? 'var(--danger)' : 'var(--text-secondary)'
                  }}>
                    {addrHint.text}
                    {addrHint.type === 'ok' && <CheckCircle className="w-3 h-3 ml-auto"/>}
                  </div>
                ) : (
                  <div className="px-4 pb-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    Enter wallet address on destination chain
                  </div>
                )}
              </div>

              {/* Destination Chain — tap to open picker */}
              <button onClick={() => setShowChainPicker(true)}
                className="w-full flex items-center gap-3 p-3.5 rounded-2xl active:scale-[.98] transition-all"
                style={{background:'var(--surface)', border:'1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)'}}>
                <ChainLogoImg id={chain.id} size={38}/>
                <div className="flex-1 text-left min-w-0">
                  <p className="text-xs font-medium mb-0.5" style={{color:'var(--text-secondary)'}}>Destination Chain</p>
                  <div className="flex items-center gap-1.5">
                    <p className="text-base font-extrabold text-text-primary">{chain.name}</p>
                    <ChainSpeedBadge ub={!!chain.ub}/>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl flex-shrink-0"
                  style={{background:'color-mix(in srgb, var(--brand) 15%, transparent)', border:'1px solid color-mix(in srgb, var(--brand) 50%, transparent)'}}>
                  <span className="text-xs font-bold" style={{color:'var(--brand)'}}>Change</span>
                  <ChevronDown className="w-3 h-3" style={{color:'var(--brand)'}}/>
                </div>
              </button>

              {/* Amount — hero input with quick amounts. Divider line removed
                  between the hero and the balance row (per request); wording
                  changed from "tap to enter" to "tap to edit". */}
              <div className="rounded-2xl p-3.5 space-y-2" style={{background:'var(--surface)', border:'1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)'}}>
                {/* Mobile only — desktop's live amount input is the always-
                    open AmountKeypad card right below instead of a tap-to-
                    reveal display. */}
                {!isDesktop && (
                  <div onClick={() => setShowAmountPad(true)} style={{ cursor:'pointer', textAlign:'center', padding:'10px 0' }}>
                    <div style={{ display:'flex', alignItems:'baseline', justifyContent:'center', gap:4 }}>
                      <span style={{ fontSize:44, fontWeight:800, lineHeight:1, color: amount ? 'var(--text-primary)' : 'color-mix(in srgb, var(--text-primary) 25%, transparent)' }}>$</span>
                      <span style={{ fontSize: amount && amount.length > 5 ? 38 : 48, fontWeight:800, color:'var(--text-primary)', lineHeight:1, minWidth:'1ch', letterSpacing:'-0.5px' }}>{amount || '0'}</span>
                    </div>
                  </div>
                )}
                {isDesktop ? (
                  // Reference design: a plain bordered box holding just the
                  // amount (centered, matching the reference — Swap's own
                  // desktop box is left-aligned instead, that's specific to
                  // Swap's layout), not AmountKeypad's own elevated/shadowed
                  // card — this page already has a card of its own here.
                  <div style={{
                    position: 'relative',
                    background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 14,
                    padding: '28px 20px', minHeight: 108, display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
                  }}>
                    {/* $ pinned to a fixed left inset, not inline before the
                        input — keeps the digits truly centered in the box
                        no matter how many are typed (matches Pay's box). */}
                    <span style={{ position: 'absolute', left: 20, fontSize: 34, fontWeight: 700, color: amount ? 'var(--text-primary)' : 'var(--text-muted)', pointerEvents: 'none' }}>$</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      autoFocus
                      value={amount}
                      onChange={e => setAmount(sanitizeMultichainAmount(e.target.value))}
                      placeholder="0.00"
                      style={{
                        width: '100%', background: 'transparent', border: 'none', outline: 'none', padding: 0,
                        fontSize: 34, fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums',
                        textAlign: 'center',
                      }}
                      aria-label="Amount in USDC"
                    />
                  </div>
                ) : (
                  <AmountKeypad
                    open={showAmountPad}
                    value={amount}
                    onChange={v => setAmount(v)}
                    balance={balance}
                    token="USDC"
                    quickAmounts={[10, 20, 50, 100]}
                    // Same reserve as the inline Max button below — this sheet
                    // has its own separate Max button and was filling in the
                    // full balance too. No live fee estimate is fetched here
                    // (that only happens on Review now) — this is a static,
                    // conservative reserve just to leave enough USDC for the
                    // transaction to actually execute.
                    feeReserve={feeReserveEstimate}
                    // Removed — this page already has its own inline Max
                    // button in the balance row just below (see the comment
                    // above), so the sheet's copy was a duplicate. Dropping
                    // it also shortens the sheet enough that the amount box
                    // above stays partially visible instead of being fully
                    // covered when the keypad opens.
                    showMax={false}
                    onClose={() => setShowAmountPad(false)}
                    onDone={() => setShowAmountPad(false)}
                  />
                )}

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-success"/>
                    <span className="text-[13px]" style={{color:'var(--text-secondary)'}}>Balance: <span style={{color:'var(--success)', fontWeight:600}}>{formatAmount(balance)} USDC</span></span>
                  </div>
                  <div className="flex items-center gap-2">
                    {numAmount > 0 && numAmount < MIN_AMOUNT && (
                      <span className="text-xs font-semibold" style={{color:'var(--danger)'}}>Min $3</span>
                    )}
                    <button onClick={() => {
                        // Max never fetches or waits on a live fee estimate —
                        // that only happens once on Review now. Instead it
                        // just reserves a conservative static buffer
                        // (feeReserveEstimate) off the full balance, so
                        // there's still enough USDC left for the transaction
                        // to actually execute, without pretending to know
                        // the exact forwarder fee ahead of time.
                        const maxAmount = Math.max(0, balance - feeReserveEstimate)
                        // Floor (never round up) to 6 decimals — matches the
                        // precision the rest of this page's amount math uses
                        // (numAmount.toFixed(6) throughout) instead of
                        // dumping the raw float's full precision into the
                        // input.
                        setAmount(trimTrailingZeros((Math.floor(maxAmount * 1e6) / 1e6).toFixed(6)))
                      }}
                      className={isDesktop ? "text-sm font-bold px-4 py-2 rounded-full active:scale-95 transition-transform" : "text-xs font-bold px-3 py-1 rounded-full active:scale-95 transition-transform"}
                      style={{background:'var(--brand)', color:'#fff'}}>Max</button>
                  </div>
                </div>
              </div>


              {gasWarning && (
                <div className="flex items-start gap-2 p-3 rounded-xl" style={{background:'color-mix(in srgb, var(--warning) 8%, transparent)', border:'1px solid color-mix(in srgb, var(--warning) 25%, transparent)'}}>
                  <AlertCircle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5"/>
                  <p className="text-xs text-warning">{gasWarning}</p>
                </div>
              )}

              {/* Cancel / Continue */}
              <div className="flex gap-3 pt-1 pb-2">
                <button onClick={() => navigate('/')}
                  className="px-5 py-3.5 rounded-2xl text-sm font-semibold active:scale-[.98] transition-all"
                  style={{color:'var(--text-secondary)', background:'var(--surface)', border:'1px solid var(--border)'}}>
                  Cancel
                </button>
                <button
                  disabled={!canContinue} onClick={handleContinue}
                  className="flex-1 py-3.5 rounded-2xl text-white font-bold text-sm disabled:opacity-35 active:scale-[.98] transition-all"
                  style={{background:'var(--brand)'}}>
                  Continue
                </button>
              </div>

            </motion.div>
          )}

          {/* ── REVIEW ─────────────────────────────────────────────────── */}
          {(step === 'review' || step === 'confirm') && (
            <motion.div key="review" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-3 pt-2">

              {/* Summary hero */}
              <div className="rounded-2xl p-3.5 flex flex-col items-center gap-2 text-center"
                style={{background:'var(--surface)', border:'1px solid var(--border)'}}>
                <ChainLogoImg id={chain.id} size={38}/>
                <div>
                  <p className="text-2xl font-bold text-text-primary">{formatAmount(numAmount)} USDC</p>
                  <p className="text-sm mt-1" style={{color:'var(--text-secondary)'}}>{chain.name}</p>
                  <p className="text-xs mt-0.5 font-mono" style={{color:'var(--text-secondary)'}}>{midShortenAddress(address)}</p>
                </div>
              </div>

              {/* Fee-changed notice — shown briefly when the background poll
                  that keeps this screen's fee numbers fresh (while Review is
                  open, before the passcode sheet) detects the forwarder fee
                  moved. The numbers below already reflect the new total;
                  this is just a heads-up why. Auto-clears on its own. */}
              {feeChangedNotice && (
                <div className="rounded-xl px-3.5 py-2.5 text-xs font-medium text-center"
                  style={{background:'color-mix(in srgb, var(--warning) 12%, transparent)', border:'1px solid color-mix(in srgb, var(--warning) 30%, transparent)', color:'var(--warning)'}}>
                  {feeChangedNotice}
                </div>
              )}

              {/* Fee rows */}
              <div className="rounded-2xl overflow-hidden" style={{background:'var(--surface)', border:'1px solid var(--border)'}}>
                {feeEstimate.loading ? (
                  <div className="flex items-center gap-2 px-4 py-4 text-xs" style={{color:'var(--text-secondary)'}}>
                    <Loader2 className="w-3.5 h-3.5 animate-spin"/> Fetching fees…
                  </div>
                ) : (
                  <>
                    {[
                      ['You Send', `${formatAmount(numAmount)} USDC`, 'var(--text-primary)'],
                      // UB/Gateway doesn't bridge (no lock-and-mint) — this
                      // field holds the Gateway protocol fee there, not a
                      // bridge fee, so it needs its own label or it
                      // contradicts the "Circle Gateway" caption right below
                      // this list. CCTP keeps its original "Bridge Fee" label
                      // and value untouched.
                      ...(feeEstimate.bridgeFee > 0 ? [[chain.ub ? 'Protocol Fee' : 'Bridge Fee', `${trimTrailingZeros(feeEstimate.bridgeFee.toFixed(4))} USDC`, 'var(--warning)']] : []),
                      ...(feeEstimate.forwarderFee > 0 ? [['Forwarder Fee', `${trimTrailingZeros(feeEstimate.forwarderFee.toFixed(4))} USDC`, 'var(--warning)']] : []),
                      ['Network Gas', feeEstimate.networkFee > 0 ? `${trimTrailingZeros(feeEstimate.networkFee.toFixed(4))} USDC` : '~$0.01', 'var(--success)'],
                      ['Est. Time', '<30s', 'var(--accent)'],
                    ].map(([label, value, color], i) => (
                      <div key={label as string} className="flex justify-between items-center px-3 py-2">
                        <span className="text-sm" style={{color:'var(--text-secondary)'}}>{label}</span>
                        <span className="text-sm font-semibold" style={{color: color as string}}>{value}</span>
                      </div>
                    ))}
                    <div className="flex justify-between items-center px-3 py-2.5 mt-1"
                      style={{background:'color-mix(in srgb, var(--brand) 8%, transparent)', borderRadius: 14}}>
                      <span className="text-sm font-bold text-text-primary">Receiver Gets</span>
                      <span className="text-sm font-bold" style={{color:'var(--success)'}}>{trimTrailingZeros(feeEstimate.receiverGets.toFixed(4))} USDC</span>
                    </div>
                  </>
                )}
              </div>

              <p className="text-xs text-center px-4" style={{color:'var(--text-secondary)'}}>{chain.ub ? 'Circle Gateway · recipient receives native USDC' : 'Circle CCTP v2 · recipient receives native USDC'}</p>

              <div className="flex gap-3 pt-1">
                <button onClick={() => { resetUBTransientState(); setStep('form'); setFeeChangedNotice('') }}
                  className="px-5 py-3 rounded-xl text-sm font-semibold" style={{color:'var(--text-secondary)', background:'var(--surface)', border:'1px solid var(--border)'}}>
                  Back
                </button>
                <button
                  disabled={feeEstimate.loading}
                  onClick={() => { if (feeEstimate.loading) return; setFeeChangedNotice(''); setStep('confirm'); setPassEntry(''); setPassError('') }}
                  className="flex-1 py-3 rounded-xl text-sm font-bold text-white active:scale-[.98] transition-transform disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
                  style={{background:'var(--brand)', border: '1px solid color-mix(in srgb, black 12%, transparent)', boxShadow: feeEstimate.loading ? 'none' : 'var(--shadow-2)'}}>
                  {feeEstimate.loading ? 'Fetching fees…' : 'Confirm & Transfer'}
                </button>
              </div>
            </motion.div>
          )}



          {/* ── BROADCASTING ──────────────────────────────────────────────────── */}
          {step === 'broadcasting' && (
            <motion.div key="broadcasting" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="py-8 space-y-6">

              {/* Header */}
              <div className="text-center">
                <div className="w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: 'color-mix(in srgb, var(--brand) 15%, transparent)', border: '2px solid color-mix(in srgb, var(--brand) 30%, transparent)' }}>
                  <Loader2 className="w-10 h-10 text-[var(--brand)] animate-spin" />
                </div>
                <h2 className="text-xl font-bold text-text-primary">{chain.ub ? 'Transferring via Unified Balance' : 'Transferring via CCTP v2'}</h2>
                <p className="text-text-secondary text-sm mt-1">Arc → {chain.name}</p>
              </div>

              {/* Amount in flight */}
              <div className="rounded-xl p-3 flex justify-between items-center" style={{background:'var(--surface)', border:'1px solid var(--border)'}}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Amount Transferring</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{formatAmount(numAmount)} USDC</span>
              </div>

              {/* Journey visual — same underlying progress math as before
                  (ringPercent/ringErrored, still real elapsed-time-driven,
                  still capped at 90% of a step's slice until the actual
                  completion event flips it to done — see ringPercent's own
                  comment above, untouched). Only the VISUAL changed: a
                  continuous 0-100% climb along a path between the source
                  and destination chain icons, with per-step checkpoint
                  markers that light up exactly when that step boundary is
                  actually crossed (doneCount, not a fixed timer), plus a
                  short comet-trail behind the current position so there's
                  always visible motion during long waits (Circle
                  attestation) instead of a static number sitting still. */}
              {(() => {
                const color = ringErrored ? 'var(--danger)' : 'var(--brand)'
                // Initial paint only — the rAF loop above (see tankRafRef)
                // takes over every value below (tank levels, percent text,
                // bar width) every frame once broadcasting starts, so
                // nothing here waits for the once-a-second ticker re-render
                // any more. A stalled/errored transfer freezes both tanks
                // and the bar exactly where they are rather than draining
                // to empty, so the visual never implies funds vanished.
                const toLevel = ringPercent
                const fromLevel = ringErrored ? (100 - ringPercent) : Math.max(0, 100 - ringPercent)
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '4px 0 4px' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 14 }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                        <svg width={64} height={100} viewBox="0 0 64 100" style={{ borderRadius: 8, border: `1.5px solid ${ringErrored ? 'var(--danger)' : 'var(--border)'}`, background: 'var(--surface)', overflow: 'hidden' }}>
                          <path ref={tankFromPathRef} d={wavePath(fromLevel, 0)} fill={color} />
                        </svg>
                        <ChainLogoImg id="arc" size={28} />
                      </div>
                      <svg width={32} height={20} viewBox="0 0 32 20" style={{ flexShrink: 0, marginBottom: 34 }}>
                        <path d="M2 10 L26 10 M20 4 L28 10 L20 16" fill="none" stroke="var(--border-strong)" strokeWidth="2" />
                      </svg>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                        <svg width={64} height={100} viewBox="0 0 64 100" style={{ borderRadius: 8, border: `1.5px solid ${ringErrored ? 'var(--danger)' : 'var(--border)'}`, background: 'var(--surface)', overflow: 'hidden' }}>
                          <path ref={tankToPathRef} d={wavePath(toLevel, 0)} fill={color} />
                        </svg>
                        <ChainLogoImg id={chain.id} size={28} />
                      </div>
                    </div>

                    <div style={{ width: '100%', maxWidth: 280, marginTop: 14 }}>
                      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 6 }}>
                        <span ref={tankPercentRef} style={{ fontSize: 13, fontWeight: 500, color }}>{ringPercent}%</span>
                      </div>
                      <div style={{ height: 6, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
                        <div ref={tankBarRef} style={{ width: `${ringPercent}%`, height: '100%', background: color }} />
                      </div>
                    </div>

                    <p style={{ fontSize: 15, fontWeight: 500, margin: '14px 0 4px', color: ringErrored ? 'var(--danger)' : 'var(--text-primary)', textAlign: 'center' }}>
                      {ringErrored ? (bridgeSteps.find(s => s.status === 'error')?.message || 'Something went wrong')
                        : activeStep?.message || bridgeSteps[bridgeSteps.length - 1]?.message || 'Processing…'}
                    </p>
                  </div>
                )
              })()}

              {/* Completed legs — quiet, tap-to-view-explorer list. Stacked
                  (step name, then its hash on the line below) rather than
                  side-by-side, so a full hash has room to read clearly
                  instead of getting squeezed against the label on one line. */}
              {bridgeSteps.some(s => s.status === 'done' && s.txHash) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {bridgeSteps.filter(s => s.status === 'done' && s.txHash).map((s, i) => {
                    const href = s.name === 'mint' || s.name === 'spend' ? explorerTxUrl(chain.sdk, s.txHash!) : arcExplorerTxUrl(s.txHash!)
                    const shortTx = `${s.txHash!.slice(0, 10)}…${s.txHash!.slice(-6)}`
                    return (
                      <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12 }}>
                        <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{s.label}</span>
                        {href ? (
                          <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--brand)', fontFamily: 'monospace', textDecoration: 'none' }}>{shortTx}</a>
                        ) : (
                          <span style={{ color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{shortTx}</span>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Estimated time for active step */}
              {activeStep && estLabel && (
                <p className="text-xs text-center text-text-secondary">
                  <Clock className="w-3 h-3 inline mr-1" />
                  {activeStep.name === 'attestation' ? 'Circle attestation usually takes 20–90 seconds' : `Estimated time for this step: ${estLabel}`}
                </p>
              )}

              {/* Normal-range wait — calm/informational, not a warning. Most
                  transfers will pass through this state briefly; it should
                  never look like something is wrong. */}
              {showStepInfo && (
                <div className="flex items-start gap-2 p-3 bg-brand/10 border border-brand/20 rounded-xl">
                  <Clock className="w-4 h-4 text-brand flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs text-brand font-semibold">Still processing ({activeStepElapsed}s)</p>
                    <p className="text-xs text-brand/80 mt-0.5">{stepInfoHint}</p>
                  </div>
                </div>
              )}

              {/* Genuinely past Circle's normal window — this is the tier
                  that should read as "worth a second look," not the 45-60s
                  mark that every normal FAST transfer passes through. */}
              {showStepTimeout && (
                <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/30 rounded-xl">
                  <AlertCircle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs text-warning font-semibold">Taking longer than usual ({activeStepElapsed}s)</p>
                    <p className="text-xs text-warning/80 mt-0.5">{stepTimeoutHint}</p>
                  </div>
                </div>
              )}

              <p className="text-xs text-text-muted text-center">Do not close this screen — your funds are safe, the {chain.ub ? 'transfer' : 'bridge'} is still processing</p>
            </motion.div>
          )}

          {/* ── SUCCESS ─── full-screen flash → hero-card takeover, identical
               mechanic to MultichainClaimPage's completed-claim screen: the
               whole screen flashes brand color with a big checkmark +
               "Transfer Successful", holds briefly, then that panel shrinks
               away while the traveling checkmark bridges into the detailed
               hero card that fades in underneath. Arc is the origin here
               (sends go Arc → destination), mirroring how Claims show the
               source chain in reverse. ── */}
          {step === 'success' && (() => {
            const txHash = successInfo?.txHash || finalTxHashRef.current || ''
            const approveHash = bridgeSteps.find(s => s.name === 'approve' || s.name === 'deposit')?.txHash
            const burnHash = bridgeSteps.find(s => s.name === 'burn')?.txHash
            const sourceHash = burnHash || approveHash || ''
            const shortHash = txHash ? `${txHash.slice(0, 6)}...${txHash.slice(-4)}` : '—'
            const timeLabel = new Date().toLocaleString('en-US', {
              month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
            })
            const fmtAmount = `${formatAmount(successInfo?.sentAmount || numAmount)} USDC`
            const sourceHref = arcExplorerTxUrl(sourceHash)
            // Only build the destination-explorer link from a REAL destination
            // mint/spend hash — never from `txHash`, which for forwarder
            // transfers is the Arc-side burn/deposit hash and would produce a
            // "transaction not found" link on the destination chain's
            // explorer. Empty for every forwarder transfer (Circle's
            // Forwarding Service submits the mint with no locally-signed hash).
            const destMintHash = successInfo?.mintTxHash || ''
            const destHref = explorerTxUrl(chain.sdk, destMintHash)
            // True when the transfer genuinely succeeded but no destination tx
            // hash exists to link to — surface a one-liner instead of just
            // silently dropping the button.
            const forwarderMint = !destHref
            const sourceLabel = chain.ub ? 'View on\nArc Explorer' : 'View Burn on\nArc Explorer'
            const destLabel = chain.ub ? `View on\n${chain.name}` : `View Mint on\n${chain.name}`
            // All fee components (bridge/protocol fee + forwarder fee +
            // network gas) rolled into one number — successInfo.totalFees
            // is set from feeEstimate.totalFee at the moment this transfer
            // actually completed, so it reflects what was really charged,
            // not a live re-estimate that could've since drifted.
            const totalFeesLabel = `${trimTrailingZeros((successInfo?.totalFees ?? feeEstimate.totalFee).toFixed(4))} USDC`
            // Process checklist — the actual bridge steps this transfer
            // went through (approve → burn → attestation → mint for CCTP
            // chains, or the 2-step Gateway path for ub chains), all
            // rendered as already-done since this only ever mounts after
            // the transfer has actually succeeded.
            const processSteps = bridgeSteps

            return (
            <motion.div key="done-step" style={{ position: 'relative' }}>
              {/* Full-screen flash */}
              {successPhase === 'flash' && createPortal(
                // Portalled straight to <body> — same fix as Swap/Send/
                // Claim's identical flash overlay: PageTransition's
                // motion.div (wraps every route, desktop included) leaves a
                // non-`none` transform on itself from animating `y`, making
                // it the containing block for any `position: fixed`
                // descendant instead of the real viewport. Desktop's
                // Multichain Send flow also sits inside its own extra
                // scrollable column below, so without this the overlay
                // could render sized/positioned to that scrolled box
                // instead of the screen.
                <div style={{
                  position: 'fixed',
                  ...(isDesktop && flashColumnRect
                    ? { top: flashColumnRect.top, left: flashColumnRect.left, width: flashColumnRect.width, height: flashColumnRect.height, borderRadius: 20 }
                    : { inset: 0 }),
                  zIndex: 999, background: 'var(--brand)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                }}>
                  <motion.div ref={flashCheckRef} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.1, type: 'spring', stiffness: 220, damping: 16 }}
                    onAnimationComplete={() => setFlashCircleReady(true)}
                    className="rounded-full flex items-center justify-center" style={{ width: 82.08, height: 82.08, background: '#fff', marginBottom: 20 }}>
                    {paidViaBiometric ? (
                      <FlashAuthIcon viaBiometric start={flashCircleReady} size={37.62} color="var(--brand)" />
                    ) : (
                      <motion.svg width={37.62} height={37.62} viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                        <motion.polyline points="20 6 9 17 4 12" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.5, delay: 0.25 }} />
                      </motion.svg>
                    )}
                  </motion.div>
                  <p style={{ fontSize: 22, fontWeight: 700, color: '#fff', margin: 0 }}>Transfer Successful</p>
                </div>,
                document.body
              )}

              {travelRect && !travelDone && (
                <TravelingCheckmark from={travelRect.from} to={travelRect.to} />
              )}

              {successPhase === 'collapsed' && (
              <div style={{ margin: '0 -12px', transform: isDesktop ? 'scale(0.9)' : undefined, transformOrigin: 'top center' }}>
                {/* Hidden SVG def: smooth elliptical-arc clip path for the
                    hero's scalloped bottom border — same curve Claim's own
                    hero card uses. */}
                <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
                  <defs>
                    <clipPath id="transferHeroBottomClip" clipPathUnits="objectBoundingBox">
                      <path d="M0,0 L1,0 L1,0.75 L0.826,0.75 C0.805,0.75 0.805,0.859 0.755,0.859 L0.245,0.859 C0.195,0.859 0.195,0.75 0.174,0.75 L0,0.75 Z" />
                    </clipPath>
                  </defs>
                </svg>

                {/* ─── Hero: back + title, success badge, Delivered, amount, network, completion pill ─── */}
                <div style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                  background: 'var(--brand)',
                  paddingTop: 'calc(env(safe-area-inset-top, 0px) + clamp(10.6px, 2.34vh, 17.5px))', paddingBottom: 'clamp(34px, 6.15vh, 48.8px)',
                  paddingLeft: 'clamp(16px, 4.78vw, 21.2px)', paddingRight: 'clamp(16px, 4.78vw, 21.2px)',
                  clipPath: 'url(#transferHeroBottomClip)',
                }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '44px 1fr 44px', alignItems: 'center', width: '100%', marginBottom: 'clamp(2px, 1vh, 10px)' }}>
                    {!isDesktop ? (
                      <button onClick={() => navigate('/')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: '#FFFFFF', display: 'flex', justifySelf: 'start' }}>
                        <ArrowLeft style={{ width: 24, height: 24 }} />
                      </button>
                    ) : <span />}
                    <h1 style={{ fontSize: 'clamp(16.5px, 4.8vw, 22px)', fontWeight: 700, color: '#FFFFFF', textAlign: 'center', margin: 0 }}>Transfer Successful!</h1>
                    <span />
                  </div>

                  <div ref={heroCheckRef} style={{ position: 'relative', width: 'clamp(51px, 13.3vw, 60px)', height: 'clamp(51px, 13.3vw, 60px)', borderRadius: '50%', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, margin: 'clamp(2px, 0.8vh, 8px) 0', opacity: travelDone ? 1 : 0 }}>
                    <TransferSparkle size={11} style={{ top: '4%', left: '-40%' }} />
                    <TransferSparkle size={7} style={{ top: '70%', left: '-32%' }} />
                    <TransferSparkle size={11} style={{ top: '2%', right: '-42%' }} />
                    <TransferSparkle size={7} style={{ top: '68%', right: '-30%' }} />
                    {paidViaBiometric && travelDone ? (
                      <FlashAuthIcon key="landing-toggle" viaBiometric loop size={25} color="var(--brand)" />
                    ) : (
                      <svg viewBox="0 0 24 24" width="46%" height="46%" fill="none" stroke="var(--brand)" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </div>

                  <motion.div initial={false} animate={travelDone ? { opacity: 1, y: 0 } : { opacity: 0, y: -14 }} transition={{ duration: 0.4, delay: travelDone ? 0.1 : 0, ease: [0.2, 0.8, 0.2, 1] }}
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 'clamp(3.2px, 0.958vh, 10.6px)', paddingBottom: 'clamp(3.2px, 0.958vh, 10.6px)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8.4, color: 'rgba(255,255,255,0.92)' }}>
                      <ArrowUpFromLine style={{ width: 20.2, height: 20.2 }} />
                      <span style={{ fontSize: 'clamp(14.3px, 4.09vw, 16.5px)', fontWeight: 600 }}>Delivered</span>
                    </div>

                    <p style={{ fontSize: 'clamp(26.6px, 8.17vw, 36.1px)', fontWeight: 800, color: '#FFFFFF', margin: 'clamp(6.4px, 1.28vh, 11.6px) 0 0', lineHeight: 1 }}>{fmtAmount}</p>

                    <p style={{ fontSize: 'clamp(13.8px, 3.82vw, 16.5px)', color: 'rgba(255,255,255,0.75)', margin: 'clamp(5.4px,1.06vh,10.6px) 0 0', textAlign: 'center', lineHeight: 1.35 }}>
                      has been delivered to the<br/>recipient on {chain.name}.
                    </p>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 7.4, background: 'rgba(255,255,255,0.14)', padding: 'clamp(4.78px,1.06vh,5.84px) clamp(9.55px,2.54vw,12.2px)', borderRadius: 999, marginTop: 'clamp(8.4px,1.6vh,13.8px)' }}>
                      <Zap style={{ width: 14.8, height: 14.8, color: '#FFD54A' }} fill="#FFD54A" />
                      <span style={{ fontSize: 'clamp(11.1px, 2.91vw, 12.8px)', fontWeight: 600, color: '#FFFFFF' }}>Completed in {transferElapsedSeconds} Seconds</span>
                    </div>
                  </motion.div>
                </div>

                {/* ─── Transaction details card followed by success actions. Details expand naturally; actions remain in normal flow. ─── */}
                <motion.div initial={false} animate={travelDone ? { opacity: 1, y: 0 } : { opacity: 0, y: -14 }} transition={{ duration: 0.4, delay: travelDone ? 0.2 : 0, ease: [0.2, 0.8, 0.2, 1] }}
                  style={{ paddingLeft: 'clamp(17px, 4.78vw, 21.2px)', paddingRight: 'clamp(17px, 4.78vw, 21.2px)', marginTop: 'calc(-1 * clamp(34px, 6.15vh, 48.8px) + 17px)' }}>

                  <div className="shadow-elevation-1" style={{
                    background: 'var(--surface)', border: '1px solid var(--border)',
                    borderTopLeftRadius: 'clamp(17px, 4.24vw, 21.2px)', borderTopRightRadius: 'clamp(17px, 4.24vw, 21.2px)',
                    borderBottomLeftRadius: 'clamp(14.8px, 3.82vw, 19.1px)', borderBottomRightRadius: 'clamp(14.8px, 3.82vw, 19.1px)',
                    padding: '0 clamp(14.8px, 3.82vw, 19.1px)', marginBottom: 'clamp(14.8px, 3.18vh, 21.2px)',
                  }}>
                    <TransferDetailRow icon={<FileText className="w-4 h-4" />} label="Transaction Hash" value={shortHash} mono onCopy={txHash ? () => copyTransferHash(txHash) : undefined} copied={hashCopied} showDivider />
                    <TransferDetailRow icon={<Globe className="w-4 h-4" />} label="From" value="Arc Testnet" showDivider />
                    <TransferDetailRow icon={<ChainLogoImg id={chain.id} size={21.2} />} label="To" value={chain.name} showDivider />
                    <TransferDetailRow icon={<Clock className="w-4 h-4" />} label="Time" value={timeLabel} showDivider last />

                    {/* Expandable "Process" checklist — total fees charged
                        (all fee components rolled into one figure) plus the
                        actual bridge steps this transfer went through,
                        shown as already-completed steps. */}
                    <AnimatePresence initial={false}>
                      {showProcessDetails && (
                        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }} style={{ overflow: 'hidden' }}>
                          <div style={{ borderTop: '1px solid var(--border)' }}>
                            <TransferDetailRow icon={<Receipt className="w-4 h-4" />} label="Total Fees" value={totalFeesLabel} />
                          </div>
                          <div style={{ paddingTop: 'clamp(10.6px, 2.34vh, 14.8px)', paddingBottom: 'clamp(9.6px, 2.12vh, 13.3px)', borderTop: '1px solid var(--border)' }}>
                            <p style={{ fontSize: 'clamp(11.6px, 3.18vw, 12.8px)', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.4, margin: '0 0 clamp(8.4px, 1.8vh, 11.6px)' }}>Process</p>
                            {processSteps.map((s, i) => (
                              <TransferProcessStep key={s.name} text={<>{s.label}</>} last={i === processSteps.length - 1} />
                            ))}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    <button onClick={() => setShowProcessDetails(v => !v)}
                      style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6.4, background: 'none', border: 'none', cursor: 'pointer', padding: 'clamp(8.4px, 1.8vh, 10.6px) 0', borderTop: showProcessDetails ? '1px solid var(--border)' : 'none' }}>
                      <span style={{ fontSize: 'clamp(12.8px, 3.4vw, 13.8px)', fontWeight: 600, color: 'var(--text-primary)' }}>{showProcessDetails ? 'Hide details' : 'More details'}</span>
                      <ChevronDown className="w-4 h-4" style={{ color: 'var(--text-secondary)', transform: showProcessDetails ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease' }} />
                    </button>
                  </div>

                  {/* ─── Success actions + explorer links ─── */}
                  <div style={{ position: 'relative', background: 'var(--bg)', paddingBottom: 'calc(env(safe-area-inset-bottom, 12px) + clamp(14.8px, 3.18vh, 21.2px))' }}>
                    {/* Source (burn/deposit on Arc) + destination (mint/spend
                        on the chosen chain) explorer links, each rendered as
                        a circular icon button matching Claim's own
                        explorer-link style. */}
                    {(sourceHref || destHref) && (
                      <div style={{ display: 'flex', justifyContent: 'center', gap: 'clamp(42.4px, 14.8vw, 72.1px)', paddingTop: 'clamp(14.8px, 3.18vh, 21.2px)', marginBottom: 'clamp(12.8px, 2.54vh, 19.1px)' }}>
                        {sourceHref && (
                          <a href={sourceHref} target="_blank" rel="noopener noreferrer"
                            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6.4, textDecoration: 'none' }}>
                            <span style={{ width: 'clamp(42.4px, 11.6vw, 48.8px)', height: 'clamp(42.4px, 11.6vw, 48.8px)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--brand)' }}>
                              <ExternalLink className="w-4 h-4" />
                            </span>
                            <span style={{ fontSize: 'clamp(11.6px, 3.08vw, 12.8px)', color: 'var(--text-primary)', textAlign: 'center', lineHeight: 1.3 }}>{sourceLabel.split('\n').map((l, i) => <React.Fragment key={i}>{i > 0 && <br />}{l}</React.Fragment>)}</span>
                          </a>
                        )}
                        {destHref && (
                          <a href={destHref} target="_blank" rel="noopener noreferrer"
                            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6.4, textDecoration: 'none' }}>
                            <span style={{ width: 'clamp(42.4px, 11.6vw, 48.8px)', height: 'clamp(42.4px, 11.6vw, 48.8px)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--brand)' }}>
                              <ExternalLink className="w-4 h-4" />
                            </span>
                            <span style={{ fontSize: 'clamp(11.6px, 3.08vw, 12.8px)', color: 'var(--text-primary)', textAlign: 'center', lineHeight: 1.3 }}>{destLabel.split('\n').map((l, i) => <React.Fragment key={i}>{i > 0 && <br />}{l}</React.Fragment>)}</span>
                          </a>
                        )}
                      </div>
                    )}

                    {/* Forwarder transfers have no destination-side tx hash to
                        link to (Circle's Forwarding Service submits the mint).
                        Say so plainly instead of leaving a lone Arc button
                        looking like something is missing. */}
                    {forwarderMint && sourceHref && (
                      <p style={{ fontSize: 'clamp(10.6px, 2.9vw, 11.6px)', color: 'var(--text-muted)', textAlign: 'center', margin: '0 0 clamp(12.8px, 2.54vh, 19.1px)', paddingLeft: 24, paddingRight: 24, lineHeight: 1.4 }}>
                        {formatAmount(successInfo?.receiverGets || 0)} USDC was delivered on {chain.name} by Circle's Forwarding Service — there's no separate destination transaction hash to view.
                      </p>
                    )}

                    {/* View in Hub / Back to Home */}
                    <div style={{ display: 'flex', gap: 'clamp(8.4px, 2.76vw, 12.8px)', width: '100%', maxWidth: isDesktop ? 560 : 'none', margin: '0 auto', boxSizing: 'border-box' }}>
                      <button onClick={() => navigate('/multichain')}
                        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7.4, height: 'clamp(44.6px, 11.6vw, 50.9px)', borderRadius: 14.8, border: '1.5px solid var(--brand)', background: 'transparent', color: 'var(--brand)', fontSize: 'clamp(13.8px, 3.6vw, 14.8px)', fontWeight: 700, cursor: 'pointer' }}>
                        <RotateCcw className="w-4 h-4" /> View in Hub
                      </button>
                      <button onClick={() => navigate('/')}
                        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7.4, height: 'clamp(44.6px, 11.6vw, 50.9px)', borderRadius: 14.8, border: '1px solid color-mix(in srgb, black 12%, transparent)', background: 'var(--brand)', color: '#FFFFFF', fontSize: 'clamp(13.8px, 3.6vw, 14.8px)', fontWeight: 700, cursor: 'pointer' }}>
                        <Home className="w-4 h-4" /> Back to Home
                      </button>
                    </div>
                  </div>
                </motion.div>
              </div>
              )}
            </motion.div>
            )
          })()}

          {/* ── FAILED ────────────────────────────────────────────────────────── */}
          {step === 'failed' && (() => {
            // Circle's Forwarder relayer service failing to submit the mint is
            // a distinct failure mode from approve/burn failing outright: the
            // burn has ALREADY happened at that point, funds are already gone
            // from Arc, and the mint may still land on its own (another party
            // can submit it with the attestation Circle already signed).
            // A blind "Try Again" here restarts the WHOLE flow — a fresh
            // approve + burn + attestation + mint — while the original burn's
            // mint could still complete independently, risking an unwanted
            // double-burn. Steer the user to check their destination balance
            // first, matching what Circle's own error text already says.
            // Text-based detection alone misses a real case: if kit.bridge()
            // THROWS (rejects) instead of resolving with a {state:'error'}
            // result — e.g. an exception while polling for attestation after
            // burn already succeeded — this never gets the chance to match
            // 'relayer failed to forward' text, because that phrasing only
            // ever appears in a resolved error result, not a thrown one. But
            // bridgeSteps (updated live via kit.on('bridge.burn', ...))
            // already reflects the true on-chain state regardless of how the
            // failure surfaced. If burn is marked 'done' here, the USDC was
            // actually burned on Arc — funds DID leave the wallet — so
            //
            // UB FIX: this was checking `s.name === 'burn'` unconditionally —
            // a CCTP-only step name (see STEP_DEFS above). The UB flow's
            // equivalent completed-source-side-action step is named
            // 'deposit' (see UB_STEP_DEFS), which never matches 'burn'. That
            // meant this check could NEVER fire on the UB path: if the
            // deposit step succeeded and the spend/forwarder step then
            // failed — exactly what a "Forwarder transfer failed:
            // ON_CHAIN_FAILURE" error means — the page still said "No funds
            // were moved," even though the deposit had already moved USDC
            // out of the wallet and into the Unified Balance. Branch on
            // chain.ub so each flow checks its own step name, and recognize
            // the UB forwarder's own failure text alongside CCTP's.
            // burnTxHashRef is the authoritative signal here: it's set from
            // the real `bridge.burn` event / resolved burn step, so it stays
            // correct even when kit.bridge() threw (timeout, RPC blip, a
            // later step erroring) before the auto-advance timer flipped the
            // burn checklist row to 'done' — the case where this screen used
            // to wrongly say "No funds were moved".
            const burnAlreadyDone = !!burnTxHashRef.current
              || bridgeSteps.some(s => s.name === 'burn' && s.status === 'done')
            const depositAlreadyDone = !!ubDepositedAmountRef.current
              || bridgeSteps.some(s => s.name === 'deposit' && s.status === 'done')
            const sourceActionAlreadyDone = chain.ub ? depositAlreadyDone : burnAlreadyDone
            // "Transfer spec has already been used" — Gateway's way of saying
            // this exact spend request was already accepted and processed
            // once before. Seen in practice on slow/flaky connections: the
            // first kit.unifiedBalance.spend() call actually reaches Gateway
            // and succeeds, but the response never makes it back to the
            // client (timeout, dropped connection), so it looks like a plain
            // failure here — a resubmission of the same request then gets
            // correctly rejected as a duplicate. The transfer itself already
            // went through; only this particular network round-trip failed.
            const mintMayHaveSucceeded = sourceActionAlreadyDone
              || /relayer failed to forward|mint may still have succeeded|forwarder transfer failed|already been used|transfer spec/i.test(txError)
            return (
            <motion.div key="failed" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} className="text-center py-8 space-y-5">
              <div className="w-24 h-24 bg-danger/20 rounded-full flex items-center justify-center mx-auto"><XCircle className="w-14 h-14 text-danger" /></div>
              <div>
                <h2 className="text-2xl font-bold text-text-primary">
                  {chain.ub
                    ? (mintMayHaveSucceeded ? 'Transfer Status Unclear' : 'Transfer Failed')
                    : (mintMayHaveSucceeded ? 'Bridge Status Unclear' : 'Bridge Failed')}
                </h2>
                <p className="text-text-secondary mt-1 text-sm">{mintMayHaveSucceeded ? 'Your funds may have already arrived' : 'No funds were moved'}</p>
              </div>

              {/* Show which step failed */}
              {bridgeSteps.some(s => s.status === 'error') && (
                <div className="space-y-1.5">
                  {bridgeSteps.map((s, i) => s.status !== 'pending' && (
                    <div key={i} className={`flex items-center gap-2 px-3 py-2 rounded-2xl text-sm ${s.status === 'done' ? 'text-success' : s.status === 'error' ? 'text-danger bg-danger/5 border border-danger/20' : 'text-text-secondary'}`}>
                      {s.status === 'done' ? <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" /> : s.status === 'error' ? <XCircle className="w-3.5 h-3.5 flex-shrink-0" /> : null}
                      {s.label}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-start gap-3 p-4 bg-danger/10 border border-danger/30 rounded-xl text-left">
                <AlertCircle className="w-5 h-5 text-danger flex-shrink-0 mt-0.5" />
                <p className="text-sm text-text-secondary">{txError || 'Unknown error occurred'}</p>
              </div>

              {/* UB only: initiateUBRecovery already started the moment this
                  failure was caught (see the outer catch block above) — this
                  is Circle's trustless removeFund() escape hatch, not a
                  "someone will look into it" promise. Shown as its own,
                  reassuring block distinct from the generic error box above,
                  since "your funds are safe and coming back" is the single
                  most important thing to land here, not buried next to a
                  raw error string. */}
              {chain.ub && ubRecoveryInitiated && (
                <div className="flex items-start gap-3 p-4 bg-success/10 border border-success/30 rounded-xl text-left">
                  <CheckCircle className="w-5 h-5 text-success flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold text-success">Your funds are safe</p>
                    <p className="text-xs text-text-secondary mt-1">
                      This amount is being automatically credited back to your Arc wallet balance —
                      no action needed. This can take up to 7 days; check Activity for progress.
                    </p>
                  </div>
                </div>
              )}

              {/* Circle's SDK labels "RPC endpoint error on <chain>" using
                  whichever chain's step was active, NOT necessarily the
                  chain whose RPC actually failed — verified directly
                  against @circle-fin/app-kit source. A burn-step failure
                  can be caused by the destination chain's RPC being
                  unreachable, not Arc's. Worth knowing before assuming
                  Arc itself is the problem. */}
              {/RPC endpoint error/i.test(txError) && (
                <p className="text-xs text-text-secondary text-left px-1">
                  This message names the step that was running, not necessarily which
                  network's RPC failed — it can point to the destination chain too.
                  Check your browser console's Network tab for the actual failing request
                  if this keeps happening.
                </p>
              )}

              {mintMayHaveSucceeded ? (
                <>
                  <button onClick={() => navigate('/activity?filter=bridge')}
                    style={{ width: '100%', padding: '14px 0', borderRadius: 14, border: 'none', fontSize: 15, fontWeight: 700, color: '#FFFFFF', background: 'var(--brand)', cursor: 'pointer' }}>
                    Check Balance First
                  </button>
                  {chain.ub && ubRecoveryInitiated ? (
                    <button onClick={() => navigate('/activity?filter=bridge')}
                      className="w-full py-3 rounded-xl bg-transparent border border-border text-text-secondary font-medium text-sm">
                      View Recovery Status
                    </button>
                  ) : (
                    <button onClick={() => { setStep('confirm'); setPassEntry(''); setPassError('') }}
                      className="w-full py-3 rounded-xl bg-transparent border border-border text-text-secondary font-medium text-sm">
                      {chain.ub && depositAlreadyDone
                        ? 'Resume send (won’t deposit again)'
                        : 'Retry anyway (may double-send)'}
                    </button>
                  )}
                </>
              ) : (
                <button onClick={() => { setStep('confirm'); setPassEntry(''); setPassError('') }} className="w-full py-3.5 rounded-xl bg-brand text-text-primary font-semibold shadow-elevation-2">Try Again</button>
              )}
            </motion.div>
            )
          })()}

        </AnimatePresence>
      </div>

      {/* ── Confirm & Pay: clean passcode entry, matching the same bottom
          sheet pattern used in Send/Pay — drag handle, title, one subtitle
          line, then PinKeypad directly. No summary card or fee breakdown
          here; that's all already shown on the Review page underneath. ── */}
      <AnimatePresence>
      {step === 'confirm' && (() => {
        const closeSheet = () => { setStep('review'); setPassEntry(''); setPassError('') }
        const keypadContent = (
          <PinKeypad
            value={passEntry}
            onChange={v => { setPassEntry(v); setPassError('') }}
            length={6}
            error={!!passError}
            onComplete={(_, viaBiometric) => { if (!loading) { setPaidViaBiometric(!!viaBiometric); handleConfirm() } }}
          />
        )
        const passContent = (
          <>
            <div className="text-center mb-7">
              <h2 className="text-lg font-bold text-text-primary">Enter Passcode</h2>
              <p className="text-xs mt-1.5" style={{ color: 'var(--text-secondary)' }}>
                {passError
                  ? <span className="text-danger">{passError}</span>
                  : `Authorise $${formatAmount(numAmount)} USDC to ${chain.name}`}
              </p>
            </div>
            {keypadContent}
          </>
        )
        return isDesktop ? (
          <DesktopTransactionAuthDialog
            onClose={closeSheet}
            title="Authorize Transfer"
            amountLabel={`$${formatAmount(numAmount)} USDC`}
            subLabel={`To ${chain.name}`}
          >
            {passError && <p className="text-xs text-center mb-4" style={{ color: 'var(--danger)' }}>{passError}</p>}
            {keypadContent}
          </DesktopTransactionAuthDialog>
        ) : (
          <>
            <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }}
              className="absolute inset-0 z-50" style={{background:'rgba(0,0,0,0.6)'}}
              onClick={() => { setStep('review'); setPassEntry(''); setPassError('') }} />
            <motion.div
              initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 32, stiffness: 320 }}
              className="absolute bottom-0 left-0 right-0 z-50 rounded-t-3xl pt-3 pb-10 px-6"
              style={{ background: 'var(--surface)', borderTop: '1px solid var(--border)' }}>
              <div className="w-10 h-1 rounded-full mx-auto mb-6" style={{ background: 'color-mix(in srgb, var(--text-primary) 18%, transparent)' }} />
              {passContent}
            </motion.div>
          </>
        )
      })()}
      </AnimatePresence>

      {/* ── Chain Picker Sheet / Dialog ── */}
      <AnimatePresence>
      {showChainPicker && (() => {
        const chainHeader = (
          <div className="flex items-center justify-between px-5 py-4" style={{borderBottom:'1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)'}}>
            <p className="text-base font-bold text-text-primary">Select Chain</p>
            <button onClick={() => setShowChainPicker(false)}
              className="w-8 h-8 rounded-full flex items-center justify-center"
              style={{background:'color-mix(in srgb, var(--text-primary) 6%, transparent)'}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2.5" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12"/>
              </svg>
            </button>
          </div>
        )
        const chainList = (
          <div className="overflow-y-auto" style={{maxHeight: isDesktop ? '60vh' : '60vh'}}>
            {ENABLED_CHAINS.map((ch, i) => {
              const isSelected = selectedChain === ch.id
              return (
                <button key={ch.id}
                  onClick={() => {
                    setSelectedChain(ch.id as ChainId)
                    if (address) handleAddressChange(address)
                    setShowChainPicker(false)
                  }}
                  className="w-full flex items-center gap-3 px-5 py-3.5 active:opacity-70 transition-all"
                  style={{
                    borderTop: i > 0 ? '1px solid color-mix(in srgb, var(--text-primary) 4%, transparent)' : 'none',
                    background: isSelected ? 'color-mix(in srgb, var(--brand) 10%, transparent)' : 'transparent',
                  }}>
                  <ChainLogoImg id={ch.id} size={38}/>
                  <div className="flex-1 text-left min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-semibold text-text-primary">{ch.name}</p>
                      <ChainSpeedBadge ub={!!ch.ub}/>
                    </div>
                    <p className="text-xs mt-0.5" style={{color:'var(--text-secondary)'}}>{ch.time} · {ch.gasToken}</p>
                  </div>
                  {isSelected && (
                    <div className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0"
                      style={{ background: 'var(--brand)' }}
                      >
                      <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
                        <path d="M1 3.5l2.5 2.5 4.5-5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        )

        return isDesktop ? (
          <DesktopDialogFrame onClose={() => setShowChainPicker(false)} maxWidth={440}>
            {chainHeader}
            {chainList}
          </DesktopDialogFrame>
        ) : (
          <motion.div key="chain-picker" initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }}
            className="absolute inset-0 z-50 flex items-end justify-center"
            style={{background:'rgba(0,0,0,0.6)'}}
            onClick={() => setShowChainPicker(false)}>
            <motion.div initial={{ y:80, opacity:0 }} animate={{ y:0, opacity:1 }} exit={{ y:80, opacity:0 }}
              className="w-full max-w-md rounded-t-3xl pb-safe overflow-hidden"
              style={{background:'var(--surface)', border:'1px solid var(--border)', maxHeight:'80vh'}}
              onClick={e => e.stopPropagation()}>
              {chainHeader}
              {chainList}
            </motion.div>
          </motion.div>
        )
      })()}
      </AnimatePresence>
    </div>
  )

  if (!isDesktop) return flow

  // ── Desktop: flow (left) + Transfer History (right), independently scrollable ──
  return (
    // Fills the full available content width (no maxWidth cap — the row
    // stretches edge to edge minus the outer padding) at a fixed 65/35
    // grow split, per explicit sizing direction. Bottom padding trimmed
    // so the row — and DesktopHistoryPanel's own height:100% column
    // inside it — reaches down close to the viewport's bottom edge
    // instead of leaving a gap under it.
    <div style={{ display: 'flex', height: '100%', minHeight: 0, gap: 28, padding: '20px 24px 14px', boxSizing: 'border-box' }}>
      <div style={{ flex: '65 1 0%', minWidth: 0, minHeight: 0, overflowY: 'auto' }} ref={desktopColumnRef}>{flow}</div>
      <div style={{ flex: '35 1 0%', minWidth: 0, minHeight: 0 }}>
        <DesktopHistoryPanel title="Recent History" onViewAll={() => navigate('/multichain')}>
          {!transferHistoryLoaded ? (
            <DesktopHistorySkeleton />
          ) : transferHistory.length === 0 ? (
            <DesktopHistoryEmpty label="Transfers you send across chains will show up here" />
          ) : (
            transferHistory.map((r, i) => {
              const failed = r.status === 'failed'
              const chainLabel = (r.destinationChain || 'Unknown chain').replace(/_/g, ' ')
              return (
                <div key={r.id} onClick={() => setTransferHistDetail(r)} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', cursor: 'pointer',
                  borderTop: i > 0 ? '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' : 'none',
                }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                    background: failed ? 'color-mix(in srgb, var(--danger) 12%, transparent)' : 'color-mix(in srgb, var(--brand) 12%, transparent)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                      <path d="M2 12L12 2M12 2H6M12 2V8" stroke={failed ? 'var(--danger)' : 'var(--brand)'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      To {chainLabel}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 1 }}>
                      {failed ? <span style={{ color: 'var(--danger)' }}>Failed</span> : <>{timeAgo(r.createdAt)}</>}
                    </div>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: failed ? 'var(--danger)' : 'var(--text-primary)', flexShrink: 0 }}>
                    -{formatAmount(r.amount)} {r.tokenSymbol}
                  </div>
                </div>
              )
            })
          )}
        </DesktopHistoryPanel>
      </div>
      <AnimatePresence>
        {transferHistDetail && (() => {
          const r = transferHistDetail
          const failed = r.status === 'failed'
          const chainLabel = (r.destinationChain || 'Unknown chain').replace(/_/g, ' ')
          return (
            <DesktopHistoryDetail
              onClose={() => setTransferHistDetail(null)}
              title="Transfer Details"
              icon={<svg width="20" height="20" viewBox="0 0 14 14" fill="none"><path d="M2 12L12 2M12 2H6M12 2V8" stroke={failed ? 'var(--danger)' : 'var(--brand)'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
              iconColor={failed ? 'var(--danger)' : 'var(--brand)'}
              amountLabel={`-${formatAmount(r.amount)} ${r.tokenSymbol}`}
              amountColor={failed ? 'var(--danger)' : 'var(--text-primary)'}
              rows={[
                { label: 'To', value: chainLabel },
                { label: 'Time', value: timeAgo(r.createdAt) },
                { label: 'Status', value: failed ? 'Failed' : 'Completed' },
                ...(r.txHash ? [{ label: 'Tx Hash', value: `${r.txHash.slice(0, 8)}…${r.txHash.slice(-6)}` }] : []),
              ]}
              explorerLinks={r.txHash ? [{ label: 'View on Arc Explorer', href: `${ARC_EXPLORER}/tx/${r.txHash}` }] : undefined}
            />
          )
        })()}
      </AnimatePresence>
    </div>
  )
}
