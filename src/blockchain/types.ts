/**
 * blockchain/types.ts — shared types for the blockchain layer
 *
 * Phase 1 of docs/BLOCKCHAIN_ARCHITECTURE_PROPOSAL.md. Pure type declarations
 * plus small pure helpers — no runtime behavior, no imports from the app.
 *
 * TESTNET ONLY: these types describe MeshPort's existing Arc Testnet / Circle
 * Testnet setup. Nothing here assumes or enables mainnet.
 */

/** Internal chain id, e.g. 'Arc_Testnet' | 'Base_Sepolia'. */
export type ChainId = string

/** Asset symbol as MeshPort names it, e.g. 'USDC' | 'EURC' | 'cirBTC'. */
export type AssetSymbol = string

/** Lowercased 0x wallet address. Always normalize before using as a key. */
export type WalletAddress = string

// ARC_CHAIN_ID / isArc live in ./chains alongside the registry itself — they're
// re-exported here so consumers importing only types still get them, without a
// second definition of the same constant.
export { ARC_CHAIN_ID, isArc } from './chains'

/** Normalizes an address for use in cache keys and comparisons. */
export function normalizeAddress(addr: string | null | undefined): WalletAddress {
  return (addr ?? '').toLowerCase()
}

/**
 * Cache key for one balance. Address is included deliberately — the legacy
 * balanceCache.ts keyed only by token, so a wallet switch inside its 4s TTL
 * window could return the previous wallet's balance (bottleneck B6 in the
 * proposal). Including the wallet here makes that class of bug impossible
 * rather than merely unlikely.
 */
export function balanceKey(wallet: string, chain: ChainId, asset: AssetSymbol): string {
  return `${normalizeAddress(wallet)}:${chain}:${asset}`
}

/** Freshness of a cached value, as the UI should understand it. */
export type DataStatus = 'idle' | 'loading' | 'fresh' | 'stale' | 'error'

export interface BalanceEntry {
  amount:    number
  updatedAt: number      // epoch ms of last successful read; 0 = never
  status:    DataStatus
  error?:    string
}

export interface ChainBalance {
  chainId: ChainId
  balance: number
}

/** A transaction MeshPort submitted and is still watching. */
export interface PendingTx {
  hash:       string
  chain:      ChainId
  wallet:     WalletAddress
  asset:      AssetSymbol
  amount:     number
  to?:        string
  kind:       'send' | 'swap' | 'bridge' | 'claim' | 'escrow' | 'other'
  submittedAt: number
  status:     'pending' | 'confirmed' | 'failed'
  blockNumber?: string
  error?:     string
}

/**
 * What the server-side indexer publishes and the client reacts to. Mirrors the
 * chain_events table introduced in Phase 3 — declared here so Phases 1-2 can
 * be written against the final shape without waiting for the migration.
 */
export type ChainEventKind =
  | 'deposit'
  | 'transfer_in'
  | 'transfer_out'
  | 'claim_completed'
  | 'bridge_completed'
  | 'balance_changed'
  | 'tx_confirmed'
  | 'tx_failed'

export interface ChainEvent {
  id?:          number
  walletAddress: WalletAddress
  chain:        ChainId
  kind:         ChainEventKind
  assets:       AssetSymbol[]
  txHash?:      string | null
  blockNumber?: number | null
  metadata?:    Record<string, unknown>
  createdAt?:   string
}

/**
 * Scoped refresh request. There is deliberately no bare "refresh everything"
 * verb other than `all`, which is reserved for launch / login / wallet-import /
 * explicit manual refresh — see §19 of the proposal.
 */
export type RefreshScope =
  | { kind: 'asset';    wallet: string; chain: ChainId; asset: AssetSymbol }
  | { kind: 'chain';    wallet: string; chain: ChainId }
  | { kind: 'arc';      wallet: string }
  | { kind: 'external'; wallet: string; chains?: ChainId[] }
  | { kind: 'claims';   wallet: string }
  | { kind: 'history';  wallet: string }
  | { kind: 'all';      wallet: string }

/** Why a refresh happened — carried through for telemetry and debugging. */
export type RefreshTrigger =
  | 'launch' | 'login' | 'wallet-change' | 'wallet-import'
  | 'chain-event' | 'tx-confirmed' | 'claim-completed' | 'bridge-completed'
  | 'swap-completed' | 'deposit-detected'
  | 'manual' | 'resume' | 'page-enter'

export interface EndpointHealth {
  url:                 string
  success:             number
  failure:             number
  avgLatencyMs:        number
  lastSuccessAt:       number | null
  lastFailureAt:       number | null
  consecutiveFailures: number
  quarantinedUntil:    number
}
