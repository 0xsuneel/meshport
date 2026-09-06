/**
 * Canonical transaction state machine — pure transition logic.
 *
 * No database access here. Every function is a pure function of its inputs
 * so it can be unit-tested without a database, and reused by any runtime
 * (client, Vercel API function, Supabase Edge Function) that needs to know
 * "is this transition allowed" before touching a database at all — see
 * apply.ts for the DB-applying layer built on top of this.
 *
 * See docs/TRANSACTION_STATE_MACHINE.md for the full transition diagram and
 * rationale for every edge (and every deliberately-missing edge) below.
 */

import {
  type IntentStatus,
  type AttemptStatus,
  type LedgerStatus,
  type IntentRow,
  type AttemptRow,
  type LedgerEventRow,
  type DisplayState,
  InvalidTransitionError,
} from './types'

// ─────────────────────────────────────────────────────────────────────────
// Intent transitions
// ─────────────────────────────────────────────────────────────────────────
//
// CONFIRMED, CANCELLED, EXPIRED are terminal.
// FAILED is terminal in Phase 2 — "FAILED → CONFIRMED is invalid unless
// there is an explicitly documented recovery/replacement model" (brief).
// No such model exists yet at the intent level (replacement happens at the
// ATTEMPT level — see ATTEMPT_TRANSITIONS's REPLACED handling below, which
// is exactly how an intent reaches CONFIRMED despite an earlier attempt
// failing, without ever needing intent.status to leave SUBMITTED).
const INTENT_TRANSITIONS: Record<IntentStatus, readonly IntentStatus[]> = {
  DRAFT: ['REVIEWED', 'CANCELLED', 'EXPIRED'],
  REVIEWED: ['AUTHORIZING', 'CANCELLED', 'EXPIRED'],
  AUTHORIZING: ['SUBMITTED', 'FAILED', 'CANCELLED'],
  SUBMITTED: ['CONFIRMED', 'FAILED'],
  CONFIRMED: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
}

// ─────────────────────────────────────────────────────────────────────────
// Attempt transitions
// ─────────────────────────────────────────────────────────────────────────
//
// UNKNOWN is the critical "broadcast may have succeeded, confirmation
// failed/timed out" state — see docs/TRANSACTION_STATE_MACHINE.md
// "The UNKNOWN rule". It resolves to exactly one of CONFIRMED / REVERTED /
// DROPPED once a reconciler determines the truth; it is NEVER auto-resolved
// by another broadcast (a replacement is a *new* attempt row, not a
// transition on the UNKNOWN one — see "Replacement transactions" below).
//
// CONFIRMED and REVERTED are terminal for an attempt: they're only reached
// after the chain's confirmation-depth policy says it's safe (see
// docs/PHASE_1_SCHEMA_DESIGN.md §6), so a further reorg at that point is a
// ledger_events-level REVERSED transition, not an attempt-level one.
//
// DROPPED is terminal in Phase 2 for the same "no undocumented recovery
// model" reason FAILED is terminal at the intent level — a dropped
// transaction reappearing is exactly the kind of edge case that needs its
// own explicit design (Phase 3/4 reconciler), not a quiet transition here.
//
// REPLACED is terminal for the attempt it's set on; the replacement is a
// separate attempt row (status CREATED → ... ), never a transition target.
const ATTEMPT_TRANSITIONS: Record<AttemptStatus, readonly AttemptStatus[]> = {
  CREATED: ['BROADCASTING', 'DROPPED'],
  BROADCASTING: ['SUBMITTED', 'DROPPED'],
  SUBMITTED: ['CONFIRMING', 'UNKNOWN', 'REPLACED'],
  UNKNOWN: ['CONFIRMED', 'REVERTED', 'DROPPED'],
  CONFIRMING: ['CONFIRMED', 'REVERTED', 'UNKNOWN'],
  CONFIRMED: [],
  REVERTED: [],
  DROPPED: [],
  REPLACED: [],
}

