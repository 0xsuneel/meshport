# MeshPort Shadow Validation — Status Report

**Date:** 2026-08-07
**Recommendation: DO NOT CUT OVER.** Not because a discrepancy was found in live
data, but because **no live data exists yet.** Details in §0.

---

## 0. The headline: shadow validation has not run

You asked for validation against real testnet activity, explicitly not unit
tests or synthetic validation. That instruction is correct and I did not
substitute the latter for the former. I also cannot satisfy it from here.

Verified state of this environment:

| Prerequisite | State |
|---|---|
| `.env` / `.env.local` | absent |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | not set |
| `supabase` CLI | not installed |
| `supabase/.temp` link state | absent (project never linked) |
| Migrations `20260807120000`, `20260807130000` | **written, never applied** |
| `blockchain-indexer` function | **written, never deployed** |
| Rows in `chain_events` / `indexer_shadow_reports` | **zero — tables do not exist yet** |

Every metric you listed — events observed, matched, `worker_only`,
`indexer_only`, sync latency, publication latency, rollback count, reorg
observations — is a `SELECT` against tables that have not been created, fed by a
function that has never executed. There is no number I could report that would
be a measurement rather than an invention. So I am reporting none.

**What I did instead**, since the validation window is real time you have to
spend anyway: audited the indexer's detection logic line-by-line against
`deposit-scan-all`, the worker it must agree with. That found **five defects
that would have produced non-zero mismatch counts**, including one that
silently loses deposits. Fixing them before the window opens means the window
measures the design, not bugs I could have caught by reading.

---

## 1. Defects found and fixed

All five are in `supabase/functions/blockchain-indexer/scanner.ts`. All were
found by differential reading against `deposit-scan-all/index.ts`, and all are
now covered by `scripts/verify-parity.ts` (14/14 passing).

### D-1 — Address de-padding corrupted ~1-in-16 wallets **(severity: critical)**

```js
// before
const to = (log.topics?.[2] ?? '').toLowerCase().replace(/^0x0+/, '0x')
```

A 32-byte indexed topic is the address left-padded with 24 zeros. That regex
strips *all* leading zeros — including the address's own. Demonstrated:

| Wallet | Decoded | Result |
|---|---|---|
| `0xabcd…` | `0xabcd…` (42 ch) | matches |
| `0x0bcd…` | `0xbcdef…` (41 ch) | **never matches** |
| `0x00cd…` | `0xcdef…` (40 ch) | **never matches** |

Any wallet whose address begins with a zero nibble — about 1 in 16 — would have
**every EURC and cirBTC transfer to it silently dropped.** No error, no log; the
address simply fails the `knownWallets` lookup. In shadow mode this reads as
`worker_only > 0` on a subset of wallets with no obvious pattern.

Fixed to fixed-width `slice(-40)`, identical to `deposit-scan-all:651`.

### D-2 — Native branch missing three filters **(severity: high)**

The native USDC scan accepted any tx whose `to` was a known wallet. The legacy
worker additionally rejects self-sends, zero-value transactions, and unparseable
values. Consequence: **every zero-value contract call to a MeshPort wallet would
be published as a deposit of 0 USDC**, and self-sends would double-count. Pure
`indexer_only` noise, and on Arc — where USDC is the gas currency — zero-value
calls are ordinary traffic, so this would have been high-volume.

### D-3 — CCTP mints misattributed **(severity: high)**

The ERC-20 branch did not skip zero-address senders. A zero-address `from` is a
**mint**, i.e. a CCTP claim landing — owned by `claim-recovery-scan`, and
deliberately skipped by `deposit-scan-all:656`. The indexer would have
republished every claim as a fresh external deposit: `indexer_only > 0` on
exactly the flow you asked to scrutinize, and a double-credit risk after cutover.

### D-4 — Events published above the committed cursor **(severity: medium)**

`safeAdvance` stops at the last *contiguous* success. Later chunks that
succeeded past a gap were still read, and their events were still published —
while the cursor stayed behind, so the next pass re-scans that range. Events
escaped for blocks the system had not committed to. Now filtered to
`block_number <= safeUpTo`; re-emission on re-scan is absorbed by the dedup
index.

### D-5 — Premature confirmation **(severity: medium)**

