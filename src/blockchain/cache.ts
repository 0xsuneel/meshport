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

// ── Scoped sessionStorage persistence — 'external:' keys ONLY ─────────────
// BUG FIX (2026-09-21): the aggregate external-chain scan (the single most
// expensive read in the app — see externalBalanceReader.ts's own
// CACHE_TTL_MS comment, "raised from 20s after a real Alchemy 429
// incident") is cached here with a 90s TTL, but `entries` is an in-memory
// Map — a full browser page reload starts a fresh JS runtime, wiping it,
// so every reload paid for a brand-new 21-chain scan regardless of how
// recently one had just finished. Persisting ONLY 'external:'-prefixed
// entries to sessionStorage (not localStorage — deliberately scoped to
// this tab's session, not indefinite) closes that gap: a reload within
// the 90s window now rehydrates from sessionStorage instead of hitting
// the network again. Every other cache consumer (Arc balance, claims,
// activity, etc.) is completely unaffected — this prefix check is the
// entire scope of the change.
const SESSION_PREFIX = 'bc-cache:'
function persistToSession(key: string, value: unknown, storedAt: number): void {
  if (!key.startsWith('external:')) return
  try {
    sessionStorage.setItem(SESSION_PREFIX + key, JSON.stringify({ value, storedAt }))
  } catch { /* private browsing / quota exceeded — cache still works in-memory */ }
}
function readFromSession<T>(key: string): { value: T; storedAt: number } | null {
  if (!key.startsWith('external:')) return null
  try {
    const raw = sessionStorage.getItem(SESSION_PREFIX + key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed?.storedAt !== 'number') return null
    return parsed
  } catch { return null }
}

export function peek<T>(key: string): { value: T; ageMs: number } | null {
  const e = entries.get(key) as Entry<T> | undefined
  if (e) return { value: e.value, ageMs: Date.now() - e.storedAt }
  // In-memory miss — for external: keys only, this is most likely a fresh
  // page load rather than a genuine cold cache, so check sessionStorage
  // before treating it as a real miss.
  const fromSession = readFromSession<T>(key)
  if (!fromSession) return null
  entries.set(key, { value: fromSession.value, storedAt: fromSession.storedAt })
  return { value: fromSession.value, ageMs: Date.now() - fromSession.storedAt }
}

export function put<T>(key: string, value: T): void {
  const storedAt = Date.now()
  entries.set(key, { value, storedAt })
  persistToSession(key, value, storedAt)
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
  if (key.startsWith('external:')) {
    try { sessionStorage.removeItem(SESSION_PREFIX + key) } catch { /* ignore */ }
  }
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
  // Same prefix drop for the sessionStorage-persisted copies (external:
  // keys only — see persistToSession) so an invalidation, including the
  // manual-refresh bypass in refreshScope({kind:'external'}), can't be
  // undone by a page reload rehydrating the stale value it just cleared.
  if (prefix.startsWith('external:') || 'external:'.startsWith(prefix)) {
    try {
      for (const sk of Object.keys(sessionStorage)) {
        if (sk.startsWith(SESSION_PREFIX + prefix) || (prefix === '' && sk.startsWith(SESSION_PREFIX))) {
          sessionStorage.removeItem(sk)
        }
      }
    } catch { /* ignore */ }
  }
  return n
}

export function clearCache(): void {
  entries.clear()
  inflight.clear()
  try {
    for (const sk of Object.keys(sessionStorage)) {
      if (sk.startsWith(SESSION_PREFIX)) sessionStorage.removeItem(sk)
    }
  } catch { /* ignore */ }
}

/** Diagnostics for the dev RPC counter. */
export function cacheStats(): { entries: number; inflight: number } {
  return { entries: entries.size, inflight: inflight.size }
}
