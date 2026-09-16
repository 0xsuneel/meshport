/**
 * server/ledger/classifiers.ts — pure classification logic (Pay + Swap only).
 *
 * No I/O. Every function is a pure function of its inputs, so it is unit-
 * testable without a database — the same discipline already used for
 * server/transactionStateMachine/transitions.ts and
 * blockchain-indexer/compare.ts. DB reads (correlating a chain_event's
 * tx_hash against transaction_attempts/transaction_intents) happen in
 * interpreter.ts via the injected repository, not here.
 *
 * See types.ts's header comment for why Pay's DEBIT+CREDIT pair is sourced
 * from ONE chain_event, while Swap's SWAP_DEBIT can only ever come from a
 * confirmed transaction_attempt/intent.
 */

import type {
  IntentContext,
  AttemptContext,
  ChainEventInput,
  LedgerEventDraft,
  ClassificationOutcome,
} from './types'

const KNOWN_INTERNAL_CONTRACTS_FALLBACK = new Set([
  '0x0077777d7eba4688bdef3e311b846f25870a19b9',
  '0x9f3b8679c73c2fef8b59b4f3444d4e156fb70aa5',
  '0x7865fafc2db2093669d92c0f33aeef291086befd',
  '0xacf1ceef35caac005e15888ddb8a3515c41b4872',
  '0xc5567a5e3370d4dbfb0540025078e283e36a363d',
  '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b',
  '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',
  '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
  '0xca11bde05977b3631167028862be2a173976ca11',
])
// This module intentionally carries its own copy of the known-internal-
// contract list rather than importing supabase/functions/_shared/
// knownInternalContracts.ts across the Deno/Node boundary — an earlier
// attempt at that cross-directory import failed the server/ TypeScript
// project (`TS5097: An import path can only end with a '.ts' extension when
// 'allowImportingTsExtensions' is enabled`), and enabling that compiler flag
// project-wide to accommodate one import was judged riskier than a small,
// clearly-labeled, disclosed third copy of a list that already has TWO
// copies in this codebase by design (compare.ts's own, and the _shared
// module built for claim-recovery-scan). See
// docs/LEDGER_CORE_IMPLEMENTATION.md's "known limitations" for the explicit
// disclosure and recommended follow-up (a proper cross-runtime-safe shared
// package), out of scope for this focused change.
function isKnownInternalContract(address: string | null | undefined): boolean {
  if (!address) return false
  return KNOWN_INTERNAL_CONTRACTS_FALLBACK.has(address.trim().toLowerCase())
}

/** Deterministic ledger event identity, per docs/PHASE_1_SCHEMA_DESIGN.md §6. */
export function buildEventKey(
  chainId: string,
  txHash: string,
  logIndex: number | null,
  walletAddress: string,
  eventType: string,
): string {
  const logPart = logIndex === null || logIndex === undefined ? '' : String(logIndex)
  return `${chainId}:${txHash.toLowerCase()}:${logPart}:${walletAddress.toLowerCase()}:${eventType}`
}

/**
 * Converts a human-decimal number (chain_events stores `metadata.amount` as
 * a plain JS number, e.g. `5` for 5 USDC — confirmed against scanner.ts's
 * `metadata: { recipient, sender, amount }` shape) to an atomic-integer
 * string, WITHOUT floating-point multiplication. `value * 10 ** decimals`
 * is exactly the canonical-value risk the amount model (Phase 1) exists to
 * prevent; this shifts the decimal point as a string operation instead.
 */
export function toAmountAtomic(value: number, decimals: number): string {
  const fixed = value.toFixed(decimals)
  const [whole, frac = ''] = fixed.split('.')
  const paddedFrac = frac.padEnd(decimals, '0').slice(0, decimals)
  const combined = `${whole}${paddedFrac}`.replace(/^0+(?=\d)/, '')
  return combined || '0'
}

