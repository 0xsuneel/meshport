# Ledger Raw Identity Fix

Status: **Implemented and validated against real Postgres. Not applied to production** (Phase 1
itself remains unapplied — confirmed below). Schema change only — no Ledger Interpreter code,
no `ledger_events` row created anywhere.

---

## Original vulnerability

`ledger_events`' only uniqueness constraint, as designed in the (still unapplied) Phase 1
migration, is `UNIQUE (event_key)`, where `event_key` is an application-constructed string of
the form `"{chain_id}:{tx_hash}:{log_index}:{wallet_address}:{event_type}"`. Because
`event_type` is baked into that string, two rows describing the **identical raw blockchain
movement** — same `chain_id`, `tx_hash`, `log_index`, `wallet_address` — but classified under two
**different** `event_type` values (e.g. one correctly `SWAP_CREDIT`, one incorrectly generic
`CREDIT` because a classification pass disagreed with a previous one, or two concurrent passes
raced to different conclusions) produce two **different** `event_key` strings. `UNIQUE(event_key)`
sees no conflict between them at all — both would insert successfully, silently double-posting a
single real financial movement into the ledger.

## Exact constraint

```sql
CREATE UNIQUE INDEX IF NOT EXISTS ledger_events_raw_movement_key
  ON public.ledger_events (chain_id, tx_hash, COALESCE(log_index, -1), wallet_address)
  WHERE tx_hash IS NOT NULL;
```

Folded directly into the existing, still-unapplied
`supabase/migrations/20260823060000_phase1_canonical_transaction_model.sql` — no separate,
redundant migration file created, per your instructions.

## Why `wallet_address` is required

One `Transfer` log legitimately produces **two** `ledger_events` rows: a `DEBIT` for the sender's
wallet and a `CREDIT` for the recipient's wallet — both share `chain_id`, `tx_hash`, and
`log_index`. Omitting `wallet_address` from this index would have made those two, entirely
legitimate rows collide with each other, which would have been the wrong fix. Including it
means the index only ever catches the actual bug class: the **same** wallet's **same** leg of
the **same** log being interpreted twice — never a genuine debit/credit pair.

## Why `log_index NULL` needs `COALESCE`

The native top-level-transfer scan path (a plain value transfer read directly from a block's
transaction list, not from a log) has no log at all — `log_index` is legitimately `NULL` for
every row on that path. Postgres's default behavior treats every `NULL` as distinct from every
other `NULL` for uniqueness purposes, which would silently defeat this guard for exactly that
path: two rows for the same wallet's same native-transfer tx, both with `log_index IS NULL`,
would **not** be seen as conflicting by a plain (non-`COALESCE`) index. `COALESCE(log_index, -1)`
gives every native-path row the same sentinel value, restoring the guard for that path too. This
mirrors the identical, already-proven pattern used for `chain_events_dedup_idx`
(`20260823080000_phase3_chain_events_identity_hardening.sql`), which solved the same class of
problem one layer below this one.

---

## Test results (actually run against real Postgres, not reasoned about)

All 8 required scenarios, executed against a fresh Postgres 16 instance with the exact
`ledger_events` column shape from the migration file:

| # | Scenario | Expected | Actual |
|---|---|---|---|
| 1 | Same tx + log + wallet, `SWAP_CREDIT` | Succeeds | ✅ `INSERT 0 1` |
| 2 | Same tx + log + wallet, `CREDIT` (the exact vulnerability) | **Must fail** | ✅ `ERROR: duplicate key value violates unique constraint "ledger_events_raw_movement_key"` |
| 3 | Same tx + log, different wallet, `DEBIT` | Succeeds | ✅ `INSERT 0 1` |
| 4 | Same tx + log, different wallet, `CREDIT` | Succeeds | ✅ `INSERT 0 1` |
| 5 | Native event, `log_index = NULL`, duplicate same wallet | **Must fail** | ✅ `ERROR: duplicate key value violates unique constraint "ledger_events_raw_movement_key"`, key shown as `(..., -1, 0xwallet4)` — confirms the `COALESCE` sentinel is what caught it |
| 6 | Same native tx, different wallet | Succeeds | ✅ `INSERT 0 1` |
| 7 | Different `log_index`, same tx/wallet | Succeeds | ✅ `INSERT 0 1` |
| 8 | Retry/upsert of an identical ledger event | Idempotent | ✅ `INSERT 0 0` via `ON CONFLICT (event_key) DO NOTHING`; confirmed exactly 1 row exists for that `event_key` afterward |

