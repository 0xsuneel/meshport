/**
 * blockchain/rpcMetrics.ts — count what actually goes over the wire
 *
 * The migration's success criteria are stated as percentages ("~90% fewer RPC
 * requests"). Those numbers are only meaningful if they're measured rather than
 * asserted, so every request issued through ProviderManager is counted here.
 *
 * Deliberately tiny and dependency-free: a counter that costs anything is a
 * counter that changes what it measures. Nothing is sent anywhere — this is
 * read on demand (dev console / diagnostics), not reported.
 *
 * Usage while validating a phase:
 *   window.__meshportRpc.reset()      // start a clean window
 *   …exercise the app…
 *   window.__meshportRpc.report()     // per-chain + per-method totals
 */
import type { ChainId } from './types'

export interface RpcMetrics {
  total:      number
  byChain:    Record<string, number>
  byMethod:   Record<string, number>
  errors:     number
  cacheHits:  number
  dedupeHits: number
  startedAt:  number
}

function empty(): RpcMetrics {
  return {
    total: 0, byChain: {}, byMethod: {}, errors: 0,
    cacheHits: 0, dedupeHits: 0, startedAt: Date.now(),
  }
}

let m: RpcMetrics = empty()

/** One real network request left the app. */
export function countRequest(chain: ChainId, method: string): void {
  m.total += 1
  m.byChain[chain]  = (m.byChain[chain]  ?? 0) + 1
  m.byMethod[method] = (m.byMethod[method] ?? 0) + 1
}

export function countError(): void { m.errors += 1 }
/** A request that did NOT happen because the cache answered. */
export function countCacheHit(): void { m.cacheHits += 1 }
/** A request that did NOT happen because it joined an in-flight one. */
export function countDedupeHit(): void { m.dedupeHits += 1 }

export function snapshot(): RpcMetrics {
  return JSON.parse(JSON.stringify(m))
}

export function resetMetrics(): void { m = empty() }

/** Human-readable summary, including requests avoided. */
export function report(): string {
  const mins = Math.max((Date.now() - m.startedAt) / 60_000, 1 / 60)
  const avoided = m.cacheHits + m.dedupeHits
  const attempted = m.total + avoided
  const pctAvoided = attempted === 0 ? 0 : Math.round((avoided / attempted) * 100)
  const lines = [
    `RPC requests: ${m.total} in ${mins.toFixed(1)} min (${(m.total / mins).toFixed(1)}/min)`,
    `Avoided: ${avoided} (${m.cacheHits} cache, ${m.dedupeHits} dedupe) — ${pctAvoided}% of ${attempted} attempted`,
    `Errors: ${m.errors}`,
    `By chain: ${JSON.stringify(m.byChain)}`,
    `By method: ${JSON.stringify(m.byMethod)}`,
  ]
  return lines.join('\n')
}

// Dev-only console handle. Guarded so it never runs during SSR/build and never
// ships behavior — it only exposes the counters that already exist.
if (typeof window !== 'undefined' && (import.meta as any).env?.DEV) {
  ;(window as any).__meshportRpc = { snapshot, reset: resetMetrics, report: () => console.log(report()) }
}
