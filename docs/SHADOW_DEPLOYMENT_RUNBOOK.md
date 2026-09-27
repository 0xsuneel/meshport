# Shadow Deployment Runbook

**Status: ready to deploy, NOT deployed.** I have no credentials in this
environment (`.env` absent, all Supabase vars unset, project never linked), so
the deployment must be run by you. Everything below is scripted and guarded so
it is a small number of commands, not a manual procedure.

**No measured data exists yet.** This runbook produces it; it does not contain it.

---

## What deploys

| Object | Kind | Effect |
|---|---|---|
| `chain_cursors` | new table | none until the indexer runs |
| `chain_events` | new table | written by indexer, **consumed by nothing** |
| `indexer_config` | new table | holds `authoritative = false` |
| `indexer_shadow_reports` | new table | comparison output |
| `blockchain-indexer` | new function | runs only when invoked |

**Unchanged:** `deposit-scan-all`, `claim-worker`, `claim-recovery-scan`, every
polling loop, every refresh timer, every compatibility layer, all client code.
The legacy workers remain the authoritative source of truth throughout.

---

## Step 1 — Credentials

```bash
export SUPABASE_ACCESS_TOKEN=sbp_...        # supabase.com/dashboard/account/tokens
export SUPABASE_PROJECT_REF=<your-ref>      # dashboard URL
export SUPABASE_DB_PASSWORD=...             # database password
```

## Step 2 — Dry run

```bash
./scripts/deploy-shadow.sh
```

Changes nothing. Verifies credentials, that both migrations are additive, that
the three legacy workers are unmodified in the working tree, and that
`authoritative = false`. **It aborts rather than proceeding if any of those
fail** — including if a migration is found to drop or alter a pre-existing
object, or to unschedule a cron job that is not the indexer's own.

## Step 3 — Apply

```bash
./scripts/deploy-shadow.sh --apply
```

Links, prints pending migrations, applies both, deploys the function, then lists
functions so you can confirm the three legacy workers are still `ACTIVE`.

## Step 4 — First pass by hand

Before scheduling anything, prove one pass works:

```bash
export SUPABASE_URL=https://<ref>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=eyJ...

curl -sS -X POST "$SUPABASE_URL/functions/v1/blockchain-indexer" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"index","chains":["arc"]}' | jq
```

Expect a `chain_cursors` row for `arc` with a non-zero `last_indexed_block` and
`sync_state` of `idle` or `catching_up`. If `last_indexed_block` stays `0`,
stop — the RPC credentials in the function environment are wrong.

## Step 5 — Cron is ALREADY scheduled by migration 2

**Do not run cron.schedule by hand.** Migration
`20260807130000_shadow_validation_and_retention.sql` schedules all three jobs
itself, hardcoded to project ref `cvvpzfvzweszuuxvaayb` and authenticating with
the existing `claim_worker_service_key` vault secret:

| Job | Schedule | Mode |
|---|---|---|
| `blockchain-indexer-shadow` | `*/2 * * * *` | `index` |
| `blockchain-indexer-compare` | `*/15 * * * *` | `compare`, 60m window |
| `chain-events-retention` | `23 3 * * *` | prune |

They begin firing the moment the migration applies. Confirm with:

```sql
select jobname, schedule, active from cron.job
where jobname like '%indexer%' or jobname like '%chain-events%';
```

If you want the manual first pass (Step 4) *before* anything runs on a timer,
unschedule immediately after applying, verify, then re-schedule by re-running
just the cron block of migration 2:

```sql
select cron.unschedule('blockchain-indexer-shadow');
select cron.unschedule('blockchain-indexer-compare');
```

## Step 6 — Collect evidence

```bash
./scripts/collect-shadow-metrics.sh            # snapshot
./scripts/collect-shadow-metrics.sh --compare  # force a fresh comparison first
```

Reports events observed, comparison per window, aggregate across all windows,
cursor state and lag, and the gate.

**The gate cannot pass on an empty window.** `worker_only = 0` across zero
compared events is not evidence, and the script fails that case explicitly
rather than printing a green result. `recall_pct` is `NULL` — not `0` — for an
empty window so it cannot be averaged into a false pass.

Gate logic was exercised against synthetic inputs in three directions (empty →
fail, clean → pass, `worker_only=2` → fail). **That tested the reporter, not the
chain.** It says nothing about real detection accuracy.

---

## Step 7 — Native Arc USDC (deliberate, not incidental)

USDC is Arc's gas currency; plain sends emit no ERC-20 log, so this path is
structurally different and must be exercised on purpose. Four sends, then
compare:

| # | Action | Expected |
|---|---|---|
| 1 | Faucet → MeshPort wallet | `deposit_detected`, amount matches |
| 2 | Exchange-style withdrawal → MeshPort wallet | `deposit_detected` |
| 3 | Wallet → **itself** | **no event** (self-send filter, D-2) |
| 4 | Zero-value tx to a MeshPort wallet | **no event** (zero-value filter, D-2) |

Then, if any wallet in the set has an address beginning `0x0`, send it EURC and
confirm detection — that is the live check for D-1, the defect that silently
dropped transfers for roughly one wallet in sixteen.

```bash
curl -sS "$SUPABASE_URL/rest/v1/chain_events?event_type=eq.deposit_detected&order=created_at.desc&limit=10" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" | jq
```

## Step 8 — Restart recovery

Deliberately interrupt a pass mid-catch-up, then verify the cursor resumes
without a gap and without double-publishing:

```bash
# note the cursor
curl -sS "$SUPABASE_URL/rest/v1/chain_cursors?select=chain_id,last_indexed_block,last_indexed_hash" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"

# force a long catch-up, then kill it mid-flight
curl -sS --max-time 3 -X POST "$SUPABASE_URL/functions/v1/blockchain-indexer" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H 'Content-Type: application/json' \
  -d '{"mode":"index","chains":["arc"],"maxBlocks":3000}' || true

# resume
curl -sS -X POST "$SUPABASE_URL/functions/v1/blockchain-indexer" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H 'Content-Type: application/json' \
  -d '{"mode":"index","chains":["arc"]}' | jq
```

Pass criteria: cursor never moves backwards except via a logged reorg; no
duplicate rows (the partial unique index makes re-emission a no-op); no block
range skipped.

```sql
-- must return zero rows
select event_type, chain_id, tx_hash, block_number, count(*)
from chain_events where tx_hash is not null
group by 1,2,3,4 having count(*) > 1;
```

---

## Cutover gate

Every line must hold on **real** traffic:

- [ ] `worker_only = 0` across ≥2 non-empty windows containing real deposits
- [ ] `indexer_only = 0`, or every instance explained
- [ ] zero duplicate `(event_type, chain_id, tx_hash, block_number)`
- [ ] cursor advances monotonically; no unexplained rollback
- [ ] restart recovery verified (step 8)
- [ ] native Arc USDC verified (step 7, all four cases)
- [ ] no chain stuck in `error`

**Known risk of an incomplete gate:** Arc testnet has fast finality and may not
reorg during the window. If so, reorg handling stays unit-proven but
unobserved — I will report that as open rather than let it pass silently.

---

## Rollback

Shadow mode has no user-visible surface, so rollback is unscheduling the crons.
The tables can stay; they are additive and inert.

```sql
select cron.unschedule('blockchain-indexer-shadow');
select cron.unschedule('blockchain-indexer-compare');
update indexer_config set value = jsonb_set(value,'{enabled}','false') where key = 'shadow_mode';
```

Legacy workers are untouched by all of the above and need no action.
