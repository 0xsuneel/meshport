/**
 * store/blockchainSelectors.ts — the read-only surface pages consume
 *
 * Phase 1 of docs/BLOCKCHAIN_ARCHITECTURE_PROPOSAL.md (§8, §17).
 *
 * Pages import ONLY from this file. They never import BlockchainManager,
 * ProviderManager, arcService, or a provider — that one-way rule (§8's
 * "UI → Store", never "UI → RPC") is what makes deduplication possible: with a
 * single chokepoint for fetching, simultaneous readers collapse into one request.
 *
 * Every hook is a pure store read. None triggers a fetch. Fetching is scheduled
 * by SyncCoordinator in response to events (Phase 4); a component rendering
 * twice, or ten components reading the same balance, causes zero network
 * traffic.
 *
 * ── Phase 1 status: ADDITIVE AND UNWIRED ────────────────────────────────────
 * Nothing imports this yet. Pages migrate in Phase 2.
 */
import { shallow } from 'zustand/shallow'
import { useBlockchainStore } from './blockchainStore'
import type {
  AssetSymbol, BalanceEntry, ChainBalance, ChainId, PendingTx,
} from '@/blockchain/types'
import { ARC_CHAIN_ID, balanceKey, normalizeAddress } from '@/blockchain/types'

// ─── Stable fallbacks — not an inline `?? []` ───────────────────────────────
// These MUST be module-level singletons. zustand reads through React 18's
// useSyncExternalStoreWithSelector, which compares each selector result with
// Object.is. A selector returning a fresh `[]` or `{}` literal produces a new
// reference every time it runs, so the comparison always reports "changed" and
// the component re-renders on every unrelated store write — and React may warn
// that the snapshot isn't cached. Returning the same instance makes the empty
// case genuinely stable.
//
// Object.freeze is deliberately NOT used on the arrays: it returns
// `readonly T[]`, which TypeScript does not consider assignable to `T[]`, so
// freezing here would force a cast at every return site. Reference stability is
// the actual requirement, and a module-level const already provides it.
const EMPTY_ENTRY:   BalanceEntry   = { amount: 0, updatedAt: 0, status: 'idle' }
const EMPTY_CHAINS:  ChainBalance[] = []
const EMPTY_PENDING: PendingTx[]    = []
const EMPTY_SYNC = { lastSyncAt: 0, inFlight: false }

/** One asset's balance on one chain, with freshness metadata. */
export function useBalance(wallet: string | null, chain: ChainId, asset: AssetSymbol): BalanceEntry {
  return useBlockchainStore(s =>
    wallet ? (s.balances[balanceKey(wallet, chain, asset)] ?? EMPTY_ENTRY) : EMPTY_ENTRY)
}

/** Arc balance for one asset — the common case (USDC / EURC / cirBTC). */
export function useArcBalance(wallet: string | null, asset: AssetSymbol = 'USDC'): BalanceEntry {
  return useBalance(wallet, ARC_CHAIN_ID, asset)
}

/** Just the number, for call sites that don't care about freshness. */
export function useArcBalanceAmount(wallet: string | null, asset: AssetSymbol = 'USDC'): number {
  return useBlockchainStore(s =>
    wallet ? (s.balances[balanceKey(wallet, ARC_CHAIN_ID, asset)]?.amount ?? 0) : 0)
}

/**
 * Arc portfolio total in USD.
 *
 * EURC is converted at the rate the store holds; when no rate has been fetched
 * the entry is absent and its contribution is 0 — deliberately NOT a hardcoded
 * 1.08 fallback like the current HomePage line. Showing a total built from a
 * stale constant is worse than showing one that's briefly missing a component,
 * because the user cannot tell the difference. cirBTC behaves the same way.
 */
export function useArcPortfolioUsd(wallet: string | null): number {
  return useBlockchainStore(s => {
    if (!wallet) return 0
    const w = normalizeAddress(wallet)
    const amt = (asset: string) => s.balances[`${w}:${ARC_CHAIN_ID}:${asset}`]?.amount ?? 0
    const px  = (asset: string) => s.prices[asset]?.usd ?? 0
    return amt('USDC') + amt('EURC') * px('EURC') + amt('cirBTC') * px('cirBTC')
  })
}

