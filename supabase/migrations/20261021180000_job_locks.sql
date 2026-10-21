-- Named, expiring locks for scheduled loops (one row per job). indexer-fast
-- runs as two workers - the busy external chains and the rest - each holding
-- its own lock, so each stays well inside an Edge Function's CPU budget.
create table if not exists public.job_locks (
  name text primary key,
  locked_until timestamptz not null default 'epoch'
);
alter table public.job_locks enable row level security;

create or replace function public.job_lock_acquire(p_name text, p_seconds int default 70)
returns boolean language plpgsql security definer set search_path to 'public'
as $$
declare ok boolean;
begin
  insert into public.job_locks (name, locked_until)
  values (p_name, now() + make_interval(secs => greatest(p_seconds, 5)))
  on conflict (name) do update set locked_until = excluded.locked_until
    where public.job_locks.locked_until < now()
  returning true into ok;
  return coalesce(ok, false);
end $$;

create or replace function public.job_lock_release(p_name text)
returns void language sql security definer set search_path to 'public'
as $$ update public.job_locks set locked_until = 'epoch' where name = p_name $$;

revoke all on function public.job_lock_acquire(text, int) from public, anon, authenticated;
revoke all on function public.job_lock_release(text) from public, anon, authenticated;
grant execute on function public.job_lock_acquire(text, int) to service_role;
grant execute on function public.job_lock_release(text) to service_role;
