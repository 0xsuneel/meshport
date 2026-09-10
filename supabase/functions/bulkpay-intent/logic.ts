// supabase/functions/bulkpay-intent/logic.ts
//
// Pure, dependency-injected logic for BulkPay intent + attempt creation
// with server-reserved nonce -- docs/BULKPAY_TRANSACTION_INTENT_IMPLEMENTATION.md,
// closing the two problems traced in docs/BULKPAY_TRANSACTION_INTENT_MIGRATION_AUDIT.md
// and docs/BULKPAY_BROADCAST_RESPONSE_LOSS_AUDIT.md:
//   1. No transaction_intent/attempt exists for BulkPay today -- this module
//      creates exactly ONE of each per operation (never N for N recipients).
//   2. The nonce used for broadcast was, until now, computed client-side
//      and never independently recorded -- meaning a receipt timeout OR a
//      lost broadcast response left nothing to reconcile against. This
//      module reserves the nonce SERVER-SIDE, before the client ever
//      broadcasts, and persists it as part of the attempt.
//
// No Supabase client and no RPC client is instantiated here -- both are
// supplied by the caller (index.ts), matching the exact discipline already
// used throughout server/ledger/ and blockchain-indexer's bulkpayReconcile.ts.

export interface CreateBulkPayIntentRequest {
  walletAddress: string
  idempotencyKey: string
  chainId: string
  amountAtomic: string
  decimals: number
  isNative: boolean
  tokenAddress: string | null
  tokenSymbol: string | null
  recipientCount: number
  purpose?: string | null
}

export interface IntentRepository {
  findIntentByIdempotencyKey(walletAddress: string, idempotencyKey: string): Promise<{ id: string; attemptId: string | null } | null>

  insertIntent(row: {
    wallet_address: string
    feature: 'bulkpay'
    idempotency_key: string
    status: 'AUTHORIZING'
    amount_atomic: string
    decimals: number
    token_address: string | null
    token_symbol: string | null
    metadata: Record<string, unknown>
  }): Promise<{ outcome: 'inserted'; id: string } | { outcome: 'conflict' }>

  insertAttempt(row: {
    intent_id: string
    chain_id: string
    wallet_address: string
    nonce: number
    status: 'CREATED'
  }): Promise<{ outcome: 'inserted'; id: string } | { outcome: 'nonce_conflict' }>

  /** Sets tx_hash + status='SUBMITTED' on an existing attempt. See markBulkPayAttemptSubmitted's own doc comment for why this exists as a separate, minimal write. */
  markAttemptSubmitted(attemptId: string, txHash: string): Promise<void>

  /**
   * Transitions the parent transaction_intent AUTHORIZING -> SUBMITTED,
   * once its attempt has been created. Without this, transaction_intents.
   * status stays stuck at AUTHORIZING forever -- and deriveDisplayState
   * (server/transactionStateMachine/transitions.ts) returns intent.status
   * DIRECTLY whenever it isn't 'SUBMITTED', so a stuck AUTHORIZING intent
   * would display as "AUTHORIZING" permanently, even after the underlying
   * attempt fully confirms. Conditional (AUTHORIZING -> SUBMITTED only) --
   * mirrors the existing state machine's own transition table exactly, not
   * a new transition invented for BulkPay.
   */
  transitionIntentToSubmitted(intentId: string): Promise<void>

  /**
   * BUG FIX (live report, 2026-09-05): "could not reserve a unique nonce
   * after 5 attempts -- possible high-concurrency contention for this
   * wallet" was firing on completely ordinary, single-user traffic, not
   * concurrency -- see pay-intent/logic.ts's identical method for the full
   * root-cause writeup (mirrored exactly here). Short version: a BulkPay
   * attempt that reserves a nonce here but never actually broadcasts
   * leaves a permanent `status: 'CREATED', tx_hash: NULL` row occupying
   * that (chain_id, wallet_address, nonce) slot, which getPendingNonce
   * keeps re-reporting as "next pending" forever (nothing was ever
   * broadcast to advance it) -- so every retry hits the identical
   * conflict, and bulkpayNonceRecovery.ts's sweep deliberately never
   * resolves a `not_found` case either, by design. This closes the gap
   * safely -- see pay-intent's version for the full double-spend-safety
   * argument.
   */
  reclaimStaleAttempt(chainId: string, walletAddress: string, nonce: number, staleBeforeIso: string): Promise<boolean>
}

