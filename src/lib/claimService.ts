/**
 * claimService.ts — client for the server-owned claim state machine
 *
 * IMPORTANT: this file does NOT poll. It:
 *   1. POSTs to the `claim-submit` Edge Function (POST /claim) which returns
 *      immediately with a claimId — the actual bridging work happens in
 *      claim-worker, entirely server-side.
 *   2. Subscribes to Supabase Realtime for row changes on `claims`.
 *
 * Because processing lives in claim-worker (kicked immediately + kept alive
 * by pg_cron), a claim keeps progressing even if every subscriber here is
 * torn down (component unmount, tab close, etc). Subscriptions here are only
 * for UI, never for driving the claim forward.
 */
import { supabase, ensureAnonSession } from './supabase'
import { describeFunctionsError } from './describeFunctionsError'

export type ClaimStatus = 'submitted' | 'bridging' | 'verifying' | 'settling' | 'completed' | 'failed'

export interface Claim {
  id: string
  userId: string | null
  walletAddress: string
  sourceChain: string
  amount: number
  arrivedAmount: number | null // real on-chain-verified amount, only known once completed via the amount-matching path; may differ from `amount` due to real CCTP/relay fees
  txHash: string
  bridgeTxHash: string | null
  messageHash: string | null
  destinationTxHash: string | null
  status: ClaimStatus
  error: string | null
  // claim-worker writes these while a claim is STILL in progress, not just
  // on terminal failure — persistErrorBestEffort() sets `error` +
  // `lastErrorAt` on every transient hiccup (e.g. "waiting-on-attestation:
  // http=200, msgStatus=none", or a confirmArrival mint-matching diagnostic)
  // even though `status` stays non-terminal, and checkStuckClaims() (the
  // >10min watchdog) sets `needsReview` without ever touching `status`
  // either. Both columns existed in the DB (see
  // 20260706100000_claim_worker_hardening.sql) but were never selected here
  // — the frontend had no way to see them even though the server had
  // already written useful diagnostic detail.
  needsReview: boolean
  lastErrorAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
  // Set server-side (mark_claim_notified / get_and_mark_unnotified_claims)
  // the moment a "funds arrived" notification has actually been sent for
  // this claim. Selected here (was previously omitted even though `select
  // ('*')` already returned it) so callers can tell "already notified" from
  // "not notified yet" without relying on in-memory/per-mount state, which
  // resets — and re-fires the notification — on every refresh.
  userNotifiedAt: string | null
}

function mapRow(row: any): Claim {
  return {
    id:                 row.id,
    userId:             row.user_id,
    walletAddress:      row.wallet_address,
    sourceChain:        row.source_chain,
    amount:             Number(row.amount),
    arrivedAmount:      row.arrived_amount != null ? Number(row.arrived_amount) : null,
    txHash:             row.tx_hash,
    bridgeTxHash:       row.bridge_tx_hash,
    messageHash:        row.message_hash,
    destinationTxHash:  row.destination_tx_hash,
    status:             row.status,
    error:              row.error,
    needsReview:        row.needs_review ?? false,
    lastErrorAt:        row.last_error_at ?? null,
    completedAt:        row.completed_at,
    createdAt:          row.created_at,
    updatedAt:          row.updated_at,
    userNotifiedAt:     row.user_notified_at ?? null,
  }
}

// ── POST /claim ────────────────────────────────────────────────────────────
export async function submitClaim(params: {
  walletAddress: string
  sourceChain:   string
  amount:        number
  txHash:        string
}): Promise<{ success: boolean; claimId?: string; error?: string }> {
  try {
    await ensureAnonSession()
    const { data, error } = await supabase.functions.invoke('claim-submit', {
      body: params,
    })
    // BUG FIX: see describeFunctionsError.ts — same class of bug traced live
    // from a Swap failure ("Edge Function returned a non-2xx status code"
    // shown instead of the real validation reason claim-submit's own
    // response body carried.
    if (error) return { success: false, error: await describeFunctionsError(error, 'Failed to submit claim') }
    if (!data?.success) return { success: false, error: data?.error ?? 'Failed to submit claim' }
    return { success: true, claimId: data.claimId }
  } catch (e: any) {
    return { success: false, error: e?.message ?? 'Failed to submit claim' }
  }
}

