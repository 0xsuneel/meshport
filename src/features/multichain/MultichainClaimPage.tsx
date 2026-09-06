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
import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, type ReactNode, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom'
import { fetchActivity, type ActivityRecord } from '@/lib/ActivityService'
import { backgroundBridge, buildClaimDestTarget, cctpSpeedForSource } from '@/lib/backgroundBridge'
import { notifyClaimArrived, requestPushPermission } from '@/lib/bridgeTracker'
import {
  ArrowLeft, RefreshCw, XCircle, Globe, ArrowDownToLine, Check, Copy, Zap, FileText, Receipt,
  ChevronDown, ExternalLink, Clock, Home, RotateCcw, Activity as ActivityIcon, Fuel,
} from 'lucide-react'
import { PinKeypad } from '@/components/ui/PinKeypad'
import { AmountKeypad } from '@/components/ui/AmountKeypad'
import { TravelingCheckmark } from '@/components/ui/TravelingCheckmark'
import { FlashAuthIcon } from '@/components/ui/FlashAuthIcon'
import { motion, AnimatePresence } from 'framer-motion'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'
import { DesktopTransactionAuthDialog } from '@/components/ui/DesktopTransactionAuthDialog'
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
import { useSettingsStore } from '@/store/settingsStore'
import { isChainEnabledForClaim } from '@/lib/featureFilters'
import { readExternalBalances } from '@/blockchain/BlockchainManager'
import { ARC_RPCS } from '@/lib/arc'
import { RPC_BY_CHAIN_NAME as BASE_RPC_BY_CHAIN_NAME } from '@/lib/chainRpcs'

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

// Native gas token per chain, mapped to its mainnet CoinGecko id for live
// USD pricing — every chain above is a TESTNET (Sepolia/Fuji/testnet
// suffix), so its own gas token has no real market price. Using the
// corresponding MAINNET token's live price is the standard way to express
// "what this would actually cost" for a testnet gas figure — the same
// approach block explorers use for testnet gas-price widgets. Chains with
// no meaningful mainnet-equivalent price yet (no mainnet token launched,
// or ticker too new/ambiguous to map confidently) are left out entirely —
// their gas just doesn't count toward the USD total rather than risk a
// wrong or invented number.
const NATIVE_GAS_COINGECKO_ID: Record<string, string> = {
  Ethereum_Sepolia:    'ethereum',
  Base_Sepolia:        'ethereum',       // Base gas token is ETH
  Arbitrum_Sepolia:    'ethereum',       // Arbitrum gas token is ETH
  Optimism_Sepolia:    'ethereum',       // OP gas token is ETH
  Polygon_Sepolia:     'matic-network',
  Avalanche_Fuji:      'avalanche-2',
  Unichain_Sepolia:    'ethereum',       // Unichain gas token is ETH
  World_Chain_Sepolia: 'ethereum',       // World Chain gas token is ETH
  Linea_Sepolia:       'ethereum',       // Linea gas token is ETH
  Ink_Testnet:         'ethereum',       // Ink gas token is ETH
  Morph_Testnet:       'ethereum',       // Morph gas token is ETH
  Sei_Testnet:         'sei-network',
  XDC_Apothem:         'xdce-crowd-sale',
  Injective_Testnet:   'injective-protocol',
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

// ── Success-screen building blocks (mirrors SwapPage's own success screen
// exactly — same sparkle glyph, same row/step components, same flash→hero
// travel mechanic) so a completed claim looks and behaves just like a
// completed swap ───────────────────────────────────────────────────────────
const CLAIM_SPARKLE_PATH = 'M12 0 L14.2 9.8 L24 12 L14.2 14.2 L12 24 L9.8 14.2 L0 12 L9.8 9.8 Z'
function ClaimSparkle({ size, style }: { size: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ position: 'absolute', ...style }}>
      <path d={CLAIM_SPARKLE_PATH} fill="rgba(255,255,255,0.55)" />
    </svg>
  )
}

// One row of the Transaction details card (icon-in-circle + label on the
// left, value on the right), with an optional copy button and an optional
// bottom divider for every row but the last.
function ClaimDetailRow({ icon, label, value, mono, onCopy, copied, showDivider, last }: {
  icon: ReactNode; label: string; value: ReactNode; mono?: boolean
  onCopy?: () => void; copied?: boolean; showDivider?: boolean; last?: boolean
}) {
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 9,
        paddingTop: 'clamp(8.1px, 1.71vh, 10.8px)',
        paddingBottom: last ? 'clamp(7.3px, 1.54vh, 9.7px)' : 'clamp(8.1px, 1.71vh, 10.8px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'clamp(9px, 2.34vw, 11.7px)', minWidth: 0 }}>
          <div style={{
            width: 'clamp(28.8px, 7.65vw, 34.2px)', height: 'clamp(28.8px, 7.65vw, 34.2px)', borderRadius: '50%', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', color: 'var(--brand)',
          }}>
            {icon}
          </div>
          <span style={{ fontSize: 'clamp(13.8px, 3.5vw, 15.3px)', color: 'var(--text-secondary)' }}>{label}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
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
// "More details" expansion — same stages the Track Progress screen's own
// checklist tracks (bridging → verifying → settling → completed), always
// shown done since this only ever renders after the claim already succeeded.
function ClaimProcessStep({ text, last }: { text: ReactNode; last?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, paddingBottom: last ? 0 : 'clamp(10px, 2.2vh, 14px)' }}>
      <div style={{
        width: 20, height: 20, borderRadius: '50%', flexShrink: 0, marginTop: 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--brand)', color: '#fff',
      }}>
        <Check className="w-3 h-3" strokeWidth={3} />
      </div>
      <span style={{ fontSize: 'clamp(13.8px, 3.6vw, 15.3px)', color: 'var(--text-primary)', lineHeight: 1.4 }}>{text}</span>
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

