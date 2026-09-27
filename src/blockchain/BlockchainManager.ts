/**
 * blockchain/BlockchainManager.ts — the single entry point for chain reads
 *
 * Phase 2 of docs/BLOCKCHAIN_ARCHITECTURE_PROPOSAL.md (§5, §11, §20).
 *
 * ── What this is ────────────────────────────────────────────────────────────
 * The one place the app asks the blockchain for data. Once a page is migrated
 * it imports from here (or from the store selectors fed by here) and never
 * touches a provider, arcService, or a raw RPC helper directly.
 *
 * ── Backward compatibility ──────────────────────────────────────────────────
 * Every read preserves the exact semantics of the reader it replaces:
 *   - Arc balances: same eth_getBalance / eth_call + decimals, and the same
 *     "any failure yields 0, never throws" contract as arcService.
 *   - External scan: same settings-aware filtering, same staggered batching,
 *     same per-chain RPC fallback, same "0 on failure" as
 *     externalChainBalances.scanAllChainBalances.
 * The legacy modules are UNTOUCHED and remain the live path until each page is
 * migrated individually. This layer is additive.
 *
 * ── How duplicate RPC requests are eliminated ───────────────────────────────
 *  1. In-flight sharing (cache.dedupe) — the first caller starts the request
 *     and registers its promise; every caller arriving before it settles
 *     awaits that same promise. Home + Hub + Claim mounting together produce
 *     ONE request, not three.
 *  2. TTL + stale-while-revalidate (cache.swr) — a value read within the TTL
 *     costs no network call; a slightly older one is returned instantly while
 *     a single background refresh runs. This collapses the three independent
 *     60s timers that exist today.
 *  3. Scoped keys — every key is `wallet:chain:asset`, so nothing is ever
 *     shared across wallets (the balanceCache.ts wallet-switch bug) and
 *     invalidation can target one asset, one chain, or one wallet.
 *  4. Smart-refresh targeting (refreshScope) — computes exactly which keys a
 *     change touches. "Arc updated" drops Arc keys only; no full rescan.
 *
 * ── Phase 2 scope ───────────────────────────────────────────────────────────
 * Reads only. No indexer, no event bus, no polling removal, no write path —
 * those are Phases 3-5. Nothing here is wired into a page yet.
 *
 * TESTNET ONLY: every read resolves through src/blockchain/chains.ts, which
 * contains Arc Testnet / Circle Testnet endpoints exclusively.
 */
import type { SettingsMap } from '@/lib/adminSupabase'
import { invalidatePrefix, peek, refresh } from './cache'
import type { CacheOptions } from './cache'
import { getClient } from './ProviderManager'
import { getArcBalance, peekArcBalance, fetchArcBalanceRaw } from './arcBalanceReader'
import type { ArcAsset } from './arcBalanceReader'
import {
  externalBalanceReader, externalBalanceTotal, readChainUSDCBalance,
} from './externalBalanceReader'
import type { ChainBalanceResult, ExternalBalancesResult } from './externalBalanceReader'
import { ARC_CHAIN_ID } from './chains'
import { normalizeAddress } from './types'
import type { ChainId, RefreshScope } from './types'
import { countDedupeHit } from './rpcMetrics'

export type { ArcAsset, ChainBalanceResult, ExternalBalancesResult, CacheOptions }

export interface ArcBalances {
  USDC:   number
  EURC:   number
  cirBTC: number
}

// ─── Arc: single asset ──────────────────────────────────────────────────────

/**
 * One Arc asset for one wallet. Deduped and TTL-cached.
 * Returns 0 on failure, matching arcService's contract exactly.
 */
export function readArcBalance(
  wallet: string,
  asset: ArcAsset,
  opts?: CacheOptions,
): Promise<number> {
  return getArcBalance(wallet, asset, opts).catch(() => 0)
}

/** Last known value with no network call — for instant first paint. */
export function peekBalance(wallet: string, asset: ArcAsset): number | null {
  return peekArcBalance(wallet, asset)
}

// ─── Arc: all three assets ──────────────────────────────────────────────────

/**
 * All three Arc balances.
 *
 * Each asset is fetched through the same per-asset cache used by
 * readArcBalance, so a caller that already read USDC a moment ago pays for
 * EURC and cirBTC only. Requests are issued together (Promise.all) rather than
 * sequentially, which is what today's HomePage does for EURC/cirBTC anyway.
 *
 * Deliberately NOT using viem multicall: it requires a deployed Multicall3 and
 * `chain.contracts.multicall3` configured, which is not verified for Arc (open
 * question #3 in the proposal). Attempting it would throw
 * ChainDoesNotSupportContract. Batching is revisited once that is confirmed —
 * dedup + TTL already remove the bulk of duplicate traffic without the risk.
 */
export async function readArcBalances(
  wallet: string,
  opts?: CacheOptions,
): Promise<ArcBalances> {
  const [USDC, EURC, cirBTC] = await Promise.all([
    readArcBalance(wallet, 'USDC', opts),
    readArcBalance(wallet, 'EURC', opts),
    readArcBalance(wallet, 'CIRBTC', opts),
  ])
  return { USDC, EURC, cirBTC }
}