// ── Optional acceleration kick ───────────────────────────────────────────────
// claim-worker's own doc comment is explicit: it's "never dependent on any
// browser tab" — pg_cron alone guarantees every claim eventually finishes,
// roughly once a minute. That's correct and deliberate: relying on a tab
// being open would break the "claim keeps progressing even if this page
// closes" guarantee this whole file is built around.
//
// But "eventually, within a minute" is a real, reported UX problem while
// someone is actively watching Track Progress — funds can land on-chain
// seconds after a stage transition and the screen won't reflect it until
// the next scheduled sweep. This closes that gap WITHOUT reintroducing a
// second source of truth: it doesn't decide anything or read any status
// itself, it just asks claim-worker's real (RPC-verified, claims.status-
// writing) checker to run sooner than its next scheduled tick, for one
// specific claim. Same authoritative function, same authoritative column,
// same locking guarantees (SKIP LOCKED) that already make concurrent
// invocations safe — just triggered more often while someone's watching.
// Safe to call from the browser: claim-worker has no privileged-key check,
// only Supabase's standard JWT verification (the normal anon session this
// client already holds satisfies that), and every code path inside it only
// ever re-derives truth from real on-chain data — a caller can ask it to
// check sooner, never influence what it finds.
export async function kickClaimWorker(claimId: string): Promise<void> {
  try {
    await ensureAnonSession()
    await supabase.functions.invoke('claim-worker', { body: { mode: 'single', claimId } })
  } catch {
    // Best-effort only — the pg_cron sweep is the real guarantee. A failed
    // kick just means this claim waits for the next scheduled tick instead
    // of updating early, not that it stops progressing.
  }
}

// ── One-off fetch ─────────────────────────────────────────────────────────
export async function getClaim(claimId: string): Promise<Claim | null> {
  const { data, error } = await supabase.from('claims').select('*').eq('id', claimId).maybeSingle()
  if (error || !data) return null
  return mapRow(data)
}

export async function fetchClaimsForWallet(walletAddress: string, limit = 20): Promise<Claim[]> {
  const { data, error } = await supabase
    .from('claims')
    .select('*')
    .eq('wallet_address', walletAddress.toLowerCase())
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error || !data) return []
  return data.map(mapRow)
}

// A claim only counts as "actively blocking this chain" if it's recent.
// Anything non-terminal and older than this is almost certainly stuck
// (e.g. created before claim-worker was deployed, or the worker crashed
// on it) rather than genuinely in progress — the worker's own MAX_ATTEMPTS
// timeout will eventually mark those `failed` server-side, but the UI
// shouldn't wait on that to stop hiding a chain's balance.
const IN_FLIGHT_MAX_AGE_MS = 20 * 60 * 1000 // 20 minutes

export function fetchProcessingClaims(walletAddress: string): Promise<Claim[]> {
  const cutoff = Date.now() - IN_FLIGHT_MAX_AGE_MS
  return fetchClaimsForWallet(walletAddress, 50).then(rows =>
    rows.filter(c =>
      c.status !== 'completed' &&
      c.status !== 'failed' &&
      new Date(c.createdAt).getTime() > cutoff
    )
  )
}

