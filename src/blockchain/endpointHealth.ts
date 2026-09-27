/**
 * blockchain/endpointHealth.ts — live per-endpoint health scoring
 *
 * ── Where this comes from ───────────────────────────────────────────────────
 * This is a direct port of the scoring/quarantine logic that already runs in
 * production inside api/arc-rpc.js (the Arc proxy). That implementation has
 * been proven against real incidents — a deprecated Polygon endpoint, an
 * unreliable HyperEVM node, Arc RPC rate limits — but it only ever protected
 * Arc, because it lives inside one serverless route. The 21 external chains
 * the browser talks to directly had no equivalent: a flaky endpoint was
 * retried on every single call, forever.
 *
 * Extracting the algorithm here lets ProviderManager apply the same protection
 * to every chain, without changing how api/arc-rpc.js itself behaves (that
 * file is untouched — it keeps its own copy until Phase 6 unifies the proxy).
 *
 * ── Behavior, unchanged from the original ───────────────────────────────────
 *  - success rate dominates ranking; latency is a capped secondary penalty, so
 *    an unreliable-but-fast endpoint still sorts below a reliable-but-slower one
 *  - an unproven endpoint scores optimistically (1.0) so it gets a fair first try
 *  - failures quarantine with exponential backoff (10s → 2min cap)
 *  - a success clears the quarantine immediately
 *  - if EVERY endpoint is quarantined, fail open and try them all anyway rather
 *    than erroring out on stale quarantine state
 *
 * State is in-memory and per-tab. It resets on reload — acceptable for the same
 * reason it is in the proxy: the health picture is relearned within a few calls.
 */
import type { EndpointHealth } from './types'

export const BASE_QUARANTINE_MS = 10_000
export const MAX_QUARANTINE_MS   = 120_000
/** Delay between staggered attempts when racing endpoints. */
export const STAGGER_MS          = 150

interface Stats extends EndpointHealth {
  totalLatencyMs: number
}

function newStats(url: string): Stats {
  return {
    url,
    success: 0,
    failure: 0,
    totalLatencyMs: 0,
    avgLatencyMs: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
    quarantinedUntil: 0,
  }
}

const stats = new Map<string, Stats>()

function getStats(url: string): Stats {
  let s = stats.get(url)
  if (!s) { s = newStats(url); stats.set(url, s) }
  return s
}

export function isQuarantined(url: string): boolean {
  return getStats(url).quarantinedUntil > Date.now()
}

export function recordSuccess(url: string, latencyMs: number): void {
  const s = getStats(url)
  s.success += 1
  s.totalLatencyMs += latencyMs
  s.avgLatencyMs = s.totalLatencyMs / s.success
  s.lastSuccessAt = Date.now()
  s.consecutiveFailures = 0
  s.quarantinedUntil = 0
}

export function recordFailure(url: string): void {
  const s = getStats(url)
  s.failure += 1
  s.lastFailureAt = Date.now()
  s.consecutiveFailures += 1
  const backoff = Math.min(
    BASE_QUARANTINE_MS * 2 ** (s.consecutiveFailures - 1),
    MAX_QUARANTINE_MS,
  )
  s.quarantinedUntil = Date.now() + backoff
}

function successRate(s: Stats): number {
  const total = s.success + s.failure
  // No data yet → optimistic, so a fresh endpoint isn't permanently last.
  return total === 0 ? 1 : s.success / total
}

/**
 * Success rate minus a capped latency penalty. The cap (0.25) keeps one very
 * slow outlier from outweighing a genuine reliability difference.
 */
export function healthScore(url: string): number {
  const s = getStats(url)
  const latencyPenalty = Math.min(s.avgLatencyMs / 4000, 1) * 0.25
  return successRate(s) - latencyPenalty
}

/** Healthiest-first ordering; fails open when everything is quarantined. */
export function orderEndpoints(urls: readonly string[]): string[] {
  const live = urls.filter(u => !isQuarantined(u))
  const pool = live.length ? live : urls
  return [...pool].sort((a, b) => healthScore(b) - healthScore(a))
}

/** Read-only snapshot, for diagnostics and the sync-status UI. */
export function healthSnapshot(urls: readonly string[]): EndpointHealth[] {
  return urls.map(u => {
    const { totalLatencyMs: _ignored, ...rest } = getStats(u)
    return { ...rest }
  })
}

/** Test/diagnostic helper — clears all learned health state. */
export function resetHealth(): void {
  stats.clear()
}
