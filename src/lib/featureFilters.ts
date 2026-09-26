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
// Each chain has its OWN toggle here, independent of Claim — disabling a
// chain for Transfer does NOT affect whether it can still be Claimed, and
// vice versa.
export const CHAIN_TRANSFER_FEATURE_MAP: Record<string, string> = {
  eth:       'ethereum_transfer_enabled',
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
// internally (e.g. `Ethereum_Sepolia`). Independent from Transfer — see above.
export const CHAIN_CLAIM_FEATURE_MAP: Record<string, string> = {
  Ethereum_Sepolia:      'ethereum_claim_enabled',
  Base_Sepolia:          'base_claim_enabled',
  Arbitrum_Sepolia:      'arbitrum_claim_enabled',
  Polygon_Sepolia:       'polygon_claim_enabled',
  Polygon_Amoy_Testnet:  'polygon_claim_enabled', // alias — same chain, alt id
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

// ─── UB (Circle Gateway) vs CCTP mechanism override ───────────────────────────
// Which bridge mechanism a chain uses is normally a hardcoded constant per
// chain (`chain.ub` in MultichainTransferPage.tsx's CHAINS list) — these two maps
// let the Admin Panel override that per chain, WITHOUT changing what happens
// today: every row is seeded with `<chain>_ub_enabled = true` and
// `<chain>_cctp_enabled = false`, i.e. exactly what's hardcoded already.
// Only covers the 11 chains that actually have a working UB path at all
// (the rest are CCTP-only and have nothing to override) — see
// supabase-chains-ub-cctp-override.sql.
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
}

// Resolves the EFFECTIVE mechanism for a chain that statically supports UB
// (i.e. its CHAINS entry has ub: true). Defaults reproduce today's exact
// behavior (UB active, nothing changes) until the Admin Panel toggles are
// used — see supabase-chains-ub-cctp-override.sql's header comment for the
// full priority order and reasoning:
//   1. CCTP override toggle ON  → 'cctp' (explicit admin override)
//   2. UB toggle ON (default)   → 'ub'   (today's behavior, unchanged)
//   3. both OFF                 → 'cctp' (never leave a chain with no path)
export function resolveChainMechanism(settings: SettingsMap, chainId: string): 'ub' | 'cctp' {
  const cctpFeature = CHAIN_CCTP_OVERRIDE_FEATURE_MAP[chainId]
  if (cctpFeature && settings[cctpFeature]?.enabled) return 'cctp'
  const ubFeature = CHAIN_UB_FEATURE_MAP[chainId]
  if (!ubFeature) return 'ub' // not a UB-capable chain's id — shouldn't be called, but stay safe
  const ubRow = settings[ubFeature]
  if (!ubRow) return 'ub' // row not loaded/seeded yet — preserve current default
  return ubRow.enabled ? 'ub' : 'cctp'
}

// Independent-availability version of resolveChainMechanism above, for the
// Multichain Transfer route picker (below the amount box): instead of always
// collapsing to a single mechanism, this reports EVERY mechanism the Admin
// Panel currently has switched on for the chain, so the UI can offer a
// choice between them when more than one is available.
//
//   - Not a UB-capable chain at all (no entry in CHAIN_UB_FEATURE_MAP)
//     → ['cctp'] only, same as today — nothing to pick between.
//   - UB toggle ON (default) and CCTP override OFF (default)
//     → ['ub'] only — reproduces today's exact behavior, no picker shown.
//   - UB toggle OFF, CCTP override ON (or OFF)
//     → ['cctp'] only.
//   - Both toggles ON
//     → ['ub', 'cctp'] — both shown, user picks which one is actually used.
//   - Both toggles OFF
//     → ['cctp'] — never leave a chain with no route at all.
export function resolveAvailableMechanisms(settings: SettingsMap, chainId: string): Array<'ub' | 'cctp'> {
  const ubFeature = CHAIN_UB_FEATURE_MAP[chainId]
  if (!ubFeature) return ['cctp'] // CCTP-only chain — no UB path to offer

  const ubRow = settings[ubFeature]
  const ubEnabled = ubRow ? ubRow.enabled : true // default ON, preserves current behavior

  const cctpFeature = CHAIN_CCTP_OVERRIDE_FEATURE_MAP[chainId]
  const cctpRow = cctpFeature ? settings[cctpFeature] : undefined
  const cctpEnabled = cctpRow ? cctpRow.enabled : false // default OFF, preserves current behavior

  const mechanisms: Array<'ub' | 'cctp'> = []
  if (ubEnabled) mechanisms.push('ub')
  if (cctpEnabled) mechanisms.push('cctp')
  if (mechanisms.length === 0) mechanisms.push('cctp') // never leave a chain with no route
  return mechanisms
}

// Defaults to ON if the row hasn't loaded yet / doesn't exist — never breaks
// the app before the migration has been run.
export function isCoinEnabled(settings: SettingsMap, coinId: string): boolean {
  const feature = COIN_FEATURE_MAP[coinId]
  if (!feature) return true
  const row = settings[feature]
  if (!row) return true
  return row.enabled
}

export function isChainEnabledForTransfer(settings: SettingsMap, chainId: string): boolean {
  const feature = CHAIN_TRANSFER_FEATURE_MAP[chainId]
  if (!feature) return true
  const row = settings[feature]
  if (!row) return true
  return row.enabled
}

export function isChainEnabledForClaim(settings: SettingsMap, chainId: string): boolean {
  const feature = CHAIN_CLAIM_FEATURE_MAP[chainId]
  if (!feature) return true
  const row = settings[feature]
  if (!row) return true
  return row.enabled
}
