-- Business → Activity log: who did what (owner and staff). Rows are written
-- only by business_log() and by triggers; the owner reads their own.
create table if not exists public.business_activity_log (
  id uuid primary key default gen_random_uuid(),
  owner_auth_uid uuid not null,
  actor_auth_uid uuid,
  actor_username text,
  action text not null,
  target text,
  amount numeric,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists business_activity_log_owner_idx on public.business_activity_log (owner_auth_uid, created_at desc);
alter table public.business_activity_log enable row level security;
create policy bal_owner_select on public.business_activity_log for select to authenticated
  using (owner_auth_uid = (select auth.uid()));
revoke insert, update, delete, truncate on public.business_activity_log from anon, authenticated;

-- Internal: one row, with the actor's username.
create or replace function public.business_log_write(p_owner uuid, p_actor uuid, p_action text, p_target text, p_amount numeric, p_meta jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_owner is null then return; end if;
  insert into public.business_activity_log (owner_auth_uid, actor_auth_uid, actor_username, action, target, amount, meta)
  values (p_owner, p_actor, (select u.username from public.users u where u.auth_uid = p_actor limit 1),
          left(p_action, 40), left(p_target, 140), p_amount, coalesce(p_meta, '{}'::jsonb));
end $$;
revoke execute on function public.business_log_write(uuid, uuid, text, text, numeric, jsonb) from anon, authenticated, public;

-- From the app: the owner, or active staff of the owner.
create or replace function public.business_log(p_owner uuid, p_action text, p_target text default null, p_amount numeric default null, p_meta jsonb default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if p_owner is distinct from auth.uid() and not exists (
    select 1 from public.business_staff s where s.owner_auth_uid = p_owner and s.staff_auth_uid = auth.uid() and s.status = 'active') then
    raise exception 'Not your business';
  end if;
  if p_action !~ '^[a-z_]{2,40}$' then raise exception 'Bad action'; end if;
  if p_meta is not null and length(p_meta::text) > 2000 then raise exception 'Too much detail'; end if;
  perform public.business_log_write(p_owner, auth.uid(), p_action, p_target, p_amount, p_meta);
end $$;
revoke execute on function public.business_log(uuid, text, text, numeric, jsonb) from anon, public;
