/**
 * blockchain/cache.ts — TTL cache + in-flight request deduplication
 *
 * Phase 1 of docs/BLOCKCHAIN_ARCHITECTURE_PROPOSAL.md (§13, §12).
 *
 * ── The problem this solves ─────────────────────────────────────────────────
 * Today Home, Multichain Hub and Claim Funds each call the balance readers
 * independently, on their own timers. The only thing preventing triple RPC
 * traffic is balanceCache.ts's 4s TTL happening to overlap — and that cache has
 * two defects the proposal documents: it keys by token WITHOUT the wallet
 * address (so a wallet switch inside the window returns the previous wallet's
 * balance), and it has no in-flight tracking (so three simultaneous callers on
 * a cold cache all miss and all hit the network).
 *
 * `dedupe()` fixes the second defect structurally: the FIRST caller starts the
 * work and stores the promise; every caller arriving before it settles gets
 * that same promise. Three pages asking at once produce exactly one RPC call
 * and three references to one result. Address-scoped keys (balanceKey() in
 * types.ts) fix the first.
 *
 * ── Stale-while-revalidate ──────────────────────────────────────────────────
 * Two thresholds instead of one: within `ttlMs` a value is fresh and returned
 * with no network call at all; between `ttlMs` and `staleMs` it is returned
 * IMMEDIATELY (so the UI paints instantly) while a refresh runs in the
 * background; past `staleMs` it's discarded and the caller waits. This is what
 * makes navigation feel instant without going stale-forever.
 *
 * No external dependency — deliberately not react-query. @tanstack/react-query
 * IS in package.json but is not currently used for blockchain reads anywhere in
 * the app, and the store layer needs to be readable from non-React code
 * (SyncCoordinator, the Realtime handler, write paths). Adding a React-coupled
 * cache underneath a non-React consumer would be the wrong dependency
 * direction.
 */

import { countCacheHit, countDedupeHit } from './rpcMetrics'

export interface CacheOptions {
  /** Below this age, return cached value with no network call. */
  ttlMs?: number
  /** Below this age, return cached value AND revalidate in background. */
  staleMs?: number
}

interface Entry<T> {
  value:     T
  storedAt:  number
}

const DEFAULT_TTL_MS   = 15_000
const DEFAULT_STALE_MS = 120_000

const entries  = new Map<string, Entry<unknown>>()
const inflight = new Map<string, Promise<unknown>>()

/**
 * Shares one in-flight promise across all callers using the same key.
 * The promise is removed from the map as soon as it settles, so a later call
 * starts fresh work rather than re-reading a resolved promise.
 *
 * Every join is counted — those counts are the evidence for the migration's
 * "fewer RPC requests" claim, so they're recorded where the saving actually
 * happens rather than estimated afterwards.
 */
export function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key)
  if (existing) {
    countDedupeHit()
    return existing as Promise<T>
  }

  const p = (async () => {
    try {
      return await fn()
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, p)
  return p
}

/** True when a request for this key is currently in flight. */
export function isInflight(key: string): boolean {
  return inflight.has(key)
}

export function peek<T>(key: string): { value: T; ageMs: number } | null {
  const e = entries.get(key) as Entry<T> | undefined
  if (!e) return null
  return { value: e.value, ageMs: Date.now() - e.storedAt }
}

export function put<T>(key: string, value: T): void {
  entries.set(key, { value, storedAt: Date.now() })
}

/**
 * Full read path: fresh hit → cached; stale hit → cached now + background
 * revalidate; miss → await the (deduped) fetch.
 *
 * A background revalidation failure is intentionally swallowed: the caller
 * already has a usable value, and surfacing a rejection for a refresh nobody
 * is waiting on would produce unhandled rejections. The next non-stale read
 * will retry and can surface the error then.
 */
export async function swr<T>(
  key: string,
  fn: () => Promise<T>,
  opts: CacheOptions = {},
): Promise<T> {
  const ttlMs   = opts.ttlMs   ?? DEFAULT_TTL_MS
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS

  const hit = peek<T>(key)

  if (hit && hit.ageMs < ttlMs) {
    countCacheHit()
    return hit.value
  }

  if (hit && hit.ageMs < staleMs) {
    countCacheHit()
    void dedupe(key, fn).then(v => put(key, v)).catch(() => {})
    return hit.value
  }

  const value = await dedupe(key, fn)
  put(key, value)
  return value
}

/**
 * Bypass the TTL and re-read from the network — for an explicit user-initiated
 * refresh, or a confirmed chain event.
 *
 * Still goes through dedupe() on purpose. If a refresh is already in flight for
 * this key, joining it returns equally-current data for free; issuing a second
 * identical request would not. So "force a fetch" means "don't trust the cached
 * value", not "always open a new socket" — a distinction that matters when the
 * user taps refresh twice.
 */
export async function refresh<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const value = await dedupe(key, fn)
  put(key, value)
  return value
}

/** Drop one key. Used by targeted invalidation after a chain event. */
export function invalidate(key: string): void {
  entries.delete(key)
}

/**
 * Drop every key starting with `prefix`. Because keys are
 * `wallet:chain:asset`, this gives scoped invalidation for free:
 * `invalidatePrefix('0xabc:')` clears one wallet, `'0xabc:Arc_Testnet:'` one
 * chain of one wallet. This is what keeps smart refresh (§10) from turning
 * into a full multi-chain rescan.
 */
export function invalidatePrefix(prefix: string): number {
  let n = 0
  for (const k of [...entries.keys()]) {
    if (k.startsWith(prefix)) { entries.delete(k); n++ }
  }
  return n
}

export function clearCache(): void {
  entries.clear()
  inflight.clear()
}

/** Diagnostics for the dev RPC counter. */
export function cacheStats(): { entries: number; inflight: number } {
  return { entries: entries.size, inflight: inflight.size }
}