const CHAIN_NAME_TO_ID: Record<string, string> = {
  'Ethereum Sepolia':    'Ethereum_Sepolia',
  'Base Sepolia':        'Base_Sepolia',
  'Arbitrum Sepolia':    'Arbitrum_Sepolia',
  'OP Sepolia':          'Optimism_Sepolia',
  'Optimism Sepolia':    'Optimism_Sepolia',
  'Polygon PoS Amoy':    'Polygon_Sepolia',
  'Polygon Amoy':        'Polygon_Sepolia',
  'Avalanche Fuji':      'Avalanche_Fuji',
  'HyperEVM Testnet':    'HyperEVM_Testnet',
  'Sei Testnet':         'Sei_Testnet',
  'Sonic Testnet':       'Sonic_Testnet',
  'Unichain Sepolia':    'Unichain_Sepolia',
  'World Chain Sepolia': 'World_Chain_Sepolia',
  'Arc Testnet':         'Arc_Testnet',
  'Linea Sepolia':       'Linea_Sepolia',
  'Ink Testnet':         'Ink_Testnet',
  'Ink Sepolia':         'Ink_Testnet',
  'Monad Testnet':       'Monad_Testnet',
  'Morph Testnet':       'Morph_Testnet',
  'Morph Hoodi':         'Morph_Testnet',
  'Pharos Testnet':      'Pharos_Testnet',
  'Pharos Atlantic':     'Pharos_Testnet',
  'Plume Testnet':       'Plume_Testnet',
  'XDC Apothem':         'XDC_Apothem',
  'Apothem Network':     'XDC_Apothem',
  'Codex Testnet':       'Codex_Testnet',
  'EDGE Testnet':        'Edge_Testnet',
  'Edge Testnet':        'Edge_Testnet',
  'Injective Testnet':   'Injective_Testnet',
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

const _providerCache = new Map<string, any>()

async function buildGasSponsoredProvider(rpcList: string[], chainKey: string, walletAddr: string, onGasFunded?: (chainId: string, wei: bigint) => void) {
  const { JsonRpcProvider } = await import('ethers')
  const proxyUrl = `/api/relay-rpc?chain=${chainKey}&user=${encodeURIComponent(walletAddr)}`

  // These maps mirror api/relay-rpc.js's GAS_BY_SELECTOR/CIRCLE_CONTRACTS —
  // keep both in sync. This copy had fallen out of sync: it still had the
  // depositForBurn v2 selector (0x8a94d4fc) and depositForBurnWithHook v2
  // selector (0x44bc937b) from BEFORE those were corrected server-side —
  // neither ever matches a real V2 transaction (V2's real signature hashes
  // to 0x8e0250ee / 0x779b432d respectively), and this map was also missing
  // the V2 TokenMessenger/MessageTransmitter addresses from CIRCLE_CONTRACTS
  // entirely. Since nothing matched, every V2 burn fell through to the
  // generic 150,000 gas default — nowhere near what a V2 depositForBurn
  // actually costs. relay-rpc.js faithfully funded + broadcast the resulting
  // tx (which is why gas-relay looked like it was "working"), but it
  // reverted out-of-gas on-chain: no state change, so no USDC was ever
  // deducted. Monad and Sei are V2-only, so 100% of their burns hit this;
  // Polygon Amoy has both V1 and V2 and only failed on the V2 path.
  //
  // Follow-up: a real Polygon Amoy "Bridge With Preapproval And Hook" call
  // reverted AGAIN even after raising 0x35093510 and the CIRCLE_CONTRACTS
  // fallback — gas consumed stayed pinned at 291,183 regardless of the
  // limit raised, which was the tell that this was never actually an
  // out-of-gas revert being fixed by margin. Decoded the tx's real Input
  // Data directly: MethodID is 0x513e1175, not 0x35093510 — that selector
  // was guessed/unverified from the start and never matched a real
  // transaction on any chain. The call had been silently falling through to
  // the CIRCLE_CONTRACTS fallback (whatever its value was at the time) this
  // entire time. Added 0x513e1175 as the real, confirmed selector; left
  // 0x35093510 in place in case it corresponds to some other real call this
  // app makes, but it should not be trusted as "the" bridge-burn selector.
  const GAS_BY_SELECTOR: Record<string, string> = {
    '0x095ea7b3': '0x' + (250000).toString(16), // ERC20 approve
    '0x39509351': '0x' + (250000).toString(16), // ERC20 increaseAllowance (Circle SDK uses this)
    '0x6fd3504e': '0x' + (500000).toString(16), // depositForBurn v1 (4 params)
    '0x8e0250ee': '0x' + (650000).toString(16), // depositForBurn v2 (7 params) — was 0x8a94d4fc (WRONG, never matched)
    '0xf856ddb6': '0x' + (500000).toString(16), // depositForBurnWithCaller v1
    '0x779b432d': '0x' + (650000).toString(16), // depositForBurnWithHook v2 — was 0x44bc937b (WRONG, never matched)
    '0x57ecfd28': '0x' + (650000).toString(16), // receiveMessage (spend)
    // Raised 700,000 → 1,500,000: read directly out of the installed SDK
    // (@circle-fin/provider-cctp-v2@1.10.1, @circle-fin/adapter-ethers-v6),
    // hasCustomContractSupport(chain,'bridge') — checked BEFORE
    // isCCTPV2Supported, so it wins whenever kitContracts.bridge is set,
    // which is configured broadly across testnet chains — routes every
    // claim through this exact bridgeWithPreapprovalAndHook call in
    // adapter-ethers-v6, which calls the adapter's REAL
    // contractFunction.estimateGas(...) (unlike the "standard"
    // depositForBurn path, which passes provider-cctp-v2's own hardcoded
    // 300,000-gas override straight to execute() and never consults
    // eth_estimateGas at all). So THIS proxy's hardcoded response is what
    // ends up as the signed tx's gasLimit for essentially every claim —
    // it just only actually needs more than 700,000 gas on Polygon Amoy,
    // Monad and Sei, whose EVM execution environments (Sei's Cosmos-SDK EVM
    // layer, Monad's from-scratch parallel execution engine, Polygon's Bor
    // client) can cost more real gas units for identical bytecode than an
    // OP-stack/Arbitrum-Nitro-style L2 — consistent with 18/21 chains
    // working fine at 700,000 while these three don't, even with gas
    // funded (funding covers the SIGNED gasLimit × gasPrice, not whatever
    // the operation actually needs — see api/relay-rpc.js's own copy of
    // this map for the full writeup). A gas LIMIT ceiling costs nothing
    // unused, so there's no downside to the wider margin here.
    '0x35093510': '0x' + (1500000).toString(16), // (kept as a guess, unverified) — was labeled "Kit Bridge contract burn" but never actually matched a real tx on any chain
    '0x513e1175': '0x' + (1500000).toString(16), // bridgeWithPreapprovalAndHook(tuple bridgeParams, bytes hookData) — the REAL selector for the Kit Bridge contract call, confirmed directly from a decoded Polygon Amoy tx's Input Data (MethodID). 0x35093510 above was always wrong; this call had been falling through to the CIRCLE_CONTRACTS fallback the entire time, at whatever that fallback's value was at the time.
  }
  const CIRCLE_CONTRACTS = new Set([
    '0x0077777d7eba4688bdef3e311b846f25870a19b9',
    '0x9f3b8679c73c2fef8b59b4f3444d4e156fb70aa5',
    '0x7865fafc2db2093669d92c0f33aeef291086befd', // was '...086becd' — typo, verified against the real SDK value
    '0xacf1ceef35caac005e15888ddb8a3515c41b4872',
    '0xc5567a5e3370d4dbfb0540025078e283e36a363d',
    '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b',
    '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa', // CCTP V2 TokenMessenger — same address across all chains, safety net for any V2 selector variant not in GAS_BY_SELECTOR
    '0xe737e5cebeeba77efe34d4aa090756590b1ce275', // CCTP V2 MessageTransmitter — same reasoning
  ])
  const USDC_CONTRACTS = new Set([
    '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
    '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d',
    '0x5fd84259d66cd46123540766be93dfe6d43130d7',
    '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582',
    '0x5425890298aed601595a70ab815c96711a31bc65',
    '0x2b3370ee501b4a559b57d449569354196457d8ab',
    '0x4fcf1784b31630811181f670aea7a7bef803eaed',
    '0x0ba304580ee7c9a980cf72e55f5ed2e9fd30bc51', // Sonic — was 0xa4879fed...c4ec6, stale/wrong contract
    '0x31d0220469e10c4e71834a79b1f276d740d3768f',
    '0x66145f38cbac35ca6f1dfb4914df98f1614aea88', // World Chain — was 0x79a02482...4cd24d1, same stale-address bug as Sonic
    '0xfece4462d57bd51a6a552365a011b95f0e16d9b7', // Linea Sepolia
    '0xfabab97dce620294d2b0b0e46c68964e326300ac', // Ink Testnet
    '0x534b2f3a21130d7a60830c2df862319e593943a3', // Monad Testnet — previously missing entirely
    '0x7433b41c6c5e1d58d4da99483609520255ab661b', // Morph Testnet
    '0xcfc8330f4bcab529c625d12781b1c19466a9fc8b', // Pharos Testnet
    '0xcb5f30e335672893c7eb944b374c196392c19d18', // Plume Testnet
    '0xb5ab69f7bbada22b28e79c8ffaece55ef1c771d4', // XDC Apothem
    '0x6d7f141b6819c2c9cc2f818e6ad549e7ca090f8f', // Codex Testnet
    '0x2d9f7cad728051aa35ecdc472a14cf8cdf5cfd6b', // Edge Testnet
    '0x0c382e685bbeefe5d3d9c29e29e341fee8e84c5d', // Injective Testnet
  ])


  // BUG FIX: this used to build a single JsonRpcProvider(rpc) from only
  // rpcList[0] — every other candidate in RPC_BY_CHAIN_NAME for this chain
  // (1-2 more per chain, actively maintained with real incident history —
  // see chainRpcs.ts) was silently discarded. If that one endpoint had a
  // transient issue, EVERY call through this provider failed outright with
  // nowhere to fail over to — confirmed as the direct cause of
  // "[BgBridge] failed: RPC endpoint error on <chain>" in production, and a
  // likely contributor to "Simulation failed: Transaction reverted" too, if
  // the single endpoint served stale/lagging state for the pre-flight
  // simulation. Building a provider per URL and trying each in sequence
  // (falling through only on failure) uses the same fallback list this
  // file already imports and maintains, instead of ignoring it.
  const providers = rpcList.map((url: string) => new JsonRpcProvider(url))
  const provider = providers[0]
  const origSendFns = providers.map((p: any) => p._send.bind(p))
  const origSend = async (payload: any) => {
    let lastErr: unknown = null
    for (const send of origSendFns) {
      try {
        return await send(payload)
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr
  }

  ;(provider as any)._send = async (payload: any) => {
    const batch = Array.isArray(payload) ? payload : [payload]
    const results: any[] = []

    for (const req of batch) {
      const method = req.method
      if (method === 'eth_estimateGas') {
        const tx = req.params?.[0] ?? {}
        const toAddr  = (tx.to ?? '').toLowerCase()
        const dataHex = (tx.data ?? '0x').slice(0, 10).toLowerCase()
        const gasHex  = GAS_BY_SELECTOR[dataHex]
                     ?? (CIRCLE_CONTRACTS.has(toAddr) ? '0x' + (1500000).toString(16) : null) // same ceiling as GAS_BY_SELECTOR's own bridgeWithPreapprovalAndHook entry above
                     ?? (USDC_CONTRACTS.has(toAddr)   ? '0x' + (65000).toString(16)  : null)
                     ?? '0x' + (150000).toString(16)
        results.push({ id: req.id, result: gasHex })
        continue
      }

      if (method === 'eth_getBalance') {
        results.push({ id: req.id, result: '0x1BC16D674EC80000' })
        continue
      }

      if (method === 'eth_sendRawTransaction') {
        try {
          const resp = await fetch(proxyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: req.id, method, params: req.params }),
          })
          const json = await resp.json()
          if (json.error) {
            results.push({ id: req.id, error: json.error })
          } else {
            results.push({ id: req.id, result: json.result })
            // Real wei MeshPort's relay just transferred to broadcast THIS
            // tx (0 if the wallet was already funded — see api/relay-rpc.js's
            // fundedWei on eth_sendRawTransaction). Feeds the success
            // screen's "gas MeshPort covered" figure — see onGasFunded's own
            // doc comment on backgroundBridge.ts's runBridge for why this is
            // the real, non-guessed number, not an estimate.
            if (json.fundedWei) {
              try { onGasFunded?.(chainKey, BigInt(json.fundedWei)) } catch {}
            }
          }
        } catch(e: any) {
          results.push({ id: req.id, error: { code: -32603, message: e.message } })
        }
        continue
      }

      results.push(null)
    }

    const needRpc = batch.filter((_: any, i: number) => results[i] === null)
    if (needRpc.length > 0) {
      const rpcResults = await origSend(needRpc.length === 1 ? needRpc[0] : needRpc)
      const rpcArr = Array.isArray(rpcResults) ? rpcResults : [rpcResults]
      let ri = 0
      for (let i = 0; i < results.length; i++) {
        if (results[i] === null) results[i] = rpcArr[ri++]
      }
    }

    return results
  }

  return provider
}

