-- blockchain-indexer: the busy external chains are watched by a background
-- loop (~55s per once-a-minute call, a pass every 4s) so a deposit there
-- reaches chain_events - and every open app over Realtime - seconds after
-- its block. This lock makes one loop own those chains at a time (two
-- writers on one chain cursor can rewind it).
create table if not exists public.indexer_fast_lock (
  id int primary key default 1 check (id = 1),
  locked_until timestamptz not null default 'epoch'
);
insert into public.indexer_fast_lock (id) values (1) on conflict (id) do nothing;
alter table public.indexer_fast_lock enable row level security;

create or replace function public.indexer_fast_lock_acquire(p_seconds int default 70)
returns boolean language plpgsql security definer set search_path to 'public'
as $$
declare ok boolean;
begin
  update public.indexer_fast_lock set locked_until = now() + make_interval(secs => greatest(p_seconds, 5))
   where id = 1 and locked_until < now()
  returning true into ok;
  return coalesce(ok, false);
end $$;

create or replace function public.indexer_fast_lock_release()
returns void language sql security definer set search_path to 'public'
as $$ update public.indexer_fast_lock set locked_until = 'epoch' where id = 1 $$;

revoke all on function public.indexer_fast_lock_acquire(int) from public, anon, authenticated;
revoke all on function public.indexer_fast_lock_release() from public, anon, authenticated;
grant execute on function public.indexer_fast_lock_acquire(int) to service_role;
grant execute on function public.indexer_fast_lock_release() to service_role;
