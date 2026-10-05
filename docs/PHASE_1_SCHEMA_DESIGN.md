# Phase 1 — Canonical Transaction Data Model: Schema Design

Status: design + migration only. **No application code changed. No production writers
redirected. No existing behavior changed.**

---

## 1. Existing table audit

The base schema (`activity`, `transactions`, `multichain_transactions`, `users`, `wallet_vault`,
`p2p_trades`, `p2p_offers`, etc.) predates the `supabase/migrations/` history in this repo (no
`CREATE TABLE` for them exists in any tracked migration — they were created before migration
tracking began). Their columns below are reconstructed from actual `.from()`/`.select()`/
`.insert()`/`.upsert()` call sites in the codebase, not from a DDL dump, and are believed
accurate but should be spot-checked against the live schema before Phase 1's migration is
applied to production (`scripts/audit-supabase-state.sql` is the right tool for that — it
already does exactly this kind of live-vs-expected check for the indexer tables).

| Table | Purpose today | Columns observed | Decision |
|---|---|---|---|
| `activity` | Read-facing history feed; also today's write target for financial events, populated directly by feature pages | `id, user_id, wallet_address, tx_hash, destination_tx_hash, activity_type, source_chain, destination_chain, token_symbol, token_address, amount, arrived_amount, usd_value, counterparty_address, status, metadata, created_at, updated_at` + `UNIQUE(tx_hash, wallet_address)` | **EXTEND** — add two nullable link columns (`transaction_intent_id`, `ledger_event_id`) now so Phase 14's projection cutover doesn't need another migration. No behavior change: nothing populates these columns yet. |
| `transactions` (`api/transactions.ts`) | Ad hoc send/receive record cache, written directly by the client via an unauthenticated Vercel function | `id, type, status, amount, usd_value, sender_address, receiver_address, tx_hash, note, fee` | **DEPRECATE LATER** — superseded by `transaction_intents` + `ledger_events` + the `activity` projection. Confirmed in this pass: **both GET and POST are wallet-address-only, unauthenticated** (POST does an `on_conflict=id` upsert with no ownership check at all — anyone can write a transaction record attributing any amount to any two addresses). This is a second concrete instance of the P0 finding from the Phase 0 audit, now confirmed for POST as well as GET. Not fixed in Phase 1 (schema-only phase); carried into the Phase 16 remediation list. |
| `multichain_transactions` | Loose cross-device cache for claim/deposit/bridge/swap history; `type='swap'` rows repurpose `source_chain`/`dest_chain` to mean `tokenIn`/`tokenOut` and stuff `amountOut`/`status` into a JSON string in `note` | `tx_hash, wallet_address, type, amount, source_chain, dest_chain, note, created_at` + `UNIQUE(tx_hash)` | **EXTEND** — add the same nullable `transaction_intent_id` link column. **DEPRECATE LATER** as the primary store once `ledger_events` + `activity` projection cover claim/deposit/bridge/swap (Phases 4/9/10/11). The column-repurposing (`source_chain`/`dest_chain` meaning tokens for swaps) is exactly the kind of ambiguity `ledger_events`'s explicit `token_address`/`token_symbol` + `source_chain`/`destination_chain` fields are designed to remove. |
| `claims` | Multichain Claim's real server-owned state machine (`submitted → bridging → verifying → completed/failed`), driven only by `claim-worker` | `id, user_id, wallet_address, source_chain, amount, tx_hash, bridge_tx_hash, message_hash, destination_tx_hash, arc_balance_before, attempts, error, status, completed_at, created_at, updated_at` + `UNIQUE(tx_hash)` | **KEEP** the state machine as-is (per the brief: "the existing claim worker is valuable... keep its server-side state machine"). **EXTEND** with one nullable `transaction_intent_id` link column so a future ledger/notification wiring (Phase 11) can join back to the canonical intent without restructuring this table. Its own `status` values stay authoritative for claim progress; they are not replaced by `transaction_intents.status`. |
| `chain_events` / `chain_cursors` / `indexer_config` / `indexer_shadow_reports` | Shadow-mode blockchain indexer (Phase 0 audit, §5) | (unchanged — see prior migrations) | **KEEP**, untouched in Phase 1. `ledger_events` is designed to be *populated from* `chain_events` once the indexer goes authoritative (Phase 3/4) — see §6 (event identity) below for how the two line up. No migration needed today. |
| `notifications` | Existing P2P bell/notification-center feed, populated **only** by a `SECURITY DEFINER` trigger on `p2p_trades` | `id, user_id (text), type, title, message, trade_id, read, created_at` | **KEEP**, untouched. This table's `user_id` is `text` (matching `p2p_trades.buyer_id`/`seller_id`), it is P2P-specific, and it is already correctly designed as a trigger-fed, deny-direct-write table — the exact pattern being generalized here. New `notification_events` (below) is a **separate, more general, idempotent domain-event log** for all features; a later phase (15) can either keep both (P2P keeps its own fast path; other features feed the bell via `notification_events` → a consumer that inserts into `notifications`) or unify them. Not decided now — no reason to decide it before Phase 15 needs an answer. |
| `p2p_trades`, `p2p_offers`, `p2p_trade_audit_log`, escrow contracts | P2P trade + escrow domain | (unchanged) | **KEEP, untouched in Phase 1.** P2P's trade-state-vs-escrow-state split (Phase 13 of the brief) is a genuinely distinct design problem — deciding its intent/ledger linkage now, before that design pass, risks exactly the "duplicate/competing model" the brief warns against. Deferred to Phase 13 by choice, not oversight. |
| `users`, `wallet_vault`, `wallet_audit_log` | Auth/identity, custodial wallet storage | (unchanged) | **KEEP**, untouched — explicitly out of scope ("do not modify wallet-key in Phase 1"). |

