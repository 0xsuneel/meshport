import { describe, it, expect } from 'vitest'
import { classifyPayTransfer, classifySwapDebit, classifySwapCredit, classifyBulkPayCredit, buildEventKey, toAmountAtomic } from './classifiers'
import type { ChainEventInput, IntentContext, AttemptContext } from './types'

const CHAIN = 'arc'
const KIT_ADAPTER = '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b' // real, from knownInternalContracts.ts

function erc20Event(overrides: Partial<ChainEventInput> = {}): ChainEventInput {
  return {
    id: 'ce-1',
    chain_id: CHAIN,
    tx_hash: '0xTx1',
    wallet_address: '0xRecipient',
    event_type: 'transfer_detected',
    status: 'confirmed',
    log_index: 5,
    block_number: 100,
    token_address: '0xTokenContract',
    token_symbol: 'EURC',
    decimals: 6,
    metadata: { sender: '0xSender', amount: 10 },
    ...overrides,
  }
}

function nativeEvent(overrides: Partial<ChainEventInput> = {}): ChainEventInput {
  return {
    id: 'ce-native',
    chain_id: CHAIN,
    tx_hash: '0xNativeTx',
    wallet_address: '0xRecipient',
    event_type: 'deposit_detected',
    status: 'confirmed',
    log_index: null,
    block_number: 200,
    token_address: null,
    token_symbol: 'USDC',
    decimals: 18,
    metadata: { sender: '0xSender', recipient: '0xRecipient', amount: 2.5 },
    ...overrides,
  }
}

function payIntent(overrides: Partial<IntentContext> = {}): IntentContext {
  return {
    id: 'intent-pay-1', wallet_address: '0xSender', feature: 'pay',
    amount_atomic: '10000000', decimals: 6, token_address: '0xTokenContract',
    token_symbol: 'EURC', is_native: false, ...overrides,
  }
}
function swapIntent(overrides: Partial<IntentContext> = {}): IntentContext {
  return {
    id: 'intent-swap-1', wallet_address: '0xUser', feature: 'swap',
    amount_atomic: '100000000', decimals: 6, token_address: '0xUSDCContract',
    token_symbol: 'USDC', is_native: false, ...overrides,
  }
}
function confirmedAttempt(overrides: Partial<AttemptContext> = {}): AttemptContext {
  return { id: 'attempt-1', intent_id: 'intent-swap-1', chain_id: CHAIN, tx_hash: '0xSwapTx', status: 'CONFIRMED', block_number: 300, ...overrides }
}

// ── IDENTITY ─────────────────────────────────────────────────────────────

describe('buildEventKey — identity', () => {
  it('same movement + same event_type -> identical key (idempotency basis)', () => {
    const a = buildEventKey(CHAIN, '0xTx1', 5, '0xWallet', 'CREDIT')
    const b = buildEventKey(CHAIN, '0xTx1', 5, '0xWallet', 'CREDIT')
    expect(a).toBe(b)
  })

  it('3. same tx/log + different wallets -> different keys, both permitted', () => {
    const a = buildEventKey(CHAIN, '0xTx1', 5, '0xWalletA', 'DEBIT')
    const b = buildEventKey(CHAIN, '0xTx1', 5, '0xWalletB', 'CREDIT')
    expect(a).not.toBe(b)
  })

  it('4. same tx + different log_index -> different keys', () => {
    const a = buildEventKey(CHAIN, '0xTx1', 5, '0xWallet', 'CREDIT')
    const b = buildEventKey(CHAIN, '0xTx1', 6, '0xWallet', 'CREDIT')
    expect(a).not.toBe(b)
  })

  it('5. native NULL log_index still produces a stable, distinguishable key', () => {
    const a = buildEventKey(CHAIN, '0xNativeTx', null, '0xWallet', 'CREDIT')
    const b = buildEventKey(CHAIN, '0xNativeTx', null, '0xWallet', 'CREDIT')
    expect(a).toBe(b)
    expect(a).toContain('0xnativetx::0xwallet:CREDIT') // empty log-index segment, not "null"
  })
})

describe('toAmountAtomic — no floating-point canonical values', () => {
  it('shifts the decimal point via string ops, not multiplication', () => {
    expect(toAmountAtomic(1, 6)).toBe('1000000')
    expect(toAmountAtomic(0.881746, 6)).toBe('881746')
    expect(toAmountAtomic(5, 18)).toBe('5000000000000000000')
  })
})

