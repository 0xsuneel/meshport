// rewardsCache.ts - the last Rewards data that loaded, per account, so the
// Rewards page opens on real numbers at once (like Activity / Chats) and
// refreshes in the background, instead of sitting on loading placeholders
// until five reads answer - ~8 s on a weak network, where the database
// client retries each failed read.
//
// Only ever written from a load that fully succeeded: a failed read must
// never overwrite good numbers with zeros. The page never lets a claim start
// from these (Claim waits for a fresh load - RewardsPage), so they are for
// showing only. Cleared on logout with the other per-account caches
// (store/index.ts, prefix REWARDS_CACHE_PREFIX).

export const REWARDS_CACHE_PREFIX = 'meshport_rewards_cache_'
const VERSION = 1
const MAX_CLAIMS = 20
const MAX_HISTORY = 50

export interface RewardsSnapshot {
  totalPoints: number
  lifetimePoints: number
  claims: unknown[]
  history: unknown[]
  /** Points claimed today (UTC), from the database and the contract. */
  dailyClaimed: number
}

interface Stored extends RewardsSnapshot { v: number; at: number; day: string }

/** The UTC day the daily claim limit counts in (as fetchDailyClaimedPoints). */
export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10)

export function readRewardsCache(userId: string, now = Date.now()): (RewardsSnapshot & { at: number }) | null {
  if (!userId) return null
  try {
    const raw = localStorage.getItem(REWARDS_CACHE_PREFIX + userId)
    if (!raw) return null
    const s = JSON.parse(raw) as Stored
    if (s?.v !== VERSION || typeof s.totalPoints !== 'number' || !Array.isArray(s.claims) || !Array.isArray(s.history)) return null
    return {
      at: Number(s.at) || 0,
      totalPoints: s.totalPoints,
      lifetimePoints: Number(s.lifetimePoints) || 0,
      claims: s.claims,
      history: s.history,
      // Yesterday's count says nothing about today's limit.
      dailyClaimed: s.day === utcDay(now) ? Number(s.dailyClaimed) || 0 : 0,
    }
  } catch {
    return null
  }
}

export function writeRewardsCache(userId: string, snap: RewardsSnapshot, now = Date.now()): void {
  if (!userId) return
  const stored: Stored = {
    v: VERSION, at: now, day: utcDay(now),
    totalPoints: snap.totalPoints, lifetimePoints: snap.lifetimePoints, dailyClaimed: snap.dailyClaimed,
    claims: snap.claims.slice(0, MAX_CLAIMS), history: snap.history.slice(0, MAX_HISTORY),
  }
  try { localStorage.setItem(REWARDS_CACHE_PREFIX + userId, JSON.stringify(stored)) } catch { /* storage full / blocked */ }
}
