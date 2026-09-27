# Phase 4 → Phase 5 Handover

**Paused:** 2026-08-16 02:20 UTC · **Resume on/after:** 2026-08-23 02:20 UTC
**Branch:** `main` · **HEAD:** `c47af75` · tree clean, **pushed to `origin/main`**

> Supersedes the 2026-08-10 pause note. That note set a 2026-08-17 resume; the
> pause was extended by 7 days. Everything below was **re-verified live on
> 2026-08-16**, not carried over on trust. Three of its claims changed — see §0.

---

## 0. What changed since the 2026-08-10 note (read this first)

| # | Previous claim | Now |
|---|---|---|
| 1 | 4 transactions were flagged **`GENUINE - INVESTIGATE`** | **All 4 are benign.** The old classifier was wrong. See §4a. |
| 2 | §8 "repo risk — 3 commits exist only locally, nothing pushed" | **Resolved.** All commits are on `origin/main`. Nothing at risk. |
| 3 | Asset paths exercised since baseline: **1 of 4** | **3 of 4.** Only cirBTC is still unexercised. See §5. |

**Net effect: the R2 gate is in a materially better position than the old note
implies.** Nothing regressed during the pause; the earlier alarm was a
classifier bug, not a real defect.

---

## 1. Where we are

Phase 4 (shadow validation) engineering is **finished**. Four fixes are deployed
and proven on live Arc testnet data. What remains is **elapsed time**, not work.

| Fix | What | Commit | Deployed |
|---|---|---|---|
| A | Registered-wallet scoping in comparison | `acfc9e0` | ✅ |
| B | Indexer wrapper USDC via `0xffff…fffe` | `813155a` | ✅ indexer v8 |
| C | Exclude Circle Kit/CCTP internal senders | `6d360f4` | ✅ indexer v8 |
| D | Worker wrapper USDC via `0xffff…fffe` | `5286147` → `43856ca` → `643a1f7` | ✅ worker v25 |

**R2 baseline: `2026-08-10 01:48:00+00`** (Fix D final deploy).

The 168 h clean streak **satisfies at `2026-08-17 01:48:00+00`** — i.e. it
elapses *during* this pause. At the 2026-08-23 resume there will be **~13 days
(~313 h)** of clean evidence, nearly 2× the requirement.

### Verified green on 2026-08-16 (re-run, not assumed)

```
verify-phase3          26/26      verify-wrapper          20/20
verify-phase4          50/50      verify-worker-wrapper   66/66
verify-phase4-bus      16/16      verify-cursor-stall     32/32
verify-parity          14/14      verify-shadow-compare   46/46
                                  ── total 270/270 ──
tsc --noEmit  exit 0   ·   vite build  ✓ 713ms (165 precache entries)
```

---

## 2. What keeps running while paused (server-side — NOT dependent on Claude)

All 6 pg_cron jobs are **active**. Over the trailing 7 days: **26,887 runs,
0 failures.**

| Job | Schedule | 7-day runs | Failed |
|---|---|---|---|
| `claim-worker-sweep` | `* * * * *` | 10,080 | 0 |
| `deposit-scan-all-sweep` | `* * * * *` | 10,080 | 0 |
| `blockchain-indexer-shadow` | `*/2 * * * *` | 5,040 | 0 |
| `deposit-scan-all-reconcile` | `*/10 * * * *` | 1,008 | 0 |
| `blockchain-indexer-compare` | `*/15 * * * *` | 672 | 0 |
| `chain-events-retention` | `23 3 * * *` | 7 | 0 |

`shadow_mode = {"enabled": true, "authoritative": false}` — unchanged. The
indexer is still observation-only; legacy workers remain authoritative.

### ⚠️ 2b. Retention deadline — the one real risk of a longer pause

