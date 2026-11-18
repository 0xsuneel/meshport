import { supabase } from './supabase'
import { MAX_CLAIM_POINTS, MIN_CLAIM_POINTS } from './rewards'

// Scratch cards (18 Nov 2026) - every confirmed Pay payment wins one
// (supabase/migrations/20261118090000_scratch_cards.sql). The prize is decided
// by the server when it confirms the payment and stays hidden until the card
// is scratched: the app can only list cards (id + date) and scratch one.

export interface RewardSummary {
  /** USDC won on scratch cards, not yet claimed to the wallet (micro-USDC). */
  usdcMicro: number
  usdcLifetimeMicro: number
  points: number
  /** Cards waiting to be scratched. */
  cards: number
}

export interface ScratchPrize {
  kind: 'points' | 'usdc'
  points: number
  usdcMicro: number
  /** Scratched before (nothing credited this time). */
  already: boolean
}

/** 1 contract point = 500 micro-USDC (1000 points = 0.5 USDC). */
export const MICRO_PER_POINT = 500

export async function fetchRewardSummary(): Promise<RewardSummary> {
  const { data, error } = await supabase.rpc('my_reward_summary')
  if (error) throw error
  const d = (data ?? {}) as Record<string, unknown>
  return {
    usdcMicro: Number(d.usdc_micro) || 0,
    usdcLifetimeMicro: Number(d.usdc_lifetime_micro) || 0,
    points: Number(d.points) || 0,
    cards: Number(d.cards) || 0,
  }
}

export async function fetchScratchCards(): Promise<{ id: string; createdAt: string }[]> {
  const { data, error } = await supabase.rpc('my_scratch_cards')
  if (error) throw error
  return ((data ?? []) as { id: string; created_at: string }[]).map(c => ({ id: c.id, createdAt: c.created_at }))
}

/** Reveals and credits a card's prize (once; scratching again credits nothing). */
export async function scratchCard(id: string): Promise<ScratchPrize> {
  const { data, error } = await supabase.rpc('scratch_card', { p_card: id })
  if (error) throw error
  const d = (data ?? {}) as Record<string, unknown>
  return {
    kind: d.kind === 'usdc' ? 'usdc' : 'points',
    points: Number(d.points) || 0,
    usdcMicro: Number(d.usdc_micro) || 0,
    already: !!d.already,
  }
}

/** Contract points a USDC-rewards claim asks for: all of it, within one claim's limits (0 = not enough yet). */
export function usdcClaimPoints(usdcMicro: number, limit = MAX_CLAIM_POINTS): number {
  const pts = Math.min(limit, Math.floor(usdcMicro / MICRO_PER_POINT))
  return pts >= MIN_CLAIM_POINTS ? pts : 0
}

/** USDC needed before a claim can be made ($0.05). */
export const MIN_USDC_CLAIM_MICRO = MIN_CLAIM_POINTS * MICRO_PER_POINT

export const fmtUsdcMicro = (micro: number) => `$${(micro / 1e6).toFixed(2)}`

// The success page's gift badge reads the count of cards waiting; listeners
// let the Rewards page and the badge stay in step after a scratch.
type Listener = (cards: number) => void
const listeners = new Set<Listener>()
export function onCardCount(fn: Listener) { listeners.add(fn); return () => { listeners.delete(fn) } }
export function emitCardCount(n: number) { listeners.forEach(fn => { try { fn(n) } catch { /* listener */ } }) }

export interface ScratchWin { id: string; kind: 'points' | 'usdc'; points: number; usdcMicro: number; payAmount: number; scratchedAt: string }

/** Scratched cards with their prizes, newest first (Activity → Rewards). */
export async function fetchScratchHistory(limit = 100): Promise<ScratchWin[]> {
  const { data, error } = await supabase.rpc('my_scratch_history', { p_limit: limit })
  if (error) throw error
  return ((data ?? []) as Record<string, unknown>[]).map(r => ({
    id: String(r.id), kind: r.kind === 'usdc' ? 'usdc' : 'points', points: Number(r.points) || 0,
    usdcMicro: Number(r.usdc_micro) || 0, payAmount: Number(r.pay_amount) || 0, scratchedAt: String(r.scratched_at),
  }))
}

// ── Active offers (supabase/migrations/20261118110000_reward_offers.sql) ──
// Activated by the person; each confirmed qualifying payment moves the
// progress on the server; finishing one wins a bonus USDC scratch card.
export interface RewardOffer {
  id: string; title: string; line: string; steps: number; minUsd: number; windowDays: number
  activatedAt: string | null; expiresAt: string | null; progress: number; completedAt: string | null
  /** running · done (won its card) · expired (ran out) · idle (not activated) */
  state: 'running' | 'done' | 'expired' | 'idle'
}

export async function fetchOffers(): Promise<RewardOffer[]> {
  const { data, error } = await supabase.rpc('my_offers')
  if (error) throw error
  return ((data ?? []) as Record<string, unknown>[]).map(r => {
    const steps = Number(r.steps) || 1
    const progress = Number(r.progress) || 0
    const expiresAt = r.expires_at ? String(r.expires_at) : null
    const completedAt = r.completed_at ? String(r.completed_at) : null
    const state: RewardOffer['state'] = !r.activated_at ? 'idle'
      : progress >= steps ? 'done'
      : completedAt || (expiresAt && Date.parse(expiresAt) <= Date.now()) ? 'expired'
      : 'running'
    return {
      id: String(r.id), title: String(r.title), line: String(r.line), steps, minUsd: Number(r.min_usd) || 0, windowDays: Number(r.window_days) || 0,
      activatedAt: r.activated_at ? String(r.activated_at) : null, expiresAt, progress, completedAt, state,
    }
  })
}

export async function activateOffer(id: string): Promise<void> {
  const { error } = await supabase.rpc('activate_offer', { p_offer: id })
  if (error) throw error
}

/** "3 days left" / "5 hours left" / "Ends soon". */
export function timeLeft(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  if (ms <= 0) return 'Ended'
  const h = Math.floor(ms / 3_600_000)
  if (h >= 48) return `${Math.ceil(ms / 86_400_000)} days left`
  if (h >= 1) return `${h} hour${h === 1 ? '' : 's'} left`
  return 'Ends soon'
}
