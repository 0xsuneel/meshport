// supabase/functions/blockchain-indexer/indexChain.ts
//
// One indexing pass for one chain (head, reorg check, scan, publish to
// chain_events, confirm, advance the cursor) and the wallet set it watches.
// Shared by blockchain-indexer's once-a-minute pass over every chain and
// indexer-fast's 4-second loop over the busy external chains.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import type { IndexedChain } from './chains.ts'
import {
  getCursor, setCursor, markFailure, markSuccess, markReorg,
  insertEvents, markEventsConfirmed, markEventsReorged,
} from './cursors.ts'
import { computeScanWindow, detectReorg, reorgRollbackBlock, partitionByDepth, safeFrontier } from './cursorMath.ts'
import { getHead, scanRange } from './scanner.ts'

/**
 * Every wallet address the indexer watches.
 *
 * Source is `users.wallet_address` -- the SAME table deposit-scan-all's
 * loadWalletSet reads (an early draft of this file queried a nonexistent
 * `wallets` table; the runtime would have failed the moment a wallet had a
 * deposit). Read once per pass and held in memory: there is no server-side RPC
 * filter for plain native value transfers, so recipient matching MUST happen
 * in memory. Same constraint and same approach as deposit-scan-all.
 *
 * Returns an empty set (rather than throwing) on error so the caller can
 * decide -- the indexer treats "no wallets" as skip-this-pass, not crash.
 */
export async function loadKnownWallets(supabase: SupabaseClient): Promise<Set<string>> {
  const wallets = new Set<string>()
  const { data: users, error } = await supabase
    .from('users')
    .select('wallet_address')
    .not('wallet_address', 'is', null)
  if (error) {
    console.error('[blockchain-indexer] wallet load failed:', error.message)
    return wallets
  }
  for (const row of users ?? []) {
    const addr = (row as { wallet_address?: string }).wallet_address
    if (addr) wallets.add(addr.toLowerCase())
  }
  return wallets
}

/** One full pass for one chain. Never throws -- a chain failing is isolated. */
export async function indexChain(
  supabase: SupabaseClient,
  chain: IndexedChain,
  knownWallets: Set<string>,
): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = { chain: chain.id }

  try {
    // -- 1. Observe the head ------------------------------------------------
    const head = await getHead(chain.rpcs)
    report.head = head

    const cursor = await getCursor(supabase, chain.id)
    const depth = cursor?.confirmation_depth ?? chain.confirmationDepth

    // Cold start: begin at the head, NOT at genesis. Backfilling history is a
    // separate, explicitly-triggered concern -- a cold start that silently
    // scanned from block 0 would hammer every endpoint and could run for days.
    if (!cursor) {
      await setCursor(supabase, chain.id, {
        last_indexed_block: head,
        last_indexed_hash: null,
        latest_observed_block: head,
        confirmation_depth: chain.confirmationDepth,
        sync_state: 'idle',
      })
      report.action = 'cold_start'
      report.startedAt = head
      return report
    }

    if (cursor.sync_state === 'paused') {
      report.action = 'skipped_paused'
      return report
    }

    // -- 2. Reorg check -----------------------------------------------------
    // A reorg is detected by comparing the hash we RECORDED for the block at
    // our cursor with the hash the chain NOW reports at that same height. If
    // they differ, the chain diverged at or below us and the cursor must roll
    // back before scanning forward. (detectReorg's parent-hash form is used
    // when rolling back -- see below.)
    if (cursor.last_indexed_hash && cursor.last_indexed_block > 0) {
      try {
        const blockAtCursor = await scanBlockHeader(chain.rpcs, cursor.last_indexed_block)
        if (blockAtCursor && detectReorg(cursor.last_indexed_hash, blockAtCursor.hash)) {
          const rollback = reorgRollbackBlock(cursor.last_indexed_block, depth)
          await markEventsReorged(supabase, chain.id, rollback + 1)
          await markReorg(supabase, chain.id, rollback, null)
          await setCursor(supabase, chain.id, {
            reorg_count: (cursor.reorg_count ?? 0) + 1,
            last_reorg_at: new Date().toISOString(),
          })
          report.action = 'reorg_rollback'
          report.rolledBackTo = rollback
          return report   // next pass re-scans from the rolled-back cursor
        }
      } catch (e) {
        // A failed reorg check is not a reorg. Log and continue: asserting a
        // reorg on an RPC hiccup would roll the cursor back and re-scan for
        // no reason.
        console.warn(`[blockchain-indexer] reorg check inconclusive for ${chain.id}:`, e instanceof Error ? e.message : e)
      }
    }

    // -- 3. Scan window -----------------------------------------------------
    const win = computeScanWindow(cursor.last_indexed_block, head, chain.maxBlocksPerPass)
    if (win.toBlock <= cursor.last_indexed_block && cursor.last_indexed_block > 0) {
      await setCursor(supabase, chain.id, { latest_observed_block: head, sync_state: 'idle' })
      report.action = 'up_to_date'
      report.lag = head - cursor.last_indexed_block
      return report
    }
    report.window = `${win.fromBlock}..${win.toBlock}`

    // -- 4. Scan ------------------------------------------------------------
    const outcome = await scanRange(chain, win.fromBlock, win.toBlock, knownWallets)
    report.eventsFound = outcome.events.length
    report.safeUpTo = outcome.safeUpTo

    // -- 5. Publish (idempotent) --------------------------------------------
    // Only publish events at or below safeUpTo: an event from a block whose
    // chunk failed must not be published as if the range were complete.
    const publishable = outcome.events.filter(e => (e.block_number as number) <= outcome.safeUpTo)
    await insertEvents(supabase, publishable)
    report.eventsPublished = publishable.length

    // -- 6. Confirm what crossed the frontier -------------------------------
    const { confirmed } = partitionByDepth(outcome.confirmableBlocks, head, depth)
    if (confirmed.length > 0) {
      await markEventsConfirmed(supabase, chain.id, confirmed)
      report.blocksConfirmed = confirmed.length
    }

    // -- 7. Advance the cursor -- ONLY to the safe point ---------------------
    if (outcome.safeUpTo >= win.fromBlock) {
      await markSuccess(supabase, chain.id, {
        last_indexed_block: outcome.safeUpTo,
        last_indexed_hash: outcome.safeUpToHash,
        latest_observed_block: head,
      })
      report.cursorAdvancedTo = outcome.safeUpTo
    } else {
      // Nothing was contiguously processed -- leave the cursor untouched so the
      // whole range is retried. This is the anti-data-loss path.
      await markFailure(supabase, chain.id, 'no contiguous progress in pass')
      report.action = 'no_progress'
    }

    report.frontier = safeFrontier(head, depth)
    return report

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await markFailure(supabase, chain.id, msg)
    report.error = msg
    return report
  }
}

/** Minimal header fetch for the reorg check. */
async function scanBlockHeader(urls: string[], blockNumber: number): Promise<{ hash: string; parentHash: string } | null> {
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'eth_getBlockByNumber',
          params: ['0x' + blockNumber.toString(16), false],
        }),
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) continue
      const j = await res.json()
      if (j.error || !j.result) continue
      return { hash: j.result.hash, parentHash: j.result.parentHash }
    } catch { /* try next endpoint */ }
  }
  return null
}