`chain_events` keeps `confirmed_days = 14`. Baseline-era rows are therefore
**pruned at `2026-08-24 03:23 UTC`**. A 2026-08-23 resume leaves **~1 day of
margin.** Any further slip past 2026-08-24 destroys the raw `chain_events` rows
that the §4a classifier joins against, and the R2 evidence becomes
unreconstructable.

`indexer_shadow_reports` keeps 30 days (expires 2026-09-09), so the comparison
**verdicts** survive either way — it is only the raw join target that ages out.

**If the pause may extend past 2026-08-22, do one of these first.** Both are
deliberately left undone — changing production retention is a config decision,
not a save-work step:

```sql
-- Option A: widen retention (least invasive; revert after the gate closes)
update indexer_config
   set value = jsonb_set(value, '{confirmed_days}', '45')
 where key = 'retention';

-- Option B: snapshot just the evidence window (leaves retention policy alone)
create table if not exists chain_events_r2_snapshot as
  select * from chain_events where created_at >= '2026-08-10 01:48:00+00';
```

## 3. What does NOT survive

The Claude-side monitoring job (`c781efe4`, every 4 h) was **session-only** and
is gone. This costs nothing — it only *analysed* data pg_cron collects anyway.
On resume, run §4a/§4b over the whole window instead.

---

## 4. Resume checklist

### 4a. The FAIL classifier — **v2, corrected**

16 FAIL windows exist since baseline (22 tx-rows). **All 22 are benign.**

The v1 classifier in the previous note **over-reported 4 transactions as
`GENUINE - INVESTIGATE`.** Root cause: it tested `activity_type = 'receive'`
only. The indexer legitimately records `deposit_detected` for **in-app**
value movements too — `p2p_purchase`, `p2p_refund`, `bulk` — which the worker
files under their own activity type. Both systems saw those transactions; only
the *label* differed. They were never missed deposits.

A FAIL is **benign** if the indexer has the event AND the worker has **any**
activity row for it, regardless of `activity_type` or window.

```sql
with fails as (
  select generated_at, jsonb_array_elements(coalesce(details->'workerOnly','[]'::jsonb))->>'tx' as tx, 'worker_only' as side
  from indexer_shadow_reports where scope='deposits' and status='FAIL' and generated_at >= '2026-08-10 01:48:00+00'
  union all
  select generated_at, jsonb_array_elements(coalesce(details->'indexerOnly','[]'::jsonb))->>'tx' as tx, 'indexer_only' as side
  from indexer_shadow_reports where scope='deposits' and status='FAIL' and generated_at >= '2026-08-10 01:48:00+00')
select f.side,
  (select a.activity_type from activity a
     where lower(replace(a.tx_hash,'recv_',''))=lower(f.tx) limit 1) as wkr_type,
  case
    when not exists(select 1 from chain_events e where lower(e.tx_hash)=lower(f.tx))
      then 'GENUINE - indexer missed'
    when exists(select 1 from activity a where lower(replace(a.tx_hash,'recv_',''))=lower(f.tx)
                and a.activity_type='receive')
      then 'BENIGN boundary race'
    when exists(select 1 from activity a where lower(replace(a.tx_hash,'recv_',''))=lower(f.tx)
                and a.activity_type in ('p2p_purchase','p2p_refund','p2p_sale','bulk','send','claim'))
      then 'BENIGN in-app transfer (not a deposit)'
    else 'GENUINE - INVESTIGATE' end as verdict,
  count(*) as windows, min(f.generated_at) as first, max(f.generated_at) as last
from fails f group by 1,2,3 order by 3, 1;
```

**Expected output — every row must be `BENIGN…`. Any `GENUINE…` row resets the
168 h streak to that timestamp.** Result on 2026-08-16:

| side | wkr_type | verdict | windows |
|---|---|---|---|
| indexer_only | receive | BENIGN boundary race | 3 |
| worker_only | receive | BENIGN boundary race | 3 |
| indexer_only | p2p_purchase | BENIGN in-app transfer | 8 |
| indexer_only | p2p_refund | BENIGN in-app transfer | 4 |
| indexer_only | bulk | BENIGN in-app transfer | 4 |

