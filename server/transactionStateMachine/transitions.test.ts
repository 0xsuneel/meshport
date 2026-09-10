import { describe, it, expect } from 'vitest'
import {
  isValidIntentTransition,
  validateIntentTransition,
  isValidAttemptTransition,
  validateAttemptTransition,
  isValidLedgerTransition,
  validateLedgerTransition,
  deriveDisplayState,
  TRANSITION_TABLES,
} from './transitions'
import { InvalidTransitionError, type IntentRow, type AttemptRow } from './types'

describe('intent transitions', () => {
  it('allows the full happy-path chain: DRAFT → REVIEWED → AUTHORIZING → SUBMITTED → CONFIRMED', () => {
    expect(isValidIntentTransition('DRAFT', 'REVIEWED')).toBe(true)
    expect(isValidIntentTransition('REVIEWED', 'AUTHORIZING')).toBe(true)
    expect(isValidIntentTransition('AUTHORIZING', 'SUBMITTED')).toBe(true)
    expect(isValidIntentTransition('SUBMITTED', 'CONFIRMED')).toBe(true)
  })

  it('user rejection: AUTHORIZING → CANCELLED is valid', () => {
    expect(isValidIntentTransition('AUTHORIZING', 'CANCELLED')).toBe(true)
  })

  it('broadcast failure: AUTHORIZING → FAILED is valid', () => {
    expect(isValidIntentTransition('AUTHORIZING', 'FAILED')).toBe(true)
  })

  it('rejects CONFIRMED → DRAFT', () => {
    expect(isValidIntentTransition('CONFIRMED', 'DRAFT')).toBe(false)
    expect(() => validateIntentTransition('CONFIRMED', 'DRAFT')).toThrow(InvalidTransitionError)
  })

  it('rejects FAILED → CONFIRMED (no documented recovery model at the intent level)', () => {
    expect(isValidIntentTransition('FAILED', 'CONFIRMED')).toBe(false)
  })

  it('every terminal intent state has no outgoing transitions', () => {
    for (const terminal of ['CONFIRMED', 'FAILED', 'CANCELLED', 'EXPIRED'] as const) {
      expect(TRANSITION_TABLES.intent[terminal]).toHaveLength(0)
    }
  })

  it('same-state calls are treated as valid (idempotent) at the pure-logic level', () => {
    expect(isValidIntentTransition('SUBMITTED', 'SUBMITTED')).toBe(true)
  })
})

describe('attempt transitions', () => {
  it('allows the full happy-path chain: CREATED → BROADCASTING → SUBMITTED → CONFIRMING → CONFIRMED', () => {
    expect(isValidAttemptTransition('CREATED', 'BROADCASTING')).toBe(true)
    expect(isValidAttemptTransition('BROADCASTING', 'SUBMITTED')).toBe(true)
    expect(isValidAttemptTransition('SUBMITTED', 'CONFIRMING')).toBe(true)
    expect(isValidAttemptTransition('CONFIRMING', 'CONFIRMED')).toBe(true)
  })

  it('RPC timeout after broadcast: SUBMITTED → UNKNOWN is valid (never FAILED)', () => {
    expect(isValidAttemptTransition('SUBMITTED', 'UNKNOWN')).toBe(true)
    // There is no FAILED value in the attempt status enum at all — REVERTED
    // is the closest concept, and it is NOT reachable directly from
    // SUBMITTED without passing through UNKNOWN or CONFIRMING first.
    expect(isValidAttemptTransition('SUBMITTED', 'REVERTED' as any)).toBe(false)
  })

  it('UNKNOWN resolves to exactly CONFIRMED, REVERTED, or DROPPED', () => {
    expect(isValidAttemptTransition('UNKNOWN', 'CONFIRMED')).toBe(true)
    expect(isValidAttemptTransition('UNKNOWN', 'REVERTED')).toBe(true)
    expect(isValidAttemptTransition('UNKNOWN', 'DROPPED')).toBe(true)
  })

  it('rejects REVERTED → SUBMITTED', () => {
    expect(isValidAttemptTransition('REVERTED', 'SUBMITTED')).toBe(false)
    expect(() => validateAttemptTransition('REVERTED', 'SUBMITTED')).toThrow(InvalidTransitionError)
  })

  it('replacement: SUBMITTED → REPLACED is valid, and REPLACED is terminal', () => {
    expect(isValidAttemptTransition('SUBMITTED', 'REPLACED')).toBe(true)
    expect(TRANSITION_TABLES.attempt.REPLACED).toHaveLength(0)
  })

  it('every terminal attempt state has no outgoing transitions', () => {
    for (const terminal of ['CONFIRMED', 'REVERTED', 'DROPPED', 'REPLACED'] as const) {
      expect(TRANSITION_TABLES.attempt[terminal]).toHaveLength(0)
    }
  })
})