async function buildAdapter(createFn: any, privateKey: string, onGasFunded?: (chainId: string, wei: bigint) => void) {
  const adapter = createFn({
    privateKey,
    getProvider: async ({ chain }: { chain: any }) => {
      const rpcList = RPC_BY_CHAIN_NAME[chain?.name] ?? [chain?.rpcEndpoints?.[0] ?? ARC_RPCS[0]]
      const chainKey = CHAIN_NAME_TO_ID[chain?.name] ?? ''

      if (chainKey && chainKey !== 'Arc_Testnet') {
        const cacheKey = `sponsored:${chainKey}:${privateKey.slice(-8)}`
        if (!_providerCache.has(cacheKey)) {
          const { Wallet } = await import('ethers')
          const walletAddr = new Wallet(privateKey).address
          _providerCache.set(cacheKey, await buildGasSponsoredProvider(rpcList, chainKey, walletAddr, onGasFunded))
        }
        return _providerCache.get(cacheKey)!
      }

      // Same fix as the gas-sponsored branch above: cache and fall back
      // across every URL in rpcList, not just the first one.
      const arcCacheKey = rpcList.join('|')
      if (!_providerCache.has(arcCacheKey)) {
        const { JsonRpcProvider, FallbackProvider } = await import('ethers')
        const arcProviders = rpcList.map((url: string) => new JsonRpcProvider(url))
        _providerCache.set(
          arcCacheKey,
          arcProviders.length > 1
            ? new FallbackProvider(arcProviders.map((p: any, i: number) => ({ provider: p, priority: i, weight: 1, stallTimeout: 2000 })), undefined, { quorum: 1 })
            : arcProviders[0]
        )
      }
      return _providerCache.get(arcCacheKey)!
    },
  })

  return adapter
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
export function MultichainClaimPage() {
  const isDesktop    = useMediaQuery('(min-width: 980px)')
  const navigate     = useNavigate()
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
    ((location.state as any)?.trackClaimId as string | undefined) ??
    (searchParams.get('claim') || undefined)

  const [step,           setStep]          = useState<Step>(() => trackClaimIdFromHub ? 'confirm' : 'loading')
  const [confirmPhase,   setConfirmPhase]  = useState<ConfirmPhase>(() => trackClaimIdFromHub ? 'tracking' : 'processing')
  const [homeCountdown,  setHomeCountdown]  = useState(5)

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
    if (confirmPhase !== 'tracking') return
    window.history.pushState({ trackProgress: true }, '')
    const onPopState = () => { navigate('/multichain', { replace: true }) }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [confirmPhase, navigate])

  // Server-owned claim rows created for this session, keyed by source chain.
  // These are the single source of truth once populated — the worker keeps
  // advancing them via Supabase regardless of what this page/tab does.
  const [claimRecords,   setClaimRecords]  = useState<Array<{ chainId: string; claimId: string; initialClaim?: ServerClaim | null }>>([])
  const [claimsByStatus, setClaimsByStatus] = useState<Record<string, ServerClaim>>({})
  const [showPasscodeSheet, setShowPasscodeSheet] = useState(false)
  const [amountConfirmed, setAmountConfirmed] = useState(false)
  const [keypadOpen,     setKeypadOpen]    = useState(false)
  const [isSubmitted,    setIsSubmitted]   = useState(false)
  const [chains,         setChains]        = useState<ChainEntry[]>([])
  const [claimableTotal, setClaimableTotal] = useState(0)
  const [selected,       setSelected]      = useState<string | null>(null)
  const [claimAmounts,   setClaimAmounts]  = useState<Record<string, string>>({})
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
  }>({ loading: false, error: '', totalFee: 0, receiverGets: 0, forKey: '' })
  const [passEntry,      setPassEntry]     = useState('')
  const [passError,      setPassError]     = useState('')
  const [error,          setError]         = useState('')
  const [txRecords,      setTxRecords]     = useState<ActivityRecord[]>([])
  const [chainProgress,  setChainProgress] = useState<ChainProgress[]>([])
  // Per-chain CCTP fee (the real maxFee each chain's burn ends up signing,
  // reported live by backgroundBridge once its estimate+clamp resolves) —
  // summed for the success screen's "Total Fees" row, mirroring
  // MultichainTransferPage's own transfer success screen.
  const [claimFees,      setClaimFees]     = useState<Record<string, number>>({})
  // Real wei MeshPort's relay wallet transferred to fund gas for each
  // source chain's burn transaction this claim session — accumulated (+=)
  // since funding can happen in more than one call per chain (an early
  // mp_ensureGasFunded pre-fund, then a top-up at broadcast time if
  // needed). Fed by onGasFunded in buildAdapter/buildGasSponsoredProvider
  // and backgroundBridge.ts's runBridge — see either's own doc comment.
  // Converted to USD for the "Gas Covered" row in Total Fees using live
  // native-token prices (claimGasUsd below), never a hardcoded example.
  const [claimGasWei,    setClaimGasWei]    = useState<Record<string, bigint>>({})
  // Live USD price per CoinGecko id, for converting claimGasWei into a real
  // dollar figure — fetched once per claim session, only for the tokens
  // this claim's chains actually need (see NATIVE_GAS_COINGECKO_ID above).
  const [nativeUsdPrices, setNativeUsdPrices] = useState<Record<string, number>>({})
  useEffect(() => {
    const ids = Array.from(new Set(
      chainProgress.map(p => NATIVE_GAS_COINGECKO_ID[p.chainId]).filter((id): id is string => !!id)
    ))
    if (ids.length === 0) return
    const missing = ids.filter(id => !(id in nativeUsdPrices))
    if (missing.length === 0) return
    fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${missing.join(',')}&vs_currencies=usd`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return
        setNativeUsdPrices(prev => {
          const next = { ...prev }
          for (const id of missing) if (typeof data[id]?.usd === 'number') next[id] = data[id].usd
          return next
        })
      })
      .catch(() => {}) // best-effort — Gas Covered row just omits unpriced chains if this fails
  }, [chainProgress])
  const notifiedClaimIdsRef = useRef<Set<string>>(new Set())
  const sdkRef = useRef<{ AppKit: any; createEthersAdapterFromPrivateKey: any } | null>(null)

  // ─── Success screen — same full-screen flash → hero-card takeover
  // SwapPage/PaySendPage use for a completed action, reused here so a
  // completed claim feels identical: whole screen flashes brand color
  // with a big checkmark + "Claimed Successfully", holds briefly, then
  // that panel shrinks away while the traveling checkmark bridges into
  // the detailed hero card that fades in underneath.
  const [successPhase, setSuccessPhase] = useState<'flash' | 'collapsed'>('flash')
  const [showProcessDetails, setShowProcessDetails] = useState(false)
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

  const copyClaimHash = async (hash: string) => {
    if (!hash) return
    const ok = await copyToClipboard(hash)
    setHashCopied(true)
    showToastMessage(ok ? 'Transaction hash copied' : 'Could not copy hash', ok ? 'success' : 'error')
    setTimeout(() => setHashCopied(false), 1500)
  }

  useEffect(() => {
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
    const iv = setInterval(() => {
      pending.forEach(r => kickClaimWorker(r.claimId))
    }, 5_000)
    return () => clearInterval(iv)
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

  // Auto-redirect to the Multichain Hub 5s after "Claim Submitted" — by
  // this point the burn is confirmed and durably recorded server-side (a
  // `claims` row via claim-submit, tracked to completion by claim-worker
  // independent of this tab), so it's genuinely safe to leave. Tapping
  // either button below navigates away immediately, which unmounts this
  // effect and cancels the countdown — no separate "cancel" handling needed.
  useEffect(() => {
    if (confirmPhase !== 'submitted') return
    setHomeCountdown(5)
    const interval = setInterval(() => {
      setHomeCountdown(c => {
        if (c <= 1) {
          clearInterval(interval)
          navigate('/multichain')
          return 0
        }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [confirmPhase, navigate])

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

  const getKey = useCallback(async () => {
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
    if (addr && !key) {
      try {
        const { restorePrivateKey } = await import('@/lib/restoreWallet')
        await restorePrivateKey()
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
  // Same call shape executeClaim's own estimate (inside backgroundBridge.ts)
  // ends up making, just fired earlier and read-only here — this never
  // signs or broadcasts anything. getKey() is cheap after the first call
  // (scan() on page load already resolved and cached the private key in the
  // auth store), so this doesn't reprompt for a passcode or restore the
  // wallet a second time.
  const fetchClaimFeeEstimate = useCallback(async (chainId: string, amount: number) => {
    const key = `${chainId}|${amount}`
    setFeeEstimate(prev => ({ ...prev, loading: true, error: '' }))
    try {
      const wallet = await getKey()
      if (!wallet) throw new Error('Wallet unavailable')
      const { AppKit, createEthersAdapterFromPrivateKey } = await loadSdk()
      const kit = new AppKit({ clientKey: import.meta.env.VITE_KIT_KEY, disableErrorReporting: true } as any)
      const adapter = await buildAdapter(createEthersAdapterFromPrivateKey, wallet.key)
      const sdkChainId = toSdkChainId(chainId)
      const destTarget = buildClaimDestTarget(chainId, sdkChainId, wallet.addr, adapter)
      const transferSpeed = cctpSpeedForSource(chainId, sdkChainId)

      const estimate: any = await kit.estimateBridge({
        from:   { adapter, chain: sdkChainId as any },
        to:     destTarget,
        amount: amount.toFixed(6),
        token:  'USDC',
        config: { transferSpeed: transferSpeed as any },
      })

      // Same fee-line filter backgroundBridge.ts's own maxFee estimate uses —
      // provider/forwarder/kit are the fee types that actually reduce what
      // lands on Arc; a null/error entry means the lookup failed for this
      // route, not that the fee is zero.
      const feeEntries: any[] = estimate?.fees ?? []
      const hadFailedLookup = feeEntries.some((f: any) => f.amount === null || f.error)
      const feeTotal = feeEntries
        .filter((f: any) => (f.type === 'provider' || f.type === 'forwarder' || f.type === 'kit') && f.amount !== null)
        .reduce((sum: number, f: any) => sum + (parseFloat(f.amount) || 0), 0)

      if (hadFailedLookup && feeTotal === 0) {
        // Don't show "$0 fee" when the lookup actually failed for this route
        // — that reads as "free" when it's really "unknown".
        setFeeEstimate({ loading: false, error: 'Fee estimate unavailable for this route', totalFee: 0, receiverGets: 0, forKey: key })
        return
      }
      setFeeEstimate({ loading: false, error: '', totalFee: feeTotal, receiverGets: Math.max(0, amount - feeTotal), forKey: key })
    } catch (e: any) {
      setFeeEstimate({ loading: false, error: 'Fee estimate unavailable', totalFee: 0, receiverGets: 0, forKey: key })
    }
  }, [getKey, loadSdk])

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
      setFeeEstimate({ loading: false, error: '', totalFee: 0, receiverGets: 0, forKey: '' })
      return
    }
    const t = setTimeout(() => { fetchClaimFeeEstimate(selected, amt) }, 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, selected, claimAmounts[selected ?? ''], fetchClaimFeeEstimate])

  // BUG FIX (live report -- "why estimate fees taking longer time"): the
  // dominant cost in fetchClaimFeeEstimate's first call isn't the actual
  // estimateBridge() network round-trip -- it's the dynamic import() of
  // @circle-fin/app-kit / @circle-fin/adapter-ethers-v6, a separate JS
  // chunk that previously only started downloading AFTER the 600ms
  // debounce fired, i.e. only once the user had already stopped typing.
  // Kicking it off the moment a chain is selected (well before any amount
  // is even entered) means that chunk is normally already cached by the
  // time fetchClaimFeeEstimate actually needs it, so the debounce delay is
  // the only wait left, not debounce + a fresh network fetch of the SDK
  // itself. Fire-and-forget, errors ignored -- fetchClaimFeeEstimate's own
  // loadSdk() call still runs normally and surfaces any real failure.
  useEffect(() => {
    if (step === 'select' && selected) { loadSdk().catch(() => {}) }
  }, [step, selected, loadSdk])

  const scan = useCallback(async () => {
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
    setSelected(id)
    setClaimAmounts(prev => ({ ...prev, [id]: '' }))
    setError('')
    setAmountConfirmed(false)
    setKeypadOpen(false)
  }

  const executeClaim = useCallback(async () => {
    if (selectedTotal <= 0) return
    setError('')
    const wallet = await getKey()
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
    setClaimGasWei({})

    const setChain = (chainId: string, stage: ChainProgress['stage'], msg: string, pct: number, extra?: Partial<ChainProgress>) =>
      setChainProgress(prev => prev.map(p =>
        p.chainId === chainId ? { ...p, stage, msg, pct, ...extra } : p
      ))

    try {
      const { AppKit, createEthersAdapterFromPrivateKey } = {
        ...await sdkRef.current ?? await loadSdk(),
      }
      const kit     = new AppKit({ clientKey: import.meta.env.VITE_KIT_KEY, disableErrorReporting: true } as any)
      const onGasFunded = (chainId: string, wei: bigint) => {
        setClaimGasWei(prev => ({ ...prev, [chainId]: (prev[chainId] ?? 0n) + wei }))
      }
      const adapter = await buildAdapter(createEthersAdapterFromPrivateKey, wallet.key, onGasFunded)

      const depositedChains: Array<{ chainId: string; amount: number }> = []
      let currentClaimChainId = selChains[0]?.chainId

      kit.on('bridge.approve', (_payload: any) => {
        setChain(currentClaimChainId, 'approving', 'USDC approved ✓', 35)
      })
      kit.on('bridge.burn', (payload: any) => {
        setChain(currentClaimChainId, 'burning', 'Burned ✓ — awaiting Circle…', 55)
      })
      kit.on('bridge.attestation', (_payload: any) => {
        setChain(currentClaimChainId, 'attesting', 'Circle attesting…', 72)
      })
      kit.on('bridge.mint', (payload: any) => {
        setChain(currentClaimChainId, 'minting', 'Minting on Arc…', 92)
      })

      const CCTP_DOMAINS: Record<string, number> = {
        Ethereum_Sepolia:    0,
        Base_Sepolia:        6,
        Arbitrum_Sepolia:    3,
        Optimism_Sepolia:    2,
        Polygon_Sepolia:     7,
        Avalanche_Fuji:      1,
        HyperEVM_Testnet:    19,
        Sei_Testnet:         16,
        Sonic_Testnet:       13,
        Unichain_Sepolia:    10,
        World_Chain_Sepolia: 14,
        // Added — verified directly from Circle's official CCTP domain
        // table (developers.circle.com/cctp/concepts/supported-chains-and-domains)
        Linea_Sepolia:       11,
        Codex_Testnet:       12,
        Monad_Testnet:       15,
        XDC_Apothem:         18,
        Ink_Testnet:         21,
        Plume_Testnet:       22,
        Edge_Testnet:        28,
        Injective_Testnet:   29,
        Morph_Testnet:       30,
        Pharos_Testnet:      31,
      }

      const fetchIrisAttestation = async (chainId: string, burnTxHash: string): Promise<{ attestation: string, message: string } | null> => {
        const domain = CCTP_DOMAINS[chainId]
        if (domain === undefined) return null
        const url = `https://iris-api-sandbox.circle.com/v2/messages/${domain}?transactionHash=${burnTxHash}`
        try {
          const res = await fetch(url)
          const data = await res.json()
          const msg = data?.messages?.[0]
          if (msg?.status === 'complete' && msg?.attestation && msg?.message) {
            return { attestation: msg.attestation, message: msg.message }
          }
          return null
        } catch (e: any) {
          return null
        }
      }

      const claimOneChain = async (chain: typeof selChains[0]) => {
        const inputAmt    = parseFloat((claimAmounts[chain.chainId] ?? '').replace(/[^0-9.]/g, '')) || 0
        const claimAmount = Math.min(inputAmt, chain.claimable ?? 0)

        // MIN_CLAIM_AMOUNT (module-level, shared with the amount screen's own
        // gate and the pre-claim fee estimate) — see its doc comment.
        // See the safety clamp in backgroundBridge.ts's runBridge() for the
        // actual per-attempt enforcement — this is the earlier, clearer gate
        // so a doomed claim never gets attempted in the first place.
        if (claimAmount < MIN_CLAIM_AMOUNT) {
          // Previously just `return`ed here with zero feedback — the
          // chain's progress card stayed on whatever it last showed
          // (usually nothing), silently doing nothing with no
          // explanation. Surface it the same way a real failure would be.
          setChain(chain.chainId, 'error', `Minimum $${trimTrailingZeros(MIN_CLAIM_AMOUNT.toFixed(2))} to claim`, 0)
          return
        }

        try {
          setChain(chain.chainId, 'gas', 'Relay funding gas…', 10)
          setChain(chain.chainId, 'approving', `Approving ${formatAmount(claimAmount)} USDC…`, 25)

          currentClaimChainId = chain.chainId

          backgroundBridge.runBridge({
            chainId:      chain.chainId,
            sdkChainId:   toSdkChainId(chain.chainId),
            chainLabel:   getMeta(chain.chainId).label,
            amount:       claimAmount,
            kit,
            adapter,
            walletAddr:   wallet.addr,
            setBalance,
            onSubmitted: (_cid: string) => {
              setIsSubmitted(true)
            },
            onFeeKnown: (cid, fee) => {
              setClaimFees(prev => ({ ...prev, [cid]: fee }))
            },
            onGasFunded: (cid, wei) => {
              setClaimGasWei(prev => ({ ...prev, [cid]: (prev[cid] ?? 0n) + wei }))
            },
            onStepUpdate: (cid, stage, msg, pct, extra) => {
              setChain(cid, stage as any, msg, pct, extra)

              // Burn confirmed on-chain — hand off to the server-side worker
              // right now. From this point the claim is a Supabase row being
              // advanced by claim-worker; the user can safely leave.
              if (stage === 'attesting' && extra?.txHash) {
                submitClaim({
                  walletAddress: wallet.addr,
                  sourceChain:   cid,
                  amount:        claimAmount,
                  txHash:        extra.txHash,
                }).then(res => {
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

              if (stage === 'done' || stage === 'error') {
                setChainProgress(prev => {
                  const updated = prev.map(p => p.chainId === cid ? { ...p, stage: stage as any, msg, pct, ...extra } : p)
                  const allError    = updated.every(p => p.stage === 'error')
                  // The ONLY thing that may ever set confirmPhase to 'done' is
                  // claims.status === 'completed', via the Realtime-driven
                  // effect above — never this client SDK callback. A prior
                  // version also flipped confirmPhase to 'done' here whenever
                  // every chain's local `stage` reached 'done' AND
                  // claimRecords was still empty — meant as a rare fallback
                  // for "submitClaim() never fired at all". In practice this
                  // raced the normal path constantly: Circle's forwarder can
                  // complete the mint (stage → 'done') before submitClaim()'s
                  // own POST request resolves and pushes into claimRecords,
                  // since both happen concurrently after burn confirms. That
                  // race — not an edge case — was what showed the Success
                  // screen before claims.status ever reached 'completed',
                  // while the Hub/Activity/Track Progress (all reading
                  // claims.status directly) correctly still showed
                  // "processing". Removed entirely; claims.status is now the
                  // single source of truth for success, full stop.
                  //
                  // Failure is different: if every chain errored out AND no
                  // claims row exists, submitClaim() never ran (burn itself
                  // was rejected before ever reaching the server) — there is
                  // no server row to defer to, so this is the only signal
                  // that will ever exist for that attempt.
                  if (allError && claimRecords.length === 0) setTimeout(() => setStep('failed'), 500)
                  return updated
                })
              }
            },
          })

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
  }, [selectedTotal, chains, selected, claimAmounts, getKey, loadSdk])

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
    const { verifyPasscode } = await import('@/lib/security')
    if (!await verifyPasscode(passEntry, storedPasscode!)) {
      setPassError('Incorrect passcode'); setPassEntry(''); return
    }
    setPassError(''); setPassEntry('')
    setShowPasscodeSheet(false)
    setConfirmPhase('processing')
    setStep('confirm')
    await executeClaim()
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
    ? `$${formatAmount(feeEstimate.receiverGets)} on Arc`
    : 'Calculating…'
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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, paddingTop: 4, borderTop: `1px solid ${COLORS.border}` }}>
          <span style={{ fontSize: 11, color: COLORS.muted }}>Estimated fee</span>
          <span style={{ fontSize: 11, color: feeEstimate.error && claimEstimateIsLive ? COLORS.error : COLORS.muted, fontVariantNumeric: 'tabular-nums' }}>
            {(!claimEstimateIsLive || feeEstimate.loading) ? 'Estimating…'
              : feeEstimate.error ? feeEstimate.error
              : `~$${trimTrailingZeros(feeEstimate.totalFee.toFixed(4))} USDC`}
          </span>
        </div>
      )}
    </div>
  )

  const chainsWithFunds  = chains
    .filter(c => c.claimable > 0 || c.pending > 0)
    // Admin-disabled chains never show up here, even if funds are sitting
    // on them — matches Transfer's behavior (isChainEnabledForTransfer),
    // but with its own independent Claim toggle.
    .filter(c => isChainEnabledForClaim(settingsMap, c.chainId))
    // Highest balance first — makes the biggest claimable amounts the most
    // prominent/easiest to act on instead of showing in arbitrary chain
    // config order.
    .sort((a, b) => (b.claimable + b.pending) - (a.claimable + a.pending))

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
    <div style={{ background: COLORS.bg, display: 'flex', flexDirection: 'column', overflow: isDesktop ? 'visible' : 'hidden', height: '100%' }}>

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
      <AnimatePresence mode="wait">
      {step === 'loading' && (
        <motion.div
          key="loading"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.25, ease: 'easeInOut' }}
          style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: SPACING.lg }}
        >
          {(() => {
            const scanChains = Object.keys(CHAIN_META).filter(id => isChainEnabledForClaim(settingsMap, id))
            const loopChains = [...scanChains, ...scanChains] // duplicated for a seamless scroll loop
            return (
              <div style={{
                position: 'relative', width: '100%', maxWidth: 280, height: 60,
                overflow: 'hidden',
                WebkitMaskImage: 'linear-gradient(90deg, transparent, #000 20%, #000 80%, transparent)',
                maskImage: 'linear-gradient(90deg, transparent, #000 20%, #000 80%, transparent)',
              }}>
                <motion.div
                  animate={{ x: ['0%', '-50%'] }}
                  transition={{ duration: 6, repeat: Infinity, ease: 'linear' }}
                  style={{ position: 'absolute', display: 'flex', gap: 14, alignItems: 'center' }}
                >
                  {loopChains.map((id, i) => (
                    <ChainLogo key={`${id}-${i}`} chainId={id} size={44} />
                  ))}
                </motion.div>
                {/* Fixed vertical scan line the chain logos scroll past */}
                <div style={{
                  position: 'absolute', top: 0, bottom: 0, left: '50%', width: 2,
                  background: 'linear-gradient(180deg, transparent, var(--brand), transparent)',
                }}/>
              </div>
            )
          })()}
          <div>
            <p style={{ fontSize: 16, fontWeight: 700, color: COLORS.text, margin: '0 0 6px', textAlign: 'center' }}>Scanning chains…</p>
            <p style={{ fontSize: 13, color: COLORS.muted, margin: 0, textAlign: 'center' }}>Finding your available funds…</p>
          </div>
        </motion.div>
      )}

      {/* CHAIN SELECTION - MeshPort V2 Premium Cards */}
      {step === 'select' && !selectedChain && (
        <motion.div
          key="select"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.25, ease: 'easeInOut' }}
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
            <button onClick={scan} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: COLORS.text, display: 'flex' }}>
              <RefreshCw className="w-5 h-5"/>
            </button>
          </div>

          {/* Body */}
          <div style={{ flex: 1, overflowY: 'auto', padding: `${SPACING.md}px ${SPACING.md}px ${SPACING.xl}px`, minHeight: 0 }}>
            {/* Available Total Card */}
            <motion.div
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}
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

            {chainsWithFunds.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.md }}>
                {chainsWithFunds.map((c, i) => {
                  const m = getMeta(c.chainId)
                  const isSelectable = c.claimable > 0
                  return (
                    <motion.div
                      key={c.chainId}
                      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.25, delay: i * 0.05 }}
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
                        opacity: isSelectable ? 1 : 0.5,
                        transition: 'all 0.2s ease',
                      }}
                    >
                      <ChainLogo chainId={c.chainId} size={40}/>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: 15, fontWeight: 600, color: COLORS.text, margin: '0 0 4px' }}>
                          {m.label}
                        </p>
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
              </div>
            ) : (
              <motion.div
                initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
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
          initial={{ opacity: 0, x: 32 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }}
          transition={{ duration: 0.25 }}
          onClick={() => { if (keypadOpen) setKeypadOpen(false) }}
          style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
        >
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.md, padding: `${SPACING.sm}px ${SPACING.md}px`, background: COLORS.bg, borderBottom: `1px solid ${COLORS.border}`, flexShrink: 0 }}>
            {!isDesktop && (
              <button onClick={e => { e.stopPropagation(); setSelected(null); setError(''); setAmountConfirmed(false); setKeypadOpen(false) }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: COLORS.text, display: 'flex', alignItems: 'center' }}>
                <ArrowLeft className="w-5 h-5"/>
              </button>
            )}
            <ChainLogo chainId={selectedChain.chainId} size={28}/>
            <span style={{ fontSize: 16, fontWeight: 700, color: COLORS.text }}>{getMeta(selectedChain.chainId).label}</span>
          </div>

          {/* Amount Display — anchored near top so the bottom keypad sheet
              never covers it. overflowY:auto + minHeight:0 are the safety
              net for small screens: on a short phone with the keypad open
              (which reserves up to 340px below), the chain card + amount
              display can genuinely run out of vertical room — this lets it
              scroll instead of silently clipping, matching the same
              small-screen discipline used elsewhere on this page. */}
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', paddingTop: SPACING.xl * 2, paddingBottom: (!isDesktop && keypadOpen) ? 'min(45vh, 340px)' : SPACING.md, paddingLeft: SPACING.xl, paddingRight: SPACING.xl }}>
            {/* Chain + Available — medium-large box */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: SPACING.md, width: '100%',
              background: COLORS.surface, border: `1px solid ${COLORS.border}`,
              borderRadius: RADII.card, padding: `${SPACING.md}px ${SPACING.lg}px`,
              marginBottom: SPACING.md,
            }}>
              <div style={{
                position: 'relative', width: 56, height: 56, borderRadius: '50%', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: `radial-gradient(circle at 30% 30%, ${getMeta(selectedChain.chainId).color}33, ${COLORS.surfaceSecondary} 70%)`,
                border: `1px solid ${getMeta(selectedChain.chainId).color}55`,
                boxShadow: `0 0 0 5px ${getMeta(selectedChain.chainId).color}14`,
              }}>
                <ChainLogo chainId={selectedChain.chainId} size={36}/>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 15, fontWeight: 700, color: COLORS.text, margin: '0 0 2px' }}>{getMeta(selectedChain.chainId).label}</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: COLORS.success, flexShrink: 0 }}/>
                  <span style={{ fontSize: 12, color: COLORS.muted }}>Available</span>
                </div>
              </div>
              <span style={{ fontSize: 18, fontWeight: 700, color: COLORS.success, flexShrink: 0 }}>${formatAmount(selectedChain.claimable)}</span>
            </div>

            {/* Amount box — tap to open the amount keypad — mobile only.
                Desktop gets the same bare-box + Max pill treatment as
                Multichain Transfer's amount box instead. */}
            {!isDesktop && (
              <>
                <button
                  onClick={e => { e.stopPropagation(); setAmountConfirmed(false); setKeypadOpen(true) }}
                  style={{
                    display: 'flex', alignItems: 'baseline', gap: 2, justifyContent: 'center',
                    width: '100%', padding: `${SPACING.lg}px`, borderRadius: RADII.card,
                    background: keypadOpen ? 'color-mix(in srgb, var(--brand) 8%, transparent)' : COLORS.surfaceSecondary,
                    border: `1.5px solid ${keypadOpen ? COLORS.primary : COLORS.border}`,
                    cursor: 'pointer',
                    transition: 'background .15s ease, border-color .15s ease',
                    marginBottom: SPACING.md,
                  }}
                >
                  <span style={{ fontSize: 42, fontWeight: 700, color: claimAmounts[selected!] ? COLORS.text : COLORS.muted }}>$</span>
                  <span style={{ fontSize: 52, fontWeight: 700, color: COLORS.text, letterSpacing: '-2px', lineHeight: 1 }}>
                    {claimAmounts[selected!] || '0'}
                  </span>
                  {!amountConfirmed && (
                    <span style={{
                      width: 3, height: 36, marginLeft: 4, borderRadius: 2,
                      background: COLORS.primary,
                      animation: keypadOpen ? 'caretBlink 1s step-end infinite' : 'none',
                      opacity: keypadOpen ? undefined : 0,
                    }}/>
                  )}
                </button>
                {!amountConfirmed && !keypadOpen && (
                  <p style={{ fontSize: 12, color: COLORS.muted, margin: '0 0 4px', textAlign: 'center' }}>Tap the amount to enter a value</p>
                )}
              </>
            )}

            {isDesktop && !amountConfirmed && (
              <div style={{ width: '100%', marginBottom: SPACING.md }}>
                <div style={{
                  position: 'relative',
                  background: COLORS.surfaceSecondary, border: `1px solid ${error ? COLORS.error : COLORS.border}`, borderRadius: RADII.card,
                  padding: '28px 20px', minHeight: 108, display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
                }}>
                  {/* $ pinned to a fixed left inset (not part of the centered
                      flex group) so the digits stay truly centered in the box
                      regardless of how many digits are typed — a $ inline
                      before the input shifts the visual center off to the
                      right as the group grows. */}
                  <span style={{ position: 'absolute', left: 20, fontSize: 34, fontWeight: 700, color: claimAmounts[selected!] ? COLORS.text : COLORS.muted, pointerEvents: 'none' }}>$</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    autoFocus
                    value={claimAmounts[selected!] ?? ''}
                    onChange={e => { setClaimAmounts(prev => ({ ...prev, [selected!]: sanitizeClaimAmount(e.target.value) })); setError('') }}
                    placeholder="0.00"
                    style={{
                      width: '100%', background: 'transparent', border: 'none', outline: 'none', padding: 0,
                      fontSize: 34, fontWeight: 700, color: COLORS.text, fontVariantNumeric: 'tabular-nums',
                      textAlign: 'center',
                    }}
                    aria-label="Amount in USDC"
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
                  <span style={{ fontSize: 13, color: COLORS.muted }}>Available: <span style={{ color: COLORS.success, fontWeight: 600 }}>${formatAmount(selectedChain.claimable)}</span></span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {/* Live minimum hint — mirrors MultichainTransferPage's
                        own "Min $X" label next to its balance/Max row. Was
                        missing here entirely: below-minimum amounts only
                        ever surfaced as an error after the user tried to
                        proceed, never while they were still typing. */}
                    {claimAmt > 0 && claimAmt < MIN_CLAIM_AMOUNT && (
                      <span style={{ fontSize: 12, fontWeight: 700, color: COLORS.error }}>Min ${trimTrailingZeros(MIN_CLAIM_AMOUNT.toFixed(2))}</span>
                    )}
                    {selectedChain.claimable > 0 && (
                      <button
                        onClick={() => {
                          setClaimAmounts(prev => ({ ...prev, [selected!]: parseFloat(selectedChain.claimable.toFixed(2)).toString() }))
                          setError('')
                        }}
                        style={{
                          padding: '5px 14px', borderRadius: 100, border: `1px solid color-mix(in srgb, ${COLORS.primary} 40%, transparent)`,
                          background: `color-mix(in srgb, ${COLORS.primary} 12%, transparent)`, color: COLORS.primary, fontSize: 12, fontWeight: 700,
                          cursor: 'pointer',
                        }}
                      >
                        Max
                      </button>
                    )}
                  </div>
                </div>

                {/* BUG FIX (reorder, live report): "You will receive" now
                    renders here, ABOVE the Cancel/Confirm row below, instead
                    of after it -- so the fee summary is visible before the
                    user commits, not tucked under the button they just
                    pressed. */}
                {receiveSummaryCard}

                <div style={{ display: 'flex', gap: SPACING.sm, marginTop: 12 }}>
                  <button
                    onClick={() => { setSelected(null); setError(''); setAmountConfirmed(false); setKeypadOpen(false) }}
                    className="active:scale-[.98] transition-all"
                    style={{
                      flex: 1, padding: '14px', borderRadius: 16, border: `1px solid ${COLORS.border}`,
                      fontSize: 15, fontWeight: 600, cursor: 'pointer',
                      background: COLORS.surface, color: COLORS.muted,
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      const amt = parseFloat(claimAmounts[selected!] ?? '0') || 0
                      if (amt < MIN_CLAIM_AMOUNT) { setError(`Minimum $${trimTrailingZeros(MIN_CLAIM_AMOUNT.toFixed(2))}`); return }
                      if (amt > selectedChain.claimable) { setError('Exceeds available balance'); return }
                      // Desktop skips the separate "Confirm Amount" step —
                      // once a valid amount has a live fee estimate, this
                      // button IS the claim action (goes straight to
                      // passcode/execute via handleClaimTap), matching how
                      // desktop's other flows (Pay/Swap/Transfer) don't
                      // make the user confirm the amount and then confirm
                      // the claim as two separate clicks. Still gated on
                      // estimateReady (via canConfirm/disabled below) so the
                      // user never commits before seeing the real fee.
                      if (!estimateReady) return
                      handleClaimTap()
                    }}
                    disabled={!canConfirm}
                    className="active:scale-[.98] transition-all"
                    style={{
                      flex: 2, padding: '14px', borderRadius: 16, border: 'none',
                      fontSize: 15, fontWeight: 700, color: '#fff',
                      background: COLORS.primary, cursor: canConfirm ? 'pointer' : 'not-allowed', opacity: canConfirm ? 1 : 0.5,
                    }}
                  >
                    Claim ${formatAmount(claimAmt)} USDC
                  </button>
                </div>
              </div>
            )}

            {/* You will receive — small box, now fee-aware. Previously this
                always showed the raw claim amount with no fee subtracted at
                all — the first fee number anywhere on this page didn't
                appear until AFTER the user had entered their passcode and
                the claim was already executing. Rendered here (mobile, and
                desktop once amountConfirmed) — the desktop pre-confirm case
                renders the same `receiveSummaryCard` value above instead,
                see the reorder comment there. */}
            {!(isDesktop && !amountConfirmed) && receiveSummaryCard}

            {error && <p style={{ fontSize: 13, color: COLORS.error, margin: '16px 0 0', textAlign: 'center' }}>{error}</p>}
          </div>

          {/* Amount Keypad — mobile only now; desktop's own bare-box +
              Confirm Amount button above (isDesktop && !amountConfirmed)
              replaces this entirely, matching the other pages' treatment. */}
          {!isDesktop && (
            <div className="keypad-eraser-fix" onClick={e => e.stopPropagation()}>
              <AmountKeypad
                open={keypadOpen && !showPasscodeSheet && !amountConfirmed}
                value={claimAmounts[selected!] ?? ''}
                onChange={v => { setClaimAmounts(prev => ({ ...prev, [selected!]: v })); setError('') }}
                balance={selectedChain.claimable}
                token="USDC"
                quickAmounts={[10, 25, 50, 100]}
                doneLabel="Confirm Amount"
                // Confirm Amount only validates the amount itself
                // (min/max) — it no longer waits on the fee estimate.
                // The estimate is only actually needed once the user taps
                // the following "Claim $X USDC" button, which is where
                // that gate now lives (see the amountConfirmed block
                // below), so this step never sits disabled/dimmed just
                // because the estimate request hasn't come back yet.
                doneEnabled={true}
                // Live minimum hint on the keypad's own error/Max row —
                // was only ever surfaced as an error after tapping Confirm
                // Amount; now shows the moment a below-minimum amount is
                // typed, same as desktop's "Min $X" label.
                error={claimAmt > 0 && claimAmt < MIN_CLAIM_AMOUNT ? `Minimum $${trimTrailingZeros(MIN_CLAIM_AMOUNT.toFixed(2))}` : ''}
                onClose={() => setKeypadOpen(false)}
                onDone={() => {
                  const amt = parseFloat(claimAmounts[selected!] ?? '0') || 0
                  if (amt < MIN_CLAIM_AMOUNT) { setError(`Minimum $${trimTrailingZeros(MIN_CLAIM_AMOUNT.toFixed(2))}`); return }
                  if (amt > selectedChain.claimable) { setError('Exceeds available balance'); return }
                  setAmountConfirmed(true)
                  setKeypadOpen(false)
                }}
              />
            </div>
          )}

          {/* Cancel / Claim CTA — appears after amount is confirmed, before passcode */}
          {amountConfirmed && !showPasscodeSheet && (
            <motion.div
              initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25 }}
              style={{ flexShrink: 0, display: 'flex', gap: SPACING.sm, padding: `${SPACING.md}px ${SPACING.xl}px ${SPACING.xl}px` }}
            >
              <button
                onClick={() => { setSelected(null); setError(''); setAmountConfirmed(false); setKeypadOpen(false) }}
                className="active:scale-[.98] transition-all"
                style={{
                  flex: 1, padding: '14px', borderRadius: 16, border: `1px solid ${COLORS.border}`,
                  fontSize: 15, fontWeight: 600, cursor: 'pointer',
                  background: COLORS.surface, color: COLORS.muted,
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => { if (!estimateReady) return; handleClaimTap() }}
                disabled={!estimateReady}
                className="active:scale-[.98] transition-all"
                style={{
                  flex: 2, padding: '14px', borderRadius: 16, border: 'none',
                  fontSize: 15, fontWeight: 700,
                  cursor: estimateReady ? 'pointer' : 'not-allowed',
                  background: COLORS.primary, color: '#fff',
                  opacity: estimateReady ? 1 : 0.5,
                }}
              >
                Claim ${formatAmount(selectedTotal)} USDC
              </button>
            </motion.div>
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
                        ? <span style={{ color: COLORS.error }}>Incorrect passcode. Try again.</span>
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
                  {passError && <p style={{ fontSize: 12, color: COLORS.error, textAlign: 'center', marginTop: 16 }}>{passError}</p>}
                </>
              )

              if (isDesktop) {
                return (
                  <DesktopTransactionAuthDialog
                    onClose={() => { setShowPasscodeSheet(false); setPassEntry(''); setPassError('') }}
                    title="Authorize Claim"
                    amountLabel={`$${formatAmount(selectedTotal)} USDC`}
                    subLabel={`From ${selectedChain ? getMeta(selectedChain.chainId).label : 'Multichain'}`}
                  >
                    {passError && <p style={{ fontSize: 12, color: COLORS.error, textAlign: 'center', marginBottom: 16 }}>Incorrect passcode. Try again.</p>}
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
                    transition={{ duration: 0.2 }}
                    onClick={() => { setShowPasscodeSheet(false); setPassEntry(''); setPassError('') }}
                    style={{ position: 'fixed', top: 0, bottom: 0, left: 0, right: 0, maxWidth: 430, margin: '0 auto', zIndex: 60, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)' }}
                  />
                  <motion.div
                    key="pass-sheet"
                    initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
                    transition={{ type: 'spring', damping: 32, stiffness: 300 }}
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
          <AnimatePresence mode="wait">
          {(confirmPhase === 'processing' || confirmPhase === 'submitted') && (() => {
            const isSubmittedNow = confirmPhase === 'submitted'
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
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
            >
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: `${SPACING.xl}px ${SPACING.md}px`, gap: SPACING.md, overflowY: 'auto', minHeight: 0 }}>

                {/* Icon + title — swaps once submitted, stepper below does not reset */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', marginBottom: SPACING.lg }}>
                  <motion.div
                    animate={{ scale: isSubmittedNow ? [0.7, 1] : 1 }}
                    transition={{ type: 'spring', stiffness: 260, damping: 18 }}
                    style={{
                      width: 64, height: 64, borderRadius: '50%', marginBottom: 14,
                      background: 'color-mix(in srgb, var(--brand) 15%, transparent)', border: isSubmittedNow ? `2px solid ${COLORS.primary}` : 'none',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative',
                    }}
                  >
                    {isSubmittedNow ? (
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={COLORS.primary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/>
                      </svg>
                    ) : (
                      <>
                        <motion.div
                          animate={{ rotate: 360 }}
                          transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}
                          style={{ position: 'absolute', inset: -2, borderRadius: '50%', border: '2px solid color-mix(in srgb, var(--brand) 25%, transparent)', borderTopColor: COLORS.primary }}
                        />
                        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={COLORS.primary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 5v14M5 12l7 7 7-7"/>
                        </svg>
                      </>
                    )}
                  </motion.div>
                  <p style={{ fontSize: 17, fontWeight: 500, color: COLORS.text, margin: '0 0 4px' }}>
                    {isSubmittedNow ? 'Claim Submitted' : 'Processing claim'}
                  </p>
                  <p style={{ fontSize: 13, color: COLORS.muted, margin: 0 }}>
                    ${formatAmount(displayTotal)} USDC · {chainProgress.length} chain{chainProgress.length !== 1 ? 's' : ''}
                  </p>
                </div>

                {/* Stepper — same checklist throughout, never resets */}
                <div style={{
                  background: COLORS.surface, border: `1px solid ${COLORS.border}`,
                  borderRadius: 16, padding: '18px 18px 18px 16px',
                }}>
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

                {/* Fades in only once actually submitted */}
                {isSubmittedNow ? (
                  <motion.div
                    initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
                    style={{ display: 'flex', flexDirection: 'column', gap: SPACING.sm, marginTop: 4 }}
                  >
                    <p style={{ fontSize: 13, color: COLORS.muted, margin: '0 0 2px', textAlign: 'center', lineHeight: 1.5 }}>
                      MeshPort is processing your claim.
                    </p>
                    <p style={{ fontSize: 13, color: COLORS.muted, margin: '0 0 2px', textAlign: 'center', lineHeight: 1.5 }}>
                      You may safely leave this page.
                    </p>
                    <p style={{ fontSize: 14, fontWeight: 600, color: COLORS.primary, margin: '0 0 12px', textAlign: 'center' }}>
                      Returning to Multichain Hub in {homeCountdown}s…
                    </p>
                    <div style={{ display: 'flex', flexDirection: 'row', gap: SPACING.sm }}>
                      <button
                        onClick={() => navigate('/multichain')}
                        style={{ flex: 1, minWidth: 0, padding: `${SPACING.lg}px`, borderRadius: RADII.button, border: 'none', fontSize: 15, fontWeight: 700, color: '#fff', background: COLORS.primary, cursor: 'pointer' }}
                      >
                        View in Hub
                      </button>
                      <button
                        onClick={() => setConfirmPhase('tracking')}
                        style={{ flex: 1, minWidth: 0, padding: `${SPACING.lg}px`, borderRadius: RADII.button, border: `1px solid ${COLORS.border}`, background: 'transparent', fontSize: 15, fontWeight: 700, color: COLORS.text, cursor: 'pointer' }}
                      >
                        Track Progress
                      </button>
                    </div>
                  </motion.div>
                ) : (
                  <p style={{ fontSize: 12, color: COLORS.muted, textAlign: 'center', margin: '4px 0 0' }}>
                    Please wait — don't close this screen yet
                  </p>
                )}
              </div>
            </motion.div>
            )
          })()}

          {/* TRACKING — same page, driven entirely by Supabase Realtime */}
          {confirmPhase === 'tracking' && (
            <motion.div
              key="claim-tracking-step"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', padding: `${SPACING.md}px ${SPACING.md}px`, flexShrink: 0 }}>
                {!isDesktop && (
                  <button onClick={() => navigate('/multichain')} style={{ position: 'absolute', left: SPACING.md, background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: COLORS.text, display: 'flex', alignItems: 'center' }}>
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
                  </div>
                ))}
              </div>

              <div style={{ flexShrink: 0, display: 'flex', gap: SPACING.sm, padding: `${SPACING.md}px ${SPACING.xl}px ${SPACING.xl}px` }}>
                <button onClick={() => navigate('/multichain')} style={{ flex: 1, padding: `${SPACING.md}px`, borderRadius: RADII.button, border: `1px solid ${COLORS.border}`, background: 'transparent', fontSize: 13, fontWeight: 600, color: COLORS.muted, cursor: 'pointer' }}>
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
          {confirmPhase === 'done' && (() => {
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
            // All per-chain CCTP fees (the real maxFee each chain's burn
            // signed, reported live by backgroundBridge) rolled into one
            // number for the "Total Fees" row — same treatment
            // MultichainTransferPage's transfer success screen gives its own
            // totalFeesLabel.
            const totalFeesLabel = `${trimTrailingZeros(Object.values(claimFees).reduce((sum, f) => sum + f, 0).toFixed(4))} USDC`
            // Real "gas MeshPort covered" figure — sums claimGasWei (actual
            // wei the relay transferred, per chain) against a live mainnet
            // price for that chain's native token (NATIVE_GAS_COINGECKO_ID),
            // never a hardcoded/example number. A chain is silently skipped
            // — not shown as $0 — if either its funded amount is still 0
            // (nothing needed funding this claim, e.g. wallet already had
            // gas) or its price hasn't loaded/has no mapping; the row itself
            // only renders once at least one chain actually priced out,
            // so it never shows a misleading "$0.00 covered".
            let gasCoveredUsd = 0
            for (const [chainId, wei] of Object.entries(claimGasWei)) {
              const cgId = NATIVE_GAS_COINGECKO_ID[chainId]
              const price = cgId ? nativeUsdPrices[cgId] : undefined
              if (!price || wei <= 0n) continue
              gasCoveredUsd += Number(wei) / 1e18 * price
            }
            const gasCoveredLabel = gasCoveredUsd > 0
              ? (gasCoveredUsd < 0.01 ? '<$0.01' : `$${trimTrailingZeros(gasCoveredUsd.toFixed(2))}`)
              : null
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
              {successPhase === 'flash' && createPortal(
                // Portalled straight to <body> — same fix as SwapPage/
                // PaySendPage's identical flash overlay: PageTransition's
                // motion.div (wraps every route, desktop included) leaves a
                // non-`none` transform on itself from animating `y`, making
                // it the containing block for any `position: fixed`
                // descendant instead of the real viewport. Desktop's claim
                // flow also sits inside its own extra scrollable column
                // below, so without this the overlay could render sized/
                // positioned to that scrolled box instead of the screen.
                <div style={{
                  position: 'fixed',
                  ...(isDesktop && flashColumnRect
                    ? { top: flashColumnRect.top, left: flashColumnRect.left, width: flashColumnRect.width, height: flashColumnRect.height, borderRadius: RADII.card }
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
                  <p style={{ fontSize: 22, fontWeight: 700, color: '#fff', margin: 0 }}>Claimed Successfully</p>
                </div>,
                document.body
              )}

              {travelRect && !travelDone && (
                <TravelingCheckmark from={travelRect.from} to={travelRect.to} />
              )}

              {successPhase === 'collapsed' && (
              <div style={{ margin: isDesktop ? 0 : '0', height: '100%', overflowY: 'auto' }}>
                {/* Hidden SVG def: smooth elliptical-arc clip path for the
                    hero's scalloped bottom border — same curve Swap's own
                    hero card uses. */}
                <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
                  <defs>
                    <clipPath id="claimHeroBottomClip" clipPathUnits="objectBoundingBox">
                      <path d="M0,0 L1,0 L1,0.75 L0.826,0.75 C0.805,0.75 0.805,0.859 0.755,0.859 L0.245,0.859 C0.195,0.859 0.195,0.75 0.174,0.75 L0,0.75 Z" />
                    </clipPath>
                  </defs>
                </svg>

                {/* ─── Hero: back + title, success badge, Credited, amount, network, completion pill ─── */}
                <div style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                  background: 'var(--brand)',
                  paddingTop: 'calc(env(safe-area-inset-top, 0px) + clamp(12px, 2.5vh, 20px))', paddingBottom: 'clamp(37px, 6.7vh, 52px)',
                  paddingLeft: 'clamp(13px, 3.7vw, 16px)', paddingRight: 'clamp(13px, 3.7vw, 16px)',
                  clipPath: 'url(#claimHeroBottomClip)',
                }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '40px 1fr 40px', alignItems: 'center', width: '100%', marginBottom: 'clamp(4px, 1.3vh, 13px)' }}>
                    {!isDesktop ? (
                      <button onClick={() => navigate('/')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: '#FFFFFF', display: 'flex', justifySelf: 'start' }}>
                        <ArrowLeft style={{ width: 24, height: 24 }} />
                      </button>
                    ) : <span />}
                    <h1 style={{ fontSize: 'clamp(16.5px, 4.8vw, 22px)', fontWeight: 700, color: '#FFFFFF', textAlign: 'center', margin: 0 }}>Claim Successful!</h1>
                    <span />
                  </div>

                  <div ref={heroCheckRef} style={{ position: 'relative', width: 'clamp(55px, 14.5vw, 67px)', height: 'clamp(55px, 14.5vw, 67px)', borderRadius: '50%', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, margin: 'clamp(4px, 0.9vh, 8px) 0', opacity: travelDone ? 1 : 0 }}>
                    <ClaimSparkle size={11} style={{ top: '4%', left: '-40%' }} />
                    <ClaimSparkle size={6.6} style={{ top: '70%', left: '-32%' }} />
                    <ClaimSparkle size={11} style={{ top: '2%', right: '-42%' }} />
                    <ClaimSparkle size={6.6} style={{ top: '68%', right: '-30%' }} />
                    {paidViaBiometric && travelDone ? (
                      <FlashAuthIcon key="landing-toggle" viaBiometric loop size={28} color="var(--brand)" />
                    ) : (
                      <svg viewBox="0 0 24 24" width="46%" height="46%" fill="none" stroke="var(--brand)" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </div>

                  <motion.div initial={false} animate={travelDone ? { opacity: 1, y: 0 } : { opacity: 0, y: -14 }} transition={{ duration: 0.4, delay: travelDone ? 0.1 : 0, ease: [0.2, 0.8, 0.2, 1] }}
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 'clamp(5.4px, 1.08vh, 10.8px)', paddingBottom: 'clamp(5.4px, 1.08vh, 10.8px)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'rgba(255,255,255,0.92)' }}>
                      <ArrowDownToLine style={{ width: 16, height: 16 }} />
                      <span style={{ fontSize: 'clamp(14.3px, 4.09vw, 16.5px)', fontWeight: 600 }}>Credited</span>
                    </div>

                    <p style={{ fontSize: 'clamp(26.6px, 8.17vw, 36.1px)', fontWeight: 800, color: '#FFFFFF', margin: 'clamp(7.2px, 1.44vh, 12.6px) 0 0', lineHeight: 1 }}>{fmtAmount}</p>

                    <p style={{ fontSize: 'clamp(13.8px, 3.82vw, 16.5px)', color: 'rgba(255,255,255,0.75)', margin: 'clamp(5.4px,1.08vh,10.8px) 0 0', textAlign: 'center', lineHeight: 1.4 }}>
                      has been credited to your<br/>Arc Testnet balance.
                    </p>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'rgba(255,255,255,0.14)', padding: 'clamp(4.3px,0.94vh,5.1px) clamp(7.8px,2.1vw,10.2px)', borderRadius: 999, marginTop: 'clamp(9px,1.8vh,14.4px)' }}>
                      <Zap style={{ width: 12, height: 12, color: '#FFD54A' }} fill="#FFD54A" />
                      <span style={{ fontSize: 'clamp(11.1px, 2.91vw, 12.8px)', fontWeight: 600, color: '#FFFFFF' }}>Completed in {claimElapsedSeconds} Seconds</span>
                    </div>
                  </motion.div>
                </div>

                {/* ─── Transaction details card followed by success actions. Details expand naturally; actions remain in normal flow. ─── */}
                <motion.div initial={false} animate={travelDone ? { opacity: 1, y: 0 } : { opacity: 0, y: -14 }} transition={{ duration: 0.4, delay: travelDone ? 0.2 : 0, ease: [0.2, 0.8, 0.2, 1] }}
                  style={{ paddingLeft: 'clamp(16px, 4.5vw, 20px)', paddingRight: 'clamp(16px, 4.5vw, 20px)', marginTop: 'calc(-1 * clamp(37px, 6.7vh, 52px) + 20px)' }}>

                  <div className="shadow-elevation-1" style={{
                    background: 'var(--surface)', border: '1px solid var(--border)',
                    borderTopLeftRadius: 'clamp(16.2px, 4.05vw, 19.8px)', borderTopRightRadius: 'clamp(16.2px, 4.05vw, 19.8px)',
                    borderBottomLeftRadius: 'clamp(14.4px, 3.6vw, 18px)', borderBottomRightRadius: 'clamp(14.4px, 3.6vw, 18px)',
                    padding: '0 clamp(14.4px, 3.6vw, 18px)', marginBottom: 'clamp(20px, 4vh, 28px)',
                  }}>
                    <ClaimDetailRow icon={<FileText className="w-4 h-4" />} label="Transaction Hash" value={shortHash} mono onCopy={txHash ? () => copyClaimHash(txHash) : undefined} copied={hashCopied} showDivider />
                    <ClaimDetailRow
                      icon={fromChainIds.length === 1 ? <ChainLogo chainId={fromChainIds[0]} size={20} /> : <Globe className="w-4 h-4" />}
                      label={fromChainIds.length === 1 ? 'From Chain' : 'From Chains'}
                      value={fromChainIds.length === 1 ? getMeta(fromChainIds[0]).label : `${fromChainIds.length} chains`}
                      showDivider
                    />
                    <ClaimDetailRow icon={<Globe className="w-4 h-4" />} label="To Chain" value="Arc Testnet" showDivider />
                    <ClaimDetailRow icon={<Clock className="w-4 h-4" />} label="Time" value={timeLabel} showDivider last />

                    {/* Expandable "Process" checklist — same stages the
                        Track Progress screen tracks (bridging → verifying →
                        settling → completed), shown as already-completed
                        steps. */}
                    <AnimatePresence initial={false}>
                      {showProcessDetails && (
                        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }} style={{ overflow: 'hidden' }}>
                          <div style={{ borderTop: '1px solid var(--border)' }}>
                            <ClaimDetailRow icon={<Receipt className="w-4 h-4" />} label="Total Fees" value={totalFeesLabel} showDivider={!!gasCoveredLabel} />
                            {/* Label explicitly names MeshPort — "Gas
                                Covered" alone didn't say WHO covered it.
                                Shared by both mobile and desktop: this
                                whole `flow` tree (including this row) is
                                the same JSX rendered in both, desktop just
                                places it in the left column next to Recent
                                History (see `if (!isDesktop) return flow`
                                below and its desktop branch right after —
                                neither branches or duplicates this block). */}
                            {gasCoveredLabel && (
                              <ClaimDetailRow icon={<Fuel className="w-4 h-4" />} label="Gas Covered by MeshPort" value={gasCoveredLabel} />
                            )}
                          </div>
                          <div style={{ paddingTop: 'clamp(11.7px, 2.565vh, 16.2px)', paddingBottom: 'clamp(10.5px, 2.31vh, 14.6px)', borderTop: '1px solid var(--border)' }}>
                            <p style={{ fontSize: 'clamp(11.6px, 3.18vw, 12.8px)', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.4, margin: '0 0 clamp(9px, 2vh, 12.6px)' }}>Process</p>
                            {processSteps.map((s, i) => (
                              <ClaimProcessStep key={s.key} text={<>{s.subtitle}</>} last={i === processSteps.length - 1} />
                            ))}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    <button onClick={() => setShowProcessDetails(v => !v)}
                      style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', padding: 'clamp(9px, 2vh, 11.7px) 0', borderTop: showProcessDetails ? '1px solid var(--border)' : 'none' }}>
                      <span style={{ fontSize: 'clamp(12.8px, 3.4vw, 13.8px)', fontWeight: 600, color: 'var(--text-primary)' }}>{showProcessDetails ? 'Hide details' : 'More details'}</span>
                      <ChevronDown style={{ width: 14, height: 14, color: 'var(--text-secondary)', transform: showProcessDetails ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease' }} />
                    </button>
                  </div>

                  {/* ─── Success actions + explorer links ─── */}
                  <div style={{ position: 'relative', background: COLORS.bg, paddingBottom: 'clamp(20px, 4vh, 28px)' }}>
                    {/* One source (burn) + destination (Arc mint) link pair per
                        claimed chain, each rendered as a circular icon button
                        matching Swap's own explorer-link style. */}
                    {chainProgress.map(p => {
                      const burnHref = explorerTxUrl(p.chainId, p.txHash)
                      // ONLY link the mint when there's a genuine Arc-side mint
                      // hash. p.txHash is the SOURCE-chain burn hash, so the
                      // old `|| p.txHash` fallback produced an Arc-explorer
                      // link to a tx that only exists on the source chain
                      // ("transaction not found"). claim-worker fills
                      // destination_tx_hash (→ p.mintTxHash) once it sees the
                      // mint land on Arc; until then, just show the burn link.
                      const mintHref = arcExplorerTxUrl(p.mintTxHash)
                      if (!burnHref && !mintHref) return null
                      const label = getMeta(p.chainId).label
                      return (
                        <div key={p.chainId} style={{ display: 'flex', justifyContent: 'center', gap: 'clamp(43.2px, 15.3vw, 72px)', paddingTop: 'clamp(16.2px, 3.06vh, 23.4px)', marginBottom: 'clamp(16.2px, 3.06vh, 23.4px)' }}>
                          {burnHref && (
                            <a href={burnHref} target="_blank" rel="noopener noreferrer"
                              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, textDecoration: 'none' }}>
                              <span style={{ width: 'clamp(43.2px, 11.7vw, 50.4px)', height: 'clamp(43.2px, 11.7vw, 50.4px)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--brand)' }}>
                                <ExternalLink style={{ width: 18, height: 18 }} />
                              </span>
                              <span style={{ fontSize: 'clamp(11.6px, 3.08vw, 12.8px)', color: 'var(--text-primary)', textAlign: 'center', lineHeight: 1.35 }}>View Burn on<br />{label}</span>
                            </a>
                          )}
                          {mintHref && (
                            <a href={mintHref} target="_blank" rel="noopener noreferrer"
                              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, textDecoration: 'none' }}>
                              <span style={{ width: 'clamp(43.2px, 11.7vw, 50.4px)', height: 'clamp(43.2px, 11.7vw, 50.4px)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--brand)' }}>
                                <ExternalLink style={{ width: 18, height: 18 }} />
                              </span>
                              <span style={{ fontSize: 'clamp(11.6px, 3.08vw, 12.8px)', color: 'var(--text-primary)', textAlign: 'center', lineHeight: 1.35 }}>View Mint on<br />Arc Explorer</span>
                            </a>
                          )}
                        </div>
                      )
                    })}

                    {/* View in Hub / Back to Home */}
                    <div style={{ display: 'flex', gap: 'clamp(10px, 3vw, 14px)', width: '100%', maxWidth: isDesktop ? 560 : 'none', margin: '0 auto', boxSizing: 'border-box' }}>
                      <button onClick={() => navigate('/multichain')}
                        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, height: 'clamp(48px, 13vw, 56px)', borderRadius: 16, border: '1.5px solid var(--brand)', background: 'transparent', color: 'var(--brand)', fontSize: 'clamp(13.8px, 3.6vw, 14.8px)', fontWeight: 700, cursor: 'pointer' }}>
                        <RotateCcw className="w-4 h-4" /> View in Hub
                      </button>
                      <button onClick={() => navigate('/')}
                        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, height: 'clamp(48px, 13vw, 56px)', borderRadius: 16, border: '1px solid color-mix(in srgb, black 12%, transparent)', background: 'var(--brand)', color: '#FFFFFF', fontSize: 'clamp(13.8px, 3.6vw, 14.8px)', fontWeight: 700, cursor: 'pointer' }}>
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
          {error && <p style={{ fontSize: 13, color: COLORS.muted, margin: '0 0 28px', textAlign: 'center', maxWidth: '100%' }}>{error}</p>}
          <div style={{ display: 'flex', gap: SPACING.sm, width: '100%' }}>
            <button onClick={() => { setStep('select'); setError(''); setPassEntry(''); setSelected(null); setConfirmPhase('processing'); setIsSubmitted(false); setShowPasscodeSheet(false); setAmountConfirmed(false); setClaimRecords([]); setClaimsByStatus({}); setSearchParams(new URLSearchParams(), { replace: true }) }} style={{ flex: 1, padding: `${SPACING.lg}px`, borderRadius: RADII.button, border: 'none', fontSize: 14, fontWeight: 600, color: '#fff', background: COLORS.primary, cursor: 'pointer' }}>
              Try Again
            </button>
            <button onClick={() => navigate('/')} style={{ flex: 1, padding: `${SPACING.lg}px`, borderRadius: RADII.button, border: `1px solid ${COLORS.border}`, background: 'transparent', fontSize: 14, fontWeight: 600, color: COLORS.muted, cursor: 'pointer' }}>
              Go Home
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
        <DesktopHistoryPanel title="Recent History" onViewAll={() => navigate('/multichain')}>
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
