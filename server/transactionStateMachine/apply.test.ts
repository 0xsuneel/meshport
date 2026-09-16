import { describe, it, expect } from 'vitest'
import {
  transitionIntent,
  transitionAttempt,
  transitionLedgerEvent,
  ConcurrentTransitionConflictError,
  TransitionTargetNotFoundError,
} from './apply'
import { InvalidTransitionError } from './types'

// ─────────────────────────────────────────────────────────────────────────
// Fake Supabase client
//
// Models exactly the chain shapes apply.ts uses:
//   .from(table).select(cols).eq(col, val).maybeSingle()
//   .from(table).update(payload).eq(col, val).eq(col2, val2).select(cols).maybeSingle()
//
// This is a real in-memory table with real conditional-update semantics
// (an UPDATE only applies if every .eq() predicate matches the CURRENT row
// at the moment the update "executes"), which is what lets the concurrency
// tests below simulate an actual race rather than just asserting on mocked
// return values.
// ─────────────────────────────────────────────────────────────────────────
type Row = Record<string, unknown> & { id: string }

function makeFakeClient(tables: Record<string, Row[]>) {
  // Optional hook: lets a test mutate the underlying table BETWEEN the
  // module's read and its conditional write, to deterministically simulate
  // "another writer won the race".
  let onBeforeUpdate: (() => void) | null = null

  function from(table: string) {
    const rows = tables[table]
    if (!rows) throw new Error(`fake client: unknown table ${table}`)

    return {
      select(_cols: string) {
        const predicates: Array<[string, unknown]> = []
        return {
          eq(col: string, val: unknown) {
            predicates.push([col, val])
            return this
          },
          async maybeSingle() {
            const row = rows.find(r => predicates.every(([c, v]) => r[c] === v))
            return { data: row ? { ...row } : null, error: null }
          },
        }
      },
      update(payload: Record<string, unknown>) {
        const predicates: Array<[string, unknown]> = []
        const builder = {
          eq(col: string, val: unknown) {
            predicates.push([col, val])
            return builder
          },
          select(_cols: string) {
            return {
              async maybeSingle() {
                // Simulate the race window: a test can inject a mutation
                // here, exactly between this module reading the row (in a
                // prior .select() call) and this update actually applying.
                if (onBeforeUpdate) {
                  const hook = onBeforeUpdate
                  onBeforeUpdate = null
                  hook()
                }
                const idx = rows.findIndex(r => predicates.every(([c, v]) => r[c] === v))
                if (idx === -1) return { data: null, error: null }
                rows[idx] = { ...rows[idx], ...payload }
                return { data: { ...rows[idx] }, error: null }
              },
            }
          },
        }
        return builder
      },
    }
  }

  return {
    client: { from } as any,
    setRaceHook(hook: () => void) {
      onBeforeUpdate = hook
    },
    getTable(table: string) {
      return tables[table]
    },
  }
}

describe('transitionAttempt — idempotency', () => {
  it('calling the same transition twice is a no-op the second time, not an error', async () => {
    const { client } = makeFakeClient({
      transaction_attempts: [{ id: 'att-1', intent_id: 'int-1', status: 'SUBMITTED' }],
    })

    const first = await transitionAttempt(client, 'att-1', 'UNKNOWN')
    expect(first.changed).toBe(true)
    expect(first.status).toBe('UNKNOWN')

    const second = await transitionAttempt(client, 'att-1', 'UNKNOWN')
    expect(second.changed).toBe(false)
    expect(second.status).toBe('UNKNOWN')
  })

  it('throws TransitionTargetNotFoundError for a missing id', async () => {
    const { client } = makeFakeClient({ transaction_attempts: [] })
    await expect(transitionAttempt(client, 'does-not-exist', 'CONFIRMED')).rejects.toThrow(
      TransitionTargetNotFoundError,
    )
  })
})

