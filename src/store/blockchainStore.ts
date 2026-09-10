/**
 * store/blockchainStore.ts — the reactive blockchain store
 *
 * Phase 1 of docs/BLOCKCHAIN_ARCHITECTURE_PROPOSAL.md (§7, §17).
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 * Today the global store holds exactly ONE blockchain field: useWalletStore's
 * `balance: number` (Arc USDC). Everything else — EURC, cirBTC, external chain
 * balances, claimable totals, pending transactions, history — lives in per-page
 * useState. Unmounting a page throws that state away, so Home → Hub → Home
 * refetches everything, and two pages showing "the same" number are really
 * showing two independently-fetched values that can disagree (the documented
 * "$555 on Home vs $177 here" class of bug).
 *
 * This store is the single place blockchain data lives. Pages subscribe; nothing
 * else writes.
 *
 * ── Writers ─────────────────────────────────────────────────────────────────
 * Only BlockchainManager writes here. Pages get read-only selectors
 * (store/blockchainSelectors.ts). That one-way rule is what makes request
 * deduplication possible at all — if a page can write, it can also fetch, and
 * then there is no chokepoint to deduplicate at.
 *
 * ── Phase 1 status: ADDITIVE AND UNWIRED ────────────────────────────────────
 * Nothing imports this yet. useWalletStore remains the live source for Arc USDC
 * until Phase 2 routes reads through the manager, at which point
 * useWalletStore.balance becomes a derived alias. Adding this file cannot change
 * current behavior.
 *
 * ── Why zustand, not react-query ────────────────────────────────────────────
 * Matches the app's existing store layer (src/store/index.ts), and non-React
 * callers — SyncCoordinator, the Realtime event handler, write paths — must be
 * able to read and patch state. react-query is React-coupled and would be the
 * wrong dependency direction for those.
 */
import { create } from 'zustand'
import type {
  AssetSymbol, BalanceEntry, ChainBalance, ChainId,
  DataStatus, PendingTx, WalletAddress,
} from '@/blockchain/types'
import { balanceKey, normalizeAddress } from '@/blockchain/types'

export interface ClaimableState {
  chains:    ChainBalance[]
  updatedAt: number
  scanning:  boolean
}

export interface SyncState {
  lastSyncAt: number
  inFlight:   boolean
  lastError?: string
}

export interface PriceEntry {
  usd:        number
  change24h:  number | null
  updatedAt:  number
}

interface BlockchainStoreState {
  /** `${wallet}:${chain}:${asset}` → balance. Address-scoped by construction. */
  balances:  Record<string, BalanceEntry>
  /** wallet → external-chain claimable scan result. */
  claimable: Record<WalletAddress, ClaimableState>
  /** Transactions submitted and still being watched. Persisted by pendingTx.ts. */
  pending:   PendingTx[]
  /** chain → last sync bookkeeping, for the sync-status UI. */
  sync:      Record<ChainId, SyncState>
  /** asset → USD price. Not chain data, but shares the same refresh discipline. */
  prices:    Record<AssetSymbol, PriceEntry>

  // ── writes (BlockchainManager only) ──────────────────────────────────────
  setBalance(wallet: string, chain: ChainId, asset: AssetSymbol, amount: number): void
  setBalanceStatus(wallet: string, chain: ChainId, asset: AssetSymbol, status: DataStatus, error?: string): void
  setClaimable(wallet: string, chains: ChainBalance[]): void
  setClaimableScanning(wallet: string, scanning: boolean): void
  upsertPending(tx: PendingTx): void
  resolvePending(hash: string, status: 'confirmed' | 'failed', blockNumber?: string, error?: string): void
  removePending(hash: string): void
  setPending(list: PendingTx[]): void
  markSync(chain: ChainId, patch: Partial<SyncState>): void
  setPrice(asset: AssetSymbol, usd: number, change24h?: number | null): void
  /** Clears wallet-scoped data on logout / wallet switch. */
  resetForWallet(wallet: string | null): void
  clearAll(): void
}