// ── Realtime: subscribe to ONE claim's row changes ──────────────────────────
// Returns an unsubscribe function. Safe to call from a React effect cleanup —
// unsubscribing only stops the UI from listening, it does NOT stop the
// worker from continuing to process the claim server-side.
//
// IMPORTANT: multiple components (e.g. the claim page AND ClaimProgressTracker)
// can legitimately subscribe to the same claimId at the same time. Supabase
// Realtime does not allow calling `.on()` again on a channel that has already
// called `.subscribe()`, so a naive "new channel per call" approach throws
// `cannot add postgres_changes callbacks ... after subscribe()` the second
// time the same claimId is subscribed to. To avoid that, we multiplex: only
// ONE underlying channel is ever opened per claimId, shared by every caller.
const claimChannels = new Map<string, {
  channel: ReturnType<typeof supabase.channel>
  listeners: Set<(claim: Claim) => void>
  latest: Claim | null
  pollTimer: ReturnType<typeof setInterval> | null
}>()

// How often to poll as a safety net under an active realtime subscription.
// Not the primary update mechanism — realtime events and the other reconcile
// triggers below handle that, so this stays cheap. It exists purely to
// guarantee the UI eventually reflects reality even if the WebSocket goes
// silently half-open (looks connected to the client, but the server-side
// connection is dead) — a state mobile networks produce that never fires a
// clean 'CLOSED'/'error' transition, so none of the other reconcile
// triggers ever fire either.
const CLAIM_POLL_FALLBACK_MS = 6_000