export interface NonceFetcher {
  getPendingNonce(chainId: string, walletAddress: string): Promise<number>
}

export type CreateIntentOutcome =
  | { outcome: 'created'; intentId: string; attemptId: string; nonce: number }
  | { outcome: 'idempotent_replay'; intentId: string; attemptId: string | null }
  | { outcome: 'invalid_request'; reason: string }

const MAX_NONCE_RESERVATION_ATTEMPTS = 5
// See pay-intent/logic.ts's identical constant for the full reasoning.
// Previously 2 minutes; lowered to 10s per live report 2026-09-05.
const STALE_ATTEMPT_GRACE_MS = 10 * 1000

/**
 * Creates exactly ONE transaction_intents row (feature='bulkpay') and ONE
 * transaction_attempts row (status='CREATED', nonce reserved server-side)
 * for one BulkPay operation -- never N of either for N recipients (the
 * mandatory architectural invariant).
 *
 * Idempotency (Question B): a duplicate request with the SAME
 * (walletAddress, idempotencyKey) -- e.g. a genuine double-click, or a
 * client retry after losing the HTTP response to this very endpoint --
 * returns the EXISTING intent/attempt rather than creating a second one.
 * Checked twice: once as a courtesy pre-check, and once implicitly by the
 * database's own UNIQUE constraint if two requests race past the pre-check
 * concurrently (insertIntent's `conflict` outcome) -- the real invariant is
 * always the database constraint.
 *
 * Nonce concurrency (Phase 2's explicit requirement): the nonce is queried
 * fresh via nonceFetcher.getPendingNonce and the attempt insert relies on
 * idx_transaction_attempts_wallet_nonce (new migration,
 * 20260825060000_bulkpay_nonce_reservation.sql) to catch a genuine
 * concurrent collision. On a nonce_conflict, this function re-queries the
 * nonce and retries, bounded by MAX_NONCE_RESERVATION_ATTEMPTS.
 */