/** Force a network read for one asset, bypassing the TTL (manual refresh). */
export function refreshArcBalance(wallet: string, asset: ArcAsset): Promise<number> {
  const addr = normalizeAddress(wallet)
  const key = `${addr}:${ARC_CHAIN_ID}:${asset}`
  return refresh(key, () => fetchArcBalanceRaw(addr, asset)).catch(() => 0)
}

// ─── External chains ────────────────────────────────────────────────────────

/**
 * Every enabled external chain's USDC balance for this wallet.
 * Same settings-aware filtering and staggering as the legacy scan.
 */
export function readExternalBalances(
  wallet: string,
  settings: SettingsMap,
  settingsLoaded = true,
): Promise<ExternalBalancesResult> {
  return externalBalanceReader(wallet, settings, settingsLoaded)
}

/** Summed external balance — Home's "unified balance" figure. */
export function readExternalTotal(
  wallet: string,
  settings: SettingsMap,
  settingsLoaded = true,
): Promise<number> {
  return externalBalanceTotal(wallet, settings, settingsLoaded)
}

/** One external chain, for a targeted post-event refresh. */
export function readExternalChainBalance(chain: ChainId, wallet: string): Promise<number> {
  return readChainUSDCBalance(chain, normalizeAddress(wallet))
}

// ─── Transactions ───────────────────────────────────────────────────────────

/**
 * Transaction receipt, deduped and briefly cached.
 *
 * Today a receipt can be polled independently by a page and by a background
 * confirmation watcher; sharing this read means one request serves both.
 * Resolves to null when the receipt isn't available yet (pending or unknown),
 * so callers can poll without treating "not mined yet" as an error.
 */
export async function readTransactionReceipt(
  chain: ChainId,
  hash: string,
  opts?: CacheOptions,
): Promise<unknown | null> {
  const key = `tx:${chain}:${hash.toLowerCase()}`
  const ttl = opts?.ttlMs ?? 5_000

  const hit = peek<unknown>(key)
  if (hit && hit.ageMs < ttl) {
    countDedupeHit()
    return hit.value
  }

  return refresh(key, async () => {
    try {
      return await getClient(chain).getTransactionReceipt({ hash: hash as `0x${string}` })
    } catch {
      // viem throws when a receipt does not exist yet. That is a normal state
      // while a transaction is pending, not a failure — surface it as null so
      // a caller polling for confirmation doesn't have to catch on every tick.
      return null
    }
  })
}

// ─── Smart chain refresh ────────────────────────────────────────────────────

/**
 * Invalidate exactly the keys a change touches — never everything.
 *
 * Cache keys are `wallet:chain:asset`, so prefix invalidation gives precise
 * scoping for free: one asset, one chain, or one wallet. This is the
 * infrastructure Phase 4's event-driven refresh calls when a chain event
 * arrives; it is deliberately inert until then (dropping a cache entry only
 * means the next read goes to the network).
 *
 * `all` is reserved for launch / login / wallet-import / explicit manual
 * refresh — it is the only scope that clears a whole wallet.
 */
export function refreshScope(scope: RefreshScope): void {
  const addr = normalizeAddress(scope.wallet)

  switch (scope.kind) {
    case 'asset':
      invalidatePrefix(`${addr}:${scope.chain}:${scope.asset}`)
      break
    case 'chain':
      invalidatePrefix(`${addr}:${scope.chain}:`)
      break
    case 'arc':
      invalidatePrefix(`${addr}:${ARC_CHAIN_ID}:`)
      break
    case 'external':
      if (scope.chains?.length) {
        for (const c of scope.chains) invalidatePrefix(`${addr}:${c}:`)
      }
      // The aggregate scan is keyed `external:<wallet>:<settings-signature>`,
      // so it needs its own prefix — a per-chain drop above would leave the
      // combined result cached and the Hub would keep showing stale totals.
      invalidatePrefix(`external:${addr}:`)
      break
    case 'claims':
      invalidatePrefix(`${addr}:claims:`)
      break
    case 'history':
      invalidatePrefix(`${addr}:history:`)
      break
    case 'all':
      invalidatePrefix(`${addr}:`)
      invalidatePrefix(`external:${addr}:`)
      break
    default: {
      // An unrecognized scope kind previously fell through this switch and
      // invalidated NOTHING, while still returning normally — so the caller
      // believed a refresh had happened and the UI kept serving stale
      // balances with no error surfacing anywhere. TypeScript catches this
      // for src/ callers via the exhaustive union, but not for JS callers,
      // not for anything outside tsconfig's `include` (scripts/), and not
      // for a future RefreshScope variant added without a case here — which
      // is precisely the mistake this guard is here to make loud. Phase 4
      // drives every refresh through this function, so a silent no-op here
      // would surface as "balances randomly don't update".
      const unhandled: never = scope
      console.warn('[BlockchainManager] refreshScope: unhandled scope kind, nothing invalidated:', unhandled)
      break
    }
  }
}

/** Everything for one wallet — used on logout / wallet switch. */
export function clearWallet(wallet: string): void {
  refreshScope({ kind: 'all', wallet })
}