**Why no new table duplicates an existing concept:** `claims` already *is* a
transaction-attempt-shaped state machine for one feature; `multichain_transactions` and
`transactions` already *are* lightweight, ad hoc ledger caches. None of them is being
duplicated — `transaction_intents`/`transaction_attempts`/`ledger_events` are the thing all
three of those tables were informally, inconsistently trying to be, generalized into one place,
with the older tables kept alive (read/write unchanged) until each feature phase migrates and
Phase 16 removes them.

---

## 2. Final ERD (Phase 1 additions only)

```
transaction_intents (new)
  id (pk)
  user_id ──────────────► auth.users.id (nullable — wallet-only users may have no auth row)
  wallet_address                                    [true financial identity]
  feature / operation
  idempotency_key         UNIQUE (wallet_address, idempotency_key)
  status                  DRAFT|REVIEWED|AUTHORIZING|SUBMITTED|CONFIRMED|FAILED|CANCELLED|EXPIRED
  amount_atomic numeric(78,0) / decimals / token_address / token_symbol
  source_chain / destination_chain
  recipient_address / recipient_username
  metadata jsonb
  failure_code / failure_message
  created_at / updated_at / completed_at
        │ 1
        │
        ▼ N
transaction_attempts (new)
  id (pk)
  intent_id ────────────► transaction_intents.id  ON DELETE CASCADE
  chain_id / tx_hash      UNIQUE (chain_id, tx_hash) WHERE tx_hash IS NOT NULL
  nonce
  status                  CREATED|BROADCASTING|SUBMITTED|UNKNOWN|CONFIRMING|CONFIRMED|REVERTED|DROPPED|REPLACED
  submitted_at / confirmed_at / block_number / gas_used / gas_price
  failure_code / failure_message
  created_at / updated_at
        │ 0..1                                  ▲
        │                                        │ transaction_attempt_id (nullable)
        ▼                                        │
ledger_events (new) ───────────────────────────────
  id (pk)
  transaction_intent_id ─► transaction_intents.id  ON DELETE SET NULL
  transaction_attempt_id ► transaction_attempts.id ON DELETE SET NULL
  wallet_address / chain_id
  event_type               DEBIT|CREDIT|SWAP_DEBIT|SWAP_CREDIT|BRIDGE_BURN|BRIDGE_MINT|
                            UB_DEPOSIT|UB_SPEND|ESCROW_LOCK|ESCROW_RELEASE|ESCROW_REFUND
  direction                 debit|credit
  token_address / token_symbol / decimals / amount_atomic numeric(78,0)
  tx_hash / block_number / log_index
  event_key                 UNIQUE  — see §6
  settlement_status          PENDING|POSTED|REVERSED
  metadata jsonb
  created_at

notification_events (new)
  id (pk)
  user_id ──────────────► auth.users.id (nullable, same reason as above)
  wallet_address                                    [fallback identity when user_id is null]
  transaction_intent_id ─► transaction_intents.id  ON DELETE SET NULL
  event_key                 UNIQUE (user_id, event_key) — see §6 for the wallet-address fallback
  event_type
  payload jsonb
  created_at / delivered_at

-- Additive link columns on existing tables (all nullable, all default NULL, zero behavior change):
activity.transaction_intent_id ─────► transaction_intents.id  ON DELETE SET NULL
activity.ledger_event_id ────────────► ledger_events.id        ON DELETE SET NULL
claims.transaction_intent_id ───────► transaction_intents.id  ON DELETE SET NULL
multichain_transactions.transaction_intent_id ► transaction_intents.id ON DELETE SET NULL
```