export async function createBulkPayIntent(
  repo: IntentRepository,
  nonceFetcher: NonceFetcher,
  req: CreateBulkPayIntentRequest,
): Promise<CreateIntentOutcome> {
  const wallet = (req.walletAddress ?? '').trim().toLowerCase()
  if (!wallet) return { outcome: 'invalid_request', reason: 'walletAddress required' }
  if (!req.idempotencyKey) return { outcome: 'invalid_request', reason: 'idempotencyKey required' }
  if (!req.chainId) return { outcome: 'invalid_request', reason: 'chainId required' }
  if (req.recipientCount < 1) return { outcome: 'invalid_request', reason: 'recipientCount must be at least 1' }
  let amountBig: bigint
  try { amountBig = BigInt(req.amountAtomic) } catch { return { outcome: 'invalid_request', reason: 'amountAtomic must be a valid integer string' } }
  if (amountBig <= 0n) return { outcome: 'invalid_request', reason: 'amountAtomic must be positive' }

  const existing = await repo.findIntentByIdempotencyKey(wallet, req.idempotencyKey)
  if (existing) {
    return { outcome: 'idempotent_replay', intentId: existing.id, attemptId: existing.attemptId }
  }

  // metadata carries ONLY non-authoritative operation context -- recipient
  // amounts/addresses are deliberately NOT stored here as a canonical
  // recipient list. The real recipient/amount truth always comes from the
  // confirmed chain_events later, independently decoded from the real
  // transaction receipt -- never from anything recorded here.
  //
  // BUG FIX: this call previously also sent `is_native: req.isNative` --
  // transaction_intents has no such column (confirmed directly against the
  // live schema after a real production failure, PGRST204 "Could not find
  // the 'is_native' column"). "Native" was always fully representable via
  // token_address IS NULL (the same convention used throughout
  // server/ledger/'s own classifiers) -- req.isNative is still used below
  // to decide token_address, it's just never sent as its own column, since
  // it never had one.
  const insertResult = await repo.insertIntent({
    wallet_address: wallet,
    feature: 'bulkpay',
    idempotency_key: req.idempotencyKey,
    status: 'AUTHORIZING',
    amount_atomic: amountBig.toString(),
    decimals: req.decimals,
    token_address: req.isNative ? null : req.tokenAddress,
    token_symbol: req.tokenSymbol,
    metadata: {
      recipient_count: req.recipientCount,
      purpose: req.purpose ?? null,
    },
  })

  if (insertResult.outcome === 'conflict') {
    const raced = await repo.findIntentByIdempotencyKey(wallet, req.idempotencyKey)
    if (raced) return { outcome: 'idempotent_replay', intentId: raced.id, attemptId: raced.attemptId }
    return { outcome: 'invalid_request', reason: 'intent conflict reported but no existing row found -- inconsistent state' }
  }

  const intentId = insertResult.id

  for (let i = 0; i < MAX_NONCE_RESERVATION_ATTEMPTS; i++) {
    const nonce = await nonceFetcher.getPendingNonce(req.chainId, wallet)
    const attemptResult = await repo.insertAttempt({
      intent_id: intentId,
      chain_id: req.chainId,
      wallet_address: wallet,
      nonce,
      status: 'CREATED',
    })
    if (attemptResult.outcome === 'inserted') {
      // The intent moves out of AUTHORIZING the moment a real attempt
      // exists for it -- see transitionIntentToSubmitted's own doc comment
      // for why this is required, not cosmetic.
      await repo.transitionIntentToSubmitted(intentId)
      return { outcome: 'created', intentId, attemptId: attemptResult.id, nonce }
    }
    // nonce_conflict: could be another concurrent operation for this same
    // wallet, OR a previous abandoned attempt that never broadcast --
    // see reclaimStaleAttempt's own doc comment above for the full
    // reasoning. Try to reclaim before re-querying and retrying, bounded.
    await repo.reclaimStaleAttempt(req.chainId, wallet, nonce, new Date(Date.now() - STALE_ATTEMPT_GRACE_MS).toISOString())
  }
  return { outcome: 'invalid_request', reason: `could not reserve a unique nonce after ${MAX_NONCE_RESERVATION_ATTEMPTS} attempts -- possible high-concurrency contention for this wallet` }
}

// ── Post-broadcast tx_hash persistence (Phase 3 of the frontend integration) ──
//
// Called by the client IMMEDIATELY after sendTransaction returns, BEFORE
// waitForTransactionReceipt — the exact ordering fix already made once,
// directly in BulkPayoutPage.tsx's own local bulkTxHash variable, now
// extended to also persist server-side so the attempt survives a lost
// process (tab close, network loss) the same local-variable fix alone
// cannot help with (docs/BULKPAY_BROADCAST_RESPONSE_LOSS_AUDIT.md's Case 2).

export type MarkSubmittedOutcome =
  | { outcome: 'updated' }
  | { outcome: 'invalid_request'; reason: string }

/**
 * Persists a real, client-observed tx_hash onto an existing attempt,
 * transitioning it to SUBMITTED. This is the ONLY new server-side write
 * this integration adds beyond intent/attempt creation — everything after
 * this point (CONFIRMING/CONFIRMED/REVERTED/UNKNOWN) is the existing state
 * machine, unmodified. Does not verify the tx_hash against a real receipt
 * itself (that remains the existing confirmation/reconciliation
 * machinery's job) — this function's only responsibility is making sure a
 * real, client-known hash is never lost, exactly closing the bug traced in
 * docs/BULKPAY_TRANSACTION_INTENT_MIGRATION_AUDIT.md §1.
 */
export async function markBulkPayAttemptSubmitted(
  repo: Pick<IntentRepository, 'markAttemptSubmitted'>,
  attemptId: string,
  txHash: string,
): Promise<MarkSubmittedOutcome> {
  if (!attemptId) return { outcome: 'invalid_request', reason: 'attemptId required' }
  if (!txHash || !txHash.startsWith('0x')) return { outcome: 'invalid_request', reason: 'a valid txHash is required' }
  await repo.markAttemptSubmitted(attemptId, txHash.toLowerCase())
  return { outcome: 'updated' }
}
