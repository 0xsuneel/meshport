/**
 * Canonical transaction state machine — shared types.
 *
 * Mirrors the CHECK constraints on transaction_intents.status,
 * transaction_attempts.status, and ledger_events.settlement_status added in
 * supabase/migrations/20260823060000_phase1_canonical_transaction_model.sql.
 * If either side changes, the other must change with it — there is
 * currently no generated-types step wiring these together automatically
 * (see docs/TRANSACTION_STATE_MACHINE.md "Keeping this in sync with the
 * database" for the follow-up this leaves open).
 */

// ── Intent-level status ─────────────────────────────────────────────────────
export const INTENT_STATUSES = [
  'DRAFT',
  'REVIEWED',
  'AUTHORIZING',
  'SUBMITTED',
  'CONFIRMED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
] as const
export type IntentStatus = (typeof INTENT_STATUSES)[number]

// ── Attempt-level status ────────────────────────────────────────────────────
export const ATTEMPT_STATUSES = [
  'CREATED',
  'BROADCASTING',
  'SUBMITTED',
  'UNKNOWN',
  'CONFIRMING',
  'CONFIRMED',
  'REVERTED',
  'DROPPED',
  'REPLACED',
] as const
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number]

// ── Ledger settlement status ────────────────────────────────────────────────
export const LEDGER_STATUSES = ['PENDING', 'POSTED', 'REVERSED'] as const
export type LedgerStatus = (typeof LEDGER_STATUSES)[number]

// ── Application-level composite display state ───────────────────────────────
// Not a database column anywhere. transaction_intents.status has no
// "SUBMITTED_UNKNOWN" value (see docs/TRANSACTION_STATE_MACHINE.md — the
// brief explicitly separates "UNKNOWN at attempt level" from an
// application-level label). This is that application-level label, derived
// by combining an intent's status with its attempts' statuses — never
// stored, always computed at read time.
export const DISPLAY_STATES = [
  'DRAFT',
  'REVIEWED',
  'AUTHORIZING',
  'SUBMITTED',
  'SUBMITTED_UNKNOWN',
  'CONFIRMED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
] as const
export type DisplayState = (typeof DISPLAY_STATES)[number]

export interface TransitionError {
  code: 'INVALID_TRANSITION' | 'UNKNOWN_STATUS'
  from: string
  to: string
  entity: 'intent' | 'attempt' | 'ledger_event'
  message: string
}

export class InvalidTransitionError extends Error {
  readonly code: TransitionError['code']
  readonly from: string
  readonly to: string
  readonly entity: TransitionError['entity']

  constructor(details: TransitionError) {
    super(details.message)
    this.name = 'InvalidTransitionError'
    this.code = details.code
    this.from = details.from
    this.to = details.to
    this.entity = details.entity
  }
}

// ── Minimal row shapes the pure logic needs (not the full DB row) ──────────
export interface IntentRow {
  id: string
  status: IntentStatus
}

export interface AttemptRow {
  id: string
  intent_id: string
  status: AttemptStatus
}

export interface LedgerEventRow {
  id: string
  settlement_status: LedgerStatus
}