**8/8 passed, exactly as required.** No production data was created — all tests ran against a
disposable scratch database, dropped immediately after.

**Additional validation beyond the 8 required scenarios**, since the constraint was folded into
an existing multi-table migration rather than added standalone:

- Applied the **full** updated Phase 1 migration (all 4 tables, all triggers, all RLS, the link
  columns on `activity`/`claims`/`multichain_transactions`) end-to-end against a scratch database
  stubbed with the relevant pre-existing tables (`auth.users`, `activity`, `claims`,
  `multichain_transactions`) — applied cleanly, zero errors.
- **Re-ran the same migration a second time** — confirmed idempotent (`IF NOT EXISTS`/`NOTICE:
  already exists, skipping` throughout, no errors).
- **Applied Phase 2 on top** (`20260823070000_phase2_token_identity_and_notification_key.sql`) —
  applied cleanly, confirming the new index doesn't conflict with Phase 2's own changes
  (`is_native` columns, the notification dedup-index fix).
- Queried `pg_indexes` afterward and confirmed both `ledger_events_event_key_key` and the new
  `ledger_events_raw_movement_key` are present together, as intended (this is an *additional*
  guard, not a replacement for `event_key`'s own uniqueness).

---

## Production status

**Not applied.** Confirmed directly via `list_migrations` against the live `MeshPort` project
before making any change: the most recent applied migration is
`20260823061220_phase3_chain_events_identity_hardening` — neither the original Phase 1
migration nor this fix have been deployed. This fix exists only in the local, still-unapplied
migration file, exactly matching the state your instructions described and asked to be
confirmed before proceeding.

## Migration status

- **File modified**: `supabase/migrations/20260823060000_phase1_canonical_transaction_model.sql`
  (the existing Phase 1 file — the new index and its `COMMENT ON INDEX` were inserted directly
  after the existing `idx_ledger_events_txhash` index, immediately before the
  `transaction_intents`/`transaction_attempts` trigger-function section).
- **No new migration file created** — per your explicit instruction not to create a redundant
  migration while Phase 1 itself remains unapplied.
- **No migration applied to production** in this pass.

---

## Report

**Files changed**: exactly one — `supabase/migrations/20260823060000_phase1_canonical_transaction_model.sql`
(the new index + its documentation comment added), plus this new file,
`docs/LEDGER_RAW_IDENTITY_FIX.md`. Nothing else.

**Migrations applied/not applied**: not applied — confirmed via `list_migrations` before and
implicitly reconfirmed after (no `apply_migration` call was made in this pass at all).

**Tests**: 8/8 required scenarios passed, plus 3 additional validation steps (full-migration
apply, re-run idempotency, Phase 2 stacking) — all against a real, disposable Postgres instance,
all results shown above verbatim, not summarized from memory.

**Typecheck**: not applicable — this change is SQL-only, no TypeScript/Deno files were touched.

**Exact SQL**: reproduced in full above ("Exact constraint").

**Any unexpected findings**: none. The fix behaved exactly as designed on every test — no
surprises, no need to revise the approach mid-validation (unlike, for example, the BulkPay
fix's residual-race test in an earlier phase, which did surface a real design refinement along
the way — this one didn't need one).

---

**Stopping here per your instructions.** Not building the Ledger Interpreter in this same
change. Proceeding to Step 2 (Ledger core + Pay + Swap) only after this report, as a separate,
focused change.
