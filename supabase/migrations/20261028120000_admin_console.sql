-- Admin console: admin roles, one append-only admin audit log, RPC usage
-- counters, and the read functions behind the Transactions explorer.
--
-- Additive only - nothing is dropped, rewritten or deleted:
--   * admin_users gains a `role`. Every existing admin becomes 'owner', so
--     nobody loses access when this runs; admins added later start as
--     'viewer'. An owner changes roles on the Admins page.
--   * admin_audit_log is NEW and only for actions taken through the
--     admin-api function. The trails that already exist stay where they are
--     (settings_logs, admin_recovery_log, p2p_trade_audit_log) - the admin
--     Logs page reads all four side by side instead of copying them.
--   * rpc_usage holds per-5-minute call counters written by /api/arc-rpc.
--   * admin_tx_search / admin_tx_stats read the existing `activity`,
--     transaction_intents and transaction_attempts tables.
--
-- Writes to every new table go only through the service role (the admin-api
-- edge function and /api/arc-rpc); admins can read under RLS.

-- ── 1. Admin roles ─────────────────────────────────────────────────────────
alter table public.admin_users add column if not exists role text not null default 'owner';
-- 'owner' above only fills in today's admins; anyone added from now on
-- starts read-only until an owner raises their role.
alter table public.admin_users alter column role set default 'viewer';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'admin_users_role_check') then
    alter table public.admin_users
      add constraint admin_users_role_check check (role in ('owner', 'operations', 'support', 'viewer'));
  end if;
end $$;

comment on column public.admin_users.role is
  'owner: everything incl. admins | operations: money + settings | support: users, tickets, transactions (read) | viewer: read-only';

-- ── 2. Admin audit log (append-only) ───────────────────────────────────────
create table if not exists public.admin_audit_log (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  admin_id     uuid not null,
  admin_email  text,
  admin_role   text,
  action       text not null check (char_length(action) <= 80),
  target_type  text check (char_length(target_type) <= 40),
  target_id    text check (char_length(target_id) <= 200),
  reason       text check (char_length(reason) <= 500),
  before       jsonb,
  after        jsonb,
  ip           text check (char_length(ip) <= 64),
  user_agent   text check (char_length(user_agent) <= 300)
);

create index if not exists admin_audit_log_created_idx on public.admin_audit_log (created_at desc);
create index if not exists admin_audit_log_target_idx  on public.admin_audit_log (target_type, target_id, created_at desc);
create index if not exists admin_audit_log_admin_idx   on public.admin_audit_log (admin_id, created_at desc);

alter table public.admin_audit_log enable row level security;
revoke insert, update, delete, truncate on public.admin_audit_log from anon, authenticated;

drop policy if exists admin_audit_log_admin_read on public.admin_audit_log;
create policy admin_audit_log_admin_read on public.admin_audit_log for select
  using (exists (select 1 from public.admin_users a where a.id = auth.uid()));

-- Nobody edits or removes history - not even the service role.
create or replace function public.admin_audit_log_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'admin_audit_log is append-only';
end $$;

drop trigger if exists admin_audit_log_no_change on public.admin_audit_log;
create trigger admin_audit_log_no_change
  before update or delete on public.admin_audit_log
  for each row execute function public.admin_audit_log_append_only();

drop trigger if exists admin_audit_log_no_truncate on public.admin_audit_log;
create trigger admin_audit_log_no_truncate
  before truncate on public.admin_audit_log
  for each statement execute function public.admin_audit_log_append_only();

-- ── 3. RPC usage counters ──────────────────────────────────────────────────
-- layer 'client'   = calls the app made to /api/arc-rpc (what users cost)
-- layer 'upstream' = calls the proxy made to providers (what providers bill;
--                    higher than client because the proxy races endpoints)
-- endpoint is a host label only - never a URL, so API keys can't land here.
create table if not exists public.rpc_usage (
  bucket            timestamptz not null,
  source            text not null check (source in ('arc-proxy', 'server')),
  layer             text not null check (layer in ('client', 'upstream')),
  endpoint          text not null check (char_length(endpoint) <= 120),
  method            text not null check (char_length(method) <= 64),
  calls             integer not null default 0,
  ok                integer not null default 0,
  errors            integer not null default 0,
  rate_limited      integer not null default 0,
  cancelled         integer not null default 0,
  latency_ms_total  bigint  not null default 0,
  primary key (bucket, source, layer, endpoint, method)
);

create index if not exists rpc_usage_bucket_idx on public.rpc_usage (bucket desc);

