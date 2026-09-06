// supabase/functions/pay-intent/logic.ts
//
// Pure, dependency-injected logic for Pay intent + attempt creation with a
// server-reserved nonce -- mirrors supabase/functions/bulkpay-intent/logic.ts
// exactly, the same architecture already production-validated for BulkPay,
// applied to Pay per PAY_TRANSACTION_INTENT_IMPLEMENTATION.md.
//
// Differences from bulkpay-intent, and why:
//   - feature='pay', not 'bulkpay'.
//   - recipientAddress/recipientUsername are stored on the intent (real,
//     already-existing columns from Phase 1, never populated by BulkPay
//     since a batch has no single recipient) -- needed so confirmation can
//     later compute the correct expected `to` (see payConfirmation.ts).
//   - No `purpose`/`recipient_count` metadata -- Pay has neither concept.
//   - Otherwise byte-for-byte the same shape: one intent, one attempt,
//     idempotent on (wallet_address, idempotency_key), server-reserved
//     nonce with bounded retry on collision.

export interface CreatePayIntentRequest {
  walletAddress: string
  idempotencyKey: string
  chainId: string
  amountAtomic: string
  decimals: number
  isNative: boolean
  tokenAddress: string | null
  tokenSymbol: string | null
  recipientAddress: string
  recipientUsername?: string | null
}

export interface IntentRepository {
  findIntentByIdempotencyKey(walletAddress: string, idempotencyKey: string): Promise<{ id: string; attemptId: string | null } | null>

  insertIntent(row: {
    wallet_address: string
    feature: 'pay'
    idempotency_key: string
    status: 'AUTHORIZING'
    amount_atomic: string
    decimals: number
    token_address: string | null
    token_symbol: string | null
    recipient_address: string
    recipient_username: string | null
    metadata: Record<string, unknown>
  }): Promise<{ outcome: 'inserted'; id: string } | { outcome: 'conflict' }>

  insertAttempt(row: {
    intent_id: string
    chain_id: string
    wallet_address: string
    nonce: number
    status: 'CREATED'
  }): Promise<{ outcome: 'inserted'; id: string } | { outcome: 'nonce_conflict' }>

  markAttemptSubmitted(attemptId: string, txHash: string): Promise<void>
  transitionIntentToSubmitted(intentId: string): Promise<void>

