// supabase/functions/blockchain-indexer/cursors.ts
//
// Durable per-chain cursor persistence on chain_cursors.
//
// The read/write shape mirrors deposit-scan-all's getCursor/setCursor exactly
// (upsert on primary key, fallback on read error). What this adds:
//   * per-chain rows (deposit_scan_cursor is keyed by detection source, not chain)
//   * a recorded block HASH, which is the reorg-detection signal
//   * sync-state + failure bookkeeping for alerting
//
// A cursor write happens ONLY after a pass fully succeeds for a chain
// (safeAdvance semantics in the indexer), so a crashed invocation leaves the
// cursor exactly where it was and the next pass resumes from there.

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export interface CursorRow {
  chain_id:             string
  last_indexed_block:   number
  last_indexed_hash:    string | null
  latest_observed_block: number | null
  confirmation_depth:   number
  sync_state:           string
  consecutive_failures: number
  reorg_count:          number
  last_reorg_at:        string | null
  last_success_at:      string | null
  last_error:           string | null
}

export async function getCursor(supabase: SupabaseClient, chainId: string): Promise<CursorRow | null> {
  const { data, error } = await supabase
    .from('chain_cursors')
    .select('*')
    .eq('chain_id', chainId)
    .maybeSingle()
  if (error) {
    console.error(`[blockchain-indexer] cursor read failed for ${chainId}:`, error.message)
    return null
  }
  return data as CursorRow | null
}

/** Upsert the durable cursor. Never throws — failures are logged and retried next pass. */
export async function setCursor(
  supabase: SupabaseClient,
  chainId: string,
  patch: Partial<CursorRow>,
): Promise<void> {
  const { error } = await supabase
    .from('chain_cursors')
    .upsert(
      { chain_id: chainId, ...patch, updated_at: new Date().toISOString() },
      { onConflict: 'chain_id' },
    )
  if (error) console.error(`[blockchain-indexer] cursor write failed for ${chainId}:`, error.message)
}

/**
 * Mark a pass failure WITHOUT disturbing the cursor position, so the next
 * pass resumes from exactly where this one stopped.
 *
 * consecutive_failures is read-then-written rather than incremented in SQL.
 * That is safe here specifically because the indexer is a single writer per
 * chain (one cron-driven invocation, and each chain is processed once per
 * pass), so there is no concurrent updater to lose a write to. If the indexer
 * is ever sharded across concurrent workers, this must become an atomic
 * `UPDATE ... SET consecutive_failures = consecutive_failures + 1` via RPC —
 * noted rather than pre-built, since the counter only drives alerting.
 */
export async function markFailure(supabase: SupabaseClient, chainId: string, message: string): Promise<void> {
  const current = await getCursor(supabase, chainId)
  const failures = (current?.consecutive_failures ?? 0) + 1
  const { error } = await supabase
    .from('chain_cursors')
    .upsert({
      chain_id: chainId,
      sync_state: 'error',
      last_error: message.slice(0, 500),
      consecutive_failures: failures,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'chain_id' })
  if (error) console.error(`[blockchain-indexer] markFailure failed for ${chainId}:`, error.message)
}

/** Clear failure state after a good pass. */
export async function markSuccess(
  supabase: SupabaseClient,
  chainId: string,
  patch: Partial<CursorRow>,
): Promise<void> {
  await setCursor(supabase, chainId, {
    ...patch,
    sync_state: 'idle',
    consecutive_failures: 0,
    last_error: null,
    last_success_at: new Date().toISOString(),
  } as Partial<CursorRow>)
}

export async function markReorg(
  supabase: SupabaseClient,
  chainId: string,
  rolledBackTo: number,
  hashAtRollback: string | null,
): Promise<void> {
  await setCursor(supabase, chainId, {
    last_indexed_block: rolledBackTo,
    last_indexed_hash: hashAtRollback,
    sync_state: 'reorg',
  })
}

/** Idempotent event insert. The partial unique index is the real dedup guard. */
export async function insertEvents(
  supabase: SupabaseClient,
  events: Array<Record<string, unknown>>,
): Promise<void> {
  if (events.length === 0) return
  const { error } = await supabase.from('chain_events').insert(events)
  if (error) {
    // A 23505 (duplicate key) here is NOT an error — it means a previous pass
    // already published this event, which is the idempotency contract working.
    // Log at debug level; only log a warning for genuine insert failures.
    if (error.code !== '23505') {
      console.error(`[blockchain-indexer] event insert failed (${events.length} events):`, error.message)
    }
  }
}

export async function markEventsConfirmed(supabase: SupabaseClient, chainId: string, blockNumbers: number[]): Promise<void> {
  if (blockNumbers.length === 0) return
  const { error } = await supabase
    .from('chain_events')
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
    .eq('chain_id', chainId)
    .eq('status', 'pending')
    .in('block_number', blockNumbers)
  if (error) console.error(`[blockchain-indexer] event confirm failed for ${chainId}:`, error.message)
}

export async function markEventsReorged(supabase: SupabaseClient, chainId: string, fromBlock: number): Promise<void> {
  const { error } = await supabase
    .from('chain_events')
    .update({ status: 'reorged', reorged_at: new Date().toISOString() })
    .eq('chain_id', chainId)
    .eq('status', 'pending')
    .gte('block_number', fromBlock)
  if (error) console.error(`[blockchain-indexer] event reorg mark failed for ${chainId}:`, error.message)
}
