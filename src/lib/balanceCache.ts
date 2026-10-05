// ─── Shared balance-read coordinator ────────────────────────────────────────
// Home has several independent triggers that all end up asking "what's the
// current balance for token X right now": the scheduled 30s/60s polls, the
// debounced realtime refresh (fired from payment/activity subscriptions),
// and the on-mount missed-message catch-up scan. Each of those used to call
// getUSDCBalance / getEURCBalance / getCirBtcBalance directly, so if two of
// them landed within a second or two of each other — which happens
// constantly, e.g. right after mount, or when a realtime event fires just
// before a scheduled poll tick — that was two (or three) separate Arc RPC
// calls for the exact same data.
//
// This module fixes that with two mechanisms, per token:
//
//  1. SHORT TTL CACHE — a value fetched in the last TTL_MS is considered
//     fresh enough to hand back to every caller without hitting the
//     network again. TTL_MS is short (a few seconds) so this never makes
//     the UI meaningfully less "live" — it only collapses near-simultaneous
//     requests into one.
//  2. IN-FLIGHT SHARING — if a request for a token is already on the wire
//     when another caller asks for it, that caller awaits the SAME promise
//     instead of firing a second concurrent request.
//
// Business logic is untouched: this only wraps the existing
// getUSDCBalance/getEURCBalance/getCirBtcBalance from arcService.ts, which
// already do their own error handling (catch + return 0) — that contract is
// preserved as-is.
import { getUSDCBalance, getEURCBalance, getCirBtcBalance } from './arcService'

export type BalanceToken = 'USDC' | 'EURC' | 'CIRBTC'

// 4s: long enough to absorb the realtime-vs-poll near-collisions this is
// meant to fix, short enough that no one waiting on a "real-time" balance
// notices the difference.
const TTL_MS = 4_000

interface Entry {
  value: number
  fetchedAt: number
  inFlight: Promise<number> | null
}

const cache: Record<BalanceToken, Entry> = {
  USDC:   { value: 0, fetchedAt: 0, inFlight: null },
  EURC:   { value: 0, fetchedAt: 0, inFlight: null },
  CIRBTC: { value: 0, fetchedAt: 0, inFlight: null },
}

const fetchers: Record<BalanceToken, (address: string) => Promise<number>> = {
  USDC:   getUSDCBalance,
  EURC:   getEURCBalance,
  CIRBTC: getCirBtcBalance,
}

// Get a token balance, deduplicated and cached per the rules above. Every
// call site in HomePage (scheduled polls, the debounced realtime refresh,
// and the mount catch-up scan) should go through this instead of calling
// arcService's getters directly.
export async function getTokenBalance(token: BalanceToken, address: string): Promise<number> {
  const entry = cache[token]
  const now = Date.now()

  if (entry.fetchedAt && now - entry.fetchedAt < TTL_MS) {
    return entry.value // fresh enough — no RPC call
  }
  if (entry.inFlight) {
    return entry.inFlight // a fetch for this token is already on the wire — piggyback on it
  }

  const p = fetchers[token](address)
    .then(v => {
      entry.value = v
      entry.fetchedAt = Date.now()
      entry.inFlight = null
      return v
    })
    .catch(e => {
      entry.inFlight = null
      throw e
    })

  entry.inFlight = p
  return p
}

// Last known value without triggering any network call — useful for UI that
// wants to render something instantly before the first fetch resolves.
export function peekTokenBalance(token: BalanceToken): number | null {
  return cache[token].fetchedAt ? cache[token].value : null
}