Same root cause, worse effect: blocks above the cursor were eligible to be
marked `confirmed`, the terminal trusted state. A reorg in that range could not
retract them, since the cursor rollback only revisits blocks at or below itself.
This is a **cursor inconsistency of exactly the kind your criteria name**, and it
would have been invisible until a reorg actually hit.

---

## 2. Test results

| Suite | Result |
|---|---|
| `verify-parity.ts` (new) | **14/14** |
| `verify-phase3.ts` (cursor/reorg) | **26/26** |
| `verify-phase4-bus.ts` (event bus) | **16/16** |
| `tsc --noEmit` | clean |

`verify-parity.ts` asserts the indexer and `deposit-scan-all` reach the same
verdict on the same input: all leading-zero address shapes, eight native-tx
shapes, mint exclusion, and cursor/status coherence. It also asserts the *old*
regex fails these cases, so D-1 cannot be reintroduced quietly.

These are **parity tests, not coverage tests.** They prove the two systems apply
the same rules. They cannot prove the indexer sees every real transfer — only
live traffic does that. That distinction is the whole reason your gate exists.

---

## 3. Deliverables 1–10: what stands, what is blocked

| # | Deliverable | Status |
|---|---|---|
| 1 | Shadow validation report | **Blocked** — needs live data |
| 2 | Event comparison report | **Blocked** — `compare` mode never ran |
| 3 | Native Arc USDC validation | **Partial** — parity proven by test; live detection unproven |
| 4 | Restart recovery validation | **Blocked** — needs a real interrupted pass |
| 5 | Cursor validation | **Partial** — logic proven (26/26 + D-4/D-5 fixed); live advancement unproven |
| 6 | Reorg validation | **Blocked** — cannot manufacture a reorg; needs observation |
| 7 | Synchronization metrics | **Blocked** |
| 8 | Event accuracy report | **Blocked** |
| 9 | Mismatches + root causes | **Delivered** — §1, five defects, found pre-window |
| 10 | Cutover recommendation | **Delivered: do not cut over** — §0 |

Six of ten are blocked on the same single dependency: the migration being
applied and the function deployed against real traffic.

---

## 4. What I need to unblock it

Read-only access is **not** sufficient here — unlike the Phase 3 design
questions, this needs write access, because shadow mode writes to
`chain_events` and `indexer_shadow_reports`.

1. `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (service role: the function
   writes cursors and events)
2. Permission to apply the two migrations — both additive; they create four new
   objects and alter nothing existing
3. Permission to deploy `blockchain-indexer` — runs only when invoked; no cron
   scheduled until you approve
4. Confirmation that `pg_cron` and `pg_net` are enabled

The existing workers stay untouched throughout, per your instruction. Shadow
mode writes only to the new tables and publishes events nothing consumes.

---

## 5. Proposed window, once unblocked

Gated on evidence, not elapsed time, per your instruction:

- **Deploy** migrations + function, invoke `scan` once manually, confirm the
  cursor advances and `chain_events` receives rows
- **Observe** on a 2-minute cron alongside the untouched workers; run `compare`
  every 15 minutes writing to `indexer_shadow_reports`
- **Force a restart mid-pass** (kill during catch-up) and verify the cursor
  resumes without gap or double-publish — deliverable #4
- **Exercise native USDC deliberately**: faucet send, exchange-style withdrawal,
  a self-send, and a zero-value call, confirming the first two are detected and
  the last two correctly ignored — deliverable #3
- **Hold** until `worker_only = 0` across a window containing real deposits in
  every category. A zero over a window with no deposits proves nothing, and
  `recall_pct` is deliberately `NULL` rather than `0` in that case so it cannot
  be averaged into a false pass.

Reorg validation (#6) may not complete: Arc testnet has fast finality and may
simply not reorg during the window. I would rather report that honestly than
claim reorg safety on an unobserved path. The logic is unit-proven and D-5 is
fixed; live confirmation stays open, and I will say so rather than let it pass
silently.

---

## 6. Recommendation

**Do not cut over.** Shadow validation has not begun. Five defects were fixed
before the window opened, three of which would have produced non-zero mismatch
counts and one of which silently loses funds-affecting events for a predictable
slice of wallets.

That D-1 existed is itself the argument for your gate. It passed every earlier
review, it typechecks, it is invisible in logs, and it would have shipped had
Phase 4 gone straight to cutover.

Nothing in this report changes user-visible behavior. All workers run unmodified;
all polling and refresh timers remain in place.