// ── PAY ──────────────────────────────────────────────────────────────────

describe('classifyPayTransfer — ERC20', () => {
  it('6/7. produces a DEBIT (sender) and a CREDIT (recipient), same tx/log, correct amounts', () => {
    const result = classifyPayTransfer(erc20Event())
    expect(result.outcome).toBe('classified')
    if (result.outcome !== 'classified') return
    expect(result.drafts).toHaveLength(2)
    const debit = result.drafts.find(d => d.event_type === 'DEBIT')!
    const credit = result.drafts.find(d => d.event_type === 'CREDIT')!
    expect(debit.wallet_address).toBe('0xsender')
    expect(debit.direction).toBe('debit')
    expect(credit.wallet_address).toBe('0xrecipient')
    expect(credit.direction).toBe('credit')
    expect(debit.amount_atomic).toBe('10000000')
    expect(credit.amount_atomic).toBe('10000000')
    // same raw movement (chain_id/tx_hash/log_index), different wallet
    expect(debit.chain_id).toBe(credit.chain_id)
    expect(debit.tx_hash).toBe(credit.tx_hash)
    expect(debit.log_index).toBe(credit.log_index)
    expect(debit.wallet_address).not.toBe(credit.wallet_address)
  })
})

describe('classifyPayTransfer — native', () => {
  it('8/9. native sender debit + recipient credit, log_index null on both legs', () => {
    const result = classifyPayTransfer(nativeEvent())
    expect(result.outcome).toBe('classified')
    if (result.outcome !== 'classified') return
    const debit = result.drafts.find(d => d.event_type === 'DEBIT')!
    const credit = result.drafts.find(d => d.event_type === 'CREDIT')!
    expect(debit.is_native).toBe(true)
    expect(credit.is_native).toBe(true)
    expect(debit.log_index).toBeNull()
    expect(credit.log_index).toBeNull()
    expect(debit.amount_atomic).toBe('2500000000000000000') // 2.5 * 1e18
  })
})

describe('classifyPayTransfer — 10. multiple transfers in one transaction', () => {
  it('two chain_events, same tx, different log_index -> independent, non-interfering DEBIT/CREDIT pairs', () => {
    const first = classifyPayTransfer(erc20Event({ id: 'ce-a', log_index: 10, wallet_address: '0xRecipientA', metadata: { sender: '0xPayer', amount: 3 } }))
    const second = classifyPayTransfer(erc20Event({ id: 'ce-b', log_index: 11, wallet_address: '0xRecipientB', metadata: { sender: '0xPayer', amount: 7 } }))
    expect(first.outcome).toBe('classified')
    expect(second.outcome).toBe('classified')
    if (first.outcome !== 'classified' || second.outcome !== 'classified') return
    const firstCredit = first.drafts.find(d => d.event_type === 'CREDIT')!
    const secondCredit = second.drafts.find(d => d.event_type === 'CREDIT')!
    expect(firstCredit.event_key).not.toBe(secondCredit.event_key)
    expect(firstCredit.wallet_address).toBe('0xrecipienta')
    expect(secondCredit.wallet_address).toBe('0xrecipientb')
  })
})

describe('classifyPayTransfer — safety exclusions', () => {
  it('self-transfer is not_applicable, never classified', () => {
    const result = classifyPayTransfer(erc20Event({ wallet_address: '0xSame', metadata: { sender: '0xSame', amount: 1 } }))
    expect(result.outcome).toBe('not_applicable')
  })

  it('20 (part 1). known-internal-contract sender is never absorbed as a plain Pay/CREDIT', () => {
    const result = classifyPayTransfer(erc20Event({ metadata: { sender: KIT_ADAPTER, amount: 1 } }))
    expect(result.outcome).toBe('not_applicable')
  })
})

// ── CONFIRMATION ─────────────────────────────────────────────────────────