export function subscribeToClaim(claimId: string, onChange: (claim: Claim) => void): () => void {
  let entry = claimChannels.get(claimId)

  // Re-fetch and push the real current state — used both for the initial
  // fetch and as a catch-up mechanism below. Supabase Realtime is pure
  // live pub/sub with no replay: if the WebSocket drops for even a moment
  // (tab backgrounded, brief network blip — common on mobile), any status
  // changes that happen during that gap are gone forever and the UI would
  // otherwise stay frozen on stale status indefinitely.
  const reconcile = () => {
    getClaim(claimId).then(c => {
      if (!c || !entry) return
      entry.latest = c
      entry.listeners.forEach(fn => fn(c))
    })
  }

  if (!entry) {
    entry = { channel: null as any, listeners: new Set(), latest: null, pollTimer: null }
    claimChannels.set(claimId, entry)

    // Fire once immediately with current state so the UI isn't blank until the
    // first change event arrives.
    reconcile()

    entry.channel = supabase
      .channel(`claim-${claimId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'claims', filter: `id=eq.${claimId}` },
        (payload) => {
          if (!payload.new) return
          const c = mapRow(payload.new)
          entry!.latest = c
          entry!.listeners.forEach(fn => fn(c))
        }
      )
      .subscribe((status) => {
        // Reconnecting after a drop ('SUBSCRIBED' firing again post-error/
        // closed) means we may have missed events in between — catch up.
        if (status === 'SUBSCRIBED') reconcile()
      })

    // Belt-and-suspenders poll — fires independently of whatever state the
    // WebSocket thinks it's in, so a silently-dead connection can't leave
    // this claim stuck showing stale progress forever. Self-stops once the
    // claim reaches a terminal status, since there's nothing left to catch
    // up on at that point.
    entry.pollTimer = setInterval(() => {
      const e = claimChannels.get(claimId)
      if (!e) return
      if (e.latest && (e.latest.status === 'completed' || e.latest.status === 'failed')) {
        if (e.pollTimer) { clearInterval(e.pollTimer); e.pollTimer = null }
        return
      }
      reconcile()
    }, CLAIM_POLL_FALLBACK_MS)
  } else if (entry.latest) {
    // A channel already exists for this claim — deliver the last known state
    // to this new subscriber immediately instead of waiting for the next event.
    const latest = entry.latest
    queueMicrotask(() => onChange(latest))
  }

  entry.listeners.add(onChange)

  // Also reconcile whenever the tab becomes visible again — covers the case
  // where the OS suspended the page (and its WebSocket) without the
  // Realtime client ever seeing a clean disconnect/reconnect cycle to key
  // off of, which is common on mobile browsers.
  const onVisible = () => { if (document.visibilityState === 'visible') reconcile() }
  document.addEventListener('visibilitychange', onVisible)

  return () => {
    document.removeEventListener('visibilitychange', onVisible)
    const e = claimChannels.get(claimId)
    if (!e) return
    e.listeners.delete(onChange)
    // Only tear down the real subscription once nobody is listening anymore.
    if (e.listeners.size === 0) {
      if (e.pollTimer) clearInterval(e.pollTimer)
      supabase.removeChannel(e.channel)
      claimChannels.delete(claimId)
    }
  }
}

// ── Realtime: subscribe to ALL of a wallet's claims (for the Hub) ──────────
// Same multiplexing approach as subscribeToClaim, in case more than one
// component subscribes to the same wallet's claim list at once.
const walletChannels = new Map<string, {
  channel: ReturnType<typeof supabase.channel>
  listeners: Set<(claims: Claim[]) => void>
  pollTimer: ReturnType<typeof setInterval> | null
}>()

export function subscribeToWalletClaims(
  walletAddress: string,
  onChange: (claims: Claim[]) => void
): () => void {
  const addr = walletAddress.toLowerCase()
  let entry = walletChannels.get(addr)

  const refresh = () => {
    fetchClaimsForWallet(addr, 50).then(claims => {
      walletChannels.get(addr)?.listeners.forEach(fn => fn(claims))
    })
  }

  if (!entry) {
    entry = { channel: null as any, listeners: new Set(), pollTimer: null }
    walletChannels.set(addr, entry)

    entry.channel = supabase
      .channel(`claims-wallet-${addr}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'claims', filter: `wallet_address=eq.${addr}` },
        () => refresh()
      )
      .subscribe((status) => {
        // Same reasoning as subscribeToClaim: a reconnect after a drop means
        // events may have been missed in between — catch up explicitly.
        if (status === 'SUBSCRIBED') refresh()
      })

    // Same belt-and-suspenders poll as subscribeToClaim — this list has no
    // terminal state to stop early on (it's an ongoing view of a wallet's
    // claims, not one claim's lifecycle), so it just runs for as long as
    // anyone's subscribed.
    entry.pollTimer = setInterval(refresh, CLAIM_POLL_FALLBACK_MS)
  }

  entry.listeners.add(onChange)
  refresh() // deliver current state immediately to this subscriber

  // Covers the case where the OS suspended the tab (and its WebSocket)
  // without the Realtime client ever seeing a clean disconnect/reconnect
  // cycle to key off of — common on mobile browsers.
  const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
  document.addEventListener('visibilitychange', onVisible)

  return () => {
    document.removeEventListener('visibilitychange', onVisible)
    const e = walletChannels.get(addr)
    if (!e) return
    e.listeners.delete(onChange)
    if (e.listeners.size === 0) {
      if (e.pollTimer) clearInterval(e.pollTimer)
      supabase.removeChannel(e.channel)
      walletChannels.delete(addr)
    }
  }
}

export const CLAIM_STEPS: Array<{ key: ClaimStatus; label: string; subtitle: string }> = [
  { key: 'submitted', label: 'Submitted', subtitle: 'Claim received' },
  { key: 'bridging',  label: 'Bridging',  subtitle: 'Burn confirmed on the source chain' },
  { key: 'verifying', label: 'Verifying', subtitle: 'Circle attested the transfer' },
  { key: 'settling',  label: 'Settling',  subtitle: 'Funds landing on Arc' },
  { key: 'completed', label: 'Completed', subtitle: 'Balance updated' },
]

// Steps shown on the "Track Progress" panel — Submitted is intentionally
// excluded there since it's already been confirmed (checkmarked) on the
// screen right before Track Progress is reached.
export const TRACK_PROGRESS_STEPS = CLAIM_STEPS.filter(s => s.key !== 'submitted')

export function stepIndex(status: ClaimStatus): number {
  if (status === 'failed') return -1
  return CLAIM_STEPS.findIndex(s => s.key === status)
}
