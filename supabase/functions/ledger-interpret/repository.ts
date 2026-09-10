/**
 * server/ledger/repository.ts — the ONLY boundary between the Ledger
 * Interpreter and a database.
 *
 * The interpreter never instantiates its own Supabase (or any other)
 * client — every DB operation goes through this interface, supplied by the
 * caller. This is the same dependency-injection discipline already used by
 * server/transactionStateMachine/apply.ts, for the same reason: it keeps
 * this module testable without a live database and keeps it from ever
 * needing to know which runtime (Node/Vercel vs. Deno/Supabase Edge
 * Function) it's running in — see docs/TRANSACTION_SERVICE_BOUNDARY.md for
 * the ADR this follows.
 *
 * No implementation of this interface is provided in this phase — building
 * a real Supabase-backed implementation and wiring it into a caller (an API
 * route or Edge Function) is deployment/integration work, explicitly out of
 * scope for this phase ("Do NOT deploy Edge Functions in this phase").
 * Tests in interpreter.test.ts implement this interface against a small,
 * real in-memory store with genuine conditional-write semantics — the same
 * pattern already proven in server/transactionStateMachine/apply.test.ts —
 * not a real Postgres/Supabase instance.
 */

import type { ChainEventInput, AttemptContext, IntentContext, LedgerEventDraft, InsertOutcome } from './types.ts'

export interface LedgerRepository {
  /** Reads a chain_events row by id. Returns null if it doesn't exist. */
  getChainEvent(id: string): Promise<ChainEventInput | null>

  /**
   * Finds a transaction_attempts row by (chain_id, tx_hash) — the exact
   * correlation mechanism docs/LEDGER_CANONICAL_EVENT_DESIGN.md §2
   * specifies as the primary classification signal. Returns null if no
   * attempt has broadcast this tx_hash on this chain (the common case
   * today, since no feature yet creates transaction_intents/attempts —
   * see types.ts's header comment).
   */
  findAttemptByTxHash(chainId: string, txHash: string): Promise<AttemptContext | null>

  /** Reads a transaction_intents row by id. Returns null if it doesn't exist. */
  getIntent(intentId: string): Promise<IntentContext | null>

  /**
   * Looks up an existing ledger_events row by the RAW MOVEMENT identity
   * (chain_id, tx_hash, log_index, wallet_address) — NOT by event_key. This
   * is what lets the interpreter distinguish "this exact classification was
   * already posted, idempotent no-op" from "this raw movement was already
   * posted under a DIFFERENT classification, a real conflict" BEFORE even
   * attempting the insert — the same courtesy-check-then-authoritative-write
   * pattern already used in server/transactionStateMachine/apply.ts (the
   * real enforcement is still the database constraint itself; this is a
   * cheaper, clearer pre-check).
   */
  findLedgerEventByRawMovement(
    chainId: string,
    txHash: string,
    logIndex: number | null,
    walletAddress: string,
  ): Promise<{ id: string; event_type: string } | null>

  /**
   * Inserts one ledger_events row with settlement_status='POSTED' (this
   * phase only ever calls this for already-confirmed chain_events/attempts
   * — see interpreter.ts's confirmation-rule guard). Must be implemented
   * using the database's real conflict-detection (an upsert against
   * event_key AND the raw-movement unique index, or an explicit pre-check
   * plus a conditional insert) — never a blind INSERT that could throw an
   * unhandled constraint violation up to the caller. Returns a discriminated
   * result so the caller can tell a safe idempotent retry apart from a
   * genuine conflict that must be surfaced, not swallowed.
   */
  insertLedgerEvent(draft: LedgerEventDraft): Promise<InsertOutcome>
}