**Benign pattern 1 — the ~6.5-second write-order race.** The worker writes
`activity` seconds before the indexer writes `chain_events`. A `*/15` comparison
landing between the two reports the pair as a mismatch. It fires in BOTH
directions: worker row inside window / indexer event not yet → `worker_only`;
next window, worker row aged out / indexer event inside → `indexer_only`.

**Benign pattern 2 — in-app transfers (new; cause of the v1 false alarm).**
Confirmed txs: `0xa421b314…` (p2p_refund), `0xd6387bd1…` (p2p_purchase),
`0x435d804c…` (bulk, sender = Multicall3 `0xca11bde0…76ca11`), `0xd7496219…`
(p2p_purchase). Every one has both a `chain_events` row and an `activity` row.

**Do NOT flag as genuine:** Fix C's designed exclusions (internal-contract
senders such as the Kit Adapter `0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b`),
unregistered external recipients (`0x70e3fb28…`, `0x9171d4f0…` — absent from
`users`), or pre-Fix-B historical rows (before `2026-08-09 11:00:39+00`).

**Schema gotcha that caused the v1 bug — `chain_events.metadata` uses
`sender`/`recipient`, NOT `from`/`to`.** Querying `metadata->>'to'` silently
returns `null` and every registration check vacuously fails. The recipient is
also mirrored in the top-level `chain_events.wallet_address` column; prefer it.
`activity` has **no** `note`/`description` column (use `metadata`, `status`).

### 4b. Health checks — all green on 2026-08-16

```sql
-- R2 CRITICAL: registered-wallet deposits the indexer missed. MUST be 0.
select a.token_symbol, count(*) as receive_rows,
       count(*) filter (where e.tx_hash is null) as indexer_missed
from activity a
left join chain_events e on lower(e.tx_hash)=lower(replace(a.tx_hash,'recv_',''))
where a.activity_type='receive' and a.created_at >= '2026-08-10 01:48:00+00'
  and exists(select 1 from users u where lower(u.wallet_address)=lower(a.wallet_address))
group by 1 order by 1;
-- 2026-08-16: EURC 2/0, USDC 24/0 → indexer_missed = 0 ✅

-- reverse direction: indexer events with no worker row at all. MUST be 0.
select coalesce(a.activity_type,'(no activity row)') as t, count(*)
from chain_events e
left join activity a on lower(replace(a.tx_hash,'recv_',''))=lower(e.tx_hash)
where e.event_type='deposit_detected' and e.created_at >= '2026-08-10 01:48:00+00'
group by 1 order by 2 desc;
-- 2026-08-16: receive 24, bulk 3, p2p_purchase 2, p2p_refund 1, none orphaned ✅

-- four worker cursors: all near head, age < 300s
select source, last_scanned_block, round(extract(epoch from (now()-updated_at))) as age_s,
 (select max(last_scanned_block) from deposit_scan_cursor)-last_scanned_block as behind
from deposit_scan_cursor order by source;
-- 2026-08-16: all 4 at block 57216462, age 1-2s, behind 0 ✅

-- indexer cursor: backlog < 600, no error
select chain_id,last_indexed_block,latest_observed_block,
 latest_observed_block-last_indexed_block as backlog,sync_state,consecutive_failures,last_error
from chain_cursors;
-- 2026-08-16: arc @57216446, backlog 0, idle, 0 failures, no error ✅

-- duplicates must stay 0/0
select (select count(*) from (select tx_hash,wallet_address from activity
          where activity_type='receive' group by 1,2 having count(*)>1) d) as dup_worker,
       (select count(*) from (select event_type,chain_id,tx_hash,block_number from chain_events
          where tx_hash is not null group by 1,2,3,4 having count(*)>1) d) as dup_indexer;
-- 2026-08-16: 0 / 0 ✅

-- cron health: expect 0 in the failed column
select j.jobname, count(*) as runs,
  count(*) filter (where d.status<>'succeeded') as failed, max(d.end_time) as last_run
from cron.job_run_details d join cron.job j on j.jobid=d.jobid
where d.start_time >= now() - interval '7 days'
group by j.jobname order by failed desc, j.jobname;
```

