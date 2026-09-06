/**
 * blockchain/externalBalanceReader.ts — external-chain scan for BlockchainManager
 *
 * Phase 2. Migration target for externalChainBalances.scanAllChainBalances.
 * The legacy function is UNTOUCHED and remains the live path until pages are
 * migrated one at a time.
 *
 * ── Preserved exactly from the legacy implementation ────────────────────────
 *  - settings-aware filtering via isChainEnabledForClaim
 *  - staggeredMap batching (5 at a time, 400ms apart) so ~21 chains are never
 *    fired simultaneously at public RPC endpoints
 *  - per-chain RPC fallback, and "return 0" rather than throwing on failure
 *  - results are only cached once settings have genuinely loaded (a scan run
 *    before that treats every chain as enabled, which is safe for that one
 *    call but must not be persisted)
 *
 * ── Two live bugs fixed here (see Phase 2 findings) ─────────────────────────
 * FINDING 1 — settings-ignoring cache. The legacy cache is keyed by wallet
 * address alone with a 20s TTL, so toggling a chain in the admin panel had no
 * effect for up to 20s: the pre-toggle result kept being served, including to
 * pages opened after the change. The cache key here folds in a signature of
 * the enabled-chain set, so changing the settings changes the key and the
 * next read is a genuine miss. No TTL tuning required.
 *
 * FINDING 2 — cross-wallet in-flight race. The legacy module holds ONE
 * module-level `inFlight` promise shared across every wallet, while its cache
 * is address-keyed. If wallet B asks while wallet A's scan is still running,
 * `if (inFlight) return inFlight` hands B *A's balances*. Reachable by a
 * wallet switch mid-scan, and more likely once every page reads one shared
 * value. Keying in-flight state by wallet+settings removes the race by
 * construction — that is exactly what cache.dedupe() does with a scoped key.
 *
 * TESTNET ONLY.
 */
import { staggeredMap } from '@/lib/utils'
import { isChainEnabledForClaim } from '@/lib/featureFilters'
import type { SettingsMap } from '@/lib/adminSupabase'
import { EXTERNAL_CHAINS, resolveRpcList } from './chains'
import { normalizeAddress } from './types'
import { dedupe, peek, put } from './cache'
import { countRequest, countError, countDedupeHit } from './rpcMetrics'

export interface ChainBalanceResult {
  chainId: string
  balance: number
}

export interface ExternalBalancesResult {
  chains: ChainBalanceResult[]
  total:  number
}

/**
 * How long a completed external scan stays servable — the `external:` prefix
 * ONLY. Nothing else in the app uses this constant.
 *
 * ── Why 90s, raised from 20s (Alchemy 429 incident, 2026-08-18) ────────────
 * Three components scan external chains on independent 60s intervals AND on
 * every `visibilitychange`: HomePage (readExternalTotal), MultichainPage and
 * MultichainClaimPage (readExternalBalances). At a 20s TTL every one of those
 * triggers missed the cache, so each became a real network scan across all
 * enabled chains — six of which resolve to *.g.alchemy.com on a single shared
 * account key. Alchemy rate-limits per ACCOUNT, not per endpoint, which is why
 * eth-sepolia, base-sepolia, arb-sepolia and unichain-sepolia all returned 429
 * simultaneously rather than one at a time.
 *
 * 90s is deliberately LONGER than the 60s scan cadence. That inverts the
 * relationship: the periodic tick and any tab refocus inside the window are now
 * served from cache, and only roughly one genuine scan happens per 90s per
 * wallet regardless of how many components ask or how often the tab is
 * refocused.
 *
 * Staleness is bounded, not unbounded: Phase 6's SyncCoordinator invalidates
 * `{kind:'external'}` on a real balance_changed event, and refreshScope's
 * invalidatePrefix('external:<wallet>:') deletes the entry outright — peek()
 * then misses and the next read goes to the network. So a real external credit
 * still refreshes immediately; only the *speculative polling* is slowed down.
 * A manual pull-to-refresh ({kind:'all'}) clears it too.
 */
