import type { SettingsMap } from './adminSupabase'

// Maps the UI's internal coin/chain identifiers to the app_settings.feature keys
// the Admin Panel toggles. Add new coins/chains here as they're introduced.
export const COIN_FEATURE_MAP: Record<string, string> = {
  USDC:   'usdc_enabled',
  EURC:   'eurc_enabled',
  cirBTC: 'cirbtc_enabled',
  USDT:   'usdt_enabled',
}

// ─── Multichain Transfer chains ─────────────────────────────────────────────
// Keyed by the short id MultichainTransferPage uses internally (e.g. `eth`).
// Each chain has its OWN toggle here, independent of Claim - disabling a
// chain for Transfer does NOT affect whether it can still be Claimed, and
// vice versa.
export const CHAIN_TRANSFER_FEATURE_MAP: Record<string, string> = {
  eth:       'ethereum_transfer_enabled',
  sol:       'solana_transfer_enabled',
  base:      'base_transfer_enabled',
  arb:       'arbitrum_transfer_enabled',
  pol:       'polygon_transfer_enabled',
  op:        'optimism_transfer_enabled',
  avax:      'avalanche_transfer_enabled',
  hyperevm:  'hyperevm_transfer_enabled',
  sei:       'sei_transfer_enabled',
  sonic:     'sonic_transfer_enabled',
  unichain:  'unichain_transfer_enabled',
  world:     'world_chain_transfer_enabled',
  linea:     'linea_transfer_enabled',
  ink:       'ink_transfer_enabled',
  monad:     'monad_transfer_enabled',
  morph:     'morph_transfer_enabled',
  pharos:    'pharos_transfer_enabled',
  plume:     'plume_transfer_enabled',
  xdc:       'xdc_transfer_enabled',
  codex:     'codex_transfer_enabled',
  edge:      'edge_transfer_enabled',
  injective: 'injective_transfer_enabled',
}

// ─── Multichain Claim chains ─────────────────────────────────────────────────
// Keyed by the Circle SDK-style id MultichainClaimPage / the Hub use
// internally (e.g. `Ethereum_Sepolia`). Independent from Transfer - see above.
export const CHAIN_CLAIM_FEATURE_MAP: Record<string, string> = {
  Ethereum_Sepolia:      'ethereum_claim_enabled',
  Solana_Devnet:         'solana_claim_enabled',
  Base_Sepolia:          'base_claim_enabled',
  Arbitrum_Sepolia:      'arbitrum_claim_enabled',
  Polygon_Sepolia:       'polygon_claim_enabled',
  Polygon_Amoy_Testnet:  'polygon_claim_enabled', // alias - same chain, alt id
  Optimism_Sepolia:      'optimism_claim_enabled',
  Avalanche_Fuji:        'avalanche_claim_enabled',
  HyperEVM_Testnet:      'hyperevm_claim_enabled',
  Sei_Testnet:           'sei_claim_enabled',
  Sonic_Testnet:         'sonic_claim_enabled',
  Unichain_Sepolia:      'unichain_claim_enabled',
  World_Chain_Sepolia:   'world_chain_claim_enabled',
  Linea_Sepolia:         'linea_claim_enabled',
  Ink_Testnet:           'ink_claim_enabled',
  Monad_Testnet:         'monad_claim_enabled',
  Morph_Testnet:         'morph_claim_enabled',
  Pharos_Testnet:        'pharos_claim_enabled',
  Plume_Testnet:         'plume_claim_enabled',
  XDC_Apothem:           'xdc_claim_enabled',
  Codex_Testnet:         'codex_claim_enabled',
  Edge_Testnet:          'edge_claim_enabled',
  Injective_Testnet:     'injective_claim_enabled',
}