function senderOf(chainEvent: ChainEventInput): string | null {
  const meta = chainEvent.metadata
  if (!meta || typeof meta !== 'object') return null
  const raw = (meta as Record<string, unknown>).sender ?? (meta as Record<string, unknown>).from
  return typeof raw === 'string' ? raw.trim().toLowerCase() : null
}

function amountOf(chainEvent: ChainEventInput): number | null {
  const meta = chainEvent.metadata as Record<string, unknown> | null
  const raw = meta?.amount
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

// ── Token identity resolution (docs/LEDGER_IS_NATIVE_FIX.md) ───────────────
// Canonical invariant (must always hold on every emitted draft):
//   NATIVE: is_native = true  AND token_address = NULL
//   ERC20:  is_native = false AND token_address IS NOT NULL
// Never derived from token symbol, decimals, or "token_address happens to be
// missing" alone — see the doc for the real EURC transaction that exposed
// this exact bug when the naive `tokenAddress == null` rule was used.
//
// The reliable, always-present signal is `event_type`, confirmed directly
// against scanner.ts: 'deposit_detected' is emitted ONLY by the two native-
// scan branches (native top-level scan, native-transfer-log scan);
// 'transfer_detected' is emitted ONLY by the ERC-20 token loop (iterating
// chain.tokens — EURC/cirBTC on Arc). This is structural, not a heuristic —
// unlike token_address, which has a real historical gap for chain_events
// rows that predate the Phase 3 scanner's contract_address population fix.
const KNOWN_TOKEN_ADDRESSES_BY_SYMBOL: Readonly<Record<string, string>> = {
  EURC: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
  cirBTC: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
}

interface TokenIdentity { isNative: boolean; tokenAddress: string | null }

/**
 * Resolves the native/ERC20 identity for a chain_event, upholding the
 * invariant above in every case. Returns `null` when the identity cannot
 * be safely established — the caller must defer (`not_applicable`), never
 * guess or emit a draft that would violate the invariant.
 */
function resolveTokenIdentity(chainEvent: ChainEventInput): TokenIdentity | null {
  if (chainEvent.event_type === 'deposit_detected') {
    // Native path, by construction. token_address is always null here —
    // there is no contract, no log, for a native top-level/native-log
    // transfer (see docs/PHASE_3_INDEXER_AUDIT.md §6/§7).
    return { isNative: true, tokenAddress: null }
  }
  if (chainEvent.event_type === 'transfer_detected') {
    // ERC-20 path, by construction — NEVER native, regardless of whether
    // token_address happens to be populated on this particular row. This is
    // the exact fix for the EURC bug: the OLD code inferred native from
    // `token_address == null` alone, which is also true for historical
    // transfer_detected rows that simply predate the Phase 3 fix — event_type
    // alone already proves this is an ERC-20 event either way.
    if (chainEvent.token_address) {
      return { isNative: false, tokenAddress: chainEvent.token_address }
    }
    // token_address missing (historical row). Resolve from the same fixed,
    // public contract addresses already used throughout this codebase
    // (chains.ts, compare.ts, knownInternalContracts.ts) — not a guess, a
    // lookup of a known constant, gated on the symbol actually matching one
    // we recognize.
    const known = chainEvent.token_symbol ? KNOWN_TOKEN_ADDRESSES_BY_SYMBOL[chainEvent.token_symbol] : undefined
    if (known) {
      return { isNative: false, tokenAddress: known }
    }
    // Symbol also unrecognized — cannot safely establish the invariant.
    // Per "do not guess native", defer rather than emit an ambiguous draft.
    return null
  }
  // Unrecognized event_type — same reasoning, defer.
  return null
}


/**
 * The ordinary Pay case (also covers native transfers — see
 * docs/LEDGER_CORE_IMPLEMENTATION.md "Native Pay"). ONE confirmed
 * chain_event, whose metadata already carries both `sender` and
 * `recipient`/`to`, produces TWO ledger_events: a DEBIT for the sender's
 * wallet and a CREDIT for the recipient's wallet (the chain_event's own
 * `wallet_address`). Both share chain_id/tx_hash/log_index and differ only
 * on wallet_address — exactly the case the raw-movement identity constraint
 * is designed to permit.
 *
 * `correlatedIntent`, if supplied, must have `feature === 'pay'` — anything
 * else (including omitted, meaning no correlation was found) still produces
 * the plain DEBIT/CREDIT pair, since an ordinary Pay/external transfer needs
 * no intent to be classified correctly (unlike Swap). Passing a
 * `swap`-feature intent here is a caller error and returns
 * `not_applicable`, not a guess.
 */
export function classifyPayTransfer(
  chainEvent: ChainEventInput,
  correlatedIntent?: IntentContext | null,
): ClassificationOutcome {
  if (chainEvent.status !== 'confirmed') {
    return { outcome: 'unresolved', reason: `chain_event status is '${chainEvent.status}', not 'confirmed'` }
  }
  if (correlatedIntent && correlatedIntent.feature !== 'pay') {
    return { outcome: 'not_applicable', reason: `correlated intent has feature='${correlatedIntent.feature}', not 'pay' — use the matching classifier instead` }
  }

  const recipient = (chainEvent.wallet_address ?? '').trim().toLowerCase()
  const txHash = (chainEvent.tx_hash ?? '').trim().toLowerCase()
  const sender = senderOf(chainEvent)
  const amount = amountOf(chainEvent)

  if (!recipient || !txHash) return { outcome: 'not_applicable', reason: 'missing wallet_address or tx_hash' }
  if (!sender) return { outcome: 'not_applicable', reason: 'chain_event metadata has no sender/from — cannot derive the debit leg' }
  if (sender === recipient) return { outcome: 'not_applicable', reason: 'self-transfer — not a real payment' }
  if (amount === null) return { outcome: 'not_applicable', reason: 'chain_event metadata has no numeric amount' }

  // Priority 4 (known-internal-contract classification): a Pay-shaped
  // Transfer whose sender is a known internal contract is not an ordinary
  // Pay at all — almost certainly a swap output or similar, which this
  // classifier must not silently absorb as a plain CREDIT. Deferred, not
  // guessed — matches classifySwapCredit's own reasoning for the identical
  // sender set.
  if (!correlatedIntent && isKnownInternalContract(sender)) {
    return { outcome: 'not_applicable', reason: `sender ${sender} is a known internal contract — not an ordinary Pay transfer, deferred rather than guessed` }
  }

  const decimals = chainEvent.decimals ?? 6
  const amountAtomic = toAmountAtomic(amount, decimals)
  const identity = resolveTokenIdentity(chainEvent)
  if (!identity) {
    return { outcome: 'not_applicable', reason: `token identity could not be safely established for event_type='${chainEvent.event_type}' with no usable token_address/token_symbol — not guessing native vs ERC20` }
  }
  const { isNative, tokenAddress } = identity

  const debit: LedgerEventDraft = {
    transaction_intent_id: correlatedIntent?.id ?? null,
    transaction_attempt_id: null,
    wallet_address: sender,
    chain_id: chainEvent.chain_id,
    event_type: 'DEBIT',
    direction: 'debit',
    token_address: tokenAddress,
    token_symbol: chainEvent.token_symbol ?? null,
    decimals,
    amount_atomic: amountAtomic,
    is_native: isNative,
    tx_hash: chainEvent.tx_hash,
    block_number: chainEvent.block_number,
    log_index: chainEvent.log_index,
    event_key: buildEventKey(chainEvent.chain_id, txHash, chainEvent.log_index, sender, 'DEBIT'),
    metadata: {},
  }
  const credit: LedgerEventDraft = {
    transaction_intent_id: correlatedIntent?.id ?? null,
    transaction_attempt_id: null,
    wallet_address: recipient,
    chain_id: chainEvent.chain_id,
    event_type: 'CREDIT',
    direction: 'credit',
    token_address: tokenAddress,
    token_symbol: chainEvent.token_symbol ?? null,
    decimals,
    amount_atomic: amountAtomic,
    is_native: isNative,
    tx_hash: chainEvent.tx_hash,
    block_number: chainEvent.block_number,
    log_index: chainEvent.log_index,
    event_key: buildEventKey(chainEvent.chain_id, txHash, chainEvent.log_index, recipient, 'CREDIT'),
    metadata: {},
  }
  return { outcome: 'classified', drafts: [debit, credit] }
}

/**
 * SWAP_DEBIT — can ONLY be derived from a CONFIRMED transaction_attempt and
 * its transaction_intent (feature='swap'), never from a chain_event. See
 * types.ts's header comment for why: the swap router is never a monitored
 * wallet, so no chain_event ever captures the input leg. Returns
 * `not_applicable` for any non-swap feature or non-CONFIRMED attempt — this
 * module never guesses.
 */
export function classifySwapDebit(intent: IntentContext, attempt: AttemptContext): ClassificationOutcome {
  if (attempt.intent_id !== intent.id) return { outcome: 'not_applicable', reason: 'attempt/intent pair mismatch' }
  if (intent.feature !== 'swap') return { outcome: 'not_applicable', reason: `feature='${intent.feature}', not 'swap'` }
  if (attempt.status !== 'CONFIRMED') {
    return { outcome: 'unresolved', reason: `attempt status is '${attempt.status}', not 'CONFIRMED' — the confirmation rule forbids a ledger event here` }
  }
  if (!attempt.tx_hash) return { outcome: 'not_applicable', reason: 'CONFIRMED attempt has no tx_hash' }

  const draft: LedgerEventDraft = {
    transaction_intent_id: intent.id,
    transaction_attempt_id: attempt.id,
    wallet_address: intent.wallet_address,
    chain_id: attempt.chain_id,
    event_type: 'SWAP_DEBIT',
    direction: 'debit',
    token_address: intent.token_address,
    token_symbol: intent.token_symbol,
    decimals: intent.decimals,
    amount_atomic: intent.amount_atomic,
    is_native: intent.is_native,
    tx_hash: attempt.tx_hash,
    block_number: attempt.block_number,
    log_index: null, // no log — this leg is not derived from a log at all, see types.ts
    event_key: buildEventKey(attempt.chain_id, attempt.tx_hash, null, intent.wallet_address, 'SWAP_DEBIT'),
    metadata: {},
  }
  return { outcome: 'classified', drafts: [draft] }
}

/**
 * SWAP_CREDIT — the swap's output leg, derived from a confirmed chain_event
 * correlated (by tx_hash + chain_id) to a swap-feature transaction_intent.
 * `correlated` must be supplied by the caller (interpreter.ts), found via a
 * repository lookup — this function does no DB access itself.
 *
 * If NOT correlated but the sender is a known internal contract (the exact
 * signature of a swap output — e.g. the Kit Adapter router from the traced
 * EURC case), this returns `not_applicable`, NOT `classified` — see the
 * inline comment for why guessing here would be unsafe.
 */
export function classifySwapCredit(
  chainEvent: ChainEventInput,
  correlated: { intent: IntentContext; attempt: AttemptContext } | null,
): ClassificationOutcome {
  if (chainEvent.status !== 'confirmed') {
    return { outcome: 'unresolved', reason: `chain_event status is '${chainEvent.status}', not 'confirmed'` }
  }
  const wallet = (chainEvent.wallet_address ?? '').trim().toLowerCase()
  const txHash = (chainEvent.tx_hash ?? '').trim().toLowerCase()
  if (!wallet || !txHash) return { outcome: 'not_applicable', reason: 'missing wallet_address or tx_hash' }

  const sender = senderOf(chainEvent)
  if (sender && sender === wallet) return { outcome: 'not_applicable', reason: 'self-transfer' }

  if (correlated) {
    if (correlated.intent.feature !== 'swap') {
      return { outcome: 'not_applicable', reason: `correlated intent has feature='${correlated.intent.feature}', not 'swap'` }
    }
    const amount = amountOf(chainEvent)
    if (amount === null) return { outcome: 'not_applicable', reason: 'chain_event metadata has no numeric amount' }
    const decimals = chainEvent.decimals ?? correlated.intent.decimals
    const identity = resolveTokenIdentity(chainEvent)
    if (!identity) {
      return { outcome: 'not_applicable', reason: `token identity could not be safely established for event_type='${chainEvent.event_type}' with no usable token_address/token_symbol — not guessing native vs ERC20` }
    }
    const draft: LedgerEventDraft = {
      transaction_intent_id: correlated.intent.id,
      transaction_attempt_id: correlated.attempt.id,
      wallet_address: wallet,
      chain_id: chainEvent.chain_id,
      event_type: 'SWAP_CREDIT',
      direction: 'credit',
      token_address: identity.tokenAddress,
      token_symbol: chainEvent.token_symbol ?? null,
      decimals,
      amount_atomic: toAmountAtomic(amount, decimals),
      is_native: identity.isNative,
      tx_hash: chainEvent.tx_hash,
      block_number: chainEvent.block_number,
      log_index: chainEvent.log_index,
      event_key: buildEventKey(chainEvent.chain_id, txHash, chainEvent.log_index, wallet, 'SWAP_CREDIT'),
      metadata: {},
    }
    return { outcome: 'classified', drafts: [draft] }
  }

  // Uncorrelated known-internal-contract sender: strongly suggestive of a
  // swap output, but NOT classified as SWAP_CREDIT here. A SWAP_CREDIT with
  // no transaction_intent_id could never be paired with a SWAP_DEBIT (which,
  // per classifySwapDebit above, can ONLY come from a correlated intent) —
  // an unpaired SWAP_CREDIT would be a row the future Activity-grouping
  // design could never correctly group with its debit leg. Deferred, not
  // guessed — and NOT classified as generic CREDIT either, satisfying "do
  // not classify a swap output as generic RECEIVE" without fabricating an
  // incomplete SWAP_CREDIT.
  if (sender && isKnownInternalContract(sender)) {
    return { outcome: 'not_applicable', reason: `sender ${sender} is a known internal contract with no correlated transaction_intent — deferred` }
  }

  return { outcome: 'not_applicable', reason: 'no correlated swap intent and sender is not a known internal contract — not this classifier\'s concern (see classifyPayTransfer)' }
}

/**
 * BulkPay's DEBIT+CREDIT pair — docs/BULKPAY_LEDGER_CLASSIFICATION_AUDIT.md,
 * docs/BULKPAY_TRANSACTION_INTENT_IMPLEMENTATION_CHECKLIST.md §8.
 *
 * Structurally closer to classifyPayTransfer's shape (one function, one
 * chain_event in, a DEBIT+CREDIT pair out) than to classifySwapDebit/
 * classifySwapCredit's split shape — proven necessary, not assumed: each
 * recipient's DEBIT needs THAT recipient's own log_index/amount to keep the
 * multi-log identity model intact, and that data only exists on the
 * recipient's own chain_event, not on the attempt alone (unlike Swap, whose
 * single SWAP_DEBIT genuinely has no chain_event of its own — see types.ts's
 * header comment for that distinction).
 *
 * The one, critical difference from classifyPayTransfer: the DEBIT wallet
 * comes from `correlated.intent.wallet_address` (the real payer, recorded
 * server-side when the intent was created), NEVER from
 * `chainEvent.metadata.sender` — for a real BulkPay chain_event, that field
 * is Multicall3's own contract address, not the payer. Confirmed directly
 * against the real transaction 0xb179c4f0…'s chain_events row
 * (metadata.sender = 0xca11bde0…) in the prior audit session. Sourcing the
 * DEBIT from metadata.sender here would misattribute every DEBIT to
 * Multicall3 — a financial correctness bug, not a style choice.
 *
 * `correlated` is required (never optional) — this function must only ever
 * be called once a real transaction_intent (feature='bulkpay') and its
 * transaction_attempt have already been found via the caller's own
 * findAttemptByTxHash/getIntent lookups (interpreter.ts). There is no
 * "uncorrelated Multicall3 sender" fallback path here at all — that case is
 * classifyPayTransfer's existing, unchanged known-internal-contract
 * exclusion (still fires whenever no bulkpay correlation exists), not
 * anything this function decides. This is the exact security invariant:
 * Multicall3 sender + matching chain_id + matching tx_hash + a real,
 * verified transaction_attempt + transaction_intent.feature='bulkpay' — all
 * five, structurally required by this function only ever being reachable
 * once the caller has already established all five.
 */
export function classifyBulkPayCredit(
  chainEvent: ChainEventInput,
  correlated: { intent: IntentContext; attempt: AttemptContext },
): ClassificationOutcome {
  if (chainEvent.status !== 'confirmed') {
    return { outcome: 'unresolved', reason: `chain_event status is '${chainEvent.status}', not 'confirmed'` }
  }
  if (correlated.intent.feature !== 'bulkpay') {
    return { outcome: 'not_applicable', reason: `correlated intent has feature='${correlated.intent.feature}', not 'bulkpay'` }
  }

  const recipient = (chainEvent.wallet_address ?? '').trim().toLowerCase()
  const payer = (correlated.intent.wallet_address ?? '').trim().toLowerCase()
  const txHash = (chainEvent.tx_hash ?? '').trim().toLowerCase()
  const amount = amountOf(chainEvent)

  if (!recipient || !txHash) return { outcome: 'not_applicable', reason: 'missing wallet_address or tx_hash' }
  if (!payer) return { outcome: 'not_applicable', reason: 'correlated intent has no wallet_address — cannot derive the debit leg' }
  if (amount === null) return { outcome: 'not_applicable', reason: 'chain_event metadata has no numeric amount' }
  // A payer paying themselves via BulkPay is not a real economic transfer —
  // same reasoning as classifyPayTransfer's own self-transfer exclusion.
  if (payer === recipient) return { outcome: 'not_applicable', reason: 'self-transfer — payer wallet matches recipient wallet' }

  const identity = resolveTokenIdentity(chainEvent)
  if (!identity) {
    return { outcome: 'not_applicable', reason: `token identity could not be safely established for event_type='${chainEvent.event_type}' with no usable token_address/token_symbol — not guessing native vs ERC20` }
  }
  const decimals = chainEvent.decimals ?? correlated.intent.decimals
  const amountAtomic = toAmountAtomic(amount, decimals)

  const debit: LedgerEventDraft = {
    transaction_intent_id: correlated.intent.id,
    transaction_attempt_id: correlated.attempt.id,
    wallet_address: payer,
    chain_id: chainEvent.chain_id,
    event_type: 'DEBIT',
    direction: 'debit',
    token_address: identity.tokenAddress,
    token_symbol: chainEvent.token_symbol ?? null,
    decimals,
    amount_atomic: amountAtomic,
    is_native: identity.isNative,
    tx_hash: chainEvent.tx_hash,
    block_number: chainEvent.block_number,
    log_index: chainEvent.log_index,
    event_key: buildEventKey(chainEvent.chain_id, txHash, chainEvent.log_index, payer, 'DEBIT'),
    metadata: {},
  }
  const credit: LedgerEventDraft = {
    transaction_intent_id: correlated.intent.id,
    transaction_attempt_id: correlated.attempt.id,
    wallet_address: recipient,
    chain_id: chainEvent.chain_id,
    event_type: 'CREDIT',
    direction: 'credit',
    token_address: identity.tokenAddress,
    token_symbol: chainEvent.token_symbol ?? null,
    decimals,
    amount_atomic: amountAtomic,
    is_native: identity.isNative,
    tx_hash: chainEvent.tx_hash,
    block_number: chainEvent.block_number,
    log_index: chainEvent.log_index,
    event_key: buildEventKey(chainEvent.chain_id, txHash, chainEvent.log_index, recipient, 'CREDIT'),
    metadata: {},
  }
  return { outcome: 'classified', drafts: [debit, credit] }
}