---

## 3. State model (three independent status fields, per the brief)

**Why separate:** an intent can be `SUBMITTED` while its attempt is `UNKNOWN` (RPC timeout after
broadcast) and its ledger events are still `PENDING` (not yet at confirmation depth) — three
different, legitimately-independent axes. Overloading one field can't represent that.

- **`transaction_intents.status`**: `DRAFT → REVIEWED → AUTHORIZING → SUBMITTED → CONFIRMED`,
  or `→ FAILED` / `→ CANCELLED` (user backed out before signing) / `→ EXPIRED` (e.g. a swap
  quote that was never acted on). `DRAFT` and `CANCELLED`/`EXPIRED` are added beyond the four
  states given in the brief's example because real flows need "not yet reviewed" and "abandoned
  before submission" states; `AUTHORIZING`/`SUBMITTED`/`CONFIRMED`/`FAILED` are exactly as
  specified.
- **`transaction_attempts.status`**: the full 9-state set from the brief verbatim —
  `CREATED, BROADCASTING, SUBMITTED, UNKNOWN, CONFIRMING, CONFIRMED, REVERTED, DROPPED, REPLACED`.
  One intent can have multiple attempts (e.g. a replaced/sped-up transaction, or a retried
  broadcast after a `DROPPED` attempt) — this is exactly why attempts are their own table, not a
  column on intents.
- **`ledger_events.settlement_status`**: `PENDING → POSTED`, or `→ REVERSED` on a detected reorg.
  A ledger event should only ever reach `POSTED` once the underlying chain activity is past the
  relevant chain's `chain_cursors.confirmation_depth` — this policy lives in the future
  reconciler (Phase 3/4), not in this schema; the schema just gives it a place to record the
  decision.

No column in any of these three tables is derived from or overloaded with another table's
status. A future "is this transaction done, from the user's point of view" answer is a
join/derivation across all three, not a single flag.

---

## 4. Idempotency strategy

