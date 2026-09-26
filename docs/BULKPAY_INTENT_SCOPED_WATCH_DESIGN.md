# BulkPay Intent-Scoped Watch Design

Status: architecture design/audit only. No code modified, no schema changed, no migration, no
deployment, no `ledger_events` created, no Activity write. Every claim below is traced against
actual repository code and live database schema — not assumed.

---

## 1. Current architecture

`BulkPayoutPage.tsx` broadcasts one Multicall3 `aggregate3Value` transaction paying N recipients
(confirmed by your own note and the forensic audit — one `tx_hash` for the whole batch). There is
no server-side involvement before broadcast at all — confirmed by direct code inspection: nothing
in `BulkPayoutPage.tsx` writes to Supabase until after `publicClient.waitForTransactionReceipt`
returns. The recipient list exists only in the client's own local React state until that point.

After confirmation, three writes happen, all client-initiated, all post-broadcast:

1. `bulk_payments` (base table) — one aggregate row per batch: `wallet_address` (payer),
   `total_amount`, `recipient_count`, `purpose`, `tx_hash`, `status`. No individual recipient
   addresses.
2. `activity` — one `bulk`/`direction:sent` row for the payer (with a `metadata.recipients`
   array listing every recipient + amount + label), and one `bulk`/`direction:received` row per
   recipient (`Activity.bulkReceived()`, already guarded by the BulkPay Activity safety fix from
   an earlier session).
3. `bulk_payments_received` — appears to be a per-recipient table with exactly the fields needed
   (`wallet_address`, `tx_hash`, `amount_received`, `payer_wallet_address`, `created_at`) — but it
   is not a table at all. Confirmed via `information_schema.tables`: `table_type = 'VIEW'`. Its
   definition (`information_schema.views`):

   ```sql
   SELECT id, wallet_address, amount AS amount_received, token_symbol,
          counterparty_address AS payer_wallet_address,
          metadata->>'fromUsername' AS payer_label,
          metadata->>'purpose' AS purpose,
          status, tx_hash, explorer_url, created_at
   FROM activity a
   WHERE activity_type = 'bulk' AND metadata->>'direction' = 'received';
   ```

   It is literally `activity`, filtered and relabeled — not an independent data source. It has
   exactly the same trust/timing properties as `activity` itself, because it is `activity`. This
   matters directly for §4.

## 2. Root limitation (restated precisely from the forensic audit)

`blockchain-indexer/index.ts`'s `loadKnownWallets()` builds `knownWallets` exclusively from
`users.wallet_address`. `scanner.ts`'s native-transfer-log and ERC-20 log loops both filter
`if (!wallet || !knownWallets.has(wallet)) continue` (lines 402 and 476) before ever constructing
a `chain_events` row. A recipient who isn't a registered MeshPort user is invisible to the
indexer, unconditionally, regardless of the transaction's validity or source.

## 3. Real transaction example

`0xb179c4f0691199d5a1fdfc49d5086cf587f5440b13c768629a2913f7f783714c` — recipient
`0xebe52519a38e857a744e65d01f23137e22fb784b` (registered, `username: suvarna`) got a
`chain_events` row; recipient `0x9171d4f0d376019297d9598c33cdc6e92413f730` (not in `users` at
all) did not. Both are real legs of the same real, confirmed Multicall3 transaction, corroborated
by the payer's own `activity`/`bulk_payments`/`bulk_payments_received`(view) records totaling
the correct 24 USDC. See §6 for how this design would have changed the outcome.

---

## 4. Proposed architecture — and a necessary refinement to the brief's framing

Direct answer to "can the server obtain the exact recipient addresses without trusting arbitrary
client input after broadcast?": not from any data source that exists today. `bulk_payments` has
no recipient list at all. `activity` and `bulk_payments_received` (the view over it) both
originate from the same post-broadcast, client-initiated write — trusting either one as
authorization to watch an address would be exactly the "cross-user address injection" risk your
brief warns against, since a malicious client could write an `activity` row claiming an arbitrary
address received funds, and a design that watches whatever `activity`/`bulk_payments_received`
says would dutifully start monitoring it.

