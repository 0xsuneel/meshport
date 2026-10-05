# Phase 3A — Indexer Audit

Status: descriptive audit of `supabase/functions/blockchain-indexer/`'s actual current
capabilities, cross-referenced against the live production database. This is the file several
code comments and the applied migration (`20260823080000_phase3_chain_events_identity_hardening.sql`)
cite as `docs/PHASE_3_INDEXER_AUDIT.md` — created now to match those citations, consolidating
facts already established across the Phase 3 forensic work
(`docs/PHASE_3_REAL_STATE_AUDIT.md`, `docs/PHASE_3_EVENT_COVERAGE_MATRIX.md`) rather than
re-deriving them.

**Read `docs/PHASE_3_REAL_STATE_AUDIT.md` first** — it establishes that this indexer is not
shadow-only; it is the live primary detection path, feeding `activity-consumer` every minute.
Everything below describes what it actually does, given that real state.

---

## 1. What events the indexer currently detects

Two `chain_events.event_type` values, both generic (not feature-specific):

- `deposit_detected` — native USDC, via two distinct scan paths (plain top-level value transfer,
  and the `0xffff…fffe` wrapper-routed native-transfer-log path).
- `transfer_detected` — ERC-20 `Transfer` logs on the two configured token contracts (EURC,
  cirBTC).