describe('transitionAttempt — concurrency', () => {
  it('two racing calls to the SAME target status: both succeed, exactly one write happens', async () => {
    const { client, setRaceHook, getTable } = makeFakeClient({
      transaction_attempts: [{ id: 'att-1', intent_id: 'int-1', status: 'UNKNOWN' }],
    })

    // Simulate: caller B's UPDATE actually lands on the DB in between
    // caller A's read and caller A's own UPDATE executing — i.e. B wins the
    // race to CONFIRMED first.
    setRaceHook(() => {
      const rows = getTable('transaction_attempts')
      rows[0] = { ...rows[0], status: 'CONFIRMED' }
    })

    const a = await transitionAttempt(client, 'att-1', 'CONFIRMED')
    // A's conditional UPDATE (WHERE status = 'UNKNOWN') now affects zero
    // rows because the hook already flipped it to CONFIRMED — the module
    // re-reads, sees CONFIRMED === requested CONFIRMED, and reports success
    // without a second write and without throwing.
    expect(a.status).toBe('CONFIRMED')

    expect(getTable('transaction_attempts')[0].status).toBe('CONFIRMED')
  })

  it('two racing calls to DIFFERENT target statuses: the loser gets a clear conflict, not silent success', async () => {
    const { client, setRaceHook, getTable } = makeFakeClient({
      transaction_attempts: [{ id: 'att-1', intent_id: 'int-1', status: 'UNKNOWN' }],
    })

    // Simulate a concurrent writer resolving this attempt to REVERTED while
    // this caller is trying to resolve it to CONFIRMED.
    setRaceHook(() => {
      const rows = getTable('transaction_attempts')
      rows[0] = { ...rows[0], status: 'REVERTED' }
    })

    await expect(transitionAttempt(client, 'att-1', 'CONFIRMED')).rejects.toThrow(
      ConcurrentTransitionConflictError,
    )
    // The row reflects whoever actually won — REVERTED, not CONFIRMED, and
    // not some corrupted in-between state.
    expect(getTable('transaction_attempts')[0].status).toBe('REVERTED')
  })
})

describe('transitionAttempt — invalid transitions', () => {
  it('rejects an invalid transition before ever touching the row', async () => {
    const { client, getTable } = makeFakeClient({
      transaction_attempts: [{ id: 'att-1', intent_id: 'int-1', status: 'REVERTED' }],
    })
    await expect(transitionAttempt(client, 'att-1', 'SUBMITTED')).rejects.toThrow(InvalidTransitionError)
    // Row is untouched.
    expect(getTable('transaction_attempts')[0].status).toBe('REVERTED')
  })
})

describe('ledger_events transitions', () => {
  it('PENDING → POSTED', async () => {
    const { client } = makeFakeClient({
      ledger_events: [{ id: 'le-1', settlement_status: 'PENDING' }],
    })
    const result = await transitionLedgerEvent(client, 'le-1', 'POSTED')
    expect(result.status).toBe('POSTED')
  })

  it('POSTED → REVERSED', async () => {
    const { client } = makeFakeClient({
      ledger_events: [{ id: 'le-1', settlement_status: 'POSTED' }],
    })
    const result = await transitionLedgerEvent(client, 'le-1', 'REVERSED')
    expect(result.status).toBe('REVERSED')
  })

  it('rejects an invalid ledger transition (POSTED → PENDING)', async () => {
    const { client } = makeFakeClient({
      ledger_events: [{ id: 'le-1', settlement_status: 'POSTED' }],
    })
    await expect(transitionLedgerEvent(client, 'le-1', 'PENDING')).rejects.toThrow(InvalidTransitionError)
  })
})

describe('end-to-end: normal Pay-shaped success flow', () => {
  it('intent DRAFT→...→CONFIRMED, one attempt CREATED→...→CONFIRMED, ledger PENDING→POSTED', async () => {
    const { client } = makeFakeClient({
      transaction_intents: [{ id: 'int-1', status: 'DRAFT' }],
      transaction_attempts: [{ id: 'att-1', intent_id: 'int-1', status: 'CREATED' }],
      ledger_events: [{ id: 'le-1', settlement_status: 'PENDING' }],
    })

    await transitionIntent(client, 'int-1', 'REVIEWED')
    await transitionIntent(client, 'int-1', 'AUTHORIZING')
    await transitionIntent(client, 'int-1', 'SUBMITTED')

    await transitionAttempt(client, 'att-1', 'BROADCASTING')
    await transitionAttempt(client, 'att-1', 'SUBMITTED')
    await transitionAttempt(client, 'att-1', 'CONFIRMING')
    const attemptFinal = await transitionAttempt(client, 'att-1', 'CONFIRMED')
    expect(attemptFinal.status).toBe('CONFIRMED')

    const intentFinal = await transitionIntent(client, 'int-1', 'CONFIRMED')
    expect(intentFinal.status).toBe('CONFIRMED')

    const ledgerFinal = await transitionLedgerEvent(client, 'le-1', 'POSTED')
    expect(ledgerFinal.status).toBe('POSTED')
  })
})

