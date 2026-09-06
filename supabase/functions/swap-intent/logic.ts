// supabase/functions/swap-intent/logic.ts
//
// Pure, dependency-injected logic for Swap intent + attempt creation with a
// server-reserved nonce -- mirrors supabase/functions/pay-intent/logic.ts
// (itself mirroring bulkpay-intent/logic.ts) exactly, the same
// production-validated architecture applied to Swap.
//
// Differences from pay-intent, and why:
//   - feature='swap', not 'pay'.
//   - The intent's primary token_address/token_symbol/amount_atomic/decimals
//     columns represent the INPUT leg only (what the wallet gives up) --
//     this is what transaction_attempts/ledger's classifySwapDebit reads
//     (see server/ledger/classifiers.ts). The OUTPUT leg is never stored as
//     blockchain truth here: only an expected/quoted reference figure goes
//     into metadata.expectedOutput, strictly for display/slippage-check
//     purposes. The actual output token+amount are derived later, entirely
//     independently, from the real on-chain Transfer log by
//     classifySwapCredit -- never copied from this intent.
//   - recipient_address is the swapping wallet itself (Swap has no separate
//     counterparty) -- set for consistency/queryability, not because
//     confirmation needs a distinct expected recipient the way Pay does.
//   - metadata carries router/Kit-Adapter target, slippage_bps, and the
//     quote reference (tokenOut, minOutAtomic) -- authoritative for
//     "what the user asked for", never for "what happened on-chain".
//   - Otherwise byte-for-byte the same shape: one intent, one attempt,
//     idempotent on (wallet_address, idempotency_key), server-reserved
//     nonce with bounded retry on collision.

export interface CreateSwapIntentRequest {
  walletAddress: string
  idempotencyKey: string
  chainId: string
  amountInAtomic: string
  decimalsIn: number
  tokenInAddress: string | null
  tokenInSymbol: string | null
  isNativeIn: boolean
  tokenOutAddress: string | null
  tokenOutSymbol: string | null
  decimalsOut: number
  minAmountOutAtomic: string | null
  expectedAmountOutAtomic: string | null
  slippageBps: number | null
  routerAddress: string | null
}

export interface IntentRepository {
  findIntentByIdempotencyKey(walletAddress: string, idempotencyKey: string): Promise<{ id: string; attemptId: string | null } | null>

