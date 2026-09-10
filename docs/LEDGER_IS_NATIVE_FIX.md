# Ledger `is_native` Classification Fix

Status: **Fixed and verified against real data. No production changes.** No migration applied,
no `ledger_events` inserted, no Activity/indexer/Pay/Swap/CCTP/BulkPay/P2P/UB code touched.

---

## 1. Exact real transaction that exposed the bug

`chain_events` id 103, tx `0xef6d341036fedf9f9b4e1eaf6d4cf3fd289bc7e50b35995199aa9bfb21c9c778`
— found and traced in `docs/LEDGER_REAL_DATA_SHADOW_VALIDATION.md` §5. Real row:
`event_type: 'transfer_detected'`, `wallet_address: '0x05d00ab7…'`,
`token_symbol: 'EURC'`, `token_address: null`, `log_index: null`, `block_number: null`,
`metadata: {to: '0x05d00ab7…', from: '0xd4c0b787…', amount: 20}`. Two further real
transactions (`0xb907e17f…`, `0x8583295f…`) exhibited the identical bug for the identical
reason.

## 2. Root cause — traced value → classifier → predicted event, not guessed

- **Source**: `chain_events.token_address` is `null` on this row **because it predates the
  Phase 3 scanner enhancement** that began populating `contract_address` on ERC-20 log-derived
  events (documented in `docs/PHASE_3_FIXES_APPLIED.md`) — not because the transfer is native.
- **Classifier**: `server/ledger/classifiers.ts`, two sites —
  `classifyPayTransfer` (was line 145: `const isNative = tokenAddress == null`) and
  `classifySwapCredit` (was line 332: `is_native: (chainEvent.token_address ?? null) == null`).
  Both computed nativity from `token_address == null` alone.
- **Predicted event**: since `token_address` was `null` on this row for the historical reason
  above, both sites incorrectly set `is_native: true` on the emitted `DEBIT`/`CREDIT` drafts,
  even though the underlying asset is EURC, a genuine ERC-20 token.

**Why EURC specifically**: EURC/cirBTC are the only two ERC-20 tokens this app watches
(`chains.ts`), and every real `transfer_detected` row that predates the Phase 3 fix has this
exact `token_address: null` shape — confirmed directly against the live data, not assumed.

## 3. Old behavior

```
tokenAddress = chainEvent.token_address ?? null   // null for this row
isNative = tokenAddress == null                    // true — WRONG
```
Produced `is_native: true` for a genuine ERC-20 transfer.

## 4. New behavior

`server/ledger/classifiers.ts` now derives native/ERC20 identity from a new
`resolveTokenIdentity()` function, keyed on `chain_events.event_type` — a structurally reliable
signal confirmed directly against `scanner.ts`: `'deposit_detected'` is emitted **only** by the
two native-scan branches; `'transfer_detected'` is emitted **only** by the ERC-20 token loop
(iterating `chain.tokens` — EURC/cirBTC). This is true regardless of whether `token_address`
happens to be populated on any given row, which is exactly what makes it the correct signal
where `token_address` itself has a real historical gap.

```
event_type === 'deposit_detected'  → { isNative: true,  tokenAddress: null }
event_type === 'transfer_detected' → { isNative: false, tokenAddress: chainEvent.token_address
                                          ?? KNOWN_TOKEN_ADDRESSES_BY_SYMBOL[token_symbol]
                                          ?? DEFER (not_applicable) }
anything else                      → DEFER (not_applicable)
```

`KNOWN_TOKEN_ADDRESSES_BY_SYMBOL` is a small, fixed, public map (`EURC` →
`0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`, `cirBTC` → `0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF`)
— the same, already-public, already-used-elsewhere-in-this-codebase (`chains.ts`, `compare.ts`)
contract addresses, used only as a **fallback lookup** when `token_address` is missing and
`event_type` has already proven the row is a genuine ERC-20 event. Not a guess: a correct
resolution of a known constant, gated on a symbol match.

**If the symbol also can't be matched** (or `event_type` is unrecognized): the classifier returns
`not_applicable` rather than emit a draft with an unresolved identity — the invariant (§5) can't
be established, so nothing is guessed.

## 5. Correct native/ERC20 invariant (as specified, now enforced by construction)

```
NATIVE: is_native = true  AND token_address = NULL
ERC20:  is_native = false AND token_address IS NOT NULL
```

`resolveTokenIdentity()` can only ever return one of: `{isNative: true, tokenAddress: null}`,
`{isNative: false, tokenAddress: <real address>}`, or `null` (defer). **There is no code path
that can produce `{isNative: false, tokenAddress: null}`** — the invalid state the old code could
silently create — confirmed by re-reading the function's every branch. This satisfies the
existing Phase 2 schema constraint (`ledger_events_token_identity_check`,
`CHECK (is_native = true OR token_address IS NOT NULL)`) by construction, with no schema change
needed (§9).

