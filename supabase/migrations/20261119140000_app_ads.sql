-- Ads (19 Nov 2026): the Home banner's slides and the success screens' "For
-- you" card, managed from Admin → Ads instead of being fixed in the app.
-- MeshPort's own features (sponsor null, "From MeshPort") and partners
-- (sponsor set, shown "Sponsored · <sponsor>"). Everyone reads the ads that
-- are on; only admin_users can add, change or remove them.
create table if not exists public.app_ads (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(title) between 1 and 60),
  body        text not null default '' check (char_length(body) <= 120),
  -- An app page ("/swap") or a website (https://…).
  link        text not null check (link ~ '^/[A-Za-z0-9/_?=&.-]*$' or link ~ '^https://[^\s]+$'),
  -- Uploaded image (ads bucket) or one of the app's own images ("/logos/…").
  image_url   text check (image_url is null or image_url ~ '^https://[^\s]+$' or image_url ~ '^/[A-Za-z0-9/_.-]+$'),
  -- MeshPort's built-in icon for its own features (hub, p2p, swap, chat, bulk) when there's no image.
  icon        text check (icon is null or icon in ('hub', 'p2p', 'swap', 'chat', 'bulk')),
  -- null: MeshPort's own. Otherwise the partner's name ("Sponsored · …").
  sponsor     text check (sponsor is null or char_length(sponsor) between 1 and 40),
  on_home     boolean not null default true,
  on_success  boolean not null default true,
  active      boolean not null default true,
  -- An app feature switch (app_settings key) that must be on, e.g. p2p_enabled.
  feature_flag text,
  sort        integer not null default 100,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.app_ads enable row level security;

drop policy if exists app_ads_read on public.app_ads;
create policy app_ads_read on public.app_ads for select
  using (active or exists (select 1 from public.admin_users a where a.id = auth.uid()));
drop policy if exists app_ads_admin_insert on public.app_ads;
create policy app_ads_admin_insert on public.app_ads for insert
  with check (exists (select 1 from public.admin_users a where a.id = auth.uid()));
drop policy if exists app_ads_admin_update on public.app_ads;
create policy app_ads_admin_update on public.app_ads for update
  using (exists (select 1 from public.admin_users a where a.id = auth.uid()))
  with check (exists (select 1 from public.admin_users a where a.id = auth.uid()));
drop policy if exists app_ads_admin_delete on public.app_ads;
create policy app_ads_admin_delete on public.app_ads for delete
  using (exists (select 1 from public.admin_users a where a.id = auth.uid()));

grant select on public.app_ads to anon, authenticated;
grant insert, update, delete on public.app_ads to authenticated;

-- Ad images: public to read, only admins upload / replace / remove.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ads', 'ads', true, 1048576, array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])
on conflict (id) do update set public = true, file_size_limit = 1048576,
  allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];

drop policy if exists ads_images_admin_insert on storage.objects;
create policy ads_images_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'ads' and exists (select 1 from public.admin_users a where a.id = auth.uid()));
drop policy if exists ads_images_admin_update on storage.objects;
create policy ads_images_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'ads' and exists (select 1 from public.admin_users a where a.id = auth.uid()));
drop policy if exists ads_images_admin_delete on storage.objects;
create policy ads_images_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'ads' and exists (select 1 from public.admin_users a where a.id = auth.uid()));

-- The ads the app showed until now (MeshPort's features), and Arc Portal.
insert into public.app_ads (title, body, link, icon, image_url, sponsor, feature_flag, sort)
select * from (values
  ('Multichain Hub',  'Your USDC across 20+ chains',       '/multichain',  'hub',  null, null, null,          10),
  ('Arc Portal',      'Explore the Arc ecosystem',         'https://portal.arc.io', null, '/logos/chains/arc.svg', 'portal.arc.io', null, 15),
  ('P2P Marketplace', 'Buy & sell USDC safely with escrow', '/p2p',        'p2p',  null, null, 'p2p_enabled', 20),
  ('Instant Swap',    'Change currency in seconds on Arc', '/swap',        'swap', null, null, null,          30),
  ('Pay in Chat',     'Send money as you chat',            '/chat',        'chat', null, null, null,          40),
  ('Bulk Payout',     'Pay many people at once',           '/bulk-payout', 'bulk', null, null, null,          50)
) v(title, body, link, icon, image_url, sponsor, feature_flag, sort)
where not exists (select 1 from public.app_ads);