This means a literal "temporary watch-list of client-declared addresses" implementation of
Option B, however time-bounded, does not by itself solve the security requirement. The necessary
refinement: client-declared recipient data (from any table) may only ever serve as a low-trust
worklist pointer — "here's a `tx_hash` worth checking" — never as directly-actioned watch
authorization. The actual, trustworthy recipient list must come from an independent, server-side
read of the real, confirmed transaction itself, which a client cannot fabricate (a made-up
`tx_hash` simply won't resolve to anything on-chain; a real `tx_hash` resolves to exactly what
was actually broadcast, outside the client's control once submitted).

### Proposed flow

```
BulkPay broadcasts (unchanged)
    -> client writes activity/bulk_payments/bulk_payments_received (unchanged, still low-trust)
    -> [NEW] a worklist entry exists: "tx_hash X was claimed as a BulkPay batch"
    -> [NEW] a bounded, narrowly-scoped reconciliation step:
         - reads tx_hash X's REAL transaction receipt directly via RPC (independent of any
           client claim)
         - decodes ALL Transfer logs / internal value transfers in that ONE real transaction
           (reusing the exact same decode logic scanner.ts already has for the
           native-transfer-log/ERC-20 paths -- not new decoding logic)
         - for each REAL recipient found (regardless of registration status), creates a
           chain_events row -- this is the "watch," but it is a one-shot, targeted decode of a
           single already-confirmed transaction, not an open-ended address subscription
    -> chain_events now has a row for EVERY real recipient of this ONE real transaction
    -> Ledger Interpreter picks it up exactly as it already does (§10 -- zero Ledger change)
```

This still matches the shape your brief asked for (`BulkPay Intent -> known recipient addresses
-> ... -> indexer -> chain_events -> Ledger`) — the difference is where the authoritative
recipient list comes from: not a client-submitted list trusted at face value, but the real
on-chain transaction, independently re-read server-side, using the client's claim only as a
pointer to which transaction to check.

---

## 5. Existing tables/components reusable

- `bulk_payments`: reusable as the worklist trigger source — its `tx_hash` column is exactly the
  pointer needed; no per-recipient data required from it.
- `activity`/`bulk_payments_received`: reusable as a secondary cross-check only (does the
  independently-decoded recipient list match what the client claimed? — useful for detecting a
  discrepancy, never as the primary authorization).
- `scanner.ts`'s existing decode logic: the native-transfer-log and ERC-20 log parsing (the exact
  code that already produced recipient A's row) is directly reusable for decoding recipient B's
  leg too — no new decoding logic needed, only a new trigger for when to apply it to a specific
  already-known `tx_hash` outside the normal block-range scan.
- `transaction_intents`/`transaction_attempts` (Phase 1, unapplied): not a natural fit for this
  specific need. They're intent-level (one row per broadcast), not recipient-level — using them
  would still require a new child structure to hold N recipients per intent. Given
  `bulk_payments`/`activity` already exist, populated, and Phase 1 remains unapplied, they are
  not the path of least resistance here regardless of their eventual role in the broader Ledger
  architecture.

## 6. Required schema changes, if any

Two options, genuinely different in footprint:

**Option B-literal** (matching your brief's exact requested field list): a new table, e.g.
`indexer_watch_targets`:

```
intent_id       -- FK-able reference, e.g. the bulk_payments row's tx_hash or a synthetic id
wallet_address  -- the candidate recipient (untrusted until verified -- see §4)
chain_id
created_at
expires_at
status          -- 'pending' | 'verified' | 'expired' | 'not_found'
reason          -- e.g. 'bulkpay_recipient'
source          -- e.g. 'bulk_payments_received' (which client table suggested this candidate)
tx_hash
```

This is a real, new table — not derivable from anything existing. Not drafted as a migration
here, per your instructions; shape only.

**Option B-refined** (this document's recommendation, §12): no new table strictly required. The
"worklist" can be `bulk_payments` itself (already has `tx_hash`, `status`, `created_at`) — a
reconciliation step queries `bulk_payments WHERE created_at > now() - interval` and checks
whether every recipient it should have (cross-referenced against `bulk_payments_received`, used
only as a hint of expected count/addresses, not as authorization) has a matching `chain_events`
row yet. A minimal `bulk_payments.chain_events_verified_at` (nullable timestamp) column would
make the reconciliation idempotent and cheap to re-run. Smaller footprint than B-literal, and
reuses a table that already exists and is already populated for every real BulkPay transaction.

## 7. Security model

The core principle, restated as the actual answer to your brief's Section 4: authorization to
create a `chain_events` row must never derive from a client-submitted address list alone — only
from an independent, server-side read of a real, already-confirmed transaction. Applied to each
explicit threat:

- **Permanent arbitrary-address monitoring**: impossible by construction — nothing is ever added
  to `knownWallets` at all, permanently or temporarily. Each reconciliation pass targets one
  specific, already-confirmed `tx_hash`, decodes it, and produces `chain_events` rows for exactly
  what that transaction actually contains — there is no persistent "watch list" of addresses to
  grow.
- **Unbounded address growth**: bounded by the number of real BulkPay transactions actually
  broadcast, not by anything a client can inflate — an attacker submitting fake `bulk_payments`
  rows with a fabricated `tx_hash` produces a `tx_hash` that simply fails to resolve via RPC
  (`eth_getTransactionReceipt` returns nothing), so the reconciliation step finds nothing to
  decode and creates nothing.
- **Unauthorized watch registration**: there is no "registration" step to abuse — the mechanism
  only ever re-derives facts about transactions that genuinely happened on-chain.
- **Cross-user address injection**: a malicious client cannot cause a `chain_events` row for an
  address that wasn't actually paid in a real transaction, because the row is only ever created
  from the real transaction's own decoded logs, never from the client's claim about who was paid.
  The client's claim (`bulk_payments_received`/`activity`) can at most point at which real
  transaction to check — it cannot fabricate what that transaction's real logs contain.
- **Indefinite RPC cost increase**: bounded by (a) how many real BulkPay transactions occur
  (naturally rate-limited by real usage) and (b) the lifetime window in §8, after which a
  `tx_hash` stops being re-checked even if something about it remains unresolved (logged as a
  standalone anomaly worth investigating, not retried forever).

Required server-side authorization, explicitly: none beyond what already exists — the
reconciliation step needs the same service-role Supabase access the indexer already has, and a
real Arc RPC endpoint (already configured). No new authorization mechanism is needed precisely
because the design never trusts anything the client asserts as ground truth.

## 8. Watch lifetime

Arc's `confirmationDepth = 0` materially simplifies this. A block is eligible for `'confirmed'`
status the instant it's observed — there is no extended "wait for N confirmations" window the way
there would be on a chain with real confirmation depth. This means:

- A BulkPay transaction is fully final essentially the moment it's mined — there is no "watch
  while waiting for finality" phase to design for at all, unlike what a chain with real reorg
  risk would require.
- The only real waiting is for the reconciliation step itself to run — if it's cron-driven
  (matching the indexer's own 2-minute cadence, or piggybacking on the same invocation), a
  BulkPay transaction should be fully reconciled within one or two cron cycles of being broadcast
  (a few minutes), not hours.
- Recommended lifetime: check any `bulk_payments` row from roughly the last 30-60 minutes (a
  generous multiple of the expected 2-4 minute resolution time, covering transient RPC
  hiccups/retries) on every reconciliation pass; stop re-checking anything older than that and
  flag it as a standalone anomaly instead of retrying indefinitely. This is not an arbitrary
  duration — it's sized the same way `TIMING_DIFFERENCE_THRESHOLD_MS` was sized in the Ledger
  Fix work (a multiple of measured, real propagation latency, not a guess), applied to this
  specific mechanism.

Given Arc's zero confirmation depth, there is no meaningful distinction between "watch active"
and "confirmation depth reached" as separate lifecycle stages the way your brief's example
diagram sketches — they collapse into one step here. Worth flagging plainly: a chain with real
confirmation depth would need this lifetime design to look meaningfully different (a real
"pending, don't finalize yet" phase), and this design's simplicity is partly an artifact of Arc's
specific configuration, not something that would generalize unchanged to another chain.

---

## 9. Indexer integration point

Traced precisely, per your instructions, without modifying anything:

- `loadKnownWallets()` (`index.ts`, lines 68-83) is the single point where `knownWallets` is
  constructed, once per pass.
- It is consumed at exactly two sites in `scanner.ts` (lines 402, 476), both simple `Set.has()`
  checks.
- The smallest extension point, if a literal merged-set approach were ever chosen (B-literal):
  `loadKnownWallets()` could be extended to also union in any currently-unexpired watch targets
  from a new table — a small, localized change, but still means the full indexer scan (all blocks
  in the window) would treat these addresses as "always relevant," which is a heavier mechanism
  than needed for a problem that's really "re-check one specific already-known transaction."
- This document's recommendation (B-refined) does not need this extension point at all — it
  doesn't touch `loadKnownWallets`/`knownWallets` or the main scan loop. It would live as a
  separate, narrowly-scoped reconciliation function (a new Edge Function, or a new mode on an
  existing one) that calls `eth_getTransactionReceipt` directly for one specific `tx_hash` at a
  time and reuses `scanner.ts`'s log-decoding logic as a library import, entirely independent of
  the main block-range scan loop. This is a materially smaller, more isolated change than
  extending `knownWallets`.

## 10. Ledger integration

No Ledger code change is needed, at all, under either design variant. Once a `chain_events` row
exists for recipient B (created however §4/§9 produces it), the existing, unmodified
`classifyPayTransfer` (`server/ledger/classifiers.ts`) picks it up on its next
`interpretConfirmedChainEvent` pass exactly the way it already does for recipient A — same
`event_type: 'deposit_detected'`, same shape, same code path. This was directly confirmed in the
shadow validation work: the classifier's logic has no dependency on whether a wallet is a
"registered" user — it only reads `chain_events`' own fields. The entire fix, whichever variant is
chosen, is fully upstream of the Ledger.

This also directly answers your Step 7 framing — "how does the Ledger avoid depending on the
sender's Activity write": it already does, structurally, today. The Ledger Interpreter has never
read `activity` at all (confirmed: no import of `ActivityService` anywhere in `server/ledger/`,
per the security boundary already established). The dependency on Activity is entirely on the
`chain_events` side (the indexer not seeing the recipient), not on anything about how the Ledger
itself is built.

---

## 11. Alternatives

| | A. Registered-only (today) | B-literal (client-declared watch-list) | B-refined (tx-hash-triggered RPC re-verification, recommended) | C. Globally monitor all BulkPay recipients | D. Server-verified receipt stored directly as a financial fact |
|---|---|---|---|---|---|
| Correctness | Misses unregistered recipients (proven) | Correct, if verification is added on top (else vulnerable, see §4) | Correct — derived from real on-chain data, not client claims | Correct, but same open-ended trust surface as B-literal without verification | Correct, but skips `chain_events` entirely — a parallel, second source of truth |
| Security | N/A (nothing new watched) | Weak on its own — needs the same RPC-verification refinement as B-refined to be safe, at which point it's just B-refined plus an extra table | Strong — never trusts client-declared addresses (§7) | Weakest — literally the "add all arbitrary addresses forever" anti-pattern your brief explicitly rejected | Strong for what it covers, but bypasses the indexer's own identity/dedup guarantees (Phase 3) entirely — a new, parallel trust path to maintain |
| RPC cost | Lowest (no change) | Extra scan-loop overhead for however many addresses are "watched" at once | One extra targeted `eth_getTransactionReceipt` call per real BulkPay tx — small, bounded | Highest — permanently scanning likely-growing arbitrary address set | One extra RPC call per BulkPay tx, similar to B-refined |
| Complexity | None (status quo) | Medium — new table + `knownWallets` extension point touched | Medium — new narrowly-scoped function, reuses existing decode logic, doesn't touch the main scan loop | Low to implement, high to operate safely (the exact concern your brief raised) | Medium — a second, parallel ingestion path outside `chain_events` |
| Recovery (crash mid-process) | N/A | Watch rows could be left orphaned/expired-but-unprocessed | Stateless-ish — a missed pass just gets re-checked on the next reconciliation cycle within the lifetime window | N/A | Depends entirely on the new path's own idempotency, not inherited from anything proven |
| App-closed receiver support | Already true for registered users via the existing indexer | True, once the watch itself fires | True — reconciliation is entirely server-side, no receiver app involvement of any kind | True | True |
| Ledger compatibility | Ledger already ignores registration status (§10) | Same — no Ledger change either way | Same — no Ledger change either way | Same | Different — Ledger would need a second ingestion path if this bypasses `chain_events`, a real compatibility cost the others don't have |

## 12. Recommendation

B-refined (tx-hash-triggered, independent server-side RPC re-verification of a real,
already-confirmed transaction; client-declared recipient data used only as a low-trust worklist
pointer, never as watch authorization). Reasoning, weighing the comparison above:

- It is the only option that fully satisfies §7's security requirements without requiring an
  additional verification layer bolted on afterward — B-literal, done safely, converges to
  exactly this design anyway (a client-declared address list is never sufficient alone; it always
  needs the RPC re-check to be trustworthy) — so B-refined is B-literal's necessary safe form, not
  a different, weaker alternative to it.
- Smallest new schema footprint (§6) — potentially zero new tables, reusing `bulk_payments`.
- Does not touch the main indexer scan loop or `knownWallets` at all (§9) — the smallest, most
  isolated integration point among the viable options.
- Fully compatible with the Ledger as-is (§10), same as every other option.
- Directly closes the exact gap traced in the forensic audit for the exact real transaction in
  §3/§6, without the unbounded-growth risk of C or the parallel-trust-path cost of D.

---

## 13. Recommended implementation phases (not implemented here)

1. Add the minimal state needed to make reconciliation idempotent — most likely a nullable
   `chain_events_verified_at` (or similar) column on `bulk_payments`, not a new table, per §6's
   B-refined footprint.
2. Build the reconciliation function as a new, small, narrowly-scoped Edge Function (or a new
   mode on an existing one) that: reads recent unverified `bulk_payments` rows, calls
   `eth_getTransactionReceipt` for each `tx_hash`, reuses `scanner.ts`'s decode logic (imported,
   not duplicated) to extract every real Transfer/internal-value-transfer leg, and inserts
   `chain_events` rows for whichever wallets the real transaction actually paid.
3. Cross-check the independently-decoded recipient list against `bulk_payments_received` (the
   Activity-derived view) and log (not act on) any discrepancy — a useful anomaly signal, never a
   trust input.
4. Only after that path is proven on real traffic: revisit whether the Ledger Interpreter needs
   any BulkPay-specific classification refinement (per
   `docs/LEDGER_CANONICAL_EVENT_DESIGN.md` §6/§7.6) — likely still none, since §10 shows the
   existing Pay classifier already handles this shape correctly once `chain_events` has the row.

## 14. Risks

- RPC dependency: the reconciliation step is a new, additional consumer of Arc RPC capacity, on
  top of the existing indexer's own usage — worth sizing against the same rate-limit reasoning
  already documented in `scanner.ts`'s retry/backoff comments, not assumed to be free headroom.
- Silent staleness: if a `bulk_payments` row's `tx_hash` never resolves (e.g. a genuinely
  malformed/fake row), it will correctly produce nothing — but nothing will alert anyone that
  this happened either, unless the "flag as anomaly past the lifetime window" step (§8) is
  actually built and monitored, not just designed.
- Decode-logic duplication risk: reusing `scanner.ts`'s decode logic as an import (§9) is the
  right call, but requires that logic to actually be factored as an importable, pure function
  today — not independently verified in this pass; worth confirming before implementation that
  the relevant parsing isn't tightly coupled to the main scan loop's own state.
- This design does not retroactively backfill `0xb179c4f0…`'s missing recipient — it only
  prevents the gap for future BulkPay transactions once implemented. A separate, one-off decision
  (out of scope here) would be needed if backfilling this specific historical transaction's
  `chain_events` row is wanted.

## 15. Acceptance criteria

- A real BulkPay transaction with at least one unregistered recipient produces a `chain_events`
  row for that recipient within the lifetime window (§8), verified against real data the same
  way `0xb179c4f0…` was traced in the forensic audit.
- No address is ever added to `knownWallets` (permanently or temporarily) as part of this
  mechanism — verified by code review of whatever implementation is eventually built.
- A fabricated `bulk_payments` row (fake `tx_hash`, no real corresponding transaction) produces
  zero `chain_events` rows and zero errors that block other reconciliation — verified by a
  dedicated test using an intentionally-unresolvable `tx_hash`.
- The Ledger Interpreter requires zero code changes to correctly process the newly-captured
  `chain_events` row — verified by re-running the existing, unmodified
  `scripts/ledger-shadow-validation.ts`-style check against the backfilled data once available.

---

No code was modified, no schema changed, no migration applied, no deployment, no
`ledger_events`/Activity write. Stopping here per your instructions — this is a design document
only, not an implementation.
