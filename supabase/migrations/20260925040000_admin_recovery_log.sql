-- Every admin recovery action (relay, requeue, notify, reattest) is recorded.
create table if not exists public.admin_recovery_log (
  id           uuid primary key default gen_random_uuid(),
  admin_id     uuid,
  admin_email  text,
  action       text not null,
  target_kind  text not null,
  target_id    text not null,
  result       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists admin_recovery_log_created_idx on public.admin_recovery_log (created_at desc);
alter table public.admin_recovery_log enable row level security;
create policy admin_recovery_log_admin_read on public.admin_recovery_log for select
  using (exists (select 1 from public.admin_users a where a.id = auth.uid()));
