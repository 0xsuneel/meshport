-- ============================================================================
-- audit-supabase-state.sql — what IS deployed, what is MISSING, what is STALE
--
-- Read-only. Creates nothing, changes nothing, deletes nothing. Safe to run on
-- the live project at any time, including before the shadow migrations.
--
-- Paste the whole file into the Supabase SQL editor. Each section returns its
-- own result set.
-- ============================================================================

-- ── 1. Do the shadow tables exist yet? ──────────────────────────────────────
select
  t.expected                                             as object,
  case when c.relname is null then 'MISSING' else 'PRESENT' end as status,
  case when c.relname is null
       then 'apply 20260807120000 / 20260807130000'
       else 'ok' end                                     as action
from (values
  ('chain_cursors'), ('chain_events'),
  ('indexer_config'), ('indexer_shadow_reports')
) as t(expected)
left join pg_class c
  on c.relname = t.expected
 and c.relnamespace = 'public'::regnamespace
order by 2 desc, 1;

-- ── 2. Pre-existing tables the indexer READS (must all be PRESENT) ─────────
-- Derived from the actual .from() calls in the function, not assumed:
--   users  — wallet addresses to watch (users.wallet_address, the same source
--            deposit-scan-all's loadWalletSet uses; there is no `wallets` table)
--   activity, claims — what compare mode measures the indexer against
select
  t.expected as required_table,
  case when c.relname is null then 'MISSING — indexer will fail' else 'PRESENT' end as status
from (values
  ('users'), ('activity'), ('claims'), ('deposit_scan_cursor')
) as t(expected)
left join pg_class c
  on c.relname = t.expected and c.relnamespace = 'public'::regnamespace
order by 2, 1;

-- ── 2b. users.wallet_address column + how many wallets will be watched ─────
-- Zero rows here means the indexer has nothing to match against and every
-- pass will find nothing — which would look like a clean run, not a broken one.
select
  case when count(*) = 0 then 'COLUMN MISSING — indexer cannot load wallets'
       else 'present' end as wallet_address_column
from information_schema.columns
where table_schema = 'public' and table_name = 'users' and column_name = 'wallet_address';

select count(*) as wallets_to_watch
from public.users
where wallet_address is not null;

-- ── 3. Extensions ───────────────────────────────────────────────────────────
select
  e.expected as extension,
  case when x.extname is null then 'NOT ENABLED' else 'enabled v' || x.extversion end as status,
  case when x.extname is null
       then 'create extension if not exists ' || e.expected
       else 'ok' end as action
from (values ('pg_cron'), ('pg_net'), ('supabase_vault')) as e(expected)
left join pg_extension x on x.extname = e.expected;

-- ── 4. Cron jobs — live vs expected ────────────────────────────────────────
-- Legacy three MUST remain active. Indexer two appear only after migration 2.
select
  jobname,
  schedule,
  active,
  case
    when jobname in ('deposit-scan-all-sweep','deposit-scan-all-reconcile',
                     'claim-worker-sweep')                then 'LEGACY — must stay'
    when jobname in ('blockchain-indexer-shadow',
                     'blockchain-indexer-compare',
                     'chain-events-retention')            then 'SHADOW — new'
    when jobname = 'claim-attention-scan-sweep'           then 'STALE — should already be unscheduled'
    else 'UNRECOGNISED — investigate before removing'
  end as verdict
from cron.job
order by verdict, jobname;

-- ── 5. Anything scheduled that points at a function that is not deployed ───
-- This is the real "needs removing" query: a cron job firing at a dead URL
-- burns a pg_net request every interval and logs a failure nobody reads.
select
  j.jobname,
  j.schedule,
  substring(j.command from 'functions/v1/([a-z-]+)') as targets_function,
  'verify this function is deployed; if not, cron.unschedule it' as note
from cron.job j
where j.command like '%functions/v1/%'
order by 3;

-- ── 6. Vault secret the indexer cron authenticates with ────────────────────
select
  'claim_worker_service_key' as secret,
  case when count(*) = 0 then 'MISSING — indexer cron will 401 every run'
       else 'present' end as status
from vault.decrypted_secrets
where name = 'claim_worker_service_key';

-- ── 7. Realtime publication — shadowEventBus depends on this ───────────────
select
  'chain_events in supabase_realtime' as requirement,
  case when count(*) = 0
       then 'NOT PUBLISHED — bus will receive nothing (migration 1 adds it)'
       else 'published' end as status
from pg_publication_tables
where pubname = 'supabase_realtime'
  and schemaname = 'public'
  and tablename = 'chain_events';

-- ── 8. Indexer progress (only meaningful after a pass has run) ─────────────
select
  chain_id,
  last_indexed_block,
  latest_observed_block,
  coalesce(latest_observed_block - last_indexed_block, -1) as lag_blocks,
  sync_state,
  reorg_count,
  consecutive_failures,
  last_success_at,
  last_error
from chain_cursors
order by chain_id;

-- ── 9. Event volume by status/type ─────────────────────────────────────────
select status, event_type, count(*) as events,
       min(created_at) as first_seen, max(created_at) as last_seen
from chain_events
group by 1, 2
order by 3 desc;

-- ── 10. Duplicate events — MUST return zero rows ───────────────────────────
-- The partial unique index should make this impossible. If it returns
-- anything, idempotency is broken and cutover is off the table.
select event_type, chain_id, tx_hash, block_number, count(*) as copies
from chain_events
where tx_hash is not null
group by 1, 2, 3, 4
having count(*) > 1;

-- ── 11. Latest shadow comparison results ───────────────────────────────────
-- worker_only > 0 means the indexer MISSED something the legacy worker caught.
select generated_at, scope, window_minutes,
       matched, worker_only, indexer_only, recall_pct
from indexer_shadow_reports
order by generated_at desc
limit 20;

-- ── 12. Cutover gate, evaluated in SQL ─────────────────────────────────────
-- Deliberately reports NO DATA rather than a pass when nothing was compared:
-- "worker_only = 0 across zero events" is not evidence of correctness.
with agg as (
  select coalesce(sum(matched),0)      as matched,
         coalesce(sum(worker_only),0)  as worker_only,
         coalesce(sum(indexer_only),0) as indexer_only,
         count(*) filter (where matched + worker_only + indexer_only > 0) as non_empty_windows
  from indexer_shadow_reports
)
select
  matched, worker_only, indexer_only, non_empty_windows,
  case
    when matched + worker_only + indexer_only = 0
      then 'NO DATA — gate cannot pass on an empty window'
    when non_empty_windows < 2
      then 'INSUFFICIENT — need >= 2 non-empty windows'
    when worker_only > 0
      then 'FAIL — indexer missed ' || worker_only || ' event(s)'
    when indexer_only > 0
      then 'REVIEW — ' || indexer_only || ' indexer-only event(s) need explanation'
    else 'automated conditions met — restart recovery + native USDC still manual'
  end as gate
from agg;