### 4c. Re-run the suites before any decision

```
npx tsx scripts/verify-phase3.ts        # 26
npx tsx scripts/verify-phase4.ts        # 50
npx tsx scripts/verify-phase4-bus.ts    # 16
npx tsx scripts/verify-parity.ts        # 14
npx tsx scripts/verify-wrapper.ts       # 20
npx tsx scripts/verify-worker-wrapper.ts# 66
npx tsx scripts/verify-cursor-stall.ts  # 32
npx tsx scripts/verify-shadow-compare.ts# 46
npx tsc --noEmit && npx vite build
```

---

## 5. Gate status

> ### ⛔ R2 168-HOUR OBSERVATION REQUIREMENT — WAIVED BY EXPLICIT PROJECT DECISION
>
> **`R2 168-hour observation requirement waived/shortened by explicit project
> decision for this submission.`**
>
> Recorded 2026-08-16 07:40 UTC. Phase 5 cutover and Phase 6 event-driven
> refresh were implemented **without** the 168 h observation window elapsing.
>
> **The gate was NOT naturally satisfied.** At the time of the waiver the clean
> streak stood at **2 h 56 m of 168 h** (1.8 %), and there were **zero PASS
> windows** inside that streak because no deposit traffic occurred after the v9
> deploy. This is a deliberate, authorised acceptance of risk for submission
> purposes — it is not evidence of correctness and must not be cited as such.
>
> No shadow report was altered and no PASS window was manufactured to support
> this decision. The historical record in `indexer_shadow_reports` is untouched.
>
> **What IS evidenced independently of the duration gate:**
> - 343/343 assertions green; `tsc` and `vite build` clean
> - zero unpaired receives on all three fundable asset paths (16 wrapper USDC,
>   9 plain-native USDC, 2 EURC), 0 duplicates worker-side and indexer-side
> - the wrapper-USDC path verified end-to-end by 3 consecutive real **PASS**
>   windows (03:00 / 03:15 / 03:30 on 2026-08-16, `matched=1`, recall 100 %)
> - indexer v9 healthy: backlog 0, `idle`, 0 failures, 0 reorgs
>
> **What remains unevidenced and is the accepted risk:** sustained multi-day
> behaviour, reorg handling under real conditions (unit-proven only), and
> detection under the traffic patterns a full week would surface.

> ### ⚠️ R2 CLOCK RESTARTED — 2026-08-16 04:44 UTC
>
> The pre-v9 evidence window was **~30 % blind**: of 580 deposit windows since
> the 2026-08-10 baseline, 172 (29.7 %) were `NOT_COMPARABLE` because the
> indexer was in `error` state (84) or behind head (88). "No FAILs" across that
> span was partly *absence of comparison*, not proof of health. Indexer **v9**
> (commit `20151ab`, RPC retry + log-scan diagnostics) fixed the cause, so the
> 168 h streak is measured from the v9 deploy.
>
> **Baseline: `2026-08-16 04:44:00+00` · would have satisfied `2026-08-23 04:44:00+00`.**
>
> Detection semantics are UNCHANGED by v9 — its diff touched zero acceptance
> filters (verified byte-identical). So tx-level pairing proven before v9 still
> attests to the detection paths; only the *comparison-layer* evidence restarted.

