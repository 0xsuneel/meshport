-- Crashes the app hits on people's devices (the "Something went wrong"
-- screen and uncaught errors), so they can be diagnosed without a screenshot.
-- Write-only for the app; read by admins / service role.
create table if not exists public.client_errors (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  auth_uid uuid default auth.uid(),
  kind text not null check (kind in ('route', 'uncaught', 'rejection')),
  path text check (char_length(path) <= 300),
  message text check (char_length(message) <= 1000),
  stack text check (char_length(stack) <= 4000),
  user_agent text check (char_length(user_agent) <= 400),
  build text check (char_length(build) <= 80)
);
alter table public.client_errors enable row level security;
create policy client_errors_insert on public.client_errors for insert to anon, authenticated
  with check (auth_uid is not distinct from (select auth.uid()));
create policy client_errors_admin_read on public.client_errors for select to authenticated
  using (exists (select 1 from public.admin_users a where a.id = (select auth.uid())));
revoke all on public.client_errors from anon, authenticated;
grant insert (kind, path, message, stack, user_agent, build) on public.client_errors to anon, authenticated;
grant select on public.client_errors to authenticated;
create index if not exists client_errors_created_idx on public.client_errors (created_at desc);

-- Keep a buggy loop (or anyone) from flooding the table: extra reports are dropped quietly.
create or replace function public.client_errors_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare cap int := 30; n int;
begin
  if new.auth_uid is null then cap := 300; end if;
  select count(*) into n from public.client_errors e
   where e.created_at > now() - interval '1 hour' and e.auth_uid is not distinct from new.auth_uid;
  if n >= cap then return null; end if;
  return new;
end $$;
revoke all on function public.client_errors_limit() from public, anon, authenticated;
create trigger client_errors_limit before insert on public.client_errors
  for each row execute function public.client_errors_limit();
