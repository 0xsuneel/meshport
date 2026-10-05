import { describe, it, expect } from 'vitest'
import { interpretConfirmedChainEvent, interpretConfirmedAttempt } from './interpreter'
import type { LedgerRepository } from './repository'
import type { ChainEventInput, AttemptContext, IntentContext, LedgerEventDraft, InsertOutcome } from './types'

const CHAIN = 'arc'
const KIT_ADAPTER = '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b'

/**
 * A fake LedgerRepository backed by real in-memory tables with GENUINE
 * conditional-write semantics — modeling the actual raw-movement unique
 * index (chain_id, tx_hash, COALESCE(log_index,-1), wallet_address),
 * exactly as validated against real Postgres in
 * docs/LEDGER_RAW_IDENTITY_FIX.md. This is what lets the concurrency tests
 * below simulate a genuine race, not just assert on canned return values —
 * the same discipline already used in
 * server/transactionStateMachine/apply.test.ts's fake client.
 */
function makeFakeRepo(seed: {
  chainEvents?: ChainEventInput[]
  attempts?: AttemptContext[]
  intents?: IntentContext[]
} = {}) {
  const chainEvents = new Map((seed.chainEvents ?? []).map(e => [e.id, e]))
  const attempts = seed.attempts ?? []
  const intents = new Map((seed.intents ?? []).map(i => [i.id, i]))
  const ledgerRows: Array<LedgerEventDraft & { id: string }> = []
  let nextId = 1
  let raceHook: (() => void) | null = null

  const rawKey = (chainId: string, txHash: string, logIndex: number | null, wallet: string) =>
    `${chainId}:${txHash.toLowerCase()}:${logIndex ?? -1}:${wallet.toLowerCase()}`

  const repo: LedgerRepository = {
    async getChainEvent(id) {
      return chainEvents.get(id) ?? null
    },
    async findAttemptByTxHash(chainId, txHash) {
      return attempts.find(a => a.chain_id === chainId && a.tx_hash?.toLowerCase() === txHash.toLowerCase()) ?? null
    },
    async getIntent(intentId) {
      return intents.get(intentId) ?? null
    },
    async findLedgerEventByRawMovement(chainId, txHash, logIndex, walletAddress) {
      const key = rawKey(chainId, txHash, logIndex, walletAddress)
      const row = ledgerRows.find(r => rawKey(r.chain_id, r.tx_hash ?? '', r.log_index, r.wallet_address) === key)
      return row ? { id: row.id, event_type: row.event_type } : null
    },
    async insertLedgerEvent(draft): Promise<InsertOutcome> {
      // Simulate the race window: a hook can mutate the table BETWEEN this
      // module's own courtesy pre-check (in insertIdempotently) and this
      // "real" conditional insert actually landing — exactly the same
      // technique proven in apply.test.ts.
      if (raceHook) {
        const hook = raceHook
        raceHook = null
        hook()
      }
      const key = rawKey(draft.chain_id, draft.tx_hash ?? '', draft.log_index, draft.wallet_address)
      const existing = ledgerRows.find(r => rawKey(r.chain_id, r.tx_hash ?? '', r.log_index, r.wallet_address) === key)
      if (existing) {
        if (existing.event_type === draft.event_type) return { outcome: 'already_posted', id: existing.id }
        return { outcome: 'conflict', existingEventType: existing.event_type }
      }
      const id = `ledger-${nextId++}`
      ledgerRows.push({ ...draft, id })
      return { outcome: 'inserted', id }
    },
  }

  return {
    repo,
    ledgerRows,
    setRaceHook: (hook: () => void) => { raceHook = hook },
  }
}

function erc20Event(overrides: Partial<ChainEventInput> = {}): ChainEventInput {
  return {
    id: 'ce-1', chain_id: CHAIN, tx_hash: '0xTx1', wallet_address: '0xRecipient',
    event_type: 'transfer_detected', status: 'confirmed', log_index: 5, block_number: 100,
    token_address: '0xTokenContract', token_symbol: 'EURC', decimals: 6,
    metadata: { sender: '0xSender', amount: 10 }, ...overrides,
  }
}

// ── IDENTITY / IDEMPOTENCY ──────────────────────────────────────────────

