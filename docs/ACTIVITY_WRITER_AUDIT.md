# Activity Writer Audit

Status: **audit only**. No production code, Activity row, or writer was changed in this pass.
Every finding below is traced against actual source (client `src/`, Edge Functions
`supabase/functions/`) and, where noted, against live production data.

---

## 1. Complete Activity writer matrix

| # | Writer | File | Function | Activity type(s) | Trigger | Confirmation requirement | tx_hash identity | Event/log identity used? | Dedup mechanism | Can create RECEIVE for a swap? | Concurrent? | Server/client | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Send (sender leg) | `src/features/send/SendPage.tsx`, `ChatPage.tsx`, `ContactsPage.tsx` | `Activity.send()` → `saveActivity()` | `send` | User-initiated payment, fires on broadcast | **None** — fires the instant `result.txHash` exists, before any receipt wait | `send_<hash>` | No | `UNIQUE(tx_hash, wallet_address)`, upsert-ignore-duplicates | No | Yes (multiple tabs) | Client | **Active, pre-confirmation write (P1, pre-existing)** |
| 2 | Send (receiver leg, written by sender) | `src/features/send/SendPage.tsx` | `Activity.receive()` | `receive` | Same event as #1, same browser | None — same pre-confirmation timing | `recv_<hash>` | No | Same unique index | N/A (this IS the receive path) | Yes | Client | **Active — sender writes receiver's row (P0 architecture issue, pre-existing, already flagged Phase 0)** |
| 3 | Chat-derived receive backfill | `src/features/home/HomePage.tsx` | `Activity.receive()` | `receive` | Chat message reconciliation / catch-up scan on mount | None enforced here | `recv_<hash>` | No | Same unique index | Indirectly — see §4 Q3 | Yes | Client | Active |
| 4 | Swap (success) | `src/features/swap/SwapPage.tsx:781` | `Activity.swap()` | `swap` | Swap completes client-side | None — fires on perceived success | plain `<hash>` | No | Same unique index | N/A | Yes | Client | Active, pre-confirmation |
| 5 | Swap (failure) | `src/features/swap/SwapPage.tsx:870` | `Activity.swap()` | `swap`, `status: failed` | Swap fails/uncertain | N/A | synthetic `fail_<timestamp>` | No | N/A — synthetic hash, never collides | N/A | Yes | Client | Active, cosmetic only |
| 6 | Swap (server proxy) | `api/swap-proxy.js` (`recordSwapActivity`) | direct upsert | `swap` | Server-side, after Circle SDK call returns | Post-SDK-response, not post-confirmation | plain `<hash>` | No | `onConflict: tx_hash,wallet_address` | N/A | Yes (races #4) | Server | Active, redundant-safe with #4 |
| 7 | BulkPay (payer summary) | `src/features/bulkpayout/BulkPayoutPage.tsx` | `Activity.bulk()` | `bulk`, `direction: sent` | Payer's browser, after Multicall3 tx | None — fires on perceived success | plain `<hash>` | No | Same unique index | N/A | No (one payer) | Client | Active, pre-confirmation |
| 8 | BulkPay (recipient records) | `src/features/bulkpayout/BulkPayoutPage.tsx` | `Activity.bulkReceived()`, once per recipient | `bulk`, `direction: received` | **Same payer's browser**, one call per recipient | None | plain `<hash>` (same for all recipients) | No | Same unique index (distinguished by `wallet_address`) | N/A | No | Client | **Active — payer writes N recipients' rows directly, zero backstop specific to `bulk` type (P0 architecture issue, newly identified this audit — see §6)** |
| 9 | Rewards claim | `src/lib/rewards.ts` | `Activity.receive()` | `receive` | Reward claim tx confirms (`waitForTransactionReceipt` already awaited) | **Yes** — only called after receipt confirms non-reverted | `recv_<hash>` | No | Same unique index | N/A | Low (one claim per user at a time) | Client | Active, the one client writer that *does* wait for confirmation |
| 10 | P2P (offer/trade lifecycle) | `src/lib/p2pService.ts` (~12 call sites: sell-order creation, purchase, refund, cancellation, dispute resolution) | `saveActivity()` direct, `activityType: p2p_sell_order \| p2p_purchase \| p2p_refund` | `p2p_sell_order`, `p2p_purchase`, `p2p_refund` | Various P2P state transitions, client-driven | Mixed — some paths follow on-chain escrow confirmation, some are optimistic; not independently re-verified for all 12 sites in this pass | plain `<hash>` (escrow tx) | No | Same unique index | N/A per-se, but see §4 Q6 | Yes (client + `p2p-release-reconcile` backstop) | Client (mostly), some server-triggered | Active — high call-site count not individually re-audited line-by-line this pass |
| 11 | `deposit-scan-all` sweep (native+ERC20 primary) | `supabase/functions/deposit-scan-all/index.ts` | `recordExternalReceive()` | `receive` | Cron, every 1 min | Reads confirmed chain state directly via RPC/explorer | `recv_<hash>` | No (address-level, not log-level) | `onConflict: tx_hash,wallet_address`, ignore-duplicates | No (excludes `KNOWN_INTERNAL_CONTRACTS` senders) | Yes | Server | **DISABLED** (cron `active: false`, confirmed Phase 3 real-state audit) |
| 12 | `deposit-scan-all` reconcile (native-only backstop) | same file | `recordExternalReceive()` | `receive` | Cron, every 10 min | Same as above | `recv_<hash>` | No | Same | No | Yes | Server | Active, native USDC only |
| 13 | `claim-recovery-scan` (external receive) | `supabase/functions/claim-recovery-scan/index.ts` | `recordExternalReceive()` | `receive`, `metadata.recovered: true` | **Client-invoked**, on app mount / tab refocus, per-wallet (`AppLayout.tsx`) | Reads confirmed chain state via RPC/Blockscout | `recv_<hash>` | No | `onConflict: tx_hash,wallet_address`, ignore-duplicates, **plus** an application-level TOCTOU guard (`existsActivityForTxHash`, up to 3 checks over ~3s) | **Yes — this is the exact mechanism behind the traced EURC duplicate, see §2** | **Yes — explicitly invoked on tab focus, i.e. exactly when a user might also be completing a swap in the same tab** | Server (client-triggered) | **Active — known, partially-mitigated race, see §2** |
| 14 | `claim-recovery-scan` (claim reconciliation) | same file | direct `.from('activity').update()` | `claim`, various | Same trigger | Depends on claim state | plain `<hash>` (burn hash) | No | Targeted `UPDATE ... WHERE tx_hash = ... AND wallet_address = ...` (not an insert) | N/A | Yes | Server (client-triggered) | Active |
| 15 | `claim-worker` (claim completion) | `supabase/functions/claim-worker/index.ts` (`recordClaimActivity`) | direct upsert | `claim` | Cron, every 1 min, self-looping ~8s internally | Yes — called only from claim-completion paths, after mint confirms | plain `<hash>` (burn hash) | No | `onConflict: tx_hash,wallet_address`, ignore-duplicates | No | Yes (vs. `claim-recovery-scan`'s reconciliation) | Server | Active, correctly confirmation-gated |
| 16 | `activity-consumer` (indexer-driven) | `supabase/functions/activity-consumer/decide.ts` + `index.ts` | `decideActivityRow()` → upsert | `receive` | Cron, every 1 min | **Yes — hard-gated on `chain_events.status = 'confirmed'`, plus a 30s settle delay** | `recv_<hash>` | **No** (dedup is `(tx_hash, wallet_address)`, not log-level — see §4 Q7 for why this hasn't mattered yet) | `onConflict: tx_hash,wallet_address`, ignore-duplicates, plus `hasAnyActivityForTxHash` pre-check (any type, not just receive) | No — explicitly excludes `KNOWN_INTERNAL_CONTRACTS` senders (Fix C) and zero-address (mint) senders | Yes | Server | Active, deployed Phase 3, the most rigorously confirmation-gated writer of all 16 |
| 17 | `p2p-release-reconcile` | `supabase/functions/p2p-release-reconcile/index.ts` | — | none | Cron | — | — | — | — | — | — | Server | **Not an Activity writer** — confirmed by direct inspection; only touches `p2p_trades`/`p2p_offers`. Listed for completeness since it's a P2P-adjacent worker that could plausibly have been one. |

**17 rows, 16 real writers.** Every one of `send`/`receive`/`swap`/`bulk`/`p2p_*`/`claim` is
covered. No writer outside this list was found in a repo-wide search for `Activity.`,
`saveActivity(`, or `.from('activity').insert`/`.upsert`.

---

## 2. Known EURC case — full trace

Transaction: `0xed2868e6d034e65d2a0063816906dd2d69604102ce9a7a71a08fbf78c7492312`

```
Blockchain (Arc, EURC contract 0x89B50855…)
   │  Transfer log, log_index 59, to 0x05d00ab7…64ee126e0
   ▼
chain_events id 110 — transfer_detected, status: confirmed, created_at 12:44:12.604
   │
   │  (this row plays NO role in what follows — activity-consumer's 30s
   │   settle delay meant it hadn't acted yet by the time both activity
   │   rows below were already written; confirmed by timestamps)
   ▼
activity rows (TWO, for the same underlying transfer):
   1. recv_0xed2868e6…  activity_type=receive   created 12:44:01.606
      metadata: {recovered: true, note: "External deposit (e.g. faucet)"}
   2. 0xed2868e6…       activity_type=swap      created 12:44:03.198
      metadata: {tokenIn: USDC, amountIn: 1, tokenOut: EURC, amountOut: 0.881746}
```

### 1. Who created the swap row?

`SwapPage.tsx:781` (writer #4) — the user's own browser, `Activity.swap()`, the moment the swap
was perceived to succeed client-side.

### 2. Who created the receive row?

`claim-recovery-scan`'s `recordExternalReceive()` (writer #13), invoked from `AppLayout.tsx`
on **that same browser tab's mount/focus event** — not `activity-consumer` (ruled out by the
exact `metadata.note` wording: `activity-consumer`'s strings are `'External deposit'` or
`'External deposit (near a swap)'`, never `'External deposit (e.g. faucet)'`, which is
`claim-recovery-scan`'s own literal string, confirmed by direct source read).

### 3. Why did the recovery path classify the swap output as a receive?

Because at the log level, a swap's output-token leg **is indistinguishable from a genuine
external deposit** — both are just an ERC-20 `Transfer` to the wallet. `claim-recovery-scan`'s
own code comments (lines 494–513, read directly) already document this exact ambiguity and
already contain a purpose-built mitigation for it (the TOCTOU guard below) — this is a known,
previously-identified failure mode, not a new discovery, but the mitigation did not fully close
it in this instance.

### 4. What condition allowed the recovery path to create it?

`existsActivityForTxHash()` polls for an existing row **up to 3 times over ~3 seconds** (delays
`[0, 1200, 1800]`ms) before conceding no row exists and calling `recordExternalReceive()`. In
this trace, the `receive` row was written at `12:44:01.606` and the `swap` row two seconds later
at `12:44:03.198`. If `claim-recovery-scan`'s guard sequence began before `12:44:01` (plausible —
it's invoked on tab focus, and a user actively watching a swap complete would very likely have
just (re)focused the tab), its 3-second polling window would have **fully elapsed before the
client's own swap-activity write landed**, so all three checks correctly reported "no row yet"
— the guard did exactly what it was designed to do, the window was just narrower than the actual
gap between on-chain confirmation and the client's own write completing. This is a timing
mismatch between two independently-tuned constants (`claim-recovery-scan`'s ~3s guard vs.
whatever the client's real swap-completion pipeline actually takes, which was not independently
measured in this pass), not a logic bug in either file.

### 5. Why did deduplication not recognize the existing swap?

At the moment `recordExternalReceive()` ran, the swap row **did not exist yet** — there was
nothing to recognize. This is a genuine, real TOCTOU race, not a dedup mechanism failing to
catch something that was already there. The `onConflict: tx_hash,wallet_address` unique
constraint upsert *would* have prevented a literal duplicate if both rows used the *same*
`tx_hash` string — but they don't: `recv_0xed2868e6…` and `0xed2868e6…` are two different
strings by design (the `recv_`/plain-hash convention that lets `receive` and `swap` legitimately
coexist for genuinely different transactions), so the unique index provides no protection
against this specific cross-type race at all.

### 6. Could the same issue happen for: Swap / BulkPay / CCTP mint / UB / P2P release / Claim?

| Feature | Same race possible? | Reasoning |
|---|---|---|
| **Swap** | **Yes — this is the traced case.** | Any output-token leg is a generic Transfer at the log level. |
| **BulkPay** | **Yes, and structurally worse.** | `Activity.bulkReceived()` (writer #8) has **no TOCTOU guard at all** — it's a plain client write with no existence check before writing. If `claim-recovery-scan` or `deposit-scan-all` reconcile independently detects one of the recipients' Transfer legs first (very plausible — N recipients means N chances for a race, not one), that recipient gets a `recv_`-prefixed "External deposit" row **in addition to** their eventual `bulk`/`direction:received` row — same class of duplicate, unguarded. |
| **CCTP mint** | **No.** | Both `activity-consumer`'s scanner-level skip (zero-address sender) and `claim-recovery-scan`'s own zero-address check (`MINT_FROM_TOPIC`) exclude mints from the generic-receive path entirely — this is deliberately and consistently excluded everywhere, confirmed across three files. |
| **Unified Balance** | **Not independently verified this pass** — no dedicated UB Activity writer was found in the matrix (§1), and Phase 3's event-coverage matrix already noted UB isn't decoded by the indexer at all. If a UB spend's destination-chain leg is a generic Transfer, the same class of race is plausible in principle, but no concrete UB writer exists yet to trace. |
| **P2P release** | **Plausible, not traced in this pass.** | `p2pService.ts`'s `p2p_purchase` writes (writer #10) use the plain (unprefixed) hash, same as `swap` — the same class of race (recovery path credits a `receive` before the P2P-specific write lands) is structurally possible, but none of the 12 individual call sites were re-audited line-by-line for their own guard logic in this pass. |
| **Claim** | **No — the confirmation-gating already prevents it.** | `claim-worker` only writes after mint confirms; `claim-recovery-scan`'s claim-reconciliation paths (writer #14) target existing rows via `UPDATE`, not a fresh insert competing with anything. |

### 7. Is this capable of creating incorrect balance changes, or is it only duplicate Activity?

**Duplicate Activity only, not a balance error.** Traced directly: no balance table or cache is
written by any of the 16 writers in §1 (re-confirmed for `claim-recovery-scan` and
`recordExternalReceive` specifically in this pass — neither touches anything but `activity`).
Client-side balance is chain-derived (a direct RPC/balance read), not summed from `activity`
rows, so two `activity` rows for one real transfer does not double-credit the user's spendable
balance. The user-visible impact is cosmetic but real: the Activity feed shows the same money
movement twice, under two different labels ("External deposit" and "Swap Complete"), and (per
`claim-recovery-scan`'s own code comment) can fire a spurious extra "Payment received"
notification alongside the correct "Swap Complete" one.

---

## 3. All duplicate-generation paths (summary, cross-referencing §1/§2)

1. **Swap output leg vs. recovery-path receive** (traced above) — `claim-recovery-scan` vs.
   `SwapPage.tsx`/`api/swap-proxy.js`. Partially mitigated (3s TOCTOU guard), not fully closed.
2. **BulkPay recipient leg vs. recovery-path receive** — `claim-recovery-scan`/
   `deposit-scan-all` reconcile vs. `BulkPayoutPage.tsx`'s `bulkReceived()`. **Unmitigated** —
   `bulkReceived()` has no existence check at all.
3. **Sender writes receiver's row (Pay)** — `SendPage.tsx`'s `Activity.receive()` call, already
   flagged in Phase 0. Not a *duplicate*-row risk today (the shared unique index prevents a
   literal second row), but is the same underlying anti-pattern (a party other than the
   recipient's own detection path deciding the recipient's financial history) that motivates the
   other two entries here.
4. **Sender writes N receivers' rows (BulkPay)** — `BulkPayoutPage.tsx`'s `bulkReceived()` loop,
   §1 row #8 — same anti-pattern as #3, multiplied by recipient count, with no per-recipient
   confirmation wait.

---

## 4. Receive-vs-swap classification problems

The core issue is structural, not a bug in any one file: **there is no canonical way to know, at
the moment a generic Transfer log is observed, whether it is "a swap's output," "a BulkPay
recipient's cut," "a P2P release," or "a genuine external deposit."** Every writer that tries to
guess (`claim-recovery-scan`, `deposit-scan-all`, `activity-consumer`) does so with an
after-the-fact exclusion list (`KNOWN_INTERNAL_CONTRACTS`, zero-address-sender, or a
existence-check race) rather than a structural guarantee. `activity-consumer` is the most
disciplined of the three (confirmed-only, 30s settle delay, checks *any* existing activity type
before crediting) but still relies on the same fundamentally racy "does a row already exist yet"
pattern as `claim-recovery-scan` — it is just far less likely to lose the race in practice
because its settle delay (30s) is an order of magnitude longer than `claim-recovery-scan`'s (3s).

---

## 5. Confirmation behavior (cross-writer comparison)

| Writer | Waits for on-chain confirmation before writing? |
|---|---|
| `Activity.send`/`receive` (Pay, client) | **No** |
| `Activity.swap` (client) | **No** |
| `Activity.bulk`/`bulkReceived` (client) | **No** |
| `Activity.receive` (rewards.ts) | **Yes** |
| `api/swap-proxy.js` server write | Post-SDK-response, not post-confirmation |
| `p2pService.ts` (12 sites) | Mixed, not individually re-verified this pass |
| `deposit-scan-all` (both modes) | Yes (reads confirmed chain state) |
| `claim-recovery-scan` (external receive) | Yes (reads confirmed chain state) — but races a client write that does *not* wait |
| `claim-worker` | Yes |
| `activity-consumer` | **Yes, most strictly** — hard status gate + 30s settle delay |

The pattern is consistent: **every client-side writer for a user's own in-flight action
(send/swap/bulk) writes optimistically, before confirmation.** Every server-side/recovery writer
correctly waits for confirmation. The EURC race exists precisely at the seam between these two
categories — a confirmed-only server writer racing an intentionally-optimistic client writer.

## 6. Idempotency behavior

All 16 real writers use the same `UNIQUE(tx_hash, wallet_address)` upsert-ignore-duplicates
shape (or a targeted `UPDATE` for the two finalize-in-place cases, #6/#14). This reliably
prevents a literal duplicate row for the *same* `tx_hash` string. It provides **zero** protection
against the cross-type race in §2/§3, because the colliding rows deliberately use *different*
`tx_hash` strings (`recv_<hash>` vs. plain `<hash>`) by the send/receive/swap/bulk convention
itself — the identity scheme that makes legitimate coexistence possible is the same one that
makes this race un-catchable by the unique index alone.

## 7. Concurrency risks

- `claim-recovery-scan` is invoked on **every** tab focus, per wallet — a user rapidly
  switching tabs, or multiple devices open to the same wallet, can trigger overlapping
  invocations. The TOCTOU guard reduces same-invocation risk but does nothing for two
  *concurrent* invocations racing each other the same way they race the client write.
- `deposit-scan-all` reconcile (10 min) and `claim-recovery-scan` (on-focus, effectively
  unbounded frequency) both call `recordExternalReceive()` independently — they are
  safely-redundant with *each other* (same unique index), but both independently race the same
  client writers.
- `activity-consumer` (1 min cron) is the least concurrency-risky by construction — confirmed-
  only + 30s settle delay means it is very unlikely to ever be the *losing* side of one of these
  races (it's usually the slowest writer to attempt a given tx, so by the time it checks, the
  faster writer has typically already landed) — consistent with zero `activity-consumer`-
  attributable duplicates found in this or the prior forensic audit.

## 8. Balance impact

**None found.** Restated from §2 Q7: no writer in the matrix touches a balance table or cache;
client balance is chain-derived. This audit found no path by which duplicate Activity rows
translate into an incorrect balance.

## 9. Notification impact

**Real, non-zero.** `claim-recovery-scan`'s own comment documents the exact symptom: a spurious
extra "Payment received" notification alongside the correct "Swap Complete" one, for the traced
race. The same would apply to the BulkPay case (§3 item 2) — a recipient could see both an
"External deposit" notification and their `bulkReceived` notification for the same payment.
`activity-consumer`'s "quiet" mechanism (matching recent swap outputs to suppress the
notification-triggering `note` string) is a partial mitigation for its *own* writes, but does
**not** apply to `claim-recovery-scan`'s writes, which use a fixed note string
(`'External deposit (e.g. faucet)'`) with no quiet variant at all.

## 10. Which writers must eventually be removed

Per the original migration's stated end-state (chain_events → ledger_events → Activity
projection, with feature pages no longer writing Activity directly):

- **#1/#2** (`SendPage.tsx` send/receive) — the sender-writes-receiver anti-pattern, already
  flagged Phase 0.
- **#4/#5/#6** (`SwapPage.tsx`/`api/swap-proxy.js` swap writes) — pre-confirmation, duplicative
  with a future ledger-driven swap projection.
- **#7/#8** (`BulkPayoutPage.tsx` bulk/bulkReceived) — same reasoning as #1/#2, worse
  (multi-recipient, unguarded).
- **#10** (`p2pService.ts`'s direct `saveActivity` calls) — once P2P's own ledger integration
  exists (Phase 13 of the original plan).
- **#11** (`deposit-scan-all` sweep) — already disabled; formally retire once the indexer is
  proven authoritative for the categories it used to cover.

## 11. Which writers should become projections

- **`activity-consumer`** is already shaped correctly — confirmed-only, chain-driven, no
  reliance on any client being online — and should become the **template** other feature
  domains' projections are built from, not itself replaced.
- A future **swap projection**, **bulk projection**, and **P2P projection**, each reading from
  `ledger_events` once that layer exists (per the original Phase 5 architecture), replacing
  #4-8 and #10 respectively.
- **`claim-worker`**'s and **`claim-recovery-scan`**'s `claim`-type writes can likely remain
  largely as-is longer than the others — they are already confirmation-gated and
  narrowly-scoped to a domain (`claims`) that already has its own well-tested state machine;
  the *external-receive* half of `claim-recovery-scan` (`recordExternalReceive`, writer #13) is
  the part that should fold into the `activity-consumer`-style projection pattern, since it's
  functionally redundant with `activity-consumer`'s own `receive` detection except for being
  faster (on-focus) and less carefully guarded.

## 12. Recommended final Activity architecture

```
Confirmed on-chain event (chain_events, status=confirmed)
   │
   ▼
ledger_events (future phase — not built yet)
   │
   ├──▶ Activity projection (receive/swap/bulk/p2p/claim — ALL types, one consumer)
   ├──▶ Balance refresh (chain-derived, already correct today)
   └──▶ Notification projection (with the SAME quiet/dedup logic activity-consumer already has,
        generalized across all types instead of just 'receive')

Client-side writes (send/swap/bulk optimistic writes) become PENDING-labeled, non-authoritative
UI state only — never the thing another user's history is built from. The confirmation-gated
projection above is the only writer of another party's Activity row, ever.
```

This directly generalizes `activity-consumer`'s already-correct design (confirmed-only, 30s
settle delay, checks-before-credits) to every Activity type, not just `receive`, and is the same
end-state the original Phase 3-16 migration plan was already heading toward — this audit doesn't
propose a new direction, it confirms the existing plan is the right one and adds the concrete
evidence (the EURC trace, the BulkPay gap) for why the swap/bulk/P2P writers specifically need to
migrate, not just the already-known Pay/Receive ones.

## 13. Migration order (recommended, consistent with the original Phase 17 plan)

1. **P0**: Add a TOCTOU guard to `BulkPayoutPage.tsx`'s `bulkReceived()` call (mirroring
   `claim-recovery-scan`'s existing pattern) as a narrow, immediate mitigation — *not done in
   this audit-only pass*, flagged for a dedicated small fix.
2. **P1**: Widen `claim-recovery-scan`'s TOCTOU guard window (3s → closer to
   `activity-consumer`'s 30s) or, better, have it defer entirely to `activity-consumer` for the
   generic-receive case and keep only the claim-specific reconciliation logic — narrows the
   race without a full rewrite.
3. Build the `ledger_events` layer (already-approved future phase).
4. Migrate Pay (#1/#2) to the projection pattern — highest user-facing volume, already flagged.
5. Migrate Swap (#4/#5/#6).
6. Migrate BulkPay (#7/#8).
7. Migrate P2P (#10) — largest single file, most call sites, do last once the pattern is proven
   on the simpler cases above.
8. Retire `claim-recovery-scan`'s `recordExternalReceive` (writer #13) once `activity-consumer`
   (or its successor) is proven to cover the same ground without the on-focus timing risk.
9. Formally retire `deposit-scan-all` sweep (already disabled) and reconcile (once ERC-20
   coverage parity is proven, per the Phase 3 real-state audit's own recommendation).

---

## P0 / P1 / P2

**P0 (user-visible correctness risk today, no financial risk):**
- BulkPay recipient rows (#8) have zero duplicate-guard — the same race as the traced EURC case,
  but for potentially many recipients per payout, with no existing mitigation at all.
- The sender-writes-receiver pattern for both Pay (#1/#2) and BulkPay (#7/#8) remains
  architecturally unresolved (already known for Pay since Phase 0; newly confirmed for BulkPay
  this audit).

**P1 (known, partially mitigated, worth tightening):**
- `claim-recovery-scan`'s 3-second TOCTOU guard vs. `SwapPage.tsx`'s actual write latency — the
  traced, real, reproducible race. Narrow but not zero probability given both are timing-based.
- `p2pService.ts`'s 12 call sites were catalogued but not individually re-verified for their own
  guard logic in this pass — worth a dedicated, narrower audit before P2P migrates.

**P2 (hygiene, no urgency):**
- `claim-recovery-scan`'s fixed `'External deposit (e.g. faucet)'` note has no "quiet" variant
  the way `activity-consumer`'s does, so a race it loses always produces a visible spurious
  notification, never a silent-but-correct row.
- Unified Balance has no dedicated Activity writer in this matrix at all — not necessarily a
  problem (may simply not be implemented as a distinct flow yet), but worth confirming
  explicitly before any UB-specific projection work begins.

---

**No writer was modified, no row deleted, no ActivityService change, no ledger_events created,
no indexer/activity-consumer change.** Per your instructions, this is audit-only. Stopping here
for review — not proceeding to Phase 4, not migrating Pay/Receive/Swap.