  insertIntent(row: {
    wallet_address: string
    feature: 'swap'
    idempotency_key: string
    status: 'AUTHORIZING'
    amount_atomic: string
    decimals: number
    token_address: string | null
    token_symbol: string | null
    recipient_address: string
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
   * concurrency -- see pay-intent/logic.ts's identical method for the full
   * root-cause writeup (this mirrors it exactly, same as everywhere else
   * in this file). Short version: a Swap attempt that reserves a nonce
   * here but never actually broadcasts leaves a permanent
   * `status: 'CREATED', tx_hash: NULL` row occupying that (chain_id,
   * wallet_address, nonce) slot, which getPendingNonce will keep
   * re-reporting as "next pending" forever (nothing was ever broadcast to
   * advance it) -- so every retry hits the identical conflict, and no
   * existing mechanism (swapNonceRecovery.ts's sweep deliberately never
   * resolves a `not_found` case, by design) ever frees it. This closes the
   * gap safely, using the fact that THIS SAME request just asked the
   * chain for this exact nonce and got it back, proving nothing has
   * broadcast there as of right now -- see pay-intent's version for the
   * full double-spend-safety argument (a losing race just gets an
   * ordinary "nonce too low" RPC rejection, never a double-spend).
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
 * Creates exactly ONE transaction_intents row (feature='swap') and ONE
 * transaction_attempts row (status='CREATED', nonce reserved server-side)
 * for one Swap operation. Idempotent on (wallet_address, idempotency_key),
 * same as Pay/BulkPay.
 *
 * Represents ONE user Swap -- never one per Transfer log or per internal
 * contract movement (see PHASE 3 of the task spec this mirrors).
 */
export async function createSwapIntent(
  repo: IntentRepository,
  nonceFetcher: NonceFetcher,
  req: CreateSwapIntentRequest,
): Promise<CreateIntentOutcome> {
  const wallet = (req.walletAddress ?? '').trim().toLowerCase()
  if (!wallet) return { outcome: 'invalid_request', reason: 'walletAddress required' }
  if (!req.idempotencyKey) return { outcome: 'invalid_request', reason: 'idempotencyKey required' }
  if (!req.chainId) return { outcome: 'invalid_request', reason: 'chainId required' }

  let amountInBig: bigint
  try { amountInBig = BigInt(req.amountInAtomic) } catch { return { outcome: 'invalid_request', reason: 'amountInAtomic must be a valid integer string' } }
  if (amountInBig <= 0n) return { outcome: 'invalid_request', reason: 'amountInAtomic must be positive' }
  if (!req.isNativeIn && !req.tokenInAddress) return { outcome: 'invalid_request', reason: 'tokenInAddress required for a non-native swap input' }
  if (!req.tokenOutSymbol) return { outcome: 'invalid_request', reason: 'tokenOutSymbol required' }
  if (req.tokenInSymbol && req.tokenOutSymbol && req.tokenInSymbol === req.tokenOutSymbol) {
    return { outcome: 'invalid_request', reason: 'tokenIn and tokenOut must differ' }
  }

  const existing = await repo.findIntentByIdempotencyKey(wallet, req.idempotencyKey)
  if (existing) {
    return { outcome: 'idempotent_replay', intentId: existing.id, attemptId: existing.attemptId }
  }

  const insertResult = await repo.insertIntent({
    wallet_address: wallet,
    feature: 'swap',
    idempotency_key: req.idempotencyKey,
    status: 'AUTHORIZING',
    amount_atomic: amountInBig.toString(),
    decimals: req.decimalsIn,
    token_address: req.isNativeIn ? null : req.tokenInAddress,
    token_symbol: req.tokenInSymbol,
    // Swap has no separate counterparty -- the swapping wallet is its own
    // "recipient" for the purpose of this column, kept only for
    // queryability/consistency with the other features.
    recipient_address: wallet,
    metadata: {
      tokenOutAddress: req.tokenOutAddress,
      tokenOutSymbol: req.tokenOutSymbol,
      decimalsOut: req.decimalsOut,
      // Reference/quote figures only -- never treated as blockchain truth.
      // classifySwapCredit derives the real output token+amount from the
      // actual on-chain Transfer log, independent of these.
      minAmountOutAtomic: req.minAmountOutAtomic,
      expectedAmountOutAtomic: req.expectedAmountOutAtomic,
      slippageBps: req.slippageBps,
      routerAddress: req.routerAddress,
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
      await repo.transitionIntentToSubmitted(intentId)
      return { outcome: 'created', intentId, attemptId: attemptResult.id, nonce }
    }
    // BUG FIX: see reclaimStaleAttempt's own doc comment on IntentRepository
    // above for the full reasoning.
    await repo.reclaimStaleAttempt(req.chainId, wallet, nonce, new Date(Date.now() - STALE_ATTEMPT_GRACE_MS).toISOString())
  }
  return { outcome: 'invalid_request', reason: `could not reserve a unique nonce after ${MAX_NONCE_RESERVATION_ATTEMPTS} attempts -- possible high-concurrency contention for this wallet` }
}

export type MarkSubmittedOutcome =
  | { outcome: 'updated' }
  | { outcome: 'invalid_request'; reason: string }

/** Persists a real, client-observed tx_hash onto an existing attempt, transitioning it to SUBMITTED. Mirrors markPayAttemptSubmitted exactly. */
export async function markSwapAttemptSubmitted(
  repo: Pick<IntentRepository, 'markAttemptSubmitted'>,
  attemptId: string,
  txHash: string,
): Promise<MarkSubmittedOutcome> {
  if (!attemptId) return { outcome: 'invalid_request', reason: 'attemptId required' }
  if (!txHash || !txHash.startsWith('0x')) return { outcome: 'invalid_request', reason: 'a valid txHash is required' }
  await repo.markAttemptSubmitted(attemptId, txHash.toLowerCase())
  return { outcome: 'updated' }
}