describe('ledger settlement transitions', () => {
  it('PENDING → POSTED is valid', () => {
    expect(isValidLedgerTransition('PENDING', 'POSTED')).toBe(true)
  })

  it('POSTED → REVERSED is valid (reorg after posting)', () => {
    expect(isValidLedgerTransition('POSTED', 'REVERSED')).toBe(true)
  })

  it('rejects POSTED → PENDING directly (must go through REVERSED first)', () => {
    expect(isValidLedgerTransition('POSTED', 'PENDING')).toBe(false)
    expect(() => validateLedgerTransition('POSTED', 'PENDING')).toThrow(InvalidTransitionError)
  })

  it('rejects REVERSED → POSTED directly (recovery must re-earn confirmation depth via PENDING)', () => {
    expect(isValidLedgerTransition('REVERSED', 'POSTED')).toBe(false)
  })

  it('allows REVERSED → PENDING as the one documented reorg-recovery exception', () => {
    expect(isValidLedgerTransition('REVERSED', 'PENDING')).toBe(true)
  })
})

describe('deriveDisplayState — the SUBMITTED_UNKNOWN rule', () => {
  const intent: IntentRow = { id: 'intent-1', status: 'SUBMITTED' }

  it('shows SUBMITTED when the latest attempt is not UNKNOWN', () => {
    const attempts: AttemptRow[] = [{ id: 'a1', intent_id: 'intent-1', status: 'CONFIRMING' }]
    expect(deriveDisplayState(intent, attempts)).toBe('SUBMITTED')
  })

  it('shows SUBMITTED_UNKNOWN when the latest attempt is UNKNOWN — never FAILED', () => {
    const attempts: AttemptRow[] = [{ id: 'a1', intent_id: 'intent-1', status: 'UNKNOWN' }]
    expect(deriveDisplayState(intent, attempts)).toBe('SUBMITTED_UNKNOWN')
  })

  it('ignores attempts belonging to other intents', () => {
    const attempts: AttemptRow[] = [{ id: 'a1', intent_id: 'some-other-intent', status: 'UNKNOWN' }]
    expect(deriveDisplayState(intent, attempts)).toBe('SUBMITTED')
  })

  it('passes through non-SUBMITTED intent statuses unchanged, regardless of attempt history', () => {
    const confirmed: IntentRow = { id: 'intent-2', status: 'CONFIRMED' }
    const attempts: AttemptRow[] = [{ id: 'a1', intent_id: 'intent-2', status: 'UNKNOWN' }]
    expect(deriveDisplayState(confirmed, attempts)).toBe('CONFIRMED')
  })

  it('replacement: uses the LATEST attempt (caller must pass oldest → newest)', () => {
    const attempts: AttemptRow[] = [
      { id: 'a1', intent_id: 'intent-1', status: 'REPLACED' },
      { id: 'a2', intent_id: 'intent-1', status: 'CONFIRMING' },
    ]
    expect(deriveDisplayState(intent, attempts)).toBe('SUBMITTED')
  })
})