| Criterion | Required | 2026-08-10 | **2026-08-16 07:15** |
|---|---|---|---|
| Clean streak (from v9) | 168 h | n/a | **2 h 31 m** |
| Genuine detection failures | 0 | 0 | **0** ✅ |
| Duplicates (worker / indexer) | 0 / 0 | 0 / 0 | **0 / 0** ✅ |
| Unpaired receives, available paths | 0 | 0 | **0** ✅ |
| Asset paths (available assets only) | 3 | 1 | **3 of 3** ✅ |
| Cursors healthy | yes | yes | **all 4 at head, age 2-3 s** ✅ |
| Indexer state | idle, 0 failures | idle | **idle, 0 fail, 0 reorg, backlog 0** ✅ |
| `nc_error + nc_behind` since v9 | ~0 | 29.7 % | **9.1 %** (1 window, deploy transition) |
| **PASS windows since v9** | **≥1** | — | **0 — no traffic at all** ❌ |

### Asset paths — 3 of 3 *available* paths covered

| Path | Status | Evidence (tx-level pairing since 2026-08-10) |
|---|---|---|
| Wrapper USDC (`via: native-transfer-log`) | ✅ | **16 paired, 0 unpaired**, Aug 10 01:50 → Aug 16 02:34. Verified by 3 consecutive **PASS** windows 03:00/03:15/03:30 on Aug 16 (`matched=1`, recall 100 %) |
| Plain native USDC (no `via`) | ✅ | **9 paired, 0 unpaired**, Aug 10 07:19 → Aug 15 03:32 |
| EURC | ✅ | **2 paired, 0 unpaired**, Aug 10 01:59 → Aug 15 03:32 |
| cirBTC | ⛔ **NOT TESTABLE — excluded from the gate** | see below |

### cirBTC — reclassified as UNAVAILABLE TEST COVERAGE, not a detection failure

**cirBTC cannot be exercised.** The available Circle / Arc Testnet funding flow
issues **only USDC and EURC** — there is no way to obtain cirBTC to send to a
registered wallet. This is a *test-environment limitation*, not a defect and not
a missed deposit.

Therefore:
- The R2 asset-path criterion is **amended from 4 paths to 3** (wrapper USDC,
  plain-native USDC, EURC). With all three covered and zero unpaired rows, the
  coverage criterion is **satisfied**.
- cirBTC must **NOT** be counted as an outstanding gate item, a detection
  failure, or a reason to withhold Phase 5.
- Do **not** wait for, request, or fabricate a cirBTC transaction.

What is known about the path, for the record: it last carried real traffic on
**2026-08-09** (6 `activity` receive rows, 2 `chain_events`) — before the
2026-08-10 baseline — so the code path has demonstrably worked. Its cursor
(`erc20_logs:cirBTC`) is healthy and at head. The scanner treats it identically
to EURC (same `eth_getLogs` loop, same acceptance filters, differing only in
`decimals: 8`), so EURC coverage exercises the same code path with a different
constant.

**Residual risk, accepted:** the cirBTC-specific `decimals: 8` conversion is not
covered by live traffic. It IS covered by unit tests. Re-verify if cirBTC ever
becomes fundable, or on mainnet where the asset set may differ.

### The real remaining gate item: no traffic since v9

Zero deposits have occurred since 04:44 (`indexer_events_since_v9 = 0`,
`receives_since_v9 = 0`), so 10 of 11 post-v9 windows are
`no deposit events on either side` and **there are no PASS windows in the clean
window at all**. A 168 h streak satisfied entirely by "nothing happened" proves
availability, not detection. **At least one real PASS window is required after
v9** — via a deliberate **USDC or EURC** deposit to a registered wallet (both
are fundable). Sparse testnet traffic means this will not occur on its own.

---

## 6. Open decisions (must be settled before Phase 5)

### D1 — `claim-recovery-scan`'s four normal-deposit branches

Verified read-only. It has a **genuine CCTP claim-recovery path** (63/63
`activity_type='claim'` rows claim-linked) that **must stay**. It ALSO has four
branches writing normal deposits (`activity_type='receive'`, note
`'External deposit (e.g. faucet)'`): lines ~641 (`!isMint`), ~691 (`!isCctpMint`),
~900 (EURC/cirBTC), ~928 (native USDC via explorer).

