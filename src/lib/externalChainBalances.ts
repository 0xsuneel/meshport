// lib/externalChainBalances.ts
//
// ── Why this exists ─────────────────────────────────────────────────────────
// Home, Multichain Hub, and the Claim page each had their OWN independent
// copy of "check every supported chain's USDC balance for this wallet" —
// three separately-maintained chain lists, three separate fetch
// implementations, three separate 21-request bursts on three separate 60s
// timers. That's how they drifted: Home and Hub had only ONE RPC per chain
// (no fallback if it failed), while Claim page had accumulated a properly
// verified, multi-RPC-per-chain fallback list over many rounds of real
// production debugging (see the per-chain comments below — several of
// these were wrong at some point and fixed against Circle's own SDK
// source or developers.circle.com directly). Home and Hub were silently
// missing all of that hard-won reliability. This file is the single
// source of truth all three now share, built from Claim page's version
// specifically because it was the most battle-tested of the three.
//
// ── What changed for each caller ────────────────────────────────────────────
// Home and Hub now get Claim page's per-chain RPC fallback for free — a
// single flaky RPC no longer means that chain silently reports $0 for
// them the way it used to. All three now also share ONE staggered request
// batch (see staggeredMap in utils.ts) and one short-lived cache (see
// below) instead of three independent bursts.
//
// ── Shared cache ─────────────────────────────────────────────────────────────
// A full scan hits every enabled chain — expensive enough that re-running
// it from scratch every time a user taps between Home → Hub → Claim within
// a few seconds of each other is pure waste: the underlying balances
// almost certainly haven't changed in that window. Cached per wallet
// address for a short window; each of the three pages' own periodic
// refresh (still on their existing 60s/visibility triggers) naturally
// keeps it from ever going stale for long.

import { staggeredMap } from './utils'
import { isChainEnabledForClaim } from './featureFilters'
import type { SettingsMap } from './adminSupabase'
import { EXTERNAL_CHAINS, resolveRpcList } from '@/blockchain/chains'

// ── Phase 0 note ────────────────────────────────────────────────────────────
// The chain table itself moved to src/blockchain/chains.ts (EXTERNAL_CHAINS) —
// the single client-side chain registry. Re-exported under its original name
// so nothing that reads CHAIN_CONFIG has to change. Values are identical; the
// scanning/caching logic below is untouched.
export const CHAIN_CONFIG = EXTERNAL_CHAINS

const BALANCE_OF_SELECTOR = '0x70a08231'

/** Single-chain balance check, with per-chain RPC fallback baked in. */
export async function getChainUSDCBalance(chainId: string, walletAddress: string): Promise<number> {
  const cfg = CHAIN_CONFIG[chainId]
  if (!cfg) return 0

  const paddedAddr = walletAddress.toLowerCase().replace('0x', '').padStart(64, '0')
  const data = BALANCE_OF_SELECTOR + paddedAddr

  // Endpoint list from the shared registry. Alchemy was removed from the client
  // balance path (see the note in blockchain/chains.ts) — these are now the
  // keyless public/native RPCs only, which is what was already serving every
  // balance whenever the shared Alchemy key was rate-limited.
  const rpcs = resolveRpcList(cfg.rpcs)

  for (const rpc of rpcs) {
    try {
      const res = await fetch(rpc, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call',
          params: [{ to: cfg.usdc, data }, 'latest'] }),
        signal: AbortSignal.timeout(6_000),
      })
      if (!res.ok) continue
      const json = await res.json()
      const hex = json?.result
      if (!hex || hex === '0x' || hex === '0x0') return 0
      return Number(BigInt(hex)) / Math.pow(10, cfg.decimals)
    } catch {
      // Try next RPC
    }
  }
  return 0
}

export interface ChainBalanceResult {
  chainId: string
  balance: number
}

const CACHE_TTL_MS = 20_000
let cache: { walletAddress: string; at: number; result: ChainBalanceResult[] } | null = null
let inFlight: Promise<ChainBalanceResult[]> | null = null

/**
 * Scans every claim-enabled chain for this wallet's USDC balance, staggered
 * (see staggeredMap) rather than firing all ~21 requests at once, and
 * shared across callers via a short-lived cache — if Home, Hub, and Claim
 * all request this within the same ~20s window (e.g. a user tapping
 * between them), only the first call actually hits the network; the rest
 * get the same result instantly. Also collapses truly-concurrent callers
 * (e.g. two of the three pages mounting in the same tick) into a single
 * in-flight scan rather than two overlapping ones.
 */
export async function scanAllChainBalances(
  walletAddress: string,
  settings: SettingsMap,
  settingsLoaded: boolean = true,
): Promise<ChainBalanceResult[]> {
  const addr = walletAddress.toLowerCase()
  const now = Date.now()

  if (cache && cache.walletAddress === addr && now - cache.at < CACHE_TTL_MS) {
    return cache.result
  }
  if (inFlight) return inFlight

  const chainIds = Object.keys(CHAIN_CONFIG).filter(id => isChainEnabledForClaim(settings, id))

  inFlight = staggeredMap(chainIds, async (chainId) => ({
    chainId,
    balance: await getChainUSDCBalance(chainId, addr),
  })).then(result => {
    // Only persist to the cache once settings have genuinely loaded — a
    // scan run before that point treats every chain as enabled (the safe
    // per-call default), which is fine for that one call, but caching it
    // would keep a since-disabled chain's balance visible for the full
    // cache window even after the real settings arrive and would
    // otherwise correctly exclude it.
    if (settingsLoaded) cache = { walletAddress: addr, at: Date.now(), result }
    inFlight = null
    return result
  }).catch(e => {
    inFlight = null
    throw e
  })

  return inFlight
}

/** Convenience wrapper for callers that only want the summed total (Home's use case). */
export async function scanTotalExternalBalance(walletAddress: string, settings: SettingsMap, settingsLoaded: boolean = true): Promise<number> {
  const results = await scanAllChainBalances(walletAddress, settings, settingsLoaded)
  return results.reduce((sum, r) => sum + r.balance, 0)
}
