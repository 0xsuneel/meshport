// supabase/functions/blockchain-indexer/index.ts
//
// BlockchainIndexer -- the authoritative blockchain OBSERVER. It watches
// chains, maintains durable per-chain cursors, derives typed events, and
// publishes them to chain_events. It does not decide what any of it means.
//
// Writes only to chain_cursors/chain_events directly from its own "index"
// scan pass; never to activity, claims, or balances from that pass.
//
// NOT a replacement for claim-worker (which owns claim attestation/retries
// with an external dependency) and NOT a business-logic host on its own --
// the pay/bulkpay/swap confirm/reconcile modes below are siblings bolted
// onto this same scheduled function for operational reuse, each isolated
// to its own feature and calling out to ledger-interpret for the actual
// ledger writes rather than writing ledger_events directly here.
//
// MODES: index (default), status, compare, metrics, bulkpay-reconcile,
// bulkpay-nonce-recovery, bulkpay-confirm, pay-confirm, pay-nonce-recovery,
// pay-reconcile, swap-confirm, swap-nonce-recovery, swap-reconcile.
//
// TESTNET ONLY.
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { enabledChains, INDEXED_CHAINS, IndexedChain, chainById } from './chains.ts'
import {
  getCursor, setCursor, markFailure, markSuccess, markReorg,
  insertEvents, markEventsConfirmed, markEventsReorged,
} from './cursors.ts'
import { computeScanWindow, detectReorg, reorgRollbackBlock, partitionByDepth, safeFrontier } from './cursorMath.ts'
import { getHead, scanRange } from './scanner.ts'
import { runCompare, runMetrics } from './monitor.ts'
import { runBulkpayReconciliation } from './bulkpayReconcile.ts'
import { makeLiveBulkpayReconcileRepository, makeLiveArcReceiptFetcher } from './bulkpayReconcileLive.ts'
import { sweepUnresolvedAttempts } from './bulkpayNonceRecovery.ts'
import { findUnresolvedAttempts, makeLiveBlockFetcher, makeLiveAttemptUpdateRepository } from './bulkpayNonceRecoveryLive.ts'
import { sweepSubmittedAttempts } from './bulkpayConfirmation.ts'
import { findSubmittedAttempts, makeLiveTransactionVerifier, makeLiveConfirmationUpdateRepository } from './bulkpayConfirmationLive.ts'
import { sweepSubmittedAttempts as sweepPaySubmittedAttempts } from './payConfirmation.ts'
import { findSubmittedAttempts as findPaySubmittedAttempts, makeLiveTransactionVerifier as makeLivePayTransactionVerifier, makeLiveConfirmationUpdateRepository as makeLivePayConfirmationUpdateRepository } from './payConfirmationLive.ts'
import { sweepUnresolvedAttempts as sweepPayUnresolvedAttempts } from './payNonceRecovery.ts'
import { findUnresolvedAttempts as findPayUnresolvedAttempts, makeLiveBlockFetcher as makeLivePayBlockFetcher, makeLiveAttemptUpdateRepository as makeLivePayAttemptUpdateRepository } from './payNonceRecoveryLive.ts'
import { runPayReconciliation } from './payReconcile.ts'
import { makeLivePayReconcileRepository, makeLivePayReceiptFetcher } from './payReconcileLive.ts'
import { sweepSubmittedSwapAttempts } from './swapConfirmation.ts'
import { findSubmittedSwapAttempts, makeLiveSwapTransactionVerifier, makeLiveSwapConfirmationUpdateRepository, KIT_ADAPTER_CONTRACT } from './swapConfirmationLive.ts'
import { sweepUnresolvedSwapAttempts } from './swapNonceRecovery.ts'
import { findUnresolvedSwapAttempts, makeLiveSwapBlockFetcher, makeLiveSwapAttemptUpdateRepository } from './swapNonceRecoveryLive.ts'
import { runSwapReconciliation } from './swapReconcile.ts'
import { makeLiveSwapReconcileRepository, makeLiveSwapReceiptFetcher } from './swapReconcileLive.ts'
import { sweepUnresolvedSwapAttemptsForBroadcastRecovery } from './swapBroadcastRecovery.ts'
import { findUnresolvedSwapAttemptsForBroadcastRecovery, makeLiveBroadcastRecoveryCandidateFinder, makeLiveBroadcastVerifier, makeLiveBroadcastRecoveryUpdateRepository } from './swapBroadcastRecoveryLive.ts'
import { sweepStaleCreatedAttempts } from './attemptReaper.ts'
import { findStaleCreatedAttempts, makeLiveAttemptReaperUpdateRepository } from './attemptReaperLive.ts'
import { sweepUnlinkedActivityRows } from './activityLedgerLink.ts'
import { findUnlinkedSwapActivityRows, makeLiveCanonicalLedgerEventLookup, makeLiveActivityLinkUpdateRepository } from './activityLedgerLinkLive.ts'
import { sweepDepositCandidateChainEvents } from './depositActivityConsumer.ts'
import { findDepositCandidateChainEvents, makeLiveDepositEligibilityLookup, makeLiveDepositActivityUpdateRepository } from './depositActivityConsumerLive.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

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
async function loadKnownWallets(supabase: SupabaseClient): Promise<Set<string>> {
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
async function indexChain(
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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
  )

  let mode = 'index'
  let body: Record<string, unknown> | null = null
  try {
    body = await req.json()
    if (body?.mode) mode = String(body.mode)
  } catch { /* no body -- default mode */ }

  // -- compare: shadow validation against the legacy workers ----------------
  // Reads only. Classifies overlap between chain_events and what
  // deposit-scan-all / claim-worker recorded, and persists the result so
  // accuracy is a trend rather than a log line.
  if (mode === 'compare') {
    const windowMinutes = Number(body?.windowMinutes) || 60
    return json(await runCompare(supabase, windowMinutes))
  }

  // -- bulkpay-reconcile: BulkPay recipient coverage gap closure ------------
  // docs/BULKPAY_RECONCILIATION_IMPLEMENTATION.md, implementing Option
  // B-refined from docs/BULKPAY_INTENT_SCOPED_WATCH_DESIGN.md. Reuses this
  // SAME scheduled function rather than adding a new cron job (Phase 9's
  // explicit "prefer reuse" instruction) -- callable as its own mode,
  // NOT wired into any cron trigger by this change (per "do not enable or
  // modify production cron configuration in this task unless explicitly
  // requested"). Reads bulk_payments only for its tx_hash pointer, never
  // for recipient/amount authorization -- see bulkpayReconcile.ts's own
  // header comment for the full security reasoning.
  if (mode === 'bulkpay-reconcile') {
    const windowMinutes = Number(body?.windowMinutes) || 60
    const sinceIso = new Date(Date.now() - windowMinutes * 60_000).toISOString()
    const chain = chainById('arc')
    if (!chain) return json({ ok: false, mode, error: 'arc chain config not found' }, 500)
    const repo = makeLiveBulkpayReconcileRepository(supabase)
    const fetcher = makeLiveArcReceiptFetcher(chain.rpcs)
    const results = await runBulkpayReconciliation(
      repo, fetcher, chain.id, chain.nativeTransferLogContract, chain.tokens, sinceIso,
    )
    return json({ ok: true, mode, sinceIso, processed: results.length, results })
  }

  // -- bulkpay-nonce-recovery: Case 2 recovery (broadcast response lost) ----
  // docs/BULKPAY_BROADCAST_RESPONSE_LOSS_AUDIT.md. Reuses this same
  // scheduled function rather than adding a new cron job, matching
  // bulkpay-reconcile's own precedent immediately above. Callable as its
  // own mode, NOT wired into any cron trigger by this change. Never
  // broadcasts anything -- only discovers or fails to discover a real,
  // already-mined transaction, and only ever accepts a candidate once its
  // `to` field is independently verified as Multicall3
  // (bulkpayNonceRecovery.ts's own mandatory security rule).
  if (mode === 'bulkpay-nonce-recovery') {
    const graceMinutes = Number(body?.graceMinutes) || 5
    const scanWindowBlocks = Number(body?.scanWindowBlocks) || 2000
    const chain = chainById('arc')
    if (!chain) return json({ ok: false, mode, error: 'arc chain config not found' }, 500)
    const unresolved = await findUnresolvedAttempts(supabase, chain.id, graceMinutes)
    const fetcher = makeLiveBlockFetcher(chain.rpcs)
    const updateRepo = makeLiveAttemptUpdateRepository(supabase)
    const results = await sweepUnresolvedAttempts(unresolved, fetcher, updateRepo, scanWindowBlocks)
    return json({ ok: true, mode, graceMinutes, scanWindowBlocks, processed: results.length, results })
  }

  // -- bulkpay-confirm: canonical BulkPay confirmation (Phase 4) ------------
  // docs/BULKPAY_TRANSACTION_INTENT_IMPLEMENTATION.md. Architecture B: the
  // frontend's own receipt observation (Phase 3) is never trusted directly
  // -- this mode independently re-verifies every SUBMITTED/CONFIRMING
  // attempt's real transaction (sender, nonce, to=Multicall3) and real
  // receipt before ever transitioning to CONFIRMED/REVERTED. Reuses this
  // same scheduled function rather than adding a new cron, matching the
  // same precedent as bulkpay-reconcile/bulkpay-nonce-recovery above. A
  // mismatch defers to the existing bulkpay-nonce-recovery mode rather than
  // duplicating its own already-proven replacement-detection logic.
  if (mode === 'bulkpay-confirm') {
    const chain = chainById('arc')
    if (!chain) return json({ ok: false, mode, error: 'arc chain config not found' }, 500)
    const attempts = await findSubmittedAttempts(supabase, chain.id)
    const verifier = makeLiveTransactionVerifier(chain.rpcs)
    const updateRepo = makeLiveConfirmationUpdateRepository(supabase)
    const results = await sweepSubmittedAttempts(attempts, verifier, updateRepo)
    return json({ ok: true, mode, processed: results.length, results })
  }

  // -- pay-confirm: canonical Pay confirmation -------------------------------
  // Same architecture as bulkpay-confirm, applied to Pay. The frontend's own
  // receipt observation is never trusted directly -- independently
  // re-verifies against the real chain, with expectedTo computed per
  // attempt from its correlated intent (recipient wallet for native, token
  // contract for ERC20) rather than a fixed constant.
  if (mode === 'pay-confirm') {
    const chain = chainById('arc')
    if (!chain) return json({ ok: false, mode, error: 'arc chain config not found' }, 500)
    const attempts = await findPaySubmittedAttempts(supabase, chain.id)
    const verifier = makeLivePayTransactionVerifier(chain.rpcs)
    const updateRepo = makeLivePayConfirmationUpdateRepository(supabase)
    const results = await sweepPaySubmittedAttempts(attempts, verifier, updateRepo)
    return json({ ok: true, mode, processed: results.length, results })
  }

  // -- pay-nonce-recovery: Pay's UNKNOWN/broadcast-response-loss recovery ---
  if (mode === 'pay-nonce-recovery') {
    const graceMinutes = Number(body?.graceMinutes) || 5
    const scanWindowBlocks = Number(body?.scanWindowBlocks) || 2000
    const chain = chainById('arc')
    if (!chain) return json({ ok: false, mode, error: 'arc chain config not found' }, 500)
    const unresolved = await findPayUnresolvedAttempts(supabase, chain.id, graceMinutes)
    const fetcher = makeLivePayBlockFetcher(chain.rpcs)
    const updateRepo = makeLivePayAttemptUpdateRepository(supabase)
    const results = await sweepPayUnresolvedAttempts(unresolved, fetcher, updateRepo, scanWindowBlocks)
    return json({ ok: true, mode, graceMinutes, scanWindowBlocks, processed: results.length, results })
  }

  // -- pay-reconcile: Pay reconciliation for unregistered recipients --------
  // (Root Cause #3.) Independently re-decodes the real transaction/receipt
  // for CONFIRMED pay attempts the regular scanner's knownWallets filter
  // would have missed. Never touches knownWallets or scanner.ts itself.
  if (mode === 'pay-reconcile') {
    const windowMinutes = Number(body?.windowMinutes) || 1440
    const sinceIso = new Date(Date.now() - windowMinutes * 60_000).toISOString()
    const repo = makeLivePayReconcileRepository(supabase)
    const chain = chainById('arc')
    if (!chain) return json({ ok: false, mode, error: 'arc chain config not found' }, 500)
    const fetcher = makeLivePayReceiptFetcher(chain.rpcs)
    const results = await runPayReconciliation(repo, fetcher, sinceIso)
    return json({ ok: true, mode, sinceIso, processed: results.length, results })
  }

  // -- swap-confirm: canonical Swap confirmation -----------------------------
  // Same architecture as pay-confirm/bulkpay-confirm, applied to Swap. The
  // frontend's own receipt observation (swap-proxy.js's kit.swap() result)
  // is never trusted directly -- independently re-verifies against the real
  // chain, with expectedTo fixed to the Kit Adapter Contract (every swap
  // broadcasts to the same router, unlike Pay's per-transaction `to`). Once
  // this transitions an attempt to CONFIRMED, classifySwapDebit
  // (server/ledger/classifiers.ts) becomes applicable for that attempt.
  if (mode === 'swap-confirm') {
    const chain = chainById('arc')
    if (!chain) return json({ ok: false, mode, error: 'arc chain config not found' }, 500)
    const attempts = await findSubmittedSwapAttempts(supabase, chain.id)
    const verifier = makeLiveSwapTransactionVerifier(chain.rpcs)
    const updateRepo = makeLiveSwapConfirmationUpdateRepository(supabase)
    const results = await sweepSubmittedSwapAttempts(attempts, verifier, updateRepo)
    // Chain straight into the Ledger Interpreter for any attempt that just
    // became CONFIRMED this pass -- this is what actually produces the
    // SWAP_DEBIT row; without it, transaction_attempts would reach
    // CONFIRMED but ledger_events would never be written.
    const ledgerResults = []
    for (const r of results) {
      if (r.outcome === 'confirmed') {
        try {
          const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/ledger-interpret`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
            body: JSON.stringify({ mode: 'attempt', attemptId: r.attemptId }),
          })
          ledgerResults.push(await res.json())
        } catch (e) {
          console.error('[swap-confirm] ledger-interpret call failed:', e instanceof Error ? e.message : e)
        }
      }
    }
    return json({ ok: true, mode, processed: results.length, results, ledgerResults })
  }

  // -- swap-nonce-recovery: Swap's UNKNOWN/broadcast-response-loss recovery -
  // Never broadcasts anything -- only discovers or fails to discover a real,
  // already-mined transaction, and only ever accepts a candidate once its
  // `to` field is independently verified as the Kit Adapter Contract
  // (swapNonceRecovery.ts's own mandatory security rule, mirroring
  // bulkpay-nonce-recovery's Multicall3 check and pay-nonce-recovery's
  // per-attempt expectedTo check).
  if (mode === 'swap-nonce-recovery') {
    const graceMinutes = Number(body?.graceMinutes) || 5
    const scanWindowBlocks = Number(body?.scanWindowBlocks) || 2000
    const chain = chainById('arc')
    if (!chain) return json({ ok: false, mode, error: 'arc chain config not found' }, 500)
    const unresolved = await findUnresolvedSwapAttempts(supabase, chain.id, graceMinutes)
    const fetcher = makeLiveSwapBlockFetcher(chain.rpcs)
    const updateRepo = makeLiveSwapAttemptUpdateRepository(supabase)
    const results = await sweepUnresolvedSwapAttempts(unresolved, fetcher, updateRepo, scanWindowBlocks)
    return json({ ok: true, mode, graceMinutes, scanWindowBlocks, processed: results.length, results })
  }

  // -- swap-reconcile: Swap's SWAP_CREDIT chain_event gap closure -----------
  // The regular scanner never watches the Kit Adapter Contract as a sender
  // (it is a KNOWN_INTERNAL_CONTRACT), so no chain_event ever captures a
  // swap's output leg without this. Independently re-decodes each CONFIRMED
  // swap attempt's real receipt for the Kit Adapter Contract's outbound
  // Transfer to the attempt's own wallet -- see swapReconcile.ts's header
  // comment for the full correlation-safety reasoning. Never touches
  // KNOWN_INTERNAL_CONTRACTS or scanner.ts itself.
  if (mode === 'swap-reconcile') {
    const windowMinutes = Number(body?.windowMinutes) || 1440
    const sinceIso = new Date(Date.now() - windowMinutes * 60_000).toISOString()
    const repo = makeLiveSwapReconcileRepository(supabase)
    const chain = chainById('arc')
    if (!chain) return json({ ok: false, mode, error: 'arc chain config not found' }, 500)
    const fetcher = makeLiveSwapReceiptFetcher(chain.rpcs)
    const results = await runSwapReconciliation(repo, fetcher, KIT_ADAPTER_CONTRACT, chain.nativeTransferLogContract, chain.tokens, sinceIso)
    // Chain into the Ledger Interpreter in 'sweep' mode for any newly
    // reconciled chain_event -- this is what actually produces the
    // SWAP_CREDIT row. Uses 'sweep' rather than a per-event call since this
    // module doesn't track individual chain_event ids from its own insert
    // (runSwapReconciliation's result shape doesn't expose them) -- sweep
    // mode safely finds and interprets exactly the uninterpreted ones,
    // idempotent if called repeatedly.
    // Chain into the Ledger Interpreter in 'sweep' mode whenever this pass's
    // worklist was non-empty -- not only on 'reconciled'. BUG FOUND against
    // a real transaction: scanner.ts's ERC20/native-transfer-log loops have
    // NO known-internal-contract filtering at all (confirmed by inspection
    // -- only mint/self-transfer are excluded), so the ordinary shadow scan
    // can and does independently capture the Kit Adapter's outbound
    // Transfer to a registered wallet before this worker's own pass runs.
    // When that happens, chainEventAlreadyExists is true and the outcome is
    // 'already_covered' -- which is NOT 'reconciled', so the original
    // `results.some(r => r.outcome === 'reconciled')` condition never fired
    // ledger-interpret, and SWAP_CREDIT was silently never produced even
    // though the chain_event existed the whole time. Sweeping whenever the
    // worklist had any row (regardless of outcome) closes this gap --
    // sweep mode is cheap and fully idempotent, so this costs nothing on
    // the common case where nothing new needs interpreting.
    let ledgerSweep = null
    if (results.length > 0) {
      try {
        const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/ledger-interpret`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
          body: JSON.stringify({ mode: 'sweep' }),
        })
        ledgerSweep = await res.json()
      } catch (e) {
        console.error('[swap-reconcile] ledger-interpret sweep call failed:', e instanceof Error ? e.message : e)
      }
    }
    return json({ ok: true, mode, sinceIso, processed: results.length, results, ledgerSweep })
  }

  // -- swap-broadcast-recovery: durable tx_hash recovery for swap attempts --
  // whose nonce cannot be used for recovery (Circle Kit SDK owns the real
  // broadcast nonce -- see swapBroadcastRecovery.ts's own header). Read-only
  // against the chain (no signing, no broadcast); only ever persists a
  // tx_hash once independently verified via RPC. Runs on a much longer
  // grace period than swap-nonce-recovery so it never duplicates that
  // cheaper check -- it only ever looks at attempts nonce-recovery already
  // had many chances to resolve and could not.
  if (mode === 'swap-broadcast-recovery') {
    const graceMinutes = Number(body?.graceMinutes) || 30
    const windowMinutes = Number(body?.windowMinutes) || 60
    const chain = chainById('arc')
    if (!chain) return json({ ok: false, mode, error: 'arc chain config not found' }, 500)
    const unresolved = await findUnresolvedSwapAttemptsForBroadcastRecovery(supabase, chain.id, graceMinutes)
    const finder = makeLiveBroadcastRecoveryCandidateFinder(supabase)
    const verifier = makeLiveBroadcastVerifier(chain.rpcs)
    const updateRepo = makeLiveBroadcastRecoveryUpdateRepository(supabase)
    const results = await sweepUnresolvedSwapAttemptsForBroadcastRecovery(unresolved, finder, verifier, updateRepo, windowMinutes, KIT_ADAPTER_CONTRACT)
    return json({ ok: true, mode, graceMinutes, windowMinutes, processed: results.length, results })
  }

  // -- attempt-reaper: bounded expiry for CREATED/tx_hash-NULL attempts -----
  // that no automated recovery path (pay/bulkpay nonce-recovery, swap
  // nonce-recovery, swap-broadcast-recovery) was ever able to resolve.
  // Covers Pay, BulkPay, and Swap through the one shared module -- see
  // attemptReaper.ts's own header for the full scope/safety reasoning.
  // Never touches an attempt that already has a real tx_hash.
  if (mode === 'attempt-reaper') {
    const boundHours = Number(body?.boundHours) || 24
    const stale = await findStaleCreatedAttempts(supabase, boundHours)
    const updateRepo = makeLiveAttemptReaperUpdateRepository(supabase)
    const results = await sweepStaleCreatedAttempts(stale, updateRepo)
    return json({ ok: true, mode, boundHours, processed: results.length, results })
  }

  // -- activity-ledger-link: backfills Activity.ledger_event_id -----------
  // Links only (never creates) each swap Activity row to its canonical
  // SWAP_DEBIT ledger event -- see activityLedgerLink.ts's own header for
  // why SWAP_DEBIT (not CREDIT) is the deterministic choice.
  if (mode === 'activity-ledger-link') {
    const unlinked = await findUnlinkedSwapActivityRows(supabase)
    const lookup = makeLiveCanonicalLedgerEventLookup(supabase)
    const updateRepo = makeLiveActivityLinkUpdateRepository(supabase)
    const results = await sweepUnlinkedActivityRows(unlinked, lookup, updateRepo)
    return json({ ok: true, mode, processed: results.length, results })
  }

  // -- deposit-activity-consume: canonical chain_events -> Activity -------
  // The consumer for the deposit/incoming side -- see depositActivityConsumer.ts's
  // own header for the full design (recv_<hash> key convention, internal-
  // contract + tracked-attempt correlation safety). Reads chain_events only;
  // never rescans the chain. Coexists safely with deposit-scan-all's own
  // Activity writer during the phased cutover (both upsert the identical
  // recv_<hash>+wallet key onto the real UNIQUE(tx_hash, wallet_address)
  // index -- whichever runs first wins, the other is a no-op).
  if (mode === 'deposit-activity-consume') {
    const windowMinutes = Number(body?.windowMinutes) || 1440
    const sinceIso = new Date(Date.now() - windowMinutes * 60_000).toISOString()
    const chain = chainById('arc')
    if (!chain) return json({ ok: false, mode, error: 'arc chain config not found' }, 500)
    const candidates = await findDepositCandidateChainEvents(supabase, chain.id, sinceIso)
    const lookup = makeLiveDepositEligibilityLookup(supabase)
    const updateRepo = makeLiveDepositActivityUpdateRepository(supabase)
    const results = await sweepDepositCandidateChainEvents(candidates, lookup, updateRepo, 'https://testnet.arcscan.app')
    return json({ ok: true, mode, sinceIso, processed: results.length, results })
  }

  // -- metrics: aggregated operational observability ------------------------
  if (mode === 'metrics') {
    return json(await runMetrics(supabase))
  }

  // -- status: read-only health, no scanning --------------------------------
  if (mode === 'status') {
    const { data } = await supabase.from('chain_cursors').select('*')
    return json({
      ok: true,
      mode,
      chains: INDEXED_CHAINS.map(c => {
        const row = (data ?? []).find((r: Record<string, unknown>) => r.chain_id === c.id)
        return {
          chain: c.id,
          enabled: c.enabled,
          hasRpc: c.rpcs.length > 0,
          confirmationDepth: c.confirmationDepth,
          lastIndexedBlock: row?.last_indexed_block ?? null,
          latestObserved: row?.latest_observed_block ?? null,
          lag: row?.latest_observed_block && row?.last_indexed_block
            ? Number(row.latest_observed_block) - Number(row.last_indexed_block) : null,
          syncState: row?.sync_state ?? 'uninitialized',
          consecutiveFailures: row?.consecutive_failures ?? 0,
          reorgCount: row?.reorg_count ?? 0,
          lastError: row?.last_error ?? null,
        }
      }),
    })
  }

  // -- index: one pass over every enabled chain -----------------------------
  const chains = enabledChains()
  if (chains.length === 0) {
    return json({ ok: true, mode, note: 'no chains enabled or no RPC configured', chains: [] })
  }

  const knownWallets = await loadKnownWallets(supabase)
  if (knownWallets.size === 0) {
    return json({ ok: true, mode, note: 'no wallets to watch', walletCount: 0 })
  }

  const started = Date.now()
  // Chains are processed sequentially: one slow/failing chain must not starve
  // the others of the invocation's CPU budget, and sequential keeps RPC
  // concurrency predictable. With one chain enabled this is moot; it becomes
  // the throttle that matters when more are turned on.
  const reports: Array<Record<string, unknown>> = []
  for (const chain of chains) {
    reports.push(await indexChain(supabase, chain, knownWallets))
  }

  return json({
    ok: true,
    mode,
    shadowMode: true,
    note: 'events published to chain_events; no consumer wired (Phase 4)',
    walletCount: knownWallets.size,
    elapsedMs: Date.now() - started,
    chains: reports,
  })
})