  /**
   * BUG FIX (live report, 2026-09-05): "could not reserve a unique nonce
   * after 5 attempts -- possible high-concurrency contention for this
   * wallet" was firing on completely ordinary, single-user traffic, not
   * concurrency. Root cause: a Pay attempt that gets its nonce reserved
   * here but then never actually broadcasts (the passcode step fails, the
   * wallet decrypt fails, sendTransaction itself throws, the tab closes)
   * leaves a `status: 'CREATED', tx_hash: NULL` row permanently occupying
   * that (chain_id, wallet_address, nonce) slot in
   * idx_transaction_attempts_wallet_nonce (see
   * 20260825060000_bulkpay_nonce_reservation.sql). getPendingNonce reports
   * the chain's real "next pending" nonce -- which never advances past
   * this exact value, because nothing was ever actually broadcast there --
   * so every one of the 5 retry attempts fetches the SAME nonce and hits
   * the SAME conflict. The existing background sweep
   * (payNonceRecovery.ts's sweepUnresolvedAttempts) deliberately never
   * resolves this case either -- by design, its own test file is named
   * "not_found leaves the attempt completely untouched -- structurally
   * cannot rebroadcast", because "not found in a scan window" isn't proof
   * of "never broadcast" on its own. There was, before this fix, no path
   * anywhere in the codebase that ever concluded "this reservation is
   * genuinely dead, free it" -- once a wallet got one abandoned attempt,
   * every future Pay/Swap/BulkPay attempt from it failed the exact same
   * way, forever.
   *
   * This closes the gap safely, using a DIFFERENT and stronger signal than
   * the background sweep's chain-scan: called only from directly inside
   * this file's own nonce-conflict retry loop, i.e. only when the SAME
   * request has *just itself* asked the chain for this wallet's current
   * pending nonce and gotten this exact value back -- which already proves
   * nothing has broadcast at this nonce as of right now, this request,
   * this moment. Combined with the conflicting row being old enough
   * (`staleBeforeIso`) and never having progressed past CREATED/tx_hash
   * NULL, reclaiming it (freeing the nonce for immediate reuse by setting
   * nonce back to NULL, which removes it from the partial unique index) is
   * safe: worst case if this races a genuinely-in-flight send, the LOSING
   * side of that race gets an ordinary "nonce too low" RPC rejection when
   * it tries to broadcast -- a normal, safe failure, never a double-spend,
   * since only one transaction can ever actually land at a given nonce.
   *
   * Returns true only if a row was actually reclaimed (lets the caller
   * decide whether retrying is worth it vs. genuine concurrent
   * contention, which this must never mask).
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

// Arc's own finality is sub-second (confirmationDepth 0), and a real send
// from click-to-broadcast (passcode entry, gas estimate, signing) normally
// completes in well under 10s even on a slow connection. 10s with zero
// on-chain trace at this nonce is overwhelming evidence the original attempt
// never actually broadcast, not just "still pending" -- see
// reclaimStaleAttempt's own doc comment for the full safety reasoning (why
// reclaiming even a false positive here can never double-spend). Previously
// 2 minutes -- lowered per live report 2026-09-05: a dangling reservation
// from one failed Swap blocked the very next Pay attempt from the same
// wallet for the entire grace window, since reclaim legitimately refuses to
// touch a reservation until it's provably stale.
const STALE_ATTEMPT_GRACE_MS = 10 * 1000

/**
 * Creates exactly ONE transaction_intents row (feature='pay') and ONE
 * transaction_attempts row (status='CREATED', nonce reserved server-side)
 * for one Pay operation. Idempotent on (wallet_address, idempotency_key) --
 * same UNIQUE constraint BulkPay already relies on, same bounded
 * nonce-collision retry.
 */
export async function createPayIntent(
  repo: IntentRepository,
  nonceFetcher: NonceFetcher,
  req: CreatePayIntentRequest,
): Promise<CreateIntentOutcome> {
  const wallet = (req.walletAddress ?? '').trim().toLowerCase()
  if (!wallet) return { outcome: 'invalid_request', reason: 'walletAddress required' }
  if (!req.idempotencyKey) return { outcome: 'invalid_request', reason: 'idempotencyKey required' }
  if (!req.chainId) return { outcome: 'invalid_request', reason: 'chainId required' }
  const recipient = (req.recipientAddress ?? '').trim().toLowerCase()
  if (!recipient) return { outcome: 'invalid_request', reason: 'recipientAddress required' }
  // Self-transfer is now permitted -- previously rejected here.
  let amountBig: bigint
  try { amountBig = BigInt(req.amountAtomic) } catch { return { outcome: 'invalid_request', reason: 'amountAtomic must be a valid integer string' } }
  if (amountBig <= 0n) return { outcome: 'invalid_request', reason: 'amountAtomic must be positive' }
  if (!req.isNative && !req.tokenAddress) return { outcome: 'invalid_request', reason: 'tokenAddress required for a non-native Pay' }

  const existing = await repo.findIntentByIdempotencyKey(wallet, req.idempotencyKey)
  if (existing) {
    return { outcome: 'idempotent_replay', intentId: existing.id, attemptId: existing.attemptId }
  }

  const insertResult = await repo.insertIntent({
    wallet_address: wallet,
    feature: 'pay',
    idempotency_key: req.idempotencyKey,
    status: 'AUTHORIZING',
    amount_atomic: amountBig.toString(),
    decimals: req.decimals,
    token_address: req.isNative ? null : req.tokenAddress,
    token_symbol: req.tokenSymbol,
    recipient_address: recipient,
    recipient_username: req.recipientUsername ?? null,
    metadata: {},
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
      await repo.transitionIntentToSubmitted(intentId)
      return { outcome: 'created', intentId, attemptId: attemptResult.id, nonce }
    }
    // BUG FIX: see reclaimStaleAttempt's own doc comment on IntentRepository
    // above for the full reasoning. The conflicting row at this exact
    // nonce might not be genuine concurrent contention at all -- it might
    // be a previous, abandoned attempt that reserved this nonce and never
    // broadcast. Try to reclaim it before the next loop iteration re-asks
    // the chain for the same "pending" nonce (which will not have moved).
    await repo.reclaimStaleAttempt(req.chainId, wallet, nonce, new Date(Date.now() - STALE_ATTEMPT_GRACE_MS).toISOString())
  }
  return { outcome: 'invalid_request', reason: `could not reserve a unique nonce after ${MAX_NONCE_RESERVATION_ATTEMPTS} attempts -- possible high-concurrency contention for this wallet` }
}

export type MarkSubmittedOutcome =
  | { outcome: 'updated' }
  | { outcome: 'invalid_request'; reason: string }

/** Persists a real, client-observed tx_hash onto an existing attempt, transitioning it to SUBMITTED. Mirrors markBulkPayAttemptSubmitted exactly. */
export async function markPayAttemptSubmitted(
  repo: Pick<IntentRepository, 'markAttemptSubmitted'>,
  attemptId: string,
  txHash: string,
): Promise<MarkSubmittedOutcome> {
  if (!attemptId) return { outcome: 'invalid_request', reason: 'attemptId required' }
  if (!txHash || !txHash.startsWith('0x')) return { outcome: 'invalid_request', reason: 'a valid txHash is required' }
  await repo.markAttemptSubmitted(attemptId, txHash.toLowerCase())
  return { outcome: 'updated' }
}