85/85 of those rows are **0% claim-linked** across `claims`, `pending_bridges`,
`bridge_sessions`, `multichain_transactions`. Zero unique coverage: since Fix B
deployed, **9/9 parity** with the indexer, 0 missed. Its native path uses the
explorer's `?filter=to`, which is **structurally blind to wrapper-routed
deposits** — so Fix D strictly supersedes it.

**Decision needed:** (A) keep the branches through cutover as a client-triggered
safety net, or (B) later narrow to claim-only. Recommended sequencing: satisfy
R2 → retire `deposit-scan-all` → observe → then B. Do not narrow both at once.

### D2 — What R2 "zero missed deposits" means

Does it mean **zero genuine detection failures** (working assumption — currently
**0**, gate closes 2026-08-17) or **zero FAIL windows of any kind** (currently
**16**, gate can never close on sparse traffic without a comparison-layer
change)?

The v2 classifier strengthens the case for the lenient reading: all 16 FAIL
windows are now *explained by mechanism*, in two named benign classes, with zero
unexplained residue in either direction. **Recommendation: adopt the lenient
reading and record it explicitly in the gate criteria.** Do not change the
comparison layer to chase a clean FAIL count — that is out of scope and should
not be done unprompted.

### D3 — Phase numbering

Two schemes in play. Session: 0-3 done, 4 = shadow validation (current),
5 = cutover. Proposal `§26`: 0-2 done, 3 = indexer dual-run (current),
4 = kill polling, 5 = writes & SDK, 6 = hardening. Session "Phase 5" maps to the
tail of proposal Phase 3, NOT proposal Phase 5. Settle which to track.
This doc uses the **session** scheme throughout.

---

## 7. Remaining phases

### Phase 5 — Cutover · **EXECUTED 2026-08-16 07:40 UTC (partial — see blocker)**

- **Done:** `indexer_config.shadow_mode.authoritative` flipped `false → true`
  via `jsonb_set` on that single key (`enabled` untouched). No migration, no
  deploy. Verified post-flip: `{"enabled":true,"authoritative":true}`, indexer
  `idle`, backlog 0, 0 failures, 0 reorgs, all 6 crons still active.
- **Legacy workers deliberately LEFT RUNNING** — `deposit-scan-all` (sweep +
  reconcile) and `claim-worker` untouched and still authoritative in practice.

#### ⛔ BLOCKER — `deposit-scan-all` CANNOT be retired

`shadow_mode.authoritative` is **declarative, not functional.** Audited every
read of it in server code: the only consumer is `monitor.ts:295`, which echoes
it back in the `metrics` response beside the note *"metrics are operational
observability only; nothing here is authoritative"*. **No code path branches on
it.** Flipping it changes no runtime behaviour.

The reason retirement is unsafe is structural: the indexer writes **only**
`chain_events`, `indexer_shadow_reports` and `chain_cursors` (verified — its
only `insert`/`update` targets). It **never writes `activity`**; it reads
`activity`/`users`/`claims` with `.select` only. There is **no
`chain_events → activity` consumer** anywhere — no edge function, no DB trigger
on `chain_events`.

So `deposit-scan-all`'s `recordExternalReceive` is still the **only** thing that
credits a deposit into `activity`. Retiring it would stop deposit crediting
entirely: balances and Activity would silently stop reflecting incoming funds.

**Building that consumer is new feature work, not a cutover step**, and is the
correct next task. Until it exists, "authoritative" means *authoritative
observer*, and the flag records intent.

### Phase 6 — Event-driven refresh · **IMPLEMENTED 2026-08-16**