// ─────────────────────────────────────────────────────────────────────────
// Ledger settlement transitions
// ─────────────────────────────────────────────────────────────────────────
//
// REVERSED → PENDING is the one deliberate exception to "terminal states
// stay terminal": docs/PHASE_1_SCHEMA_DESIGN.md §6 documents that a reorg
// which is later re-included under the SAME event_key (same tx_hash,
// same log_index — the natural key doesn't change) is handled by flipping
// the existing row back to PENDING and letting it re-earn POSTED through
// the normal confirmation-depth path, rather than inserting a second row
// (event_key is UNIQUE, so a second row for the same event is impossible
// by construction anyway). This is an explicitly documented recovery model
// for a specific, real scenario — not a general "unreverse" backdoor.
// REVERSED → POSTED directly is NOT allowed; recovery must go back through
// PENDING and re-earn confirmation depth.
const LEDGER_TRANSITIONS: Record<LedgerStatus, readonly LedgerStatus[]> = {
  PENDING: ['POSTED', 'REVERSED'],
  POSTED: ['REVERSED'],
  REVERSED: ['PENDING'],
}

// ─────────────────────────────────────────────────────────────────────────
// Validators — throw InvalidTransitionError on a disallowed edge, no-op
// (return without throwing) if from === to (idempotent same-state calls
// are handled by the DB layer in apply.ts, not treated as errors here).
// ─────────────────────────────────────────────────────────────────────────

export function isValidIntentTransition(from: IntentStatus, to: IntentStatus): boolean {
  if (from === to) return true
  return INTENT_TRANSITIONS[from]?.includes(to) ?? false
}

export function validateIntentTransition(from: IntentStatus, to: IntentStatus): void {
  if (isValidIntentTransition(from, to)) return
  throw new InvalidTransitionError({
    code: 'INVALID_TRANSITION',
    from,
    to,
    entity: 'intent',
    message: `transaction_intents: ${from} → ${to} is not a valid transition`,
  })
}

export function isValidAttemptTransition(from: AttemptStatus, to: AttemptStatus): boolean {
  if (from === to) return true
  return ATTEMPT_TRANSITIONS[from]?.includes(to) ?? false
}

export function validateAttemptTransition(from: AttemptStatus, to: AttemptStatus): void {
  if (isValidAttemptTransition(from, to)) return
  throw new InvalidTransitionError({
    code: 'INVALID_TRANSITION',
    from,
    to,
    entity: 'attempt',
    message: `transaction_attempts: ${from} → ${to} is not a valid transition`,
  })
}

export function isValidLedgerTransition(from: LedgerStatus, to: LedgerStatus): boolean {
  if (from === to) return true
  return LEDGER_TRANSITIONS[from]?.includes(to) ?? false
}

export function validateLedgerTransition(from: LedgerStatus, to: LedgerStatus): void {
  if (isValidLedgerTransition(from, to)) return
  throw new InvalidTransitionError({
    code: 'INVALID_TRANSITION',
    from,
    to,
    entity: 'ledger_event',
    message: `ledger_events: ${from} → ${to} is not a valid transition`,
  })
}

// Exported for tests and for anything (e.g. an admin/debug UI) that wants
// to render the full graph without duplicating it.
export const TRANSITION_TABLES = {
  intent: INTENT_TRANSITIONS,
  attempt: ATTEMPT_TRANSITIONS,
  ledger: LEDGER_TRANSITIONS,
} as const

// ─────────────────────────────────────────────────────────────────────────
// Composite display state — see types.ts DisplayState and
// docs/TRANSACTION_STATE_MACHINE.md "The UNKNOWN rule" for why this exists
// as a derived value rather than a stored column.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Derive the user-facing state for an intent from its own status plus its
 * attempts' statuses. Pure function — never reads or writes the database.
 *
 * The one case this exists for: an intent can sit at SUBMITTED while its
 * most recent attempt is UNKNOWN (broadcast may have succeeded, receipt
 * wait timed out). The brief is explicit that this must never render as
 * FAILED. SUBMITTED_UNKNOWN only applies while the intent itself is still
 * SUBMITTED — once the intent reaches CONFIRMED or FAILED, that is what's
 * shown, no matter what an individual attempt's history looked like along
 * the way.
 */
export function deriveDisplayState(intent: IntentRow, attempts: readonly AttemptRow[]): DisplayState {
  if (intent.status !== 'SUBMITTED') {
    return intent.status
  }
  const relevant = attempts.filter(a => a.intent_id === intent.id)
  if (relevant.length === 0) return 'SUBMITTED'

  // Most recent attempt wins — created_at ordering is the caller's
  // responsibility (this function takes whatever order it's given and
  // just looks at the last element), so callers must pass attempts sorted
  // oldest → newest.
  const latest = relevant[relevant.length - 1]
  if (latest.status === 'UNKNOWN') return 'SUBMITTED_UNKNOWN'
  return 'SUBMITTED'
}