// ─── Transfer routes: Unified Balance (Circle Gateway) and CCTP ──────────────
// Only the chains with a Unified Balance path have route switches; every
// other Transfer chain is CCTP only, so its chain switch is all there is.
export const CHAIN_UB_FEATURE_MAP: Record<string, string> = {
  eth:      'ethereum_ub_enabled',
  base:     'base_ub_enabled',
  arb:      'arbitrum_ub_enabled',
  pol:      'polygon_ub_enabled',
  op:       'optimism_ub_enabled',
  avax:     'avalanche_ub_enabled',
  hyperevm: 'hyperevm_ub_enabled',
  sei:      'sei_ub_enabled',
  sonic:    'sonic_ub_enabled',
  unichain: 'unichain_ub_enabled',
  world:    'world_chain_ub_enabled',
  sol:      'solana_ub_enabled',
}

export const CHAIN_CCTP_OVERRIDE_FEATURE_MAP: Record<string, string> = {
  eth:      'ethereum_cctp_enabled',
  base:     'base_cctp_enabled',
  arb:      'arbitrum_cctp_enabled',
  pol:      'polygon_cctp_enabled',
  op:       'optimism_cctp_enabled',
  avax:     'avalanche_cctp_enabled',
  hyperevm: 'hyperevm_cctp_enabled',
  sei:      'sei_cctp_enabled',
  sonic:    'sonic_cctp_enabled',
  unichain: 'unichain_cctp_enabled',
  world:    'world_chain_cctp_enabled',
  sol:      'solana_cctp_enabled',
}

// ─── Personal and Business accounts: separate switches ───────────────────────
// Every chain switch exists twice: once for personal accounts (the original
// keys above) and once for business accounts (the same key with a `biz_`
// prefix). Turning a chain or a route off for one kind of account never
// touches the other.
//
//   Transfer  chain  <c>_transfer_enabled      biz_<c>_transfer_enabled
//             UB     <c>_ub_enabled            biz_<c>_ub_enabled
//             CCTP   <c>_cctp_enabled          biz_<c>_cctp_enabled
//   Bring     chain  <c>_claim_enabled         biz_<c>_claim_enabled
//             UB     <c>_claim_ub_enabled      biz_<c>_claim_ub_enabled
//             CCTP   <c>_claim_cctp_enabled    biz_<c>_claim_cctp_enabled
//   Settle    chain  -                         biz_<c>_settle_enabled  (CCTP)
//
// No overrides and no fallbacks: a route is offered only when its own switch
// is on (and the chain can do it), and a chain is offered only when its
// switch is on and at least one of its routes is. Both routes off = the chain
// is off. A switch whose row hasn't loaded yet counts as on - except the
// Transfer CCTP route on Unified Balance chains, which has always started off
// (Solana: on) - so nothing breaks before the rows exist.

export type AccountKind = 'personal' | 'business'
export type Route = 'ub' | 'cctp'

const prefix = (kind: AccountKind) => (kind === 'business' ? 'biz_' : '')
/** `ethereum_transfer_enabled` → `ethereum`. */
const chainBase = (feature: string | undefined, suffix: string) =>
  feature && feature.endsWith(suffix) ? feature.slice(0, -suffix.length) : null

const on = (settings: SettingsMap, feature: string | null, dflt = true) => {
  if (!feature) return dflt
  const row = settings[feature]
  return row ? row.enabled : dflt
}

// Chains whose Transfer CCTP route is on until a row says otherwise.
const CCTP_DEFAULT_ON = new Set(['sol'])