`UNIQUE (wallet_address, idempotency_key)` on `transaction_intents`, **not**
`(user_id, idempotency_key)` as literally suggested in the brief. Reason: `user_id` is nullable
here (many MeshPort accounts are wallet-only with no `auth.users` row — the same fact already
documented in the `wallet-key` function and in `claims.user_id`, which is nullable for the same
reason). Postgres treats every `NULL` as distinct for uniqueness purposes, so
`UNIQUE(user_id, idempotency_key)` would **silently fail to prevent duplicate intents for any
wallet-only user** — the exact bug class this constraint exists to prevent. `wallet_address` is
NOT NULL on every intent (per the brief's own principle: "wallet address is financial identity")
and is therefore the correct, always-present column to key on. `user_id` is kept as a nullable
FK for convenience joins where it exists, but is not part of the idempotency guarantee.

The client generates `idempotency_key` (e.g. a UUID per user action) before creating an intent;
a double-click that races two `INSERT`s for the same `(wallet_address, idempotency_key)` will
have the second insert rejected by Postgres at the database level, not by client-side debouncing.

---

## 5. Ledger event identity ("event_key") strategy

Format, chosen per event class:

- **On-chain events with a decodable log** (`Transfer`, CCTP burn/mint, escrow events, Multicall3
  legs): `event_key = "{chain_id}:{tx_hash}:{log_index}:{wallet_address}:{event_type}"`. This
  is the strongest available identity and is exactly what the brief specifies. `log_index`
  disambiguates the multiple-`Transfer`-logs-in-one-tx case explicitly called out (BulkPay:
  N recipients in one Multicall3 tx, each producing its own log).
- **On-chain events without a natural log index** (e.g. a native-currency internal transfer, or
  a synthetic event the indexer constructs rather than decodes 1:1 from a log):
  `event_key = "{chain_id}:{tx_hash}:{wallet_address}:{event_type}:{sequence}"` where `sequence`
  is a small integer disambiguating same-tx/same-wallet/same-type events that share no log index
  (defaults to `0`).
- **Off-chain-triggered ledger events that don't yet have a tx_hash** (e.g. an `ESCROW_LOCK`
  recorded the moment a P2P deposit is *submitted*, before confirmation — should this ever be
  needed): `event_key = "{transaction_attempt_id}:{event_type}"`. Not used by anything in Phase
  1 (no writers exist yet); documented so a future phase doesn't invent an incompatible scheme.