const emptyEntry = (): BalanceEntry => ({ amount: 0, updatedAt: 0, status: 'idle' })

export const useBlockchainStore = create<BlockchainStoreState>()((set, get) => ({
  balances:  {},
  claimable: {},
  pending:   [],
  sync:      {},
  prices:    {},

  setBalance: (wallet, chain, asset, amount) => set(s => ({
    balances: {
      ...s.balances,
      [balanceKey(wallet, chain, asset)]: {
        amount,
        updatedAt: Date.now(),
        status: 'fresh',
      },
    },
  })),

  setBalanceStatus: (wallet, chain, asset, status, error) => set(s => {
    const k = balanceKey(wallet, chain, asset)
    const prev = s.balances[k] ?? emptyEntry()
    // Deliberately preserves `amount` and `updatedAt`. A failed or in-flight
    // refresh must never blank a previously-good balance — that's what produces
    // the "balance flashes to $0 then comes back" artifact. The UI decides how
    // to present a stale/errored value; it always still has one to show.
    return { balances: { ...s.balances, [k]: { ...prev, status, error } } }
  }),

  setClaimable: (wallet, chains) => set(s => ({
    claimable: {
      ...s.claimable,
      [normalizeAddress(wallet)]: { chains, updatedAt: Date.now(), scanning: false },
    },
  })),

  setClaimableScanning: (wallet, scanning) => set(s => {
    const w = normalizeAddress(wallet)
    const prev = s.claimable[w] ?? { chains: [], updatedAt: 0, scanning: false }
    return { claimable: { ...s.claimable, [w]: { ...prev, scanning } } }
  }),

  upsertPending: (tx) => set(s => {
    const i = s.pending.findIndex(p => p.hash.toLowerCase() === tx.hash.toLowerCase())
    if (i === -1) return { pending: [tx, ...s.pending] }
    const next = [...s.pending]
    next[i] = { ...next[i], ...tx }
    return { pending: next }
  }),

  resolvePending: (hash, status, blockNumber, error) => set(s => ({
    pending: s.pending.map(p =>
      p.hash.toLowerCase() === hash.toLowerCase()
        ? { ...p, status, blockNumber, error }
        : p),
  })),

  removePending: (hash) => set(s => ({
    pending: s.pending.filter(p => p.hash.toLowerCase() !== hash.toLowerCase()),
  })),

  setPending: (list) => set({ pending: list }),

  markSync: (chain, patch) => set(s => ({
    sync: { ...s.sync, [chain]: { ...(s.sync[chain] ?? { lastSyncAt: 0, inFlight: false }), ...patch } },
  })),

  setPrice: (asset, usd, change24h = null) => set(s => ({
    prices: { ...s.prices, [asset]: { usd, change24h, updatedAt: Date.now() } },
  })),

  resetForWallet: (wallet) => {
    const w = normalizeAddress(wallet)
    const { balances, claimable, pending } = get()
    // Balance keys are address-prefixed, so a wallet's data is removable
    // precisely — no risk of clearing another account's cached values.
    const nextBalances: Record<string, BalanceEntry> = {}
    for (const [k, v] of Object.entries(balances)) {
      if (!k.startsWith(`${w}:`)) nextBalances[k] = v
    }
    const nextClaimable = { ...claimable }
    delete nextClaimable[w]
    set({
      balances:  nextBalances,
      claimable: nextClaimable,
      pending:   pending.filter(p => p.wallet !== w),
    })
  },

  clearAll: () => set({ balances: {}, claimable: {}, pending: [], sync: {}, prices: {} }),
}))

// ── Non-React access ────────────────────────────────────────────────────────
// BlockchainManager, SyncCoordinator and the Realtime handler are plain modules,
// not components. zustand's getState/setState works outside React, so they use
// this rather than a hook.
export const blockchainStore = {
  get: () => useBlockchainStore.getState(),
  subscribe: useBlockchainStore.subscribe,
}