describe('interpretConfirmedChainEvent — identity and idempotency', () => {
  it('1. processing the same chain_event twice is idempotent — second pass reports already_posted, no new rows', async () => {
    const { repo, ledgerRows } = makeFakeRepo({ chainEvents: [erc20Event()] })
    const first = await interpretConfirmedChainEvent(repo, 'ce-1')
    expect(first.classification).toBe('classified')
    expect(first.inserts.every(i => i.outcome === 'inserted')).toBe(true)
    expect(ledgerRows).toHaveLength(2) // DEBIT + CREDIT

    const second = await interpretConfirmedChainEvent(repo, 'ce-1')
    expect(second.inserts.every(i => i.outcome === 'already_posted')).toBe(true)
    expect(ledgerRows).toHaveLength(2) // unchanged — no duplicate rows
  })

  it('2. same raw movement, different event_type -> blocked (conflict), never silently accepted', async () => {
    const { repo, ledgerRows } = makeFakeRepo({ chainEvents: [erc20Event()] })
    // Manually seed a CREDIT under this exact raw movement first...
    await repo.insertLedgerEvent({
      transaction_intent_id: null, transaction_attempt_id: null, wallet_address: '0xrecipient',
      chain_id: CHAIN, event_type: 'CREDIT', direction: 'credit', token_address: '0xTokenContract',
      token_symbol: 'EURC', decimals: 6, amount_atomic: '10000000', is_native: false,
      tx_hash: '0xTx1', block_number: 100, log_index: 5,
      event_key: 'seed-key', metadata: {},
    })
    expect(ledgerRows).toHaveLength(1)

    // ...then attempt to classify+insert the SAME raw movement as SWAP_CREDIT
    // (simulating a classification disagreement) directly through the
    // repository's own insert (bypassing the interpreter's pre-check, to
    // prove the REPOSITORY-level conditional write is what actually blocks
    // this, not just the in-process courtesy check).
    const conflictResult = await repo.insertLedgerEvent({
      transaction_intent_id: 'some-intent', transaction_attempt_id: 'some-attempt', wallet_address: '0xrecipient',
      chain_id: CHAIN, event_type: 'SWAP_CREDIT', direction: 'credit', token_address: '0xTokenContract',
      token_symbol: 'EURC', decimals: 6, amount_atomic: '10000000', is_native: false,
      tx_hash: '0xTx1', block_number: 100, log_index: 5,
      event_key: 'different-key', metadata: {},
    })
    expect(conflictResult.outcome).toBe('conflict')
    if (conflictResult.outcome === 'conflict') expect(conflictResult.existingEventType).toBe('CREDIT')
    expect(ledgerRows).toHaveLength(1) // still just the one row — never doubled
  })

  it('5. native NULL log_index: a second wallet on the same native tx does NOT collide (distinguished by wallet, not log_index)', async () => {
    const { repo, ledgerRows } = makeFakeRepo()
    const draftA: LedgerEventDraft = {
      transaction_intent_id: null, transaction_attempt_id: null, wallet_address: '0xwalleta',
      chain_id: CHAIN, event_type: 'CREDIT', direction: 'credit', token_address: null,
      token_symbol: 'USDC', decimals: 18, amount_atomic: '1000000000000000000', is_native: true,
      tx_hash: '0xnativetx', block_number: 1, log_index: null, event_key: 'k-a', metadata: {},
    }
    const draftB: LedgerEventDraft = { ...draftA, wallet_address: '0xwalletb', event_key: 'k-b' }
    const draftADup: LedgerEventDraft = { ...draftA, event_type: 'SWAP_CREDIT', event_key: 'k-a-dup' }

    expect((await repo.insertLedgerEvent(draftA)).outcome).toBe('inserted')
    expect((await repo.insertLedgerEvent(draftB)).outcome).toBe('inserted') // different wallet -> allowed
    expect((await repo.insertLedgerEvent(draftADup)).outcome).toBe('conflict') // same wallet, same NULL log_index, different type -> blocked
    expect(ledgerRows).toHaveLength(2)
  })
})

// ── CONFIRMATION RULE (interpreter-level guard) ─────────────────────────

