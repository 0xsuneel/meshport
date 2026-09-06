/**
 * blockchain/arcBalanceReader.ts — Arc balance reads for BlockchainManager
 *
 * Phase 2 / 2.5. Encapsulates HOW a single Arc asset balance is read, behind
 * the manager.
 *
 * ── It DELEGATES; it does not reimplement ───────────────────────────────────
 * The fetchers below are arcService's own getUSDCBalance / getEURCBalance /
 * getCirBtcBalance, called unchanged. That matters more than it looks:
 *
 *   - They go through arcRpcJson(), which handles HTTP 429 by backing off IN
 *     PLACE (300ms, then 600ms) and retrying the SAME endpoint twice before
 *     failing over. That behaviour exists because Arc's proxied endpoint was
 *     genuinely hitting burst rate limits in production — see the comment on
 *     arcRpcJson in src/lib/arc.ts.
 *   - They own the decimal conventions (native 18dp USDC via eth_getBalance;
 *     6dp EURC and 8dp cirBTC via eth_call balanceOf).
 *   - They catch every error and return 0 rather than throwing.
 *
 * An earlier draft of this file reimplemented the reads through
 * ProviderManager.rpcCall(). That was wrong: rpcCall races endpoints with a
 * stagger and has no 429-specific in-place backoff, so against ARC_RPCS —
 * which is a single same-origin proxy entry — it would have turned a
 * recoverable burst limit into a failed read. Caught while wiring the pages up
 * in Phase 2.5, which is exactly what the integration phase is for.
 *
 * What this layer adds on top of the legacy readers is ONLY:
 *   - an address-scoped cache key (so a wallet switch can never serve another
 *     wallet's balance — the balanceCache.ts:42 bug, fixed structurally)
 *   - in-flight sharing, so simultaneous callers collapse into one request
 *
 * Routing Arc reads through ProviderManager is deferred until the proxy path
 * grows equivalent 429 handling (Phase 6).
 *
 * TESTNET ONLY — same Arc Testnet tokens and endpoint as the legacy readers.
 */
import { getUSDCBalance, getEURCBalance, getCirBtcBalance } from '@/lib/arcService'
import { ARC_CHAIN_ID } from './chains'
import { balanceKey, normalizeAddress } from './types'
import { swr, peek, put } from './cache'
import type { CacheOptions } from './cache'
import { countRequest } from './rpcMetrics'

export type ArcAsset = 'USDC' | 'EURC' | 'CIRBTC'

/**
 * The legacy readers, used verbatim. Keep this mapping — swapping any entry
 * for a hand-rolled RPC call reintroduces the 429 problem described above.
 */
const FETCHERS: Record<ArcAsset, (address: string) => Promise<number>> = {
  USDC:   getUSDCBalance,
  EURC:   getEURCBalance,
  CIRBTC: getCirBtcBalance,
}

/**
 * One uncached read. Resolves to 0 on failure, because the underlying
 * arcService readers already catch and return 0 — that contract is preserved,
 * not re-derived.
 *
 * Counted as a single logical request. arcRpcJson's internal 429 retries are
 * not individually counted, so the metric slightly UNDER-reports raw HTTP
 * traffic during rate limiting; it accurately reports how many reads the app
 * asked for, which is what the dedup measurements compare.
 */
export function fetchArcBalanceRaw(addr: string, asset: ArcAsset): Promise<number> {
  countRequest(ARC_CHAIN_ID, asset === 'USDC' ? 'eth_getBalance' : 'eth_call')
  return FETCHERS[asset](normalizeAddress(addr))
}

/**
 * TTL + in-flight-deduped single-asset Arc read.
 *
 * TTL defaults match the legacy balanceCache coordinator (4s) so migrated
 * pages keep identical liveness — a longer TTL would make balances visibly
 * slower to update, which Phase 2.5 must not do.
 */
export function getArcBalance(wallet: string, asset: ArcAsset, opts?: CacheOptions): Promise<number> {
  const addr = normalizeAddress(wallet)
  const key = balanceKey(addr, ARC_CHAIN_ID, asset)
  return swr(key, () => fetchArcBalanceRaw(addr, asset), {
    ttlMs:   opts?.ttlMs   ?? 4_000,
    staleMs: opts?.staleMs ?? 120_000,
  })
}

/** Non-network peek — last known value for instant UI paint. */
export function peekArcBalance(wallet: string, asset: ArcAsset): number | null {
  const hit = peek<number>(balanceKey(normalizeAddress(wallet), ARC_CHAIN_ID, asset))
  return hit ? hit.value : null
}

/** Direct cache write, for optimistic updates on the write path (Phase 5). */
export function setArcBalance(wallet: string, asset: ArcAsset, amount: number): void {
  put(balanceKey(normalizeAddress(wallet), ARC_CHAIN_ID, asset), amount)
}