`event_key` is `UNIQUE NOT NULL` — this is the single dedup guard the brief asks for ("do not
rely only on tx_hash"). `(chain_id, tx_hash, log_index, wallet_address, event_type)` is *not*
also declared as a separate multi-column unique constraint, to avoid two overlapping uniqueness
mechanisms; `event_key` is deterministically built from exactly those fields (see above), so one
constraint enforces both.

---

## 6. Reorg strategy

- A `ledger_event` is inserted as soon as the indexer sees the underlying event (mirroring
  `chain_events.status = 'pending'`), with `settlement_status = 'PENDING'`.
- It is promoted to `settlement_status = 'POSTED'` only once the corresponding `chain_events` row
  reaches `status = 'confirmed'` (i.e. past that chain's `confirmation_depth`) — this transition
  is reconciler logic (Phase 3/4), not enforced by this migration; the schema just provides the
  state to transition into.
- If the indexer later marks the source `chain_events` row `'reorged'`, the matching
  `ledger_event` transitions to `settlement_status = 'REVERSED'` — **never deleted**, so the
  audit trail ("why did this balance briefly show X and then not") survives, matching the
  brief's own reasoning for why `chain_events` marks-not-deletes.
- `event_key` remains valid and unique for the reversed row. If the same transfer is later
  re-included (different block, but typically the *same* `tx_hash` for a simple reorg-and-
  reincluded case), the natural key doesn't change, so the reconciler's job is to flip the
  existing row's `settlement_status` back rather than insert a second one. If a transaction is
  dropped and the user broadcasts a genuinely new one (new `tx_hash`), that's a new
  `transaction_attempt` and a new `event_key` by construction — no collision.
- Downstream effect (for future phases, not implemented now): **Activity projection** should
  only render a ledger event once `POSTED` (or explicitly show a `PENDING` badge, never silently
  show `REVERSED` events as normal history without a "this was reversed" indicator). **Balance
  cache** must never sum `PENDING` or `REVERSED` events into a "confirmed" balance figure — only
  `POSTED`. **Notifications** must not fire off a `PENDING` ledger event — `notification_events`
  should be created only for `POSTED` events (or explicitly for reversal, as its own event type),
  so a user is never told a payment "arrived" only for it to be reorged away.

---

## 7. RLS strategy

All four new tables get `ENABLE ROW LEVEL SECURITY` with **no permissive policy created in this
migration** — i.e. deny-by-default for `anon`/`authenticated`, and `service_role` retains its
usual bypass. This is intentionally more conservative than the brief's minimum ask
("the client should not be able to insert **confirmed** financial ledger events" — Phase 1 goes
further and denies all direct client access to all four tables, full stop).

Why not design real per-wallet `SELECT` policies right now: this app's own migration history
documents that `auth.uid()` is **not reliably present or matching** for a meaningful fraction of
real sessions (anon-key REST calls, social-login users) — see the `p2p_notifications_system`
migration's explicit comment, and `wallet-key`'s own `auth_uid` vs `public.users.id` drift bug.
Every existing table in this app that needs real access control (`claims`, `notifications`)
either restricts to `service_role` for writes with `USING (true)` for reads (accepting that the
access boundary is "which code path can even reach this table," not per-row RLS), or is written
exclusively by a `SECURITY DEFINER` trigger. Copying the wide-open-read pattern onto tables that
will hold **raw financial ledger data** (not P2P trade metadata) is the wrong default. Since
*nothing in the client reads or writes these tables yet* (no feature has been migrated — that's
Phases 2–13), there is no cost to deferring the read-policy decision until the first feature
that actually needs it (Pay, Phase 6/7) can design the correct scoping against real, working
auth resolution — the same server-side `supabase.auth.getUser(jwt)` → `public.users.id`
resolution `wallet-key` already does correctly — rather than guessing now and needing another
migration later. This is called out explicitly as a Phase 2+ decision, not deferred silently.

Concretely, this migration:

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `transaction_intents` | service_role only (no policy for anon/authenticated) | service_role only | service_role only | service_role only |
| `transaction_attempts` | service_role only | service_role only | service_role only | service_role only |
| `ledger_events` | service_role only | service_role only | service_role only | service_role only |
| `notification_events` | service_role only | service_role only | service_role only | service_role only |

`REVOKE ALL ON <table> FROM anon, authenticated` is issued explicitly for each, mirroring the
existing `notifications` table's `REVOKE INSERT, DELETE ... FROM anon, authenticated` pattern,
so intent is unambiguous even if a future migration adds a permissive policy carelessly.

The additive link columns on `activity`/`claims`/`multichain_transactions` inherit those tables'
existing RLS unchanged — adding a nullable column does not change a table's policies.

---

## 8. Migration rollback strategy

The migration is purely additive (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`) and safe to re-run. Rollback, if ever needed before any Phase 2+
code depends on these tables:

```sql
-- Safe only as long as no application code references these yet (true as of Phase 1).
-- Order matters: the link columns on activity/claims/multichain_transactions hold
-- foreign keys INTO transaction_intents/ledger_events, so those columns must be
-- dropped BEFORE the tables they reference, or Postgres rejects the DROP TABLE
-- with a dependency error. (Verified by actually running this against a scratch
-- database — see §11.)
ALTER TABLE public.activity                 DROP COLUMN IF EXISTS transaction_intent_id;
ALTER TABLE public.activity                 DROP COLUMN IF EXISTS ledger_event_id;
ALTER TABLE public.claims                   DROP COLUMN IF EXISTS transaction_intent_id;
ALTER TABLE public.multichain_transactions  DROP COLUMN IF EXISTS transaction_intent_id;

DROP TABLE IF EXISTS public.notification_events;
DROP TABLE IF EXISTS public.ledger_events;
DROP TABLE IF EXISTS public.transaction_attempts;
DROP TABLE IF EXISTS public.transaction_intents;
```

No existing data, column, or constraint is dropped, renamed, or altered by the forward
migration, so rollback carries zero risk to `activity`, `claims`, `multichain_transactions`, or
any other existing table's existing data. This rollback script is **not** included as a
down-migration file (this project's migration tooling appears forward-only, matching every
other migration in `supabase/migrations/`) — it's here for manual use if ever needed.

---

## 9. Exact migration file created

`supabase/migrations/20260823060000_phase1_canonical_transaction_model.sql`

Single file, per the skill's "1 migration if possible" guidance. Contents: 4 new tables (with
indexes, constraints, `updated_at` triggers matching the `claims` table's existing trigger
pattern, and RLS lockdown), plus 4 nullable `ADD COLUMN IF NOT EXISTS` statements on existing
tables. No other files change in Phase 1.

---

## 11. Validation performed

The forward migration and the rollback script above were both actually executed (not just
read) against a real, locally installed PostgreSQL 16 instance, seeded with a minimal stub of
the pre-existing `activity`/`claims`/`multichain_transactions` tables and `anon`/
`authenticated`/`service_role` roles, to catch real errors rather than review-only ones:

- Forward migration applies cleanly with zero errors; every `CREATE TABLE`/`CREATE INDEX`/
  `COMMENT` statement succeeds.
- Re-running the forward migration a second time is a clean no-op (`IF NOT EXISTS`/
  `DROP TRIGGER IF EXISTS` throughout) — confirmed by executing it twice.
- `UNIQUE (wallet_address, idempotency_key)` on `transaction_intents` actually rejects a
  duplicate-key insert (tested directly).
- `UNIQUE (event_key)` on `ledger_events` actually rejects a duplicate-key insert (tested
  directly).
- `SET ROLE anon; SELECT * FROM public.transaction_intents;` actually fails with
  `permission denied` — confirming the deny-by-default RLS/REVOKE actually blocks the `anon`
  role, not just "should" block it.
- The rollback script's original column-then-table ordering **failed** on first execution
  (`cannot drop table ... because other objects depend on it`) — corrected to drop the new
  nullable link columns on `activity`/`claims`/`multichain_transactions` *before* dropping the
  tables those columns reference, then re-verified clean. The corrected order is what appears
  in §8 above and in the file; this note is left here as a record that it was actually caught by
  execution, not just written down.

Since Phase 1 changes zero TypeScript/JavaScript application code (only a new `.sql` migration
and two new docs files), `npm run typecheck`, `npm run lint`, and `npm test` are unaffected by
this change — there is nothing for them to newly pass or fail on. They were not run against the
full dependency tree in this pass (no `node_modules` present in the delivered archive; installing
the full tree, including `hardhat`/contract tooling, was judged not worth the time for a
schema-only phase with zero `.ts`/`.tsx` changes). If preferred, running `npm ci && npm run
typecheck && npm run lint && npm test` before merging is a reasonable extra gate — it should
pass trivially since no source file changed, but confirming that is cheap.

## 13. Phase 2 clarifications (added before Phase 2 implementation began)

Three clarifications were requested before Phase 2 (the state machine) could be built. All
three are now reflected in
`supabase/migrations/20260823070000_phase2_token_identity_and_notification_key.sql`, applied and
verified the same way as the Phase 1 migration (§11).

### 13.1 `event_type` vs `direction`

Both columns are kept — they answer different questions and neither can be derived from the
other:

- **`event_type`** is the *business/domain* event: what actually happened, from the feature's
  point of view. Eleven values, feature-specific.
- **`direction`** is the *accounting* direction: does this row increase or decrease the given
  `wallet_address`'s balance for this token. Exactly two values (`debit`/`credit`), always.

They're not redundant because several different `event_type`s share the same `direction` but
mean very different things to a user reading their history (a `CREDIT` from a peer's payment, a
`BRIDGE_MINT` from a claim, and an `ESCROW_RELEASE` from a completed P2P trade are all
`direction = 'credit'`, but the Activity feed needs to say something different for each). Anywhere
that only needs "did this go up or down" (balance summation) reads `direction`; anywhere that
needs "what happened, in human terms" reads `event_type`.

| Feature | Row(s) produced | `event_type` | `direction` | `wallet_address` is... |
|---|---|---|---|---|
| Pay (sender leg) | 1 | `DEBIT` | `debit` | the sender |
| Pay (recipient leg) — this is what "Receive" is, structurally | 1 | `CREDIT` | `credit` | the recipient |
| Swap | 2 | `SWAP_DEBIT` then `SWAP_CREDIT` | `debit` then `credit` | the same wallet, both legs (tokenIn leaves, tokenOut arrives) |
| CCTP V2 (Multichain Transfer/Claim) | 2, on different chains | `BRIDGE_BURN` (source) / `BRIDGE_MINT` (destination) | `debit` / `credit` | the same wallet on two different `chain_id`s |
| Unified Balance | 2 | `UB_DEPOSIT` (funds leave source chain into UB) then `UB_SPEND` (funds leave UB to complete the payout) | `debit` then `debit` | the payer, both times — UB has no "credit" leg of its own; the destination-chain arrival for whoever receives the payout is a normal `CREDIT` row, same as Pay |
| BulkPay | 1 + N | `DEBIT` (payer, once) + `CREDIT` (once per recipient) | `debit` / `credit` | payer / each recipient — reuses the exact Pay shape, just N credit rows from one Multicall3 tx |
| P2P | 1–2 per trade | `ESCROW_LOCK` (funds leave trader's wallet into escrow) then `ESCROW_RELEASE` (funds leave escrow to the buyer) or `ESCROW_REFUND` (funds return to the original locker) | `debit` then `credit` | the locker, then the recipient of release/refund (may be a different wallet for `ESCROW_RELEASE`, the same wallet for `ESCROW_REFUND`) |

### 13.2 Token identity

Implemented as an explicit `is_native boolean NOT NULL DEFAULT false` column on both
`transaction_intents` and `ledger_events`, with
`CHECK (is_native = true OR token_address IS NOT NULL)` on each. The writer must set
`is_native` explicitly from data it already has (it always knows whether it's handling the
chain's native asset or an ERC20) — this is deliberately **not** inferred from `token_symbol`,
because MeshPort already supports enough chains that a hardcoded native-symbol list would be
both incomplete on day one and would silently drift out of date every time a chain is added
(compare how often `api/relay-gas.ts`'s `CHAIN_DEFS` — one native symbol per chain — has grown).
An explicit, enforced flag can't be silently bypassed by an unrecognized or new symbol; a
symbol-matching heuristic could.

### 13.3 Notification identity

Phase 1 created two overlapping unique indexes on `notification_events`
(`(user_id, event_key)` and `(wallet_address, event_key)`). Since `wallet_address` is `NOT NULL`
on every row, the wallet-keyed index alone already dedupes every row regardless of whether
`user_id` is populated — the `user_id`-keyed index added no real protection and just created a
second mechanism a future bug could reason about inconsistently (e.g. two rows for the same
logical event that differ only in whether `user_id` happened to be resolved yet at insert time
would both pass the user-keyed index if one had `user_id = NULL`, and only the wallet-keyed
index would actually catch the duplicate). Fixed: `idx_notification_events_user_key` is dropped.
**One canonical key**: `UNIQUE (wallet_address, event_key)`. `user_id` remains a nullable column
for convenience joins/filtering by logged-in user, but is explicitly not part of the identity.

## 14. What Phase 1 deliberately does not do

- Does not write to any of the four new tables from any application code path (none exists yet).
- Does not change `activity`, `claims`, `multichain_transactions`, `transactions`,
  `chain_events`, `notifications`, `p2p_trades`/`p2p_offers` write behavior in any way.
- Does not touch `wallet-key`, `swap-proxy`, or any signing flow.
- Does not flip the indexer to authoritative or change its shadow-mode posture.
- Does not fix the confirmed `/api/transactions` GET+POST wallet-address-only authorization
  issue — carried forward to Phase 16 as planned, now with POST confirmed as well as GET.