describe('interpretConfirmedChainEvent — confirmation rule', () => {
  it('pending chain_event never reaches classification or insertion', async () => {
    const { repo, ledgerRows } = makeFakeRepo({ chainEvents: [erc20Event({ status: 'pending' })] })
    const result = await interpretConfirmedChainEvent(repo, 'ce-1')
    expect(result.classification).toBe('unresolved')
    expect(result.inserts).toHaveLength(0)
    expect(ledgerRows).toHaveLength(0)
  })

  it('missing chain_event is not_applicable, not an exception', async () => {
    const { repo } = makeFakeRepo()
    const result = await interpretConfirmedChainEvent(repo, 'does-not-exist')
    expect(result.classification).toBe('not_applicable')
  })
})

describe('interpretConfirmedAttempt — confirmation rule', () => {
  const intent: IntentContext = {
    id: 'intent-1', wallet_address: '0xUser', feature: 'swap',
    amount_atomic: '100000000', decimals: 6, token_address: '0xUSDC', token_symbol: 'USDC', is_native: false,
  }

  it('13/14/15. UNKNOWN / REVERTED / DROPPED attempts never produce a ledger row', async () => {
    for (const status of ['UNKNOWN', 'REVERTED', 'DROPPED']) {
      const { repo, ledgerRows } = makeFakeRepo({ intents: [intent] })
      const attempt: AttemptContext = { id: 'a1', intent_id: intent.id, chain_id: CHAIN, tx_hash: '0xSwapTx', status, block_number: 1 }
      const result = await interpretConfirmedAttempt(repo, attempt)
      expect(result.classification).toBe('unresolved')
      expect(ledgerRows).toHaveLength(0)
    }
  })

  it('12. CONFIRMED attempt produces SWAP_DEBIT', async () => {
    const { repo, ledgerRows } = makeFakeRepo({ intents: [intent] })
    const attempt: AttemptContext = { id: 'a1', intent_id: intent.id, chain_id: CHAIN, tx_hash: '0xSwapTx', status: 'CONFIRMED', block_number: 1 }
    const result = await interpretConfirmedAttempt(repo, attempt)
    expect(result.classification).toBe('classified')
    expect(ledgerRows).toHaveLength(1)
    expect(ledgerRows[0].event_type).toBe('SWAP_DEBIT')
  })
})

// ── SWAP end-to-end via the interpreter (correlation through the repo) ──

describe('interpretConfirmedChainEvent — Swap correlation', () => {
  it('17/18. a chain_event whose tx_hash correlates to a swap attempt produces SWAP_CREDIT, linked to the same intent', async () => {
    const intent: IntentContext = {
      id: 'intent-swap', wallet_address: '0xUser', feature: 'swap',
      amount_atomic: '100000000', decimals: 6, token_address: '0xUSDC', token_symbol: 'USDC', is_native: false,
    }
    const attempt: AttemptContext = { id: 'attempt-swap', intent_id: intent.id, chain_id: CHAIN, tx_hash: '0xSwapTx', status: 'CONFIRMED', block_number: 1 }
    const outputEvent = erc20Event({
      id: 'ce-output', tx_hash: '0xSwapTx', wallet_address: '0xUser',
      token_address: '0xEURC', token_symbol: 'EURC', metadata: { sender: KIT_ADAPTER, amount: 98.31 },
    })
    const { repo, ledgerRows } = makeFakeRepo({ chainEvents: [outputEvent], attempts: [attempt], intents: [intent] })

    const result = await interpretConfirmedChainEvent(repo, 'ce-output')
    expect(result.classification).toBe('classified')
    expect(ledgerRows).toHaveLength(1)
    expect(ledgerRows[0].event_type).toBe('SWAP_CREDIT')
    expect(ledgerRows[0].transaction_intent_id).toBe(intent.id)
  })

  it('uncorrelated (no matching attempt) swap-router-sender output defers — never CREDIT, never guessed', async () => {
    const outputEvent = erc20Event({ metadata: { sender: KIT_ADAPTER, amount: 98.31 } })
    const { repo, ledgerRows } = makeFakeRepo({ chainEvents: [outputEvent] }) // no attempts seeded
    const result = await interpretConfirmedChainEvent(repo, 'ce-1')
    expect(result.classification).toBe('not_applicable')
    expect(ledgerRows).toHaveLength(0)
  })
})

// ── CONCURRENCY ──────────────────────────────────────────────────────────