describe('end-to-end: RPC timeout after broadcast (the UNKNOWN rule)', () => {
  it('UNKNOWN → CONFIRMED: intent still reaches CONFIRMED normally', async () => {
    const { client } = makeFakeClient({
      transaction_intents: [{ id: 'int-1', status: 'SUBMITTED' }],
      transaction_attempts: [{ id: 'att-1', intent_id: 'int-1', status: 'SUBMITTED' }],
    })

    // Broadcast succeeded, then the receipt wait timed out.
    const unknown = await transitionAttempt(client, 'att-1', 'UNKNOWN')
    expect(unknown.status).toBe('UNKNOWN')

    // Intent is untouched by this — it must NOT be forced to FAILED just
    // because an attempt went UNKNOWN.
    // (No transitionIntent call here on purpose — nothing should have
    // changed it.)

    // Reconciler later finds the receipt: success.
    const resolved = await transitionAttempt(client, 'att-1', 'CONFIRMED')
    expect(resolved.status).toBe('CONFIRMED')

    const intentFinal = await transitionIntent(client, 'int-1', 'CONFIRMED')
    expect(intentFinal.status).toBe('CONFIRMED')
  })

  it('UNKNOWN → REVERTED: intent moves to FAILED once the true outcome is known', async () => {
    const { client } = makeFakeClient({
      transaction_intents: [{ id: 'int-1', status: 'SUBMITTED' }],
      transaction_attempts: [{ id: 'att-1', intent_id: 'int-1', status: 'SUBMITTED' }],
    })

    await transitionAttempt(client, 'att-1', 'UNKNOWN')
    const resolved = await transitionAttempt(client, 'att-1', 'REVERTED')
    expect(resolved.status).toBe('REVERTED')

    const intentFinal = await transitionIntent(client, 'int-1', 'FAILED')
    expect(intentFinal.status).toBe('FAILED')
  })

  it('UNKNOWN → DROPPED: attempt resolves as dropped, no automatic retry attempt is created by the state machine itself', async () => {
    const { client, getTable } = makeFakeClient({
      transaction_attempts: [{ id: 'att-1', intent_id: 'int-1', status: 'SUBMITTED' }],
    })

    await transitionAttempt(client, 'att-1', 'UNKNOWN')
    const dropped = await transitionAttempt(client, 'att-1', 'DROPPED')
    expect(dropped.status).toBe('DROPPED')

    // Confirms the state machine created no second row on its own — a
    // replacement, if any, is a deliberate decision by calling code (see
    // the replacement test below), never implicit.
    expect(getTable('transaction_attempts')).toHaveLength(1)
  })
})

describe('end-to-end: replacement transaction', () => {
  it('attempt A → REPLACED, attempt B (separate row) → CONFIRMED, intent still reaches CONFIRMED', async () => {
    const { client } = makeFakeClient({
      transaction_intents: [{ id: 'int-1', status: 'SUBMITTED' }],
      transaction_attempts: [
        { id: 'att-A', intent_id: 'int-1', status: 'SUBMITTED' },
        { id: 'att-B', intent_id: 'int-1', status: 'CREATED' },
      ],
    })

    const replacedA = await transitionAttempt(client, 'att-A', 'REPLACED')
    expect(replacedA.status).toBe('REPLACED')

    await transitionAttempt(client, 'att-B', 'BROADCASTING')
    await transitionAttempt(client, 'att-B', 'SUBMITTED')
    await transitionAttempt(client, 'att-B', 'CONFIRMING')
    const confirmedB = await transitionAttempt(client, 'att-B', 'CONFIRMED')
    expect(confirmedB.status).toBe('CONFIRMED')

    // The intent reaches CONFIRMED via attempt B — it was never forced to
    // FAILED by attempt A's replacement.
    const intentFinal = await transitionIntent(client, 'int-1', 'CONFIRMED')
    expect(intentFinal.status).toBe('CONFIRMED')
  })

  it('REPLACED cannot itself transition back to SUBMITTED', async () => {
    const { client } = makeFakeClient({
      transaction_attempts: [{ id: 'att-A', intent_id: 'int-1', status: 'REPLACED' }],
    })
    await expect(transitionAttempt(client, 'att-A', 'SUBMITTED')).rejects.toThrow(InvalidTransitionError)
  })
})