/** External-chain claimable balances (the 21-chain scan result). */
export function useClaimable(wallet: string | null): ChainBalance[] {
  // Returns the stored array by reference — it's replaced wholesale by
  // setClaimable, so identity changes exactly when the data does.
  return useBlockchainStore(s =>
    wallet ? (s.claimable[normalizeAddress(wallet)]?.chains ?? EMPTY_CHAINS) : EMPTY_CHAINS)
}

/** True while a claimable scan is running — drives the Hub's skeleton state. */
export function useClaimableScanning(wallet: string | null): boolean {
  return useBlockchainStore(s =>
    wallet ? (s.claimable[normalizeAddress(wallet)]?.scanning ?? false) : false)
}

/**
 * Summed external balance. This is the single value Home and Hub must agree on;
 * both reading it here is what structurally prevents them disagreeing.
 * Returns a number, so no reference-stability concern.
 */
export function useExternalTotal(wallet: string | null): number {
  return useBlockchainStore(s => {
    if (!wallet) return 0
    const entry = s.claimable[normalizeAddress(wallet)]
    if (!entry) return 0
    return entry.chains.reduce((sum, c) => sum + c.balance, 0)
  })
}

/**
 * Timestamp of the last claimable scan (0 = never).
 *
 * Deliberately returns the raw timestamp rather than a computed age: a
 * `Date.now() - at` selector returns a different number on every single store
 * read, which defeats the equality check and re-renders continuously. Callers
 * compute age at the point of use, where it's a plain value, not a subscription.
 */
export function useClaimableUpdatedAt(wallet: string | null): number {
  return useBlockchainStore(s =>
    wallet ? (s.claimable[normalizeAddress(wallet)]?.updatedAt ?? 0) : 0)
}

/** Non-reactive age helper for the value above. */
export function claimableAgeMs(updatedAt: number): number {
  return updatedAt === 0 ? Infinity : Date.now() - updatedAt
}

/**
 * Transactions submitted and still being watched — survives navigation.
 *
 * `filter` builds a new array each run, so this uses zustand's shallow
 * comparator: the result is only treated as changed when the pending set
 * actually differs, not merely because a new array was allocated.
 */
export function usePendingTxs(wallet: string | null): PendingTx[] {
  return useBlockchainStore(
    s => {
      if (!wallet) return EMPTY_PENDING
      const w = normalizeAddress(wallet)
      const out = s.pending.filter(p => p.wallet === w && p.status === 'pending')
      return out.length === 0 ? EMPTY_PENDING : out
    },
    shallow,
  )
}

/** Count only — cheaper than subscribing to the array when that's all you need. */
export function usePendingCount(wallet: string | null): number {
  return useBlockchainStore(s => {
    if (!wallet) return 0
    const w = normalizeAddress(wallet)
    let n = 0
    for (const p of s.pending) if (p.wallet === w && p.status === 'pending') n++
    return n
  })
}

/** Per-chain sync bookkeeping, for a "last updated" indicator. */
export function useSyncState(chain: ChainId) {
  return useBlockchainStore(s => s.sync[chain] ?? EMPTY_SYNC)
}

export function usePrice(asset: AssetSymbol): number {
  return useBlockchainStore(s => s.prices[asset]?.usd ?? 0)
}

export function usePriceChange24h(asset: AssetSymbol): number | null {
  return useBlockchainStore(s => s.prices[asset]?.change24h ?? null)
}

/**
 * True once this wallet has at least one successfully-read balance.
 * Lets the UI distinguish "loaded, genuinely zero" from "not loaded yet" —
 * a distinction the current single-number store cannot express, which is why
 * pages show $0.00 before the first fetch resolves.
 */
export function useHasLoadedBalances(wallet: string | null): boolean {
  return useBlockchainStore(s => {
    if (!wallet) return false
    const prefix = `${normalizeAddress(wallet)}:`
    for (const [k, v] of Object.entries(s.balances)) {
      if (k.startsWith(prefix) && v.updatedAt > 0) return true
    }
    return false
  })
}