/** The setting keys for one chain, for one kind of account. */
export function transferKeys(kind: AccountKind, chainId: string) {
  const c = chainBase(CHAIN_TRANSFER_FEATURE_MAP[chainId], '_transfer_enabled')
  const ub = chainBase(CHAIN_UB_FEATURE_MAP[chainId], '_ub_enabled')
  const p = prefix(kind)
  return {
    chain: c ? `${p}${c}_transfer_enabled` : null,
    ub: ub ? `${p}${ub}_ub_enabled` : null,
    cctp: ub ? `${p}${ub}_cctp_enabled` : null,
  }
}
export function bringKeys(kind: AccountKind, sdkChainId: string) {
  const c = chainBase(CHAIN_CLAIM_FEATURE_MAP[sdkChainId], '_claim_enabled')
  const p = prefix(kind)
  return {
    chain: c ? `${p}${c}_claim_enabled` : null,
    ub: c ? `${p}${c}_claim_ub_enabled` : null,
    cctp: c ? `${p}${c}_claim_cctp_enabled` : null,
  }
}
export function settleKey(sdkChainId: string): string | null {
  const c = chainBase(CHAIN_CLAIM_FEATURE_MAP[sdkChainId], '_claim_enabled')
  return c ? `biz_${c}_settle_enabled` : null
}

// ─── Transfer ────────────────────────────────────────────────────────────────
/**
 * The routes Transfer offers to `chainId` for this kind of account, Unified
 * Balance first. Empty = the chain is off. A chain without a Unified Balance
 * path is CCTP only: its chain switch alone decides.
 */
export function transferRoutes(settings: SettingsMap, chainId: string, kind: AccountKind = 'personal'): Route[] {
  const k = transferKeys(kind, chainId)
  if (!on(settings, k.chain)) return []
  if (!k.ub) return ['cctp']
  const routes: Route[] = []
  if (on(settings, k.ub)) routes.push('ub')
  if (on(settings, k.cctp, CCTP_DEFAULT_ON.has(chainId))) routes.push('cctp')
  return routes
}

export function isChainEnabledForTransfer(settings: SettingsMap, chainId: string, kind: AccountKind = 'personal'): boolean {
  return transferRoutes(settings, chainId, kind).length > 0
}

// ─── Bring ───────────────────────────────────────────────────────────────────
/**
 * The routes Bring offers from `sdkChainId` for this kind of account. `can`
 * is what the chain itself supports right now (Unified Balance chain, a
 * gasless CCTP router); without it, only the switches are read.
 */
export function bringRoutes(settings: SettingsMap, sdkChainId: string, kind: AccountKind = 'personal',
  can: { ub: boolean; cctp: boolean } = { ub: true, cctp: true }): Route[] {
  const k = bringKeys(kind, sdkChainId)
  if (!on(settings, k.chain)) return []
  const routes: Route[] = []
  if (can.ub && on(settings, k.ub)) routes.push('ub')
  if (can.cctp && on(settings, k.cctp)) routes.push('cctp')
  return routes
}

export function isChainEnabledForBring(settings: SettingsMap, sdkChainId: string, kind: AccountKind = 'personal',
  can?: { ub: boolean; cctp: boolean }): boolean {
  return bringRoutes(settings, sdkChainId, kind, can).length > 0
}

// ─── Settle (business) ───────────────────────────────────────────────────────
/** Business Settle / Claim All from `sdkChainId` (always CCTP). */
export function isChainEnabledForSettle(settings: SettingsMap, sdkChainId: string): boolean {
  return on(settings, settleKey(sdkChainId))
}

/**
 * Chains whose balance is worth reading at all: what this account can Bring,
 * and for a business also what it can Settle. Each screen then applies its
 * own list (Bring, Settle) on top.
 */
export function isChainEnabledForClaim(settings: SettingsMap, sdkChainId: string, kind: AccountKind = 'personal'): boolean {
  return isChainEnabledForBring(settings, sdkChainId, kind)
    || (kind === 'business' && isChainEnabledForSettle(settings, sdkChainId))
}

// Defaults to ON if the row hasn't loaded yet / doesn't exist - never breaks
// the app before the migration has been run.
export function isCoinEnabled(settings: SettingsMap, coinId: string): boolean {
  const feature = COIN_FEATURE_MAP[coinId]
  if (!feature) return true
  const row = settings[feature]
  if (!row) return true
  return row.enabled
}
