-- MeshPort: Home "News" box + News page
--
-- One table holds every story the app shows:
--   arc         — arc.io/blog         (read by the news-sync edge function)
--   circle      — circle.com/blog     (read by the news-sync edge function)
--   arc_status  — status.arc.io RSS   (network notices; read by news-sync)
--   meshport    — our own posts       (written by admins from the admin panel)
--
-- news-sync runs every 30 minutes (cron below). It only adds stories it has
-- not seen before (and refreshes status notices), so when a source changes
-- its page layout and nothing can be read, the stories already saved keep
-- showing.
--
-- `body` is the short article shown inside the app: a few opening
-- paragraphs. "Read full article" opens `url` on the original site.

create table if not exists public.news_items (
  id            uuid primary key default gen_random_uuid(),
  source        text not null check (source in ('arc', 'circle', 'arc_status', 'meshport')),
  url           text unique,
  title         text not null check (char_length(title) between 1 and 300),
  summary       text,
  body          text[] not null default '{}',
  image_url     text,
  topic         text,
  read_minutes  int,
  status_label  text,
  published_at  timestamptz not null default now(),
  fetched_at    timestamptz not null default now(),
  hidden        boolean not null default false,
  created_by    uuid
);

create index if not exists news_items_feed_idx on public.news_items (published_at desc) where not hidden;
create index if not exists news_items_source_feed_idx on public.news_items (source, published_at desc) where not hidden;

alter table public.news_items enable row level security;

-- Everyone (including the app's anonymous sessions) can read visible stories;
-- admins also see hidden ones so they can un-hide them.
drop policy if exists news_items_read on public.news_items;
create policy news_items_read on public.news_items
  for select to anon, authenticated
  using (not hidden or exists (select 1 from public.admin_users a where a.id = auth.uid()));

-- Admins write MeshPort posts…
drop policy if exists news_items_admin_insert on public.news_items;
create policy news_items_admin_insert on public.news_items
  for insert to authenticated
  with check (source = 'meshport' and exists (select 1 from public.admin_users a where a.id = auth.uid()));

drop policy if exists news_items_admin_delete on public.news_items;
create policy news_items_admin_delete on public.news_items
  for delete to authenticated
  using (source = 'meshport' and exists (select 1 from public.admin_users a where a.id = auth.uid()));

-- …and can edit MeshPort posts or hide any story (news-sync never touches
-- `hidden`, so a hidden Arc/Circle story stays hidden).
drop policy if exists news_items_admin_update on public.news_items;
create policy news_items_admin_update on public.news_items
  for update to authenticated
  using (exists (select 1 from public.admin_users a where a.id = auth.uid()))
  with check (exists (select 1 from public.admin_users a where a.id = auth.uid()));

revoke all on public.news_items from anon, authenticated;
grant select on public.news_items to anon, authenticated;
grant insert, update, delete on public.news_items to authenticated;

-- Fill / refresh from the three outside sources every 30 minutes.
select cron.unschedule('news-sync')
where exists (select 1 from cron.job where jobname = 'news-sync');

select cron.schedule(
  'news-sync',
  '*/30 * * * *',
  $$
  select net.http_post(
    url     := 'https://cvvpzfvzweszuuxvaayb.supabase.co/functions/v1/news-sync',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'claim_worker_service_key')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