Preserved the existing established convention exactly as requested — this is not a new
invariant, it restates the one already defined in `docs/PHASE_1_SCHEMA_DESIGN.md` §13.2 and
enforced at the database level since the Phase 2 migration; the bug was that the *application
code* violated a constraint the *schema* already correctly enforced (retroactively confirmed:
this bug was never actually able to reach a live `ledger_events` table, since Phase 1/2 remain
unapplied — it was only ever visible in the shadow-validation script's in-memory output).

## 6. Files changed

- `server/ledger/classifiers.ts` — added `KNOWN_TOKEN_ADDRESSES_BY_SYMBOL`,
  `resolveTokenIdentity()`; replaced the naive `is_native` computation at both call sites
  (`classifyPayTransfer`, `classifySwapCredit`) with calls to it, adding a `not_applicable`
  return where identity can't be established.
- `server/ledger/classifiers.test.ts` — added 7 new regression tests (§8).

**No other file touched** — confirmed by file-timestamp diff before writing this report.
`ActivityService`, `blockchain-indexer`, `claim-recovery-scan`, `compare.ts`, `scanner.ts`, the
transaction state machine, and every other explicitly-listed-as-off-limits file are untouched;
none of them proved to be the root cause, so none needed to change.

## 7. Tests added

All 6 requested cases, plus one extra (unrecognized `event_type`):

1. Native token (`token_address=NULL`, `event_type='deposit_detected'`) → accepted as native,
   `token_address` stays `NULL`.
2. ERC20 with a real `token_address` → accepted as ERC20, invariant holds.
3. **The exact real EURC transaction** (`0xef6d3410…`, reconstructed verbatim from the real
   queried data) → `is_native: false`, `token_address` resolved to the real EURC contract
   address, never `true`.
4. ERC20 with 18 decimals → still correctly `is_native: false` (decimals never used as a
   signal).
5. ERC20 symbol `"USDC"` (a wrapped/ERC-20 USDC, hypothetically) → still `is_native: false` —
   symbol string never determines nativity, only `event_type` does.
6. Missing `token_address` **and** unrecognized symbol → `not_applicable`, not guessed as
   native.
7. (extra) Unrecognized `event_type` entirely → same deferral.

## 8. Real-data shadow result (before vs after)

Re-ran `scripts/ledger-shadow-validation.ts` (unmodified) against the same real transactions.

| TX (truncated) | Before | After |
|---|---|---|
| `0xef6d3410…` | `is_native: true`, `token_address: null` (WRONG) | `is_native: false`, `token_address: "0x89B50855…"` (correct) |
| `0xb907e17f…` | same wrong result | same fix |
| `0x8583295f…` | same wrong result | same fix |
| `0x1da14d88…` (native Pay) | `is_native: true`, `token_address: null` (already correct) | **unchanged** — still `is_native: true`, `token_address: null` |
| `0xafadc14e…` (native Pay) | already correct | **unchanged** |
| `0xed2868e6…` (Swap output, uncorrelated) | `not_applicable`, zero rows | **unchanged** — still `not_applicable`, zero rows |

**The previously identified EURC `LEDGER_CLASSIFICATION_GAP` has disappeared** — verified by
actually re-running the real code against the real data, not asserted. Native and Swap-deferral
behavior are confirmed byte-for-byte unchanged (no regression introduced for the cases that were
already correct).

## 9. Before/after classification (summary)

| Input shape | Before | After |
|---|---|---|
| `deposit_detected`, `token_address=null` | `is_native: true` | `is_native: true` (unchanged, was already correct) |
| `transfer_detected`, `token_address=<real>` | `is_native: false` | `is_native: false` (unchanged, was already correct) |
| `transfer_detected`, `token_address=null`, known symbol | `is_native: true` (**BUG**) | `is_native: false`, address resolved (**FIXED**) |
| `transfer_detected`, `token_address=null`, unknown symbol | `is_native: true` (**BUG**) | `not_applicable` (**FIXED** — defers instead of guessing) |

## 10. Full test results

- `classifiers.test.ts`: **30/30 passed** (23 pre-existing + 7 new).
- `interpreter.test.ts`: **12/12 passed**, unchanged, zero regressions.
- Full `npx vitest run`: **234/234 passed** (227 pre-existing baseline + 7 new — exact count
  requested, confirmed by actually running it, not estimated).
- `deno test` (`blockchain-indexer/`): **45/45 passed**, unaffected (this fix touched no Deno
  code at all).
- `npm run typecheck` (root): clean.
- `npm run typecheck:server`: clean.
- Real-data shadow re-validation: see §8 — the exact regression fixture (real EURC transaction)
  now produces the correct classification.

## 11. Any remaining gaps

Everything else documented in `docs/LEDGER_REAL_DATA_SHADOW_VALIDATION.md` remains **exactly as
it was**, untouched by this fix:

- No real multi-log transaction exists to validate against.
- All 87 `chain_events` rows remain `confirmed`-only; no real `pending`/`reorged`/non-confirmed
  data exists.
- Swap's `SWAP_DEBIT`/input leg remains architecturally unobservable from `chain_events` (the
  router is never a monitored wallet) — unrelated to `is_native`, not addressed here.
- UB remains **NOT VALIDATED** — no successful UB transaction exists in this database.
- `p2p-release-reconcile` still has zero cron jobs — an operational finding, not touched, per
  explicit instruction.

None of these are new. None were introduced or worsened by this fix. All were already known and
are restated here only for completeness, not re-investigated in this pass.

---

## Final verdict

# B. FIXED WITH OTHER KNOWN GAPS

The `is_native` classification bug is fixed and verified against the exact real transaction that
exposed it, plus two other real transactions sharing the same root cause — all now classify
correctly, confirmed by actually re-running the real interpreter code, not by inspection alone.
Zero regressions across 234 vitest tests, 45 Deno tests, and both typechecks.

**Not "A. FIXED — clean"**: the unrelated, previously-documented gaps (no multi-log data, no
non-confirmed-state data, Swap debit unavailable, UB unvalidated, P2P cron missing) all remain,
exactly as instructed to leave them. Calling this "clean" would misrepresent what was and wasn't
addressed.

---

**No production writes occurred.** No migration applied, no `ledger_events` inserted, no
Activity/balance/notification write, no deployment, no cron change, no CCTP/BulkPay/P2P/UB work.
Stopping here per your instructions.
