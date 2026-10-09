// ── One startup request (OKX-style "home" call) ─────────────────────────────
// Opening the app used to send ~15 separate Supabase reads for the first
// screen (settings, notifications, P2P trades, conversations ×3, unread
// chats, cleared watermark ×2, recent contacts ×2, waiting chat messages,
// news, and 2 more per chat for Home's missed-payment check). On a weak
// connection each one paid its own round trip.
//
// `home_bootstrap` (supabase/migrations/20261009140000_home_bootstrap.sql)
// returns all of them in one call, under the same RLS as the separate reads.
// Each startup reader asks `bootPart(...)` first:
//   - it gets the part once (one-shot per reader), only while the answer is
//     fresh (startup only) and for the signed-in user it expects;
//   - anything else (no answer, failed, session not linked yet, too old,
//     a later refresh) returns undefined and the reader runs its normal query.
// So this can only remove requests - never change what a screen shows.
import { supabase } from './supabase'
import { useAuthStore } from '@/store'

export type HomeBoot = {
  at: number
  linked: boolean
  settings?: any[]
  news?: any[]
  cleared_at?: string | null
  conversations?: { id: string; participant_a: string; participant_b: string }[]
  unread_chats?: number
  /** Home's missed-payment check: per chat, the other person's last 20 payment messages since cleared_at. */
  chat_payments?: { other_id: string; msgs: any[]; sender: { username?: string; display_name?: string; wallet_address?: string } | null }[]
  waiting_messages?: { id: string; conversation_id: string; content: string }[]
  notifications?: any[]
  trades?: any[]
  recent_sent?: any[]
  recent_received?: any[]
}

/** Parts that are the same for everyone (no signed-in session needed). */
const PUBLIC_PARTS = new Set<keyof HomeBoot>(['settings', 'news'])
/** Only startup readers use it; later reads are fresh queries. */
const FRESH_MS = 20_000
/** Don't start it after the app has been open a while (not a startup). */
const STARTUP_WINDOW_MS = 30_000
const TIMEOUT_MS = 10_000

type Entry = { userId: string; wallet: string; startedAt: number; promise: Promise<HomeBoot | null> }
let entry: Entry | null = null
const taken = new Set<string>()

function who(): { userId: string; wallet: string } | null {
  try {
    const s: any = useAuthStore.getState()
    const userId = String(s?.user?.id || '')
    const wallet = String(s?.walletAddress || s?.user?.walletAddress || '').toLowerCase()
    if (!userId) return null
    return { userId, wallet }
  } catch { return null }
}

async function load(userId: string, wallet: string): Promise<HomeBoot | null> {
  try {
    // Same session wait every other Supabase read does (authHeaders).
    await supabase.auth.getSession().catch(() => null)
    const { data, error } = await supabase
      .rpc('home_bootstrap', { p_user_id: userId, p_wallet: wallet })
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS))
    if (error || !data || typeof data !== 'object') return null
    return data as HomeBoot
  } catch { return null }
}

function current(): Entry | null {
  const me = who()
  if (!me) return null
  if (entry && entry.userId === me.userId && entry.wallet === me.wallet) return entry
  if (performance.now() > STARTUP_WINDOW_MS) return null // not a startup any more
  entry = { ...me, startedAt: Date.now(), promise: load(me.userId, me.wallet) }
  return entry
}

/** Start the startup call early (AppLayout mount). Safe to call repeatedly. */
export function primeHomeBootstrap(): void { current() }

/**
 * The startup value of one part for `reader` (once), or undefined → run the
 * normal query. `userId` (when given) must match the bootstrap's user.
 */
export async function bootPart<K extends keyof HomeBoot>(
  part: K, reader: string, expect: { userId?: string; wallet?: string } = {},
): Promise<HomeBoot[K] | undefined> {
  const key = part + ':' + reader
  if (taken.has(key)) return undefined
  const e = current()
  if (!e || Date.now() - e.startedAt > FRESH_MS) return undefined
  if (expect.userId && expect.userId !== e.userId) return undefined
  if (expect.wallet && expect.wallet.toLowerCase() !== e.wallet) return undefined
  taken.add(key) // one-shot even if it turns out unusable: the reader queries normally next
  const boot = await e.promise
  if (!boot) return undefined
  if (!PUBLIC_PARTS.has(part) && !boot.linked) return undefined
  const v = boot[part]
  // cleared_at may be null (never cleared) - that is a real answer.
  if (v === undefined || (v === null && part !== 'cleared_at')) return undefined
  return v
}

/** Tests only. */
export function __resetHomeBootstrapForTest(): void { entry = null; taken.clear() }
