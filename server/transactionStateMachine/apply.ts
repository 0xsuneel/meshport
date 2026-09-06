/**
 * Canonical transaction state machine — the only supported way to change
 * transaction_intents.status, transaction_attempts.status, or
 * ledger_events.settlement_status.
 *
 * Feature code must call transitionIntent / transitionAttempt /
 * transitionLedgerEvent instead of writing `UPDATE ... SET status = ...`
 * directly. These three functions are the sole write path this migration
 * introduces; nothing in Phase 2 wires a caller up to them yet (see Phase 2
 * scope in docs/TRANSACTION_STATE_MACHINE.md — Pay/Receive/Swap/etc. are
 * later phases).
 *
 * Concurrency & idempotency (see docs/TRANSACTION_STATE_MACHINE.md
 * "Concurrency" and "Idempotency" sections for the full reasoning):
 *
 *   - Every transition is applied as a single conditional UPDATE
 *     (`WHERE id = $1 AND status = $2`), not read-then-write. Postgres's
 *     row-level locking makes the compare-and-swap atomic — no in-memory
 *     lock, no SELECT ... FOR UPDATE, needed.
 *   - Calling the same transition twice (from === to on the second call)
 *     is a no-op success, not an error.
 *   - Two callers racing to apply DIFFERENT valid transitions from the same
 *     starting state: exactly one UPDATE affects a row; the loser's
 *     conditional UPDATE affects zero rows, and this module re-reads the
 *     row to decide whether the loser's request was actually satisfied
 *     (someone else made the identical change → idempotent success) or
 *     genuinely conflicts with a different winning transition
 *     (→ ConcurrentTransitionConflictError, not silently swallowed).
 *   - An attempted transition that was never valid from the state that was
 *     actually current at write time throws InvalidTransitionError — this
 *     is checked twice: once optimistically against the row this function
 *     read (fast-fail before any write), and implicitly for real by the
 *     conditional UPDATE's WHERE clause, which is the actual source of
 *     truth under concurrency.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { type IntentStatus, type AttemptStatus, type LedgerStatus } from './types'

// supabase-js's generated client types parse the `select("...")` string at
// the TYPE level to infer a precise return shape from a real schema. This
// module deliberately works generically across three different tables with
// dynamically-built select strings (`id, ${statusColumn}`), which that
// string-parsing machinery can't represent — so the client is accepted as
// `SupabaseClient` (still requires a real, correctly-constructed client at
// the call site) but narrowed to `any` at the point of use, trading away
// column-name autocompletion for the genericity this module needs. The
// actual safety net is runtime: every column this module reads/writes is a
// fixed, hardcoded name (never user input), and every test in apply.test.ts
// exercises the real request/response shape.
type LooseSupabaseClient = { from: (table: string) => any }
import {
  validateIntentTransition,
  validateAttemptTransition,
  validateLedgerTransition,
} from './transitions'

export class TransitionTargetNotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} not found`)
    this.name = 'TransitionTargetNotFoundError'
  }
}

export class ConcurrentTransitionConflictError extends Error {
  readonly requestedTo: string
  readonly actualStatus: string

  constructor(entity: string, id: string, requestedTo: string, actualStatus: string) {
    super(
      `${entity} ${id}: requested transition to ${requestedTo} lost a race — ` +
        `another writer already moved it to ${actualStatus}`,
    )
    this.name = 'ConcurrentTransitionConflictError'
    this.requestedTo = requestedTo
    this.actualStatus = actualStatus
  }
}

export class TransitionDbError extends Error {
  readonly cause: unknown
  constructor(entity: string, message: string, cause: unknown) {
    super(`${entity}: ${message}`)
    this.name = 'TransitionDbError'
    this.cause = cause
  }
}

interface TransitionResult<TStatus extends string> {
  id: string
  status: TStatus
  /** false if this call was a no-op because the row was already at `to`. */
  changed: boolean
}

/**
 * Generic conditional-transition helper shared by all three entity-specific
 * functions below. Not exported — the exported functions each apply their
 * own transition-table validation before calling this, so a caller can
 * never bypass validation by reaching for the generic helper directly.
 */
