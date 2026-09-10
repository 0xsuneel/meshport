/**
 * server/ledger/types.ts — shared types for the Ledger Interpreter.
 *
 * Scope: Pay + Swap ONLY (docs/LEDGER_CORE_IMPLEMENTATION.md). CCTP/UB/
 * BulkPay/ChatPay/P2P/Activity/Notification/Balance projections are all
 * explicitly out of scope for this phase.
 *
 * ── Two different sourcing mechanisms for a DEBIT leg, and why ──────────────
 * A `chain_events` row (Phase 3, live) is only ever created when its
 * RECIPIENT is a monitored wallet (blockchain-indexer's scanner checks
 * `knownWallets.has(to)`, never `from`) — but once created, that one row's
 * `metadata` already carries BOTH `sender` and `recipient` (confirmed
 * directly against scanner.ts's `metadata: { recipient, sender, amount }`
 * shape). For an ordinary Pay transfer, the sender is typically also a
 * MeshPort user, but the specific chain_events ROW that exists for this
 * transfer was created because the RECIPIENT is monitored — its metadata is
 * still sufficient, on its own, to derive BOTH the DEBIT (sender) and CREDIT
 * (recipient) ledger legs. No separate transaction_intent/attempt lookup is
 * required for a plain Pay pair — see classifiers.ts's `classifyPayTransfer`.
 *
 * Swap is different, and this is a real architectural finding, not an
 * assumption: a swap's INPUT leg (tokenIn leaving the user's wallet, going
 * TO the swap router) would need a chain_events row where `to` = the
 * router's address — but the router is never in `knownWallets` (confirmed:
 * `knownWallets` is built from `users.wallet_address` only, per index.ts's
 * `loadKnownWallets`), so that row is NEVER created. Only the swap's OUTPUT
 * leg (tokenOut arriving back at the user's own wallet) ever gets a
 * chain_events row. So SWAP_DEBIT cannot be derived from any chain_event —
 * it can only be derived from a CONFIRMED transaction_attempt + its
 * transaction_intent, using the amount/token the app already recorded
 * before broadcasting. Confirmed by a repo-wide search before writing this
 * module: zero code anywhere currently writes to transaction_intents/
 * transaction_attempts (Pay/Swap UI have not migrated to the state machine
 * yet) — so in today's real data, SWAP_DEBIT (and correlated SWAP_CREDIT)
 * cannot actually be produced; this module's Swap classifier is correct and
 * fully tested against synthetic data, but currently dormant against live
 * data until a future, explicitly out-of-scope phase migrates Swap's UI to
 * create real intents. Documented, not hidden — see
 * docs/LEDGER_CORE_IMPLEMENTATION.md's "known limitations".
 */

export type SupportedFeature = 'pay' | 'swap' | 'bulkpay'

export interface IntentContext {
  id: string
  wallet_address: string
  feature: string
  amount_atomic: string
  decimals: number
  token_address: string | null
  token_symbol: string | null
  is_native: boolean
}

export interface AttemptContext {
  id: string
  intent_id: string
  chain_id: string
  tx_hash: string | null
  status: string
  block_number: number | null
}

/** Minimal shape of a chain_events row this module reads. Mirrors Phase 3's schema exactly. */
export interface ChainEventInput {
  id: string
  chain_id: string
  tx_hash: string | null
  wallet_address: string | null
  event_type: string
  status: string
  log_index: number | null
  block_number: number | null
  token_address?: string | null
  token_symbol?: string | null
  decimals?: number | null
  metadata: Record<string, unknown> | null
}

export type LedgerEventType = 'DEBIT' | 'CREDIT' | 'SWAP_DEBIT' | 'SWAP_CREDIT'

/** A fully-formed row ready to insert into ledger_events. Never partially built. */
export interface LedgerEventDraft {
  transaction_intent_id: string | null
  transaction_attempt_id: string | null
  wallet_address: string
  chain_id: string
  event_type: LedgerEventType
  direction: 'debit' | 'credit'
  token_address: string | null
  token_symbol: string | null
  decimals: number
  amount_atomic: string
  is_native: boolean
  tx_hash: string | null
  block_number: number | null
  log_index: number | null
  event_key: string
  metadata: Record<string, unknown>
}

/**
 * Outcome of classifying a chain_event/attempt. `not_applicable` and
 * `unresolved` are real, first-class, non-error outcomes — see
 * classifiers.ts for the distinction between them. Neither ever produces a
 * draft; the caller must never treat either as "close enough to CREDIT".
 */
export type ClassificationOutcome =
  | { outcome: 'classified'; drafts: LedgerEventDraft[] }
  | { outcome: 'not_applicable'; reason: string }
  | { outcome: 'unresolved'; reason: string }

/** Result of attempting to insert one ledger event. */
export type InsertOutcome =
  | { outcome: 'inserted'; id: string }
  | { outcome: 'already_posted'; id: string } // idempotent retry, same event_type — safe, expected
  | { outcome: 'conflict'; existingEventType: string } // raw movement exists under a DIFFERENT event_type — the dangerous case, surfaced not swallowed