Full per-feature breakdown (CCTP, Unified Balance, BulkPay, P2P escrow, and exactly which of
these are/aren't covered, with contract addresses and computed event signatures) is in
`docs/PHASE_3_EVENT_COVERAGE_MATRIX.md` — not repeated here.

## 2. Which chains are covered

**Arc only**, live. `chains.ts` declares four additional chains (with real `confirmationDepth`
values of 12-128) but all four have `enabled: false` and `tokens: []` — present as configuration
scaffolding for future chains, not currently scanned.

## 3. Which contracts are covered

- EURC token contract, cirBTC token contract (ERC-20 `Transfer` log scan).
- The native-transfer-log contract `0xffffffffffffffffffffffffffffffffffffffffe` (wrapper-routed
  native USDC).
- Plain top-level native value transfers have no contract at all (`tx.to` checked directly
  against the known-wallet set).

Not covered by any contract-specific decoding: CCTP TokenMessenger/MessageTransmitter, any
Multicall3 awareness (BulkPay transactions are seen only incidentally, as generic Transfer logs
— see the coverage matrix), any Unified Balance contract, `P2PEscrow.sol`.

## 4. Which event signatures are decoded

Exactly one: `Transfer(address,address,uint256)`, topic0
`0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` — used identically for both
the ERC-20 token loop and the native-transfer-log loop. The native top-level-tx path decodes no
log at all (it isn't a log — a plain value transfer).

## 5. Confirmation depth per chain

Arc: `confirmationDepth = 0` — a block is eligible to become `'confirmed'` the moment it's seen
(`safeFrontier(head, 0) = head`). The four disabled chains have real depths configured (12-128)
for whenever they're enabled.

## 6. Chain event model — what `chain_events` retains

**As of this pass** (after `20260823080000_phase3_chain_events_identity_hardening.sql`, applied
to production — see `docs/PHASE_3_FIXES_APPLIED.md` for the deployment record):

| Column | Present before this migration | Present now |
|---|---|---|
| `chain_id`, `block_number`, `tx_hash`, `event_type`, `wallet_address`, `assets`, `metadata`, `status`, `created_at`, `confirmed_at`, `reorged_at` | Yes | Yes, unchanged |
| `log_index` | **No** | **Yes** (nullable — NULL for the native top-level-tx path, which has no log) |
| `contract_address` | **No** | **Yes** (nullable, same reason) |
| `event_signature` | **No** | **Yes** (informational, nullable) |
| `block_hash` | **No** | **Yes** (nullable, captured free from the RPC response already read) |
| `transaction_index` | **No** | **Yes** (nullable, same) |

`transaction_index`/`log_index` requested by the original brief as "minimum canonical fields" —
all now present. `decoded payload` = `metadata` (already existed, unchanged). Cursor information
deliberately stays in `chain_cursors`, not duplicated onto `chain_events`, per the "don't
duplicate information the existing schema already has" instruction.

## 7. Event identity / dedup behavior

**Before this pass**: `UNIQUE (event_type, chain_id, tx_hash, block_number)` — proven (locally,
then re-verified safe against live data with zero existing collisions) to silently drop an
entire same-batch INSERT for any transaction producing events to more than one distinct
recipient wallet (BulkPay/Multicall3-shaped), because `wallet_address` and `log_index` were both
absent from the identity.

**Now**: `UNIQUE (event_type, chain_id, tx_hash, wallet_address, COALESCE(log_index, -1)) WHERE
tx_hash IS NOT NULL` — verified via a real, reproducible before/after test (a 3-recipient
BulkPay-shaped batch insert that failed entirely under the old index and succeeded fully under
the new one), verified for cross-pass idempotency (an identical re-insert still collides
correctly), and verified for the native-scan path specifically (`log_index IS NULL` on both
sides of a repeat insert still collides correctly via the `COALESCE` sentinel). Full detail in
`docs/PHASE_3_FIXES_APPLIED.md`.

## 8. Reorg behavior

`chain_cursors.last_indexed_hash` mismatch detection is unchanged by this pass — not touched.
`chain_events.status` transitions `pending → confirmed` (per confirmation-depth) or
`pending → reorged` (`markEventsReorged`, `cursors.ts`) — **only ever from `pending`**. A row
that has already reached `'confirmed'` has no code path to become `'reorged'`. On Arc
(`confirmationDepth = 0`, and the codebase's own documented assumption of 1-confirmation
finality) this is not currently a live risk; flagged in
`docs/PHASE_3_REAL_STATE_AUDIT.md` §10 as something to address before any second chain (with a
nonzero confirmation depth) is enabled. Not touched in this pass — out of the three approved
fixes' scope.

## 9. Cursor behavior

Unchanged by this pass. `chain_cursors` (one row per chain, currently just `arc`) tracks
`last_indexed_block`/`latest_observed_block`/`sync_state`/`consecutive_failures`/`reorg_count`/
`last_success_at`/`last_error`. `cursorMath.ts`'s `safeAdvance` is the core safety property (a
failed chunk holds the cursor strictly below the failure, never skips it) — re-verified by the
existing `cursorMath.test.ts` suite, unchanged in this pass, still passing (9/9).

## 10. Duplicate handling

Within `chain_events`: the fixed unique index (§7). Within `activity` (the downstream credit
table): three writers (`activity-consumer`, `deposit-scan-all` reconcile, client-side
`ActivityService`) all converge on the same `UNIQUE (tx_hash, wallet_address)` identity via
`upsert(..., ignoreDuplicates: true)` — audited in full in
`docs/PHASE_3_REAL_STATE_AUDIT.md` §5/§9, unchanged by this pass (activity-consumer was
explicitly out of scope for these three fixes).

## 11. Retry behavior

Unchanged by this pass. `scanner.ts`'s `rpcCallRace` retries a closed whitelist of statuses
(429/500/502/503/504) with backoff, fails fast on anything else, and never advances
`safeUpTo` past a block it could not verify. Re-verified by the existing `scanner.test.ts` retry
tests, still passing.

## 12. What shadow comparison actually measures — now, after Fix 3/4

Before this pass, "FAIL" conflated three genuinely different situations: a real miss, an event
correctly accounted for under a different `activity_type`, and a one-sided result that just
hadn't propagated yet. After Fix 3/4 (`compare.ts`, `monitor.ts`), a comparison window now
reports six distinct pieces of information per the classification taxonomy in
`docs/PHASE_3_FIXES_APPLIED.md`: `RECEIVE_MATCH` (`matched`), `ACCOUNTED_FOR_OTHER_ACTIVITY`,
`TRUE_INDEXER_ONLY`, `WORKER_ONLY` (raw), `TIMING_DIFFERENCE`, and `NOT_COMPARABLE`. The
operationally meaningful number is `TRUE_INDEXER_ONLY`, not the raw `indexerOnly` total — see
`docs/PHASE_3_FIXES_APPLIED.md`'s shadow-observation guidance for what to actually watch going
forward.

## 11 (bis). What legacy workers detect that the new indexer does not

- CCTP burn/mint (claim lifecycle) — entirely `claim-worker`/`claim-recovery-scan`'s domain, by
  deliberate design on both sides (confirmed in `docs/PHASE_3_REAL_STATE_AUDIT.md` §5).
- P2P escrow `Deposited`/`Released`/`Withdrawn` as *specific, decoded* events — the indexer only
  incidentally sees the underlying Transfer, not the escrow semantics.
- Nothing else — `deposit-scan-all` sweep (native+ERC-20 primary scan) is disabled; reconcile
  mode only covers native USDC.

## 13. What the new indexer detects that legacy workers do not

- ERC-20 (EURC/cirBTC) deposits are **only** detected by the indexer today — `deposit-scan-all`
  reconcile mode does not scan tokens at all (confirmed in `docs/PHASE_3_REAL_STATE_AUDIT.md`
  §6). This is the single largest net-new detection capability, and also the single largest
  current risk (§14 of the real-state audit — zero legacy backstop for tokens).