describe('confirmation rule', () => {
  it('11. pending chain_event -> no ledger event (unresolved, not classified)', () => {
    const result = classifyPayTransfer(erc20Event({ status: 'pending' }))
    expect(result.outcome).toBe('unresolved')
  })

  it('confirmed chain_event -> classified (the only status that ever produces a draft)', () => {
    const result = classifyPayTransfer(erc20Event({ status: 'confirmed' }))
    expect(result.outcome).toBe('classified')
  })

  it('reorged chain_event -> no ledger event', () => {
    const result = classifyPayTransfer(erc20Event({ status: 'reorged' }))
    expect(result.outcome).toBe('unresolved')
  })

  it('13. UNKNOWN attempt -> no SWAP_DEBIT', () => {
    const result = classifySwapDebit(swapIntent(), confirmedAttempt({ status: 'UNKNOWN' }))
    expect(result.outcome).toBe('unresolved')
  })

  it('14. REVERTED attempt -> no SWAP_DEBIT', () => {
    const result = classifySwapDebit(swapIntent(), confirmedAttempt({ status: 'REVERTED' }))
    expect(result.outcome).toBe('unresolved')
  })

  it('15. DROPPED attempt -> no SWAP_DEBIT', () => {
    const result = classifySwapDebit(swapIntent(), confirmedAttempt({ status: 'DROPPED' }))
    expect(result.outcome).toBe('unresolved')
  })

  it('12. CONFIRMED attempt -> SWAP_DEBIT classified', () => {
    const result = classifySwapDebit(swapIntent(), confirmedAttempt({ status: 'CONFIRMED' }))
    expect(result.outcome).toBe('classified')
  })
})

// ── SWAP ─────────────────────────────────────────────────────────────────

describe('Swap', () => {
  it('16. SWAP_DEBIT created from a confirmed attempt + swap intent', () => {
    const intent = swapIntent()
    const attempt = confirmedAttempt()
    const result = classifySwapDebit(intent, attempt)
    expect(result.outcome).toBe('classified')
    if (result.outcome !== 'classified') return
    expect(result.drafts[0].event_type).toBe('SWAP_DEBIT')
    expect(result.drafts[0].direction).toBe('debit')
    expect(result.drafts[0].log_index).toBeNull() // no log — see types.ts
  })

  it('17. SWAP_CREDIT created from a correlated confirmed chain_event', () => {
    const intent = swapIntent()
    const attempt = confirmedAttempt()
    const outputEvent = erc20Event({
      tx_hash: '0xSwapTx', wallet_address: '0xUser', token_address: '0xEURCContract',
      token_symbol: 'EURC', metadata: { sender: KIT_ADAPTER, amount: 98.31 },
    })
    const result = classifySwapCredit(outputEvent, { intent, attempt })
    expect(result.outcome).toBe('classified')
    if (result.outcome !== 'classified') return
    expect(result.drafts[0].event_type).toBe('SWAP_CREDIT')
    expect(result.drafts[0].direction).toBe('credit')
  })

  it('18. SWAP_DEBIT and SWAP_CREDIT link to the SAME transaction_intent_id', () => {
    const intent = swapIntent()
    const attempt = confirmedAttempt()
    const debitResult = classifySwapDebit(intent, attempt)
    const creditResult = classifySwapCredit(
      erc20Event({ tx_hash: '0xSwapTx', wallet_address: '0xUser', metadata: { sender: KIT_ADAPTER, amount: 98.31 } }),
      { intent, attempt },
    )
    expect(debitResult.outcome).toBe('classified')
    expect(creditResult.outcome).toBe('classified')
    if (debitResult.outcome !== 'classified' || creditResult.outcome !== 'classified') return
    expect(debitResult.drafts[0].transaction_intent_id).toBe(intent.id)
    expect(creditResult.drafts[0].transaction_intent_id).toBe(intent.id)
    expect(debitResult.drafts[0].transaction_intent_id).toBe(creditResult.drafts[0].transaction_intent_id)
  })

  it('19. different token identities preserved between the two legs', () => {
    const intent = swapIntent({ token_address: '0xUSDCContract', token_symbol: 'USDC' })
    const attempt = confirmedAttempt()
    const debitResult = classifySwapDebit(intent, attempt)
    const creditResult = classifySwapCredit(
      erc20Event({ tx_hash: '0xSwapTx', wallet_address: '0xUser', token_address: '0xEURCContract', token_symbol: 'EURC', metadata: { sender: KIT_ADAPTER, amount: 98.31 } }),
      { intent, attempt },
    )
    if (debitResult.outcome !== 'classified' || creditResult.outcome !== 'classified') throw new Error('expected classified')
    expect(debitResult.drafts[0].token_symbol).toBe('USDC')
    expect(creditResult.drafts[0].token_symbol).toBe('EURC')
    expect(debitResult.drafts[0].token_address).not.toBe(creditResult.drafts[0].token_address)
  })

  it('20 (part 2). uncorrelated known-internal-sender swap output is NEVER generic CREDIT, NEVER guessed as SWAP_CREDIT', () => {
    const outputEvent = erc20Event({ metadata: { sender: KIT_ADAPTER, amount: 98.31 } })
    const result = classifySwapCredit(outputEvent, null)
    expect(result.outcome).toBe('not_applicable')
    // Also confirm the OTHER classifier (Pay) doesn't pick it up as a fallback either.
    const payAttempt = classifyPayTransfer(outputEvent)
    expect(payAttempt.outcome).toBe('not_applicable')
  })

  it('21. retry (calling the classifier twice on the same inputs) is idempotent at the classification level — identical drafts, identical event_keys', () => {
    const intent = swapIntent()
    const attempt = confirmedAttempt()
    const first = classifySwapDebit(intent, attempt)
    const second = classifySwapDebit(intent, attempt)
    if (first.outcome !== 'classified' || second.outcome !== 'classified') throw new Error('expected classified')
    expect(first.drafts[0].event_key).toBe(second.drafts[0].event_key)
  })
})