describe('concurrency', () => {
  it('22. two interpreter passes for the same chain_event converge — one inserts, one sees already_posted', async () => {
    const { repo, ledgerRows } = makeFakeRepo({ chainEvents: [erc20Event()] })
    const [a, b] = await Promise.all([
      interpretConfirmedChainEvent(repo, 'ce-1'),
      interpretConfirmedChainEvent(repo, 'ce-1'),
    ])
    // Both calls succeed at the classification level; the repo's own
    // conditional-write semantics (not a JS-level lock) are what prevent
    // duplication — verified by the row count, not by which call "won".
    expect(a.classification).toBe('classified')
    expect(b.classification).toBe('classified')
    expect(ledgerRows).toHaveLength(2) // exactly one DEBIT + one CREDIT, never four
  })

  it('23. different classifications racing for the same raw movement -> the loser gets a surfaced conflict, never a silent double-post', async () => {
    const { repo, ledgerRows, setRaceHook } = makeFakeRepo()
    const draftCredit: LedgerEventDraft = {
      transaction_intent_id: null, transaction_attempt_id: null, wallet_address: '0xrecipient',
      chain_id: CHAIN, event_type: 'CREDIT', direction: 'credit', token_address: '0xTokenContract',
      token_symbol: 'EURC', decimals: 6, amount_atomic: '10000000', is_native: false,
      tx_hash: '0xtx1', block_number: 100, log_index: 5, event_key: 'k-credit', metadata: {},
    }
    const draftSwapCredit: LedgerEventDraft = { ...draftCredit, event_type: 'SWAP_CREDIT', event_key: 'k-swap-credit' }

    // Simulate a competing writer landing CREDIT in the exact window between
    // this call's own courtesy read and its write.
    setRaceHook(() => {
      ledgerRows.push({ ...draftCredit, id: 'ledger-raced' })
    })

    const result = await repo.insertLedgerEvent(draftSwapCredit)
    expect(result.outcome).toBe('conflict')
    if (result.outcome === 'conflict') expect(result.existingEventType).toBe('CREDIT')
    expect(ledgerRows).toHaveLength(1) // only the racer's row — the loser never got in
  })

  it('24. same transaction, multiple logs, processed concurrently -> independent, no interference', async () => {
    const eventA = erc20Event({ id: 'ce-a', log_index: 10, wallet_address: '0xRecipientA', metadata: { sender: '0xPayer', amount: 3 } })
    const eventB = erc20Event({ id: 'ce-b', log_index: 11, wallet_address: '0xRecipientB', metadata: { sender: '0xPayer', amount: 7 } })
    const { repo, ledgerRows } = makeFakeRepo({ chainEvents: [eventA, eventB] })

    const [resultA, resultB] = await Promise.all([
      interpretConfirmedChainEvent(repo, 'ce-a'),
      interpretConfirmedChainEvent(repo, 'ce-b'),
    ])
    expect(resultA.classification).toBe('classified')
    expect(resultB.classification).toBe('classified')
    expect(ledgerRows).toHaveLength(4) // 2 DEBIT (same payer, different log_index) + 2 CREDIT (different recipients)
    const payerRows = ledgerRows.filter(r => r.wallet_address === '0xpayer')
    expect(payerRows).toHaveLength(2)
    expect(new Set(payerRows.map(r => r.log_index)).size).toBe(2) // distinguished by log_index, not collapsed
  })
})

// ── BulkPay dispatch integration (docs/BULKPAY_TRANSACTION_INTENT_IMPLEMENTATION.md) ──
const MULTICALL3_ADDR = '0xca11bde05977b3631167028862be2a173976ca11'
const REAL_BULKPAY_TX_HASH = '0xb179c4f0691199d5a1fdfc49d5086cf587f5440b13c768629a2913f7f783714c'
const BULKPAY_PAYER = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
const BULKPAY_RECIPIENT_A = '0xebe52519a38e857a744e65d01f23137e22fb784b'
const BULKPAY_RECIPIENT_B = '0x9171d4f0d376019297d9598c33cdc6e92413f730'