const CACHE_TTL_MS = 90_000
const BALANCE_OF_SELECTOR = '0x70a08231'

/**
 * Stable signature of which chains are enabled. Part of the cache key so an
 * admin toggle invalidates immediately instead of being masked for the TTL.
 */
function settingsSignature(settings: SettingsMap, settingsLoaded: boolean): string {
  if (!settingsLoaded) return 'unloaded'
  const enabled = Object.keys(EXTERNAL_CHAINS)
    .filter(id => isChainEnabledForClaim(settings, id))
    .sort()
  return enabled.join(',')
}

/**
 * Single-chain USDC read with per-chain RPC fallback.
 *
 * Kept as a plain sequential fetch loop rather than routed through
 * ProviderManager: these are 21 different chains, six of which have no
 * authoritatively-confirmed numeric chain id (see chains.ts), and the legacy
 * behaviour of "try each endpoint, return 0 if all fail" is what the Hub and
 * Claim pages already depend on. Preserving it exactly is worth more here
 * than routing through a shared client — Phase 6 revisits this when all
 * chains move behind the proxy.
 */
export async function readChainUSDCBalance(chainId: string, walletAddress: string): Promise<number> {
  const cfg = EXTERNAL_CHAINS[chainId]
  if (!cfg) return 0

  const padded = walletAddress.toLowerCase().replace('0x', '').padStart(64, '0')
  const data = BALANCE_OF_SELECTOR + padded
  const rpcs = resolveRpcList(cfg.rpcs)

  for (const rpc of rpcs) {
    try {
      countRequest(chainId, 'eth_call')
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: cfg.usdc, data }, 'latest'] }),
        signal: AbortSignal.timeout(6_000),
      })
      if (!res.ok) { countError(); continue }
      const json = await res.json()
      const hex = json?.result
      if (!hex || hex === '0x' || hex === '0x0') return 0
      return Number(BigInt(hex)) / Math.pow(10, cfg.decimals)
    } catch {
      countError()
      // try next RPC — same as legacy
    }
  }
  return 0
}

/**
 * Full external scan, deduped and cached per (wallet, enabled-chain-set).
 *
 * Concurrent callers for the same wallet share one scan (dedupe); callers for
 * DIFFERENT wallets get their own, which is the fix for Finding 2.
 */
export function externalBalanceReader(
  walletAddress: string,
  settings: SettingsMap,
  settingsLoaded: boolean = true,
): Promise<ExternalBalancesResult> {
  const addr = normalizeAddress(walletAddress)
  const sig  = settingsSignature(settings, settingsLoaded)
  const key  = `external:${addr}:${sig}`

  const hit = peek<ExternalBalancesResult>(key)
  if (hit && hit.ageMs < CACHE_TTL_MS) {
    countDedupeHit()
    return Promise.resolve(hit.value)
  }

  return dedupe(key, async () => {
    const chainIds = Object.keys(EXTERNAL_CHAINS).filter(id => isChainEnabledForClaim(settings, id))

    const chains = await staggeredMap(chainIds, async (chainId) => ({
      chainId,
      balance: await readChainUSDCBalance(chainId, addr),
    }))

    const result: ExternalBalancesResult = {
      chains,
      total: chains.reduce((sum, c) => sum + c.balance, 0),
    }

    // Same rule as legacy: never persist a scan taken before settings loaded,
    // since it optimistically treats every chain as enabled.
    if (settingsLoaded) put(key, result)
    return result
  })
}

/** Convenience: summed total only (Home's use case). */
export function externalBalanceTotal(
  walletAddress: string,
  settings: SettingsMap,
  settingsLoaded: boolean = true,
): Promise<number> {
  return externalBalanceReader(walletAddress, settings, settingsLoaded).then(r => r.total)
}
