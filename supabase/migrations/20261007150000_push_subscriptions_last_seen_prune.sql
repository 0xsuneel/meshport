-- MeshPort: stop push_subscriptions piling up one row per device per day
--
-- The app renews its push subscription daily (App.tsx) and never removed the
-- row it replaced, so one phone collected a row per renewal (14 seen for one
-- user) and every alert was sent once per row. api/push.ts now deletes the
-- replaced row on renewal; this adds last_seen_at (refreshed on every save,
-- i.e. every app open) and a daily job dropping rows unused for 30 days,
-- which also clears the rows already left behind.

alter table public.push_subscriptions
  add column if not exists last_seen_at timestamptz not null default now();

-- Existing rows: last known use is when they were saved.
update public.push_subscriptions set last_seen_at = created_at where created_at is not null;

select cron.unschedule('push-subscriptions-prune')
where exists (select 1 from cron.job where jobname = 'push-subscriptions-prune');

select cron.schedule(
  'push-subscriptions-prune',
  '41 3 * * *',
  $$ delete from public.push_subscriptions where last_seen_at < now() - interval '30 days' $$
);