function bulkPayChainEventFixture(recipient: string, amount: number, logIndex: number, id: string): ChainEventInput {
  return {
    id, chain_id: CHAIN, tx_hash: REAL_BULKPAY_TX_HASH, wallet_address: recipient,
    event_type: 'deposit_detected', status: 'confirmed', log_index: logIndex, block_number: 58592562,
    token_address: null, token_symbol: 'USDC', decimals: 18,
    metadata: { recipient, sender: MULTICALL3_ADDR, amount, via: 'native-transfer-log' },
  }
}

describe('interpretConfirmedChainEvent — BulkPay correlation (real transaction 0xb179c4f0…)', () => {
  it('A. correlated BulkPay chain_events reach CREDIT via the dispatch, not classifyPayTransfer\'s rejection', async () => {
    const intent: IntentContext = {
      id: 'intent-bp', wallet_address: BULKPAY_PAYER, feature: 'bulkpay',
      amount_atomic: '24000000000000000000', decimals: 18, token_address: null, token_symbol: 'USDC', is_native: true,
    }
    const attempt: AttemptContext = { id: 'attempt-bp', intent_id: intent.id, chain_id: CHAIN, tx_hash: REAL_BULKPAY_TX_HASH, status: 'CONFIRMED', block_number: 58592562 }
    const eventA = bulkPayChainEventFixture(BULKPAY_RECIPIENT_A, 10, 6, 'ce-bp-a')
    const eventB = bulkPayChainEventFixture(BULKPAY_RECIPIENT_B, 14, 7, 'ce-bp-b')
    const { repo, ledgerRows } = makeFakeRepo({ chainEvents: [eventA, eventB], attempts: [attempt], intents: [intent] })

    const resultA = await interpretConfirmedChainEvent(repo, 'ce-bp-a')
    const resultB = await interpretConfirmedChainEvent(repo, 'ce-bp-b')
    expect(resultA.classification).toBe('classified')
    expect(resultB.classification).toBe('classified')
    // 27/28: all N events correlate to the SAME attempt, all become CREDIT (+ matching DEBIT)
    expect(ledgerRows).toHaveLength(4)
    const credits = ledgerRows.filter(r => r.event_type === 'CREDIT')
    expect(credits.map(r => r.wallet_address).sort()).toEqual([BULKPAY_RECIPIENT_A, BULKPAY_RECIPIENT_B].sort())
    for (const row of ledgerRows) {
      expect(row.transaction_intent_id).toBe(intent.id)
      expect(row.transaction_attempt_id).toBe(attempt.id)
    }
    const debits = ledgerRows.filter(r => r.event_type === 'DEBIT')
    expect(debits.every(r => r.wallet_address === BULKPAY_PAYER)).toBe(true)
  })

  it('J. uncorrelated Multicall3-sourced event (no matching attempt) remains NOT_APPLICABLE — the mandatory security invariant', async () => {
    const eventA = bulkPayChainEventFixture(BULKPAY_RECIPIENT_A, 10, 6, 'ce-bp-uncorrelated')
    const { repo, ledgerRows } = makeFakeRepo({ chainEvents: [eventA] }) // no attempts/intents seeded at all
    const result = await interpretConfirmedChainEvent(repo, 'ce-bp-uncorrelated')
    expect(result.classification).toBe('not_applicable')
    expect(ledgerRows).toHaveLength(0)
  })

  it('G. re-running the same BulkPay chain_events twice is idempotent — no duplicate financial effects', async () => {
    const intent: IntentContext = {
      id: 'intent-bp2', wallet_address: BULKPAY_PAYER, feature: 'bulkpay',
      amount_atomic: '10000000000000000000', decimals: 18, token_address: null, token_symbol: 'USDC', is_native: true,
    }
    const attempt: AttemptContext = { id: 'attempt-bp2', intent_id: intent.id, chain_id: CHAIN, tx_hash: REAL_BULKPAY_TX_HASH, status: 'CONFIRMED', block_number: 58592562 }
    const eventA = bulkPayChainEventFixture(BULKPAY_RECIPIENT_A, 10, 6, 'ce-bp2-a')
    const { repo, ledgerRows } = makeFakeRepo({ chainEvents: [eventA], attempts: [attempt], intents: [intent] })

    await interpretConfirmedChainEvent(repo, 'ce-bp2-a')
    const firstCount = ledgerRows.length
    await interpretConfirmedChainEvent(repo, 'ce-bp2-a')
    expect(ledgerRows.length).toBe(firstCount)
  })
})