- `src/blockchain/SyncCoordinator.ts` (new) — pure decision table mapping
  `chain_events.event_type → RefreshScope[]`, plus coalescing (250 ms),
  subsumption dedupe, a kill switch and fault isolation. Imports only types, so
  it is testable under tsx without Vite env or credentials.
- `shadowEventBus.ts` — the Phase 4 `console.info`-only `ingest()` line now also
  calls `syncCoordinator.handle(e)`, wrapped so a coordinator fault can never
  break the Realtime stream or the latency observation.
- Bound to `BlockchainManager.refreshScope` — the primitive Phase 2 built and
  documented at `BlockchainManager.ts:191` as *"the infrastructure Phase 4's
  event-driven refresh calls when a chain event arrives"*. Its signature was
  **not** changed; the trigger is logged, not passed.
- **Polling reduced, NOT removed:** `useActivity` 12 s → 60 s,
  Home balance 30 s → 90 s, Home portfolio 60 s → 120 s.
- **Polling deliberately UNCHANGED** where no event covers it:
  `MultichainPage` (60 s) and `claimService` (6 s). The indexer only has Arc
  `enabled: true`, so non-Arc balances have **zero** event coverage; and claim
  settlement is latency-critical. Lengthening either would degrade behaviour
  with no compensating event.
- Tests: `scripts/verify-sync-coordinator.ts`, **32 assertions**.

Event → scope map as implemented:

| `event_type` | scopes |
|---|---|
| `deposit_detected` | `arc` + `history` |
| `transfer_detected` | `asset` (or `chain` if no `assets[]`) + `history` |
| `transaction_confirmed` | `chain` + `claims` + `history` |
| `transaction_failed` | `history` only — no value moved |
| `balance_changed` | `arc`, or `chain` + `external` off-Arc |
| unknown / null wallet | `[]` — degrades to polling, never a stampede |

`{kind:'all'}` is never emitted for a chain event: it is reserved for
launch/login/wallet-import, and emitting it would reintroduce the 21-chain
rescan storm Phase 2 removed.

### Phase 7 — Writes & SDK · proposal §26 Phase 5

`manager.sendNative/sendToken`, pending registry, optimistic + rollback; Circle
SDK paths (`MultichainSend`, `MultichainClaim`, `BulkPayout`) onto
`getEthersProvider`.
**Exit:** every write flow passes checklist; pending tx survives refresh. Risk: **high** — deliberately last.

### Phase 8 — Hardening / mainnet prep · proposal §26 Phase 6

`/api/rpc/:chain` for all chains; keys out of bundle; retention cron;
`docs/BLOCKCHAIN_ARCHITECTURE.md`; load test.
**Exit:** no `VITE_*` provider key in `dist/`; documented CU/user. Risk: med.

### Still-open proposal questions (§27) relevant later

Mainnet chain set (21 testnets or reduced?) · Multicall3 per-chain availability,
Arc especially · Alchemy tier/CU budget · whether the 18-decimal-native /
6-decimal-ERC20-wrapper split holds on **mainnet** Arc (several detection paths
depend on it).

---

## 8. Resume in one minute

1. `git -C <repo> pull` — confirm HEAD is `c47af75` or later, tree clean.
2. Run the **§4a v2 classifier** → every row must read `BENIGN…`.
3. Run the **§4b** health blocks → `indexer_missed = 0`, dupes `0/0`,
   cursors at head, cron `failed = 0`.
4. Run the **§4c** suites → 270/270, `tsc` clean, `vite build` clean.
5. Send a **cirBTC** deposit to a registered wallet (§5) — the last gate item.
6. Settle **D1 / D2 / D3** (§6).
7. Only then flip `shadow_mode.authoritative` → true (§7).

**Do not skip step 2 believing the streak is safe.** The 168 h window elapses
during the pause, so the *first* thing to establish on resume is that nothing
genuine broke in the interim — the streak resets to any `GENUINE` timestamp.

Repo state is safe: everything is on `origin/main`, nothing exists only locally.