async function applyConditionalTransition<TStatus extends string>(
  client: LooseSupabaseClient,
  table: string,
  entityLabel: string,
  id: string,
  statusColumn: string,
  to: TStatus,
  extraFields: Record<string, unknown> | undefined,
  validate: (from: TStatus, to: TStatus) => void,
): Promise<TransitionResult<TStatus>> {
  const { data: current, error: fetchError } = await client
    .from(table)
    .select(`id, ${statusColumn}`)
    .eq('id', id)
    .maybeSingle()

  if (fetchError) throw new TransitionDbError(entityLabel, 'failed to read current row', fetchError)
  if (!current) throw new TransitionTargetNotFoundError(entityLabel, id)

  const from = (current as Record<string, unknown>)[statusColumn] as TStatus

  // Idempotent no-op: already at the target state. Still runs through
  // validate() first would be pointless (from === to is always allowed by
  // every validator in transitions.ts) — short-circuit directly.
  if (from === to) {
    return { id, status: to, changed: false }
  }

  // Fast-fail against the state we just read. This is a courtesy (cheaper,
  // clearer error before attempting a write) — the REAL enforcement is the
  // conditional UPDATE below, which re-checks against whatever the status
  // actually is at write time, not this possibly-stale read.
  validate(from, to)

  const updatePayload: Record<string, unknown> = { [statusColumn]: to, ...(extraFields ?? {}) }

  const { data: updated, error: updateError } = await client
    .from(table)
    .update(updatePayload)
    .eq('id', id)
    .eq(statusColumn, from)
    .select(`id, ${statusColumn}`)
    .maybeSingle()

  if (updateError) throw new TransitionDbError(entityLabel, 'conditional update failed', updateError)

  if (updated) {
    return { id, status: to, changed: true }
  }

  // Zero rows matched the conditional UPDATE — another writer changed the
  // status between our read and our write. Re-read to find out what
  // actually happened rather than guessing.
  const { data: after, error: afterError } = await client
    .from(table)
    .select(`id, ${statusColumn}`)
    .eq('id', id)
    .maybeSingle()

  if (afterError) throw new TransitionDbError(entityLabel, 'failed to read row after lost race', afterError)
  if (!after) throw new TransitionTargetNotFoundError(entityLabel, id)

  const actual = (after as Record<string, unknown>)[statusColumn] as TStatus

  // Someone else made the exact same change we were about to — idempotent
  // success, not an error.
  if (actual === to) {
    return { id, status: to, changed: false }
  }

  // Someone else moved it somewhere else entirely — a genuine conflict.
  // Do not silently accept a different outcome than what was requested.
  throw new ConcurrentTransitionConflictError(entityLabel, id, to, actual)
}

// ─────────────────────────────────────────────────────────────────────────
// transaction_intents
// ─────────────────────────────────────────────────────────────────────────
export async function transitionIntent(
  client: SupabaseClient,
  intentId: string,
  to: IntentStatus,
  extraFields?: Record<string, unknown>,
): Promise<TransitionResult<IntentStatus>> {
  return applyConditionalTransition(
    client,
    'transaction_intents',
    'transaction_intents',
    intentId,
    'status',
    to,
    extraFields,
    validateIntentTransition,
  )
}

// ─────────────────────────────────────────────────────────────────────────
// transaction_attempts
// ─────────────────────────────────────────────────────────────────────────
export async function transitionAttempt(
  client: SupabaseClient,
  attemptId: string,
  to: AttemptStatus,
  extraFields?: Record<string, unknown>,
): Promise<TransitionResult<AttemptStatus>> {
  return applyConditionalTransition(
    client,
    'transaction_attempts',
    'transaction_attempts',
    attemptId,
    'status',
    to,
    extraFields,
    validateAttemptTransition,
  )
}

// ─────────────────────────────────────────────────────────────────────────
// ledger_events
// ─────────────────────────────────────────────────────────────────────────
export async function transitionLedgerEvent(
  client: SupabaseClient,
  ledgerEventId: string,
  to: LedgerStatus,
  extraFields?: Record<string, unknown>,
): Promise<TransitionResult<LedgerStatus>> {
  return applyConditionalTransition(
    client,
    'ledger_events',
    'ledger_events',
    ledgerEventId,
    'settlement_status',
    to,
    extraFields,
    validateLedgerTransition,
  )
}