// ── is_native regression suite (docs/LEDGER_IS_NATIVE_FIX.md) ──────────────
// Real bug: chain_events rows predating the Phase 3 scanner's
// contract_address population fix have token_address=null even for genuine
// ERC-20 (transfer_detected) events — the OLD `isNative = tokenAddress ==
// null` rule misread that as "native". Fixed by deriving native/ERC20 from
// event_type (a structurally reliable signal — see scanner.ts) instead.
describe('is_native classification — the fix', () => {
  it('1. native token: token_address=NULL, event_type=deposit_detected -> is_native=true, token_address stays NULL', () => {
    const result = classifyPayTransfer(nativeEvent())
    if (result.outcome !== 'classified') throw new Error('expected classified')
    for (const d of result.drafts) {
      expect(d.is_native).toBe(true)
      expect(d.token_address).toBeNull()
    }
  })

  it('2. ERC20 with a real token_address, event_type=transfer_detected -> is_native=false, ERC20 invariant holds', () => {
    const result = classifyPayTransfer(erc20Event()) // has token_address set
    if (result.outcome !== 'classified') throw new Error('expected classified')
    for (const d of result.drafts) {
      expect(d.is_native).toBe(false)
      expect(d.token_address).not.toBeNull()
    }
  })

  it('3. THE EXACT REAL EURC REGRESSION CASE (docs/LEDGER_REAL_DATA_SHADOW_VALIDATION.md) — historical row, token_address missing, EURC MUST NEVER become native', () => {
    // Real fixture: chain_events id 103, tx 0xef6d341036fedf9f9b4e1eaf6d4cf3fd289bc7e50b35995199aa9bfb21c9c778,
    // as actually queried from production — token_address/log_index/block_number
    // are null because this row predates the Phase 3 scanner fix.
    const historicalEurcRow = erc20Event({
      id: 'ce-real-103',
      tx_hash: '0xef6d341036fedf9f9b4e1eaf6d4cf3fd289bc7e50b35995199aa9bfb21c9c778',
      wallet_address: '0x05d00ab75bcbe15450143f810cd5e5164ee126e0',
      log_index: null,
      block_number: null,
      token_address: null, // the exact condition that triggered the bug
      token_symbol: 'EURC',
      metadata: { to: '0x05d00ab75bcbe15450143f810cd5e5164ee126e0', from: '0xd4c0b787aa2ff9eb751bb515c877ebbf2daddaae', amount: 20 },
    })
    const result = classifyPayTransfer(historicalEurcRow)
    expect(result.outcome).toBe('classified')
    if (result.outcome !== 'classified') return
    for (const d of result.drafts) {
      expect(d.is_native).toBe(false) // MUST NOT be true — this was the bug
      expect(d.token_address).toBe('0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a') // resolved from the known EURC address, not fabricated
      expect(d.token_symbol).toBe('EURC')
    }
  })

  it('4. any ERC20 with 18 decimals must not automatically become native', () => {
    const result = classifyPayTransfer(erc20Event({ decimals: 18, token_symbol: 'cirBTC', token_address: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF' }))
    if (result.outcome !== 'classified') throw new Error('expected classified')
    for (const d of result.drafts) expect(d.is_native).toBe(false)
  })

  it('5. ERC20 symbol "USDC" must not determine native status — event_type is what matters, not the symbol string', () => {
    // A hypothetical ERC-20-wrapped USDC (transfer_detected, real token_address) —
    // must NOT be treated as native just because the symbol says "USDC",
    // which IS Arc's native asset's symbol in the native path.
    const result = classifyPayTransfer(erc20Event({ token_symbol: 'USDC', token_address: '0xSomeWrappedUsdcContract' }))
    if (result.outcome !== 'classified') throw new Error('expected classified')
    for (const d of result.drafts) {
      expect(d.is_native).toBe(false)
      expect(d.token_address).toBe('0xSomeWrappedUsdcContract')
    }
  })

  it('6. missing/ambiguous token identity (transfer_detected, no token_address, unrecognized symbol) -> do NOT guess native, defer instead', () => {
    const result = classifyPayTransfer(erc20Event({ token_address: null, token_symbol: 'UNKNOWNTOKEN' }))
    expect(result.outcome).toBe('not_applicable')
  })

  it('unrecognized event_type also defers rather than guessing', () => {
    const result = classifyPayTransfer(erc20Event({ event_type: 'something_else', token_address: null }))
    expect(result.outcome).toBe('not_applicable')
  })
})

// ── BulkPay classification (docs/BULKPAY_LEDGER_CLASSIFICATION_AUDIT.md) ───
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
const REAL_BULKPAY_TX = '0xb179c4f0691199d5a1fdfc49d5086cf587f5440b13c768629a2913f7f783714c'
const PAYER = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'
const RECIPIENT_A = '0xebe52519a38e857a744e65d01f23137e22fb784b' // real, registered, live chain_events id 125
const RECIPIENT_B = '0x9171d4f0d376019297d9598c33cdc6e92413f730' // real, unregistered

function bulkPayIntent(overrides: Partial<IntentContext> = {}): IntentContext {
  return {
    id: 'intent-bulkpay-1', wallet_address: PAYER, feature: 'bulkpay',
    amount_atomic: '24000000000000000000', decimals: 18, token_address: null,
    token_symbol: 'USDC', is_native: true, ...overrides,
  }
}
function bulkPayAttempt(overrides: Partial<AttemptContext> = {}): AttemptContext {
  return { id: 'attempt-bulkpay-1', intent_id: 'intent-bulkpay-1', chain_id: CHAIN, tx_hash: REAL_BULKPAY_TX, status: 'CONFIRMED', block_number: 58592562, ...overrides }
}
// Real chain_events shape for recipient A — verbatim from production id 125.
function bulkPayChainEvent(recipient: string, amount: number, logIndex: number, overrides: Partial<ChainEventInput> = {}): ChainEventInput {
  return {
    id: `ce-bulkpay-${recipient}`, chain_id: CHAIN, tx_hash: REAL_BULKPAY_TX,
    wallet_address: recipient, event_type: 'deposit_detected', status: 'confirmed',
    log_index: logIndex, block_number: 58592562, token_address: null, token_symbol: 'USDC', decimals: 18,
    metadata: { recipient, sender: MULTICALL3, amount, via: 'native-transfer-log' },
    ...overrides,
  }
}

describe('classifyBulkPayCredit — real transaction 0xb179c4f0…', () => {
  it('16. produces DEBIT (real payer) + CREDIT (recipient), correctly sourced from the intent, not chainEvent.metadata.sender', () => {
    const intent = bulkPayIntent()
    const attempt = bulkPayAttempt()
    const result = classifyBulkPayCredit(bulkPayChainEvent(RECIPIENT_A, 10, 6), { intent, attempt })
    expect(result.outcome).toBe('classified')
    if (result.outcome !== 'classified') return
    expect(result.drafts).toHaveLength(2)
    const debit = result.drafts.find(d => d.event_type === 'DEBIT')!
    const credit = result.drafts.find(d => d.event_type === 'CREDIT')!
    expect(debit.wallet_address).toBe(PAYER) // NOT Multicall3 — the exact bug this function prevents
    expect(debit.wallet_address).not.toBe(MULTICALL3)
    expect(credit.wallet_address).toBe(RECIPIENT_A)
    expect(debit.amount_atomic).toBe('10000000000000000000')
    expect(credit.amount_atomic).toBe('10000000000000000000')
    expect(debit.is_native).toBe(true)
    expect(credit.is_native).toBe(true)
  })

  it('registered recipient (A) and unregistered recipient (B) both reach CREDIT identically — no users-table dependency', () => {
    const intent = bulkPayIntent()
    const attempt = bulkPayAttempt()
    const resultA = classifyBulkPayCredit(bulkPayChainEvent(RECIPIENT_A, 10, 6), { intent, attempt })
    const resultB = classifyBulkPayCredit(bulkPayChainEvent(RECIPIENT_B, 14, 7), { intent, attempt })
    expect(resultA.outcome).toBe('classified')
    expect(resultB.outcome).toBe('classified')
    if (resultA.outcome !== 'classified' || resultB.outcome !== 'classified') return
    const creditA = resultA.drafts.find(d => d.event_type === 'CREDIT')!
    const creditB = resultB.drafts.find(d => d.event_type === 'CREDIT')!
    expect(creditA.wallet_address).toBe(RECIPIENT_A)
    expect(creditB.wallet_address).toBe(RECIPIENT_B)
    // Both DEBITs correctly attribute to the same real payer, distinguished only by log_index
    const debitA = resultA.drafts.find(d => d.event_type === 'DEBIT')!
    const debitB = resultB.drafts.find(d => d.event_type === 'DEBIT')!
    expect(debitA.wallet_address).toBe(PAYER)
    expect(debitB.wallet_address).toBe(PAYER)
    expect(debitA.log_index).not.toBe(debitB.log_index)
  })

  it('27/18. all N events correlate to the SAME transaction_intent_id/transaction_attempt_id', () => {
    const intent = bulkPayIntent()
    const attempt = bulkPayAttempt()
    const resultA = classifyBulkPayCredit(bulkPayChainEvent(RECIPIENT_A, 10, 6), { intent, attempt })
    const resultB = classifyBulkPayCredit(bulkPayChainEvent(RECIPIENT_B, 14, 7), { intent, attempt })
    if (resultA.outcome !== 'classified' || resultB.outcome !== 'classified') throw new Error('expected classified')
    for (const d of [...resultA.drafts, ...resultB.drafts]) {
      expect(d.transaction_intent_id).toBe(intent.id)
      expect(d.transaction_attempt_id).toBe(attempt.id)
    }
  })

  it('29. uncorrelated feature on the intent defers, never guesses', () => {
    const intent = bulkPayIntent({ feature: 'pay' })
    const attempt = bulkPayAttempt()
    const result = classifyBulkPayCredit(bulkPayChainEvent(RECIPIENT_A, 10, 6), { intent, attempt })
    expect(result.outcome).toBe('not_applicable')
  })

  it('non-confirmed chain_event never classified', () => {
    const intent = bulkPayIntent()
    const attempt = bulkPayAttempt()
    const result = classifyBulkPayCredit(bulkPayChainEvent(RECIPIENT_A, 10, 6, { status: 'pending' }), { intent, attempt })
    expect(result.outcome).toBe('unresolved')
  })

  it('self-transfer (payer === recipient) is excluded', () => {
    const intent = bulkPayIntent({ wallet_address: RECIPIENT_A })
    const attempt = bulkPayAttempt()
    const result = classifyBulkPayCredit(bulkPayChainEvent(RECIPIENT_A, 10, 6), { intent, attempt })
    expect(result.outcome).toBe('not_applicable')
  })

  it('21/30. retry (calling the classifier twice on the same inputs) is idempotent — identical drafts, identical event_keys', () => {
    const intent = bulkPayIntent()
    const attempt = bulkPayAttempt()
    const chainEvent = bulkPayChainEvent(RECIPIENT_A, 10, 6)
    const first = classifyBulkPayCredit(chainEvent, { intent, attempt })
    const second = classifyBulkPayCredit(chainEvent, { intent, attempt })
    if (first.outcome !== 'classified' || second.outcome !== 'classified') throw new Error('expected classified')
    expect(first.drafts.map(d => d.event_key)).toEqual(second.drafts.map(d => d.event_key))
  })
})

describe('interpretConfirmedChainEvent dispatch — BulkPay vs uncorrelated Multicall3 (security invariant)', () => {
  it('12/16. uncorrelated Multicall3 sender remains NOT_APPLICABLE — the mandatory security invariant', () => {
    // No correlation supplied at all — mirrors classifyPayTransfer being the
    // fallback path when no attempt/intent exists for this tx_hash.
    const chainEvent = bulkPayChainEvent(RECIPIENT_A, 10, 6)
    const result = classifyPayTransfer(chainEvent, null)
    expect(result.outcome).toBe('not_applicable')
    // Confirm Multicall3 specifically triggered this, not amount/token issues
    if (result.outcome === 'not_applicable') {
      expect(result.reason).toContain(MULTICALL3)
    }
  })
})
