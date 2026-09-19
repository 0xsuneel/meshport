# BulkPay Ledger Classification Audit

Status: audit only. No code modified, no schema changed, no migration, no deployment, no
server/ledger/ file touched, no Activity change. Every claim below is traced against actual,
current repository code — not assumed or carried over from prior docs without re-verification.

---

## Summary finding, stated up front

The gap is not "unregistered BulkPay recipients get not_applicable." Re-verified directly
against server/ledger/classifiers.ts: the known-internal-contract exclusion in
classifyPayTransfer fires whenever !correlatedIntent — which is true for every BulkPay
chain_events row today, registered recipient or not, since no transaction_intent exists for
BulkPay at all. Recipient A (0xebe52519..., already registered, already live in production
chain_events since before the reconciliation work) would be deferred exactly the same way
recipient B is. The reconciliation work fixed chain_events completeness; it did not, and was
never meant to, change this. This audit also surfaces two related gaps not previously documented
(§9's P2P finding, and the CCTP-mint defense-in-depth finding in §1) — both disclosed, neither
fixed here.

---

## 1. How the Ledger can distinguish the six categories — current state, traced exactly

| Category | How it reaches (or doesn't reach) chain_events | How classifiers.ts distinguishes it today |
|---|---|---|
| CCTP mint | Never reaches chain_events at all — scanner.ts's isMintTransfer check (via decodeTransferLog.ts, shared with bulkpayReconcile.ts) excludes zero-address-sender transfers before insertion | No mint-specific logic exists in classifiers.ts at all (zero matches for address(0) handling). The Ledger relies entirely on the indexer's own upstream exclusion — a real, previously-undocumented gap, see §1a |
| Swap output | chain_events row, sender = Kit Adapter Contract (in KNOWN_INTERNAL_CONTRACTS_FALLBACK) | classifySwapCredit if correlated to a real feature='swap' intent -> SWAP_CREDIT; otherwise classifyPayTransfer's own internal-contract check defers it |
| BulkPay recipient | chain_events row, sender = Multicall3 (also in KNOWN_INTERNAL_CONTRACTS_FALLBACK) | Always deferred — no feature='bulkpay' correlation path exists anywhere. This is the gap this audit is about |
| P2P escrow release/refund | chain_events row, sender = the configured P2P escrow contract, if any | Cannot be distinguished at all today — see §1b, a second real gap found |
| Generic/external CREDIT | chain_events row, sender not in the known-internal list, no correlated intent | classifyPayTransfer -> CREDIT. Working correctly |
| Internal contract transfers (other) | chain_events row, sender in the static list, no correlated intent | Correctly deferred |

### 1a. CCTP mint — a real defense-in-depth gap, disclosed, not fixed

The Ledger's own classifiers never check for a zero-address sender. Today this is safe only
because scanner.ts (main scan) and bulkpayReconcile.ts (reconciliation) both independently
exclude mints before a chain_events row is ever created. Not exploitable today, but worth
naming: the Ledger currently trusts its inputs completely for this one case, unlike its
explicit, deliberate distrust of client-declared data everywhere else in its own design.

### 1b. P2P escrow — currently indistinguishable from generic CREDIT, a second real gap

classifiers.ts's isKnownInternalContract reads only the hardcoded
KNOWN_INTERNAL_CONTRACTS_FALLBACK set — it has no `extra` parameter, unlike the indexer-side
supabase/functions/_shared/knownInternalContracts.ts module (built during the Claim-Recovery
Sender Classification fix), which explicitly supports a caller-supplied `extra` list
specifically for the P2P escrow address. Even if a P2P_ESCROW_CONTRACT is configured today, the
Ledger's own classifier has no way to know about it. Not part of your specific ask, but directly
adjacent to it, worth flagging in the same pass.

---

## 2. BulkPay transaction_intent / transaction_attempt architecture — inspected, not assumed

'bulkpay' is already a valid, envisioned feature value — confirmed directly in the still-
unapplied Phase 1 migration's own CHECK constraint
(supabase/migrations/20260823060000_phase1_canonical_transaction_model.sql, line 31):
`CHECK (feature IN ('pay', 'receive', 'swap', 'multichain_transfer', 'multichain_claim',
'bulkpay', 'chatpay', 'p2p'))`. This was written during Phase 1, before any Ledger Core code
existed — BulkPay was always intended to be a first-class transaction_intents feature.

But nothing currently populates it. Confirmed by direct search: zero code anywhere writes to
transaction_intents/transaction_attempts. server/ledger/types.ts's own SupportedFeature union is
currently 'pay' | 'swap' only — narrower than the DB schema already allows.

Is there enough authoritative context today to classify Multicall3-originated transfers safely?
No — not without either (a) real transaction_intents/transaction_attempts rows (Architecture 1,
§10) or (b) a narrower, weaker substitute correlation (Architecture 2, §10). The sender address
(Multicall3) alone is not sufficient, for the reason in §9.

## 3. Can tx_hash safely correlate chain_events -> BulkPay intent -> recipient leg?

Mechanically, yes — the exact same mechanism already proven for Swap.
LedgerRepository.findAttemptByTxHash(chainId, txHash) (already built, already tested) is a plain
lookup by (chain_id, tx_hash), backed by a real unique index
(idx_transaction_attempts_chain_txhash, Phase 1). Extending this to BulkPay requires no new
correlation mechanism — only a real transaction_attempts row to correlate against.

One structural difference from Swap, worth naming explicitly: Swap's correlation is
1-intent : 2-events (one SWAP_DEBIT, one SWAP_CREDIT, same wallet). BulkPay's natural shape is
1-intent : N-events (one payer's intent, N distinct recipient CREDITs, N different wallets, all
sharing the same tx_hash but different log_index) — a fan-out, not a pair. Not a blocker, but a
genuinely different shape worth designing for deliberately.

## 4. Does BulkPay need a dedicated BULKPAY_CREDIT type, or is CREDIT architecturally correct?

Checked the actual schema, not assumed. ledger_events.event_type's CHECK constraint (Phase 1,
still unapplied, directly editable) currently allows: 'DEBIT', 'CREDIT', 'SWAP_DEBIT',
'SWAP_CREDIT', 'BRIDGE_BURN', 'BRIDGE_MINT', 'UB_DEPOSIT', 'UB_SPEND', 'ESCROW_LOCK',
'ESCROW_RELEASE', 'ESCROW_REFUND'. No BULKPAY_CREDIT exists.

Recommendation: reuse CREDIT, do not add a dedicated type — based on the schema's own existing
pattern. Every dedicated type that does exist marks a genuinely different state-machine shape:
Swap has two simultaneous legs of different tokens; Bridge/CCTP has a cross-chain burn+mint
settlement process; Escrow has a LOCK state where money is committed but not yet paid to anyone.
Pay and Receive — the closest economic analog to BulkPay — deliberately do not get their own
type; Receive is explicitly just CREDIT (confirmed in types.ts's own header comment). BulkPay's
economic shape is identical to Pay's — the existing precedent says reuse CREDIT, distinguished
downstream via transaction_intent_id -> feature='bulkpay' and/or metadata, not a new top-level
type.

## 5/6. Not relying on Activity or client-declared recipient data — carried forward, re-verified

Confirmed again: server/ledger/ has zero imports of ActivityService or any Activity-reading
code. Any proposed architecture in §10 is designed the same way the reconciliation work already
was — recipient/amount data always comes from chain_events (itself independently derived from a
real, server-verified receipt), never from activity, bulk_payments_received, or any
client-declared field beyond a tx_hash pointer.

## 7. Behavior under each specific condition

| Condition | Current behavior | Behavior under a corrected design (§10) |
|---|---|---|
| Recipient is registered | not_applicable (see Summary — never actually fixed by reconciliation) | CREDIT, correlated if an intent exists |
| Recipient is unregistered | not_applicable today at the Ledger layer; chain_events row now exists thanks to reconciliation | Same CREDIT outcome as a registered recipient — never depended on users.wallet_address |
| Multiple recipients | Each is an independent chain_events row -> each independently deferred today | Each independently classified — same correlation check applied per-row |
| One tx, multiple Transfer logs | Already correctly modeled as distinct raw movements | Unchanged; the fan-out shape (§3) is about how many CREDITs correlate to one intent |
| Same Multicall3 tx contains unrelated transfers | N/A today (nothing is ever un-deferred) | This is exactly why sender-address-alone is unsafe — see §9. Only a correlated tx_hash should be treated as MeshPort's own BulkPay |
| Retry/reconciliation runs twice | Ledger-layer idempotency already proven, unaffected by BulkPay specifically | Unchanged — inherits existing already_posted/conflict handling for free |

---

## 8. Real transaction: 0xb179c4f0691199d5a1fdfc49d5086cf587f5440b13c768629a2913f7f783714c

Already fully traced in docs/BULKPAY_INDEXER_FORENSIC_AUDIT.md and
docs/BULKPAY_RECONCILIATION_IMPLEMENTATION.md — restated precisely for this audit's question:

- Recipient A (0xebe52519..., registered, real chain_events row id 125): running this exact,
  real, already-live row through interpretConfirmedChainEvent today produces not_applicable —
  re-confirmed directly in this session by re-running
  scripts/ledger-bulkpay-reconciliation-proof.ts (unmodified) against it. This is the concrete
  proof behind this audit's opening summary finding.
- Recipient B (0x9171d4f0..., unregistered, reconciled chain_events row): same not_applicable
  outcome, same reason (sender 0xca11bde0... is a known internal contract).
- Swapping the sender to a hypothetical non-Multicall3 address (same script, prior session)
  correctly reaches CREDIT for the same unregistered wallet — isolating that registration status
  was never the variable; the Multicall3 sender-exclusion is.

## 9. Why NOT_APPLICABLE is correct under the existing rules — traced precisely, not asserted

classifyPayTransfer's priority order (unchanged): transaction_intent correlation first,
known-internal-contract classification as a fallback exclusion. For this transaction,
correlatedIntent is always undefined (no transaction_attempts row exists for this tx_hash —
table doesn't even exist in production). With no correlation, the classifier reaches its
known-internal-contract check, finds Multicall3 in KNOWN_INTERNAL_CONTRACTS_FALLBACK, and
defers.

Why this is the correct, not merely the current, behavior: Multicall3 (0xca11bde0...) is a
canonical, publicly-shared contract — the same deployed address is used by countless unrelated
applications and users across every EVM chain, not something exclusive to MeshPort's BulkPay
feature. Without a correlated intent, there is no way to distinguish "this Multicall3-sourced
transfer is MeshPort's own BulkPay batch" from "this Multicall3-sourced transfer is some
completely unrelated app/user's own use of the same shared contract, which happens to have paid
a MeshPort-registered wallet for a reason having nothing to do with BulkPay." Classifying every
Multicall3-sourced transfer as CREDIT unconditionally (the naive fix) would misattribute that
second, real, unrelated case as if it were a MeshPort BulkPay payment. Deferring is the only
currently-safe answer — the exact same principle already governing Swap's Kit Adapter Contract
exclusion, applied consistently, not a new or different rule invented for BulkPay.

---

## 10. Candidate architectures

### Architecture 1 — Full intent correlation (matches Swap's proven pattern exactly)

BulkPayoutPage.tsx migrates to create a real transaction_intents row (feature='bulkpay') before
broadcasting and a transaction_attempts row once broadcast — the same target architecture
already planned for every feature. A new, small classifier function (classifyBulkPayCredit,
mirroring classifySwapCredit's shape) checks: correlated to a feature='bulkpay' intent -> CREDIT
(§4), transaction_intent_id set to the payer's single intent for every one of the N recipient
legs (the fan-out shape from §3); no correlation even with a Multicall3 sender -> remains
not_applicable, preserving today's safety for genuinely unrelated Multicall3 usage exactly
as-is.

- Security: strongest — the only architecture that fully closes the "unrelated Multicall3 usage"
  risk (§9) with a real, on-chain-verifiable signal.
- State machine: fits the existing Phase 2 state machine without modification.
- Idempotency: inherits everything already proven — no new mechanism.
- Cost: the largest of the three — requires Phase 1 applied and BulkPayoutPage.tsx migrated to
  the state machine, both real, separately-scoped pieces of work already tracked elsewhere.

### Architecture 2 — Lightweight tx_hash correlation via bulk_payments (interim, no Phase 1 needed)

Reuse bulk_payments.tx_hash — already real, already populated, already used as
bulkpayReconcile.ts's own worklist pointer — as a narrow, additional correlation source specific
to BulkPay. The Ledger repository gains one new, small read (e.g. findBulkPaymentByTxHash); if a
bulk_payments row exists for this chain_event's tx_hash AND the sender is Multicall3, classify
as CREDIT (no transaction_intent_id, same as an ordinary external Pay credit has none). No
bulk_payments row -> remains deferred, identical to today.

- Security: meaningfully weaker than Architecture 1, but not a "trust client data as financial
  truth" violation (§5/§6) — bulk_payments.tx_hash is used exactly the same way
  bulkpayReconcile.ts already safely uses it: as a pointer, never as the source of
  recipient/amount data. The real residual risk is narrower and different in kind: a
  MISLABELING risk, not a fabrication risk — a fabricated bulk_payments row pointing at a real,
  unrelated Multicall3 transaction could cause that transaction's real transfer to be labeled as
  MeshPort's own BulkPay credit, even though the underlying money movement is itself completely
  real and independently verified.
- State machine: does not need transaction_attempts/transaction_intents at all.
- Idempotency: unaffected — the new read is a courtesy lookup, not a write.
- Cost: small — reuses infrastructure that is already live, no migration beyond what's already
  written (chain_events_verified_at, not yet applied), no BulkPayoutPage.tsx migration needed.

### Architecture 3 — Remove Multicall3 from the exclusion list (not recommended, included for comparison)

Simply drop 0xca11bde0... from KNOWN_INTERNAL_CONTRACTS_FALLBACK, letting every
Multicall3-sourced transfer fall through to plain CREDIT unconditionally.

- Security: directly reintroduces exactly the risk §9 describes — the least safe option, and
  inconsistent with the deliberate, already-established Swap precedent. Not recommended.
  Included only as the explicit "what not to do" baseline the other two are compared against.

### Recommendation

Architecture 1 is the correct long-term target — it is the only option that fully closes the
real security gap identified in §9, and it is not a new invention: it is exactly what Phase 1's
own feature enum already anticipated for BulkPay. Architecture 2 is a reasonable, explicitly
weaker interim step, if BulkPay Ledger coverage is wanted before the larger Phase 1/
BulkPayoutPage.tsx migration work happens — mirroring the exact same "ship a safe, narrower
interim now; the fully correct architecture is a separate, larger, already-tracked piece of
work" pattern this whole BulkPay effort has already used once (the reconciliation path itself
was framed identically). Architecture 3 should not be implemented under any circumstances — it
was evaluated only for completeness, per your request for 2-3 options.

---

## Recommended implementation plan (not started — design only, per your instructions)

1. Decide between Architecture 1 and Architecture 2 — a product/timeline decision, not a
   technical one this audit should make unilaterally.
2. If Architecture 2 is chosen as the interim step: extend LedgerRepository with
   findBulkPaymentByTxHash, add a small classifyBulkPayCredit (or extend classifyPayTransfer's
   own priority chain) using it, add the equivalent security test suite already proven for the
   reconciliation work (fabricated bulk_payments row -> mislabeling risk demonstrated and
   disclosed, not silently accepted; genuinely unrelated Multicall3 tx with no bulk_payments row
   -> still deferred).
3. If/when Architecture 1 becomes feasible (Phase 1 applied, BulkPayoutPage.tsx migrated):
   replace Architecture 2's narrower correlation with the full intent-based one — designed so
   this replacement doesn't require touching chain_events, the reconciliation path, or anything
   already proven; only the classifier's correlation source changes.
4. Separately, and not blocking either option above: close the two adjacent gaps found in §1a
   (CCTP mint defense-in-depth) and §1b (P2P escrow extra-list support in the Ledger's own
   classifier) — neither is part of this audit's specific ask, but both use the exact same
   mechanism this work would already be touching.

---

No code was modified in this audit. server/ledger/, the indexer, Activity, and every migration
remain exactly as they were before this pass. Stopping here for your review, per your
instructions.
