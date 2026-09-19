// supabase/functions/_shared/trackedFeatureCorrelation.ts
//
// Deterministic, race-free correlation check: is this on-chain tx_hash
// already tracked as a Pay/BulkPay/Swap attempt?
//
// ── Why this exists (vs. a timing-based existence poll) ─────────────────────
// Pay/BulkPay/Swap each own their own Activity write for their own
// transaction, keyed by the PLAIN (unprefixed) tx_hash — a completely
// different key than a generic external-receive row (`recv_<hash>`), so the
// real `UNIQUE(tx_hash, wallet_address)` index on `activity` cannot prevent a
// generic-receive writer from ALSO creating a row for the same underlying
// transfer. Any guard against that double-write which works by polling for
// the OTHER writer's Activity row to already exist (a `SELECT` before an
// `INSERT`, however many times repeated) is a genuine TOCTOU race: if the
// other writer hasn't finished writing yet, the check correctly reports "no
// row" at that instant and the duplicate gets created anyway. This is the
// exact, previously-traced production bug in docs/ACTIVITY_WRITER_AUDIT.md
// §2 and docs/CLAIM_RECOVERY_AUDIT.md §5 (a swap's EURC output leg recorded
// twice — once as `swap`, once as a spurious `receive`).
//
// `transaction_attempts` (joined to `transaction_intents` for its `feature`)
// is NOT subject to that race for Pay/BulkPay/Swap: the attempt row is
// created by that feature's own intent/broadcast pipeline at or before
// broadcast time — i.e. before the transaction is even mined, let alone
// before any post-confirmation generic-receive scan (claim-recovery-scan,
// activity-consumer) gets a chance to look at it. Checking this table FIRST
// closes the race structurally instead of narrowing the poll window further.
//
// Verified against live production data (2026-08-30): `transaction_attempts`
// rows exist with a non-null `tx_hash` and `'CONFIRMED'` status for real
// swaps (feature='swap', 9 rows in the trailing 14 days, most recent the day
// before this check was added) — this is a currently-populated signal, not a
// theoretical one.
//
// ── What this does NOT cover ────────────────────────────────────────────────
// P2P. P2P trades/offers live in their own tables (`p2p_trades`/`p2p_offers`),
// never in `transaction_intents`/`transaction_attempts` — P2P escrow
// release/refund is excluded from generic-receive detection separately, by
// sender address (the `P2P_ESCROW_CONTRACT` / `_LEGACY` known-internal-
// contract check every caller of this module already applies before ever
// reaching this one). This module does not need to, and does not try to,
// also handle that case.
//
// Same query shape as blockchain-indexer/depositActivityConsumerLive.ts's own
// `findCorrelatedTrackedFeature` (that module is not imported directly here
// to avoid a cross-function dependency between two independently-deployed
// Edge Functions — this is the shared, canonical copy going forward; that
// module's own copy is unchanged and out of scope for this task).
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export const TRACKED_FEATURES = ['pay', 'bulkpay', 'swap'] as const

/**
 * Returns the feature name ('pay' | 'bulkpay' | 'swap') if `txHash` already
 * belongs to a tracked `transaction_attempts` row for this chain (any
 * wallet, any status), else null.
 *
 * Fails CLOSED for the caller's purposes: a read error returns null (i.e.
 * "not correlated"), so an RPC/DB hiccup here can only ever make a duplicate
 * POSSIBLE (falling through to the caller's next guard), never silently
 * suppress a genuine external deposit. That is the correct failure direction
 * for a check that only ever prevents a write, never causes one.
 */
export async function findCorrelatedTrackedFeature(
  supabase: SupabaseClient,
  chainId: string,
  txHash: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('transaction_attempts')
    .select('transaction_intents!inner(feature)')
    .eq('chain_id', chainId)
    .eq('tx_hash', txHash.toLowerCase())
    .in('transaction_intents.feature', [...TRACKED_FEATURES])
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error('[trackedFeatureCorrelation] findCorrelatedTrackedFeature failed:', error.message)
    return null
  }
  if (!data) return null
  const intent = (data as Record<string, unknown>).transaction_intents as { feature: string } | { feature: string }[] | null
  const feature = Array.isArray(intent) ? intent[0]?.feature : intent?.feature
  return feature ?? null
}
