-- Deposit watcher runs every 15 seconds; this lock makes sure two runs never
-- overlap (a slow run simply makes the next one skip).
create table if not exists public.merchant_watch_lock (
  id int primary key default 1 check (id = 1),
  locked_until timestamptz not null default 'epoch'
);
insert into public.merchant_watch_lock (id) values (1) on conflict (id) do nothing;
alter table public.merchant_watch_lock enable row level security;

create or replace function public.merchant_watch_lock_acquire(p_seconds int default 60)
returns boolean language plpgsql security definer set search_path to 'public'
as $$
declare ok boolean;
begin
  update public.merchant_watch_lock set locked_until = now() + make_interval(secs => greatest(p_seconds, 5))
   where id = 1 and locked_until < now()
  returning true into ok;
  return coalesce(ok, false);
end $$;

create or replace function public.merchant_watch_lock_release()
returns void language sql security definer set search_path to 'public'
as $$ update public.merchant_watch_lock set locked_until = 'epoch' where id = 1 $$;

revoke all on function public.merchant_watch_lock_acquire(int) from public, anon, authenticated;
revoke all on function public.merchant_watch_lock_release() from public, anon, authenticated;
grant execute on function public.merchant_watch_lock_acquire(int) to service_role;
grant execute on function public.merchant_watch_lock_release() to service_role;

-- Applied live (cron job 38, merchant-deposit-watch):
--   select cron.alter_job(38, schedule := '15 seconds');
--   plus timeout_milliseconds := 30000 on its net.http_post call.