alter table public.rpc_usage enable row level security;
revoke insert, update, delete, truncate on public.rpc_usage from anon, authenticated;

drop policy if exists rpc_usage_admin_read on public.rpc_usage;
create policy rpc_usage_admin_read on public.rpc_usage for select
  using (exists (select 1 from public.admin_users a where a.id = auth.uid()));

-- Adds a batch of counters (one call per proxy flush). Buckets are rounded
-- down to 5 minutes here, whatever the caller sent.
create or replace function public.rpc_usage_bump(p_rows jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.rpc_usage as u
    (bucket, source, layer, endpoint, method, calls, ok, errors, rate_limited, cancelled, latency_ms_total)
  -- Rows of one batch that land in the same bucket are summed first (one
  -- INSERT ... ON CONFLICT can't touch the same row twice).
  select bucket, source, layer, endpoint, method,
         sum(calls), sum(ok), sum(errors), sum(rate_limited), sum(cancelled), sum(latency_ms_total)
  from (
    select
      date_bin('5 minutes', (r->>'bucket')::timestamptz, timestamptz '2000-01-01') as bucket,
      r->>'source' as source, r->>'layer' as layer, left(r->>'endpoint', 120) as endpoint, left(r->>'method', 64) as method,
      coalesce((r->>'calls')::int, 0) as calls, coalesce((r->>'ok')::int, 0) as ok, coalesce((r->>'errors')::int, 0) as errors,
      coalesce((r->>'rate_limited')::int, 0) as rate_limited, coalesce((r->>'cancelled')::int, 0) as cancelled,
      coalesce((r->>'latency_ms_total')::bigint, 0) as latency_ms_total
    from jsonb_array_elements(p_rows) r
  ) x
  group by bucket, source, layer, endpoint, method
  on conflict (bucket, source, layer, endpoint, method) do update set
    calls            = u.calls + excluded.calls,
    ok               = u.ok + excluded.ok,
    errors           = u.errors + excluded.errors,
    rate_limited     = u.rate_limited + excluded.rate_limited,
    cancelled        = u.cancelled + excluded.cancelled,
    latency_ms_total = u.latency_ms_total + excluded.latency_ms_total;
$$;

revoke all on function public.rpc_usage_bump(jsonb) from public, anon, authenticated;
grant execute on function public.rpc_usage_bump(jsonb) to service_role;

-- ── 4. Transactions explorer ───────────────────────────────────────────────
-- Kind → activity_type:
--   pay: send | receive: receive, deposit | swap: swap | crosschain: bridge
--   claim: claim | bulk: bulk | p2p: p2p_* | withdraw: withdraw
-- An in-app payment is logged twice (send_<hash> for the payer, recv_<hash>
-- for the payee). Outside the Receive view the recv_ twin is hidden, so each
-- payment is listed once.
create or replace function public.admin_tx_kind_types(p_kind text)
returns text[] language sql immutable set search_path = '' as $$
  select case p_kind
    when 'pay'        then array['send']
    when 'receive'    then array['receive', 'deposit']
    when 'swap'       then array['swap']
    when 'crosschain' then array['bridge']
    when 'claim'      then array['claim']
    when 'bulk'       then array['bulk']
    when 'p2p'        then array['p2p_sell_order', 'p2p_refund', 'p2p_purchase']
    when 'withdraw'   then array['withdraw']
    else null
  end
$$;

create or replace function public.admin_tx_search(
  p_kind    text        default null,   -- see admin_tx_kind_types; null = all
  p_status  text        default null,   -- completed | failed | pending (anything else in flight) | null
  p_wallets text[]      default null,   -- lower-case wallet addresses (payer or payee)
  p_hash    text        default null,   -- tx hash, full or prefix-free
  p_from    timestamptz default null,
  p_to      timestamptz default null,
  p_before  timestamptz default null,   -- keyset paging: created_at < p_before
  p_limit   integer     default 50
)
returns setof public.activity
language sql stable security definer set search_path = '' as $$
  select a.*
  from public.activity a
  where (p_kind is null or a.activity_type = any (public.admin_tx_kind_types(p_kind)))
    and (
      p_status is null
      or (p_status = 'completed' and a.status = 'completed')
      or (p_status = 'failed'    and a.status = 'failed')
      or (p_status = 'pending'   and a.status not in ('completed', 'failed'))
    )
    and (p_wallets is null
         or lower(a.wallet_address) = any (p_wallets)
         or lower(coalesce(a.counterparty_address, '')) = any (p_wallets))
    and (p_hash is null
         or lower(regexp_replace(a.tx_hash, '^(send_|recv_)', '')) = lower(p_hash)
         or lower(coalesce(a.destination_tx_hash, '')) = lower(p_hash)
         or lower(coalesce(a.metadata->>'failed_tx_hash', '')) = lower(p_hash))
    and (p_from   is null or a.created_at >= p_from)
    and (p_to     is null or a.created_at <  p_to)
    and (p_before is null or a.created_at <  p_before)
    -- the payee's twin of an in-app payment, unless browsing receives
    and not (
      coalesce(p_kind, '') <> 'receive'
      and a.tx_hash like 'recv\_%'
      and exists (select 1 from public.activity s where s.tx_hash = 'send_' || substring(a.tx_hash from 6))
    )
  order by a.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
$$;

revoke all on function public.admin_tx_search(text, text, text[], text, timestamptz, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.admin_tx_search(text, text, text[], text, timestamptz, timestamptz, timestamptz, integer) to service_role;

-- Counts for the explorer header since p_since: per kind × status, the top
-- failure reasons, and server-side intents that have been in flight too long.
create or replace function public.admin_tx_stats(p_since timestamptz)
returns jsonb language sql stable security definer set search_path = '' as $$
  with rows as (
    select
      case
        when activity_type = 'send' then 'pay'
        when activity_type in ('receive', 'deposit') then 'receive'
        when activity_type = 'swap' then 'swap'
        when activity_type = 'bridge' then 'crosschain'
        when activity_type = 'claim' then 'claim'
        when activity_type = 'bulk' then 'bulk'
        when activity_type like 'p2p\_%' then 'p2p'
        when activity_type = 'withdraw' then 'withdraw'
        else activity_type
      end as kind,
      case when status in ('completed', 'failed') then status else 'pending' end as st,
      coalesce(metadata->>'failure_code', 'unknown') as code,
      coalesce(metadata->>'failure_reason', error, '') as reason
    from public.activity a
    where created_at >= p_since
      and not (a.tx_hash like 'recv\_%'
               and exists (select 1 from public.activity s where s.tx_hash = 'send_' || substring(a.tx_hash from 6)))
  )
  select jsonb_build_object(
    'by_kind', coalesce((
      select jsonb_object_agg(kind, counts) from (
        select kind, jsonb_build_object(
          'total', count(*),
          'completed', count(*) filter (where st = 'completed'),
          'failed', count(*) filter (where st = 'failed'),
          'pending', count(*) filter (where st = 'pending')) as counts
        from rows group by kind) k), '{}'::jsonb),
    'failure_reasons', coalesce((
      select jsonb_agg(jsonb_build_object('kind', kind, 'code', code, 'reason', reason, 'count', n) order by n desc)
      from (select kind, code, max(reason) as reason, count(*) as n
            from rows where st = 'failed' group by kind, code order by n desc limit 15) f), '[]'::jsonb),
    'stuck_intents', coalesce((
      select jsonb_object_agg(feature, n) from (
        select feature, count(*) as n from public.transaction_intents
        where status in ('AUTHORIZING', 'SUBMITTED') and updated_at < now() - interval '10 minutes'
          and created_at >= now() - interval '7 days'
        group by feature) s), '{}'::jsonb),
    'attempt_failures', coalesce((
      select jsonb_agg(jsonb_build_object('status', status, 'code', coalesce(failure_code, '-'), 'count', n) order by n desc)
      from (select status, failure_code, count(*) as n from public.transaction_attempts
            where status in ('REVERTED', 'DROPPED') and updated_at >= p_since
            group by status, failure_code) t), '[]'::jsonb)
  )
$$;

revoke all on function public.admin_tx_stats(timestamptz) from public, anon, authenticated;
grant execute on function public.admin_tx_stats(timestamptz) to service_role;

-- Wallet → MeshPort user, for labelling explorer rows (one query per page).
create or replace function public.admin_wallet_names(p_wallets text[])
returns table (wallet text, user_id uuid, auth_uid uuid, username text, display_name text)
language sql stable security definer set search_path = '' as $$
  select lower(u.wallet_address), u.id, u.auth_uid, u.username, u.display_name
  from public.users u
  where lower(u.wallet_address) = any (p_wallets)
$$;

revoke all on function public.admin_wallet_names(text[]) from public, anon, authenticated;
grant execute on function public.admin_wallet_names(text[]) to service_role;
