// supabase/functions/blockchain-indexer/activityLedgerLink.ts
//
// Closes the remaining gap from the swap-proxy.js Activity-writer fix:
// Activity rows for swaps are written immediately (before any ledger event
// exists), so `ledger_event_id` is always NULL at write time. This module
// backfills it once the canonical ledger event exists -- link only, never
// create.
//
// ── Which ledger event is canonical for an Activity row? ──────────────────
// A swap produces two ledger events (SWAP_DEBIT, SWAP_CREDIT) but Activity
// has exactly one ledger_event_id column. Activity's own `amount` and
// `token_symbol` fields already record the INPUT leg (see
// api/swap-proxy.js's recordSwapActivity: `amount: amountIn, token_symbol:
// tokenIn`) -- so the debit is the leg that already matches Activity's
// existing shape. SWAP_DEBIT is therefore the deterministic, canonical
// link: exactly one SWAP_DEBIT exists per tx_hash+wallet (enforced by
// ledger_events' own UNIQUE(event_key) constraint), so there is never a
// choice to make.
//
// ── Idempotency ─────────────────────────────────────────────────────────
// The live update is WHERE-guarded on `ledger_event_id IS NULL` (see
// activityLedgerLinkLive.ts), so a second run of this sweep, or a race with
// itself, is a safe no-op -- matching the same pattern already used by
// swapBroadcastRecovery.ts and attemptReaper.ts.

export interface UnlinkedActivityRow {
  id: string
  txHash: string
  walletAddress: string
}

export interface CanonicalLedgerEventLookup {
  findSwapDebitLedgerEventId(txHash: string, walletAddress: string): Promise<string | null>
}

export interface ActivityLinkUpdateRepository {
  linkLedgerEvent(activityId: string, ledgerEventId: string): Promise<void>
}

export interface ActivityLinkResult {
  activityId: string
  outcome: 'linked' | 'no_ledger_event_yet'
  ledgerEventId?: string
}

/**
 * Sweeps Activity rows with a tx_hash but no ledger_event_id yet, and links
 * each to its SWAP_DEBIT ledger event once one exists. Never invents or
 * creates a ledger event -- if none exists yet (ledger-interpret hasn't run
 * for this tx yet), the row is simply left for the next sweep. One row's
 * failure never aborts the rest of the batch.
 */
export async function sweepUnlinkedActivityRows(
  unlinkedRows: UnlinkedActivityRow[],
  lookup: CanonicalLedgerEventLookup,
  updateRepo: ActivityLinkUpdateRepository,
): Promise<ActivityLinkResult[]> {
  const results: ActivityLinkResult[] = []
  for (const row of unlinkedRows) {
    try {
      const ledgerEventId = await lookup.findSwapDebitLedgerEventId(row.txHash, row.walletAddress)
      if (!ledgerEventId) {
        results.push({ activityId: row.id, outcome: 'no_ledger_event_yet' })
        continue
      }
      await updateRepo.linkLedgerEvent(row.id, ledgerEventId)
      results.push({ activityId: row.id, outcome: 'linked', ledgerEventId })
    } catch (e) {
      console.error(`[activity-ledger-link] activity ${row.id} failed:`, e instanceof Error ? e.message : e)
      results.push({ activityId: row.id, outcome: 'no_ledger_event_yet' })
    }
  }
  return results
}
