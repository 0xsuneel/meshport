-- Alchemy Address Activity webhooks: incoming transfers are pushed to
-- alchemy-webhook instead of MeshPort scanning every chain every few seconds.
--
--   alchemy_webhooks       one Alchemy webhook per network (id only - the
--                          signing keys are Edge Function secrets)
--   users_alchemy_track    a new or changed wallet is added to every webhook
--                          (alchemy-addresses), the old one removed
--   alchemy-addresses-full daily: add every wallet again (idempotent), in case
--                          a trigger call was lost

create table if not exists public.alchemy_webhooks (
  network     text primary key,          -- Alchemy enum, e.g. ARC_TESTNET
  webhook_id  text not null unique,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
alter table public.alchemy_webhooks enable row level security;
revoke all on public.alchemy_webhooks from anon, authenticated;

create or replace function public.alchemy_track_wallet()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_w text := lower(coalesce(new.wallet_address, ''));
  old_w text := case when tg_op = 'UPDATE' then lower(coalesce(old.wallet_address, '')) else '' end;
begin
  if new_w = old_w or not exists (select 1 from alchemy_webhooks where active) then
    return new;
  end if;
  perform net.http_post(
    url := 'https://cvvpzfvzweszuuxvaayb.supabase.co/functions/v1/alchemy-addresses',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'claim_worker_service_key')),
    body := jsonb_build_object(
      'add',    case when new_w <> '' then jsonb_build_array(new_w) else '[]'::jsonb end,
      'remove', case when old_w <> '' then jsonb_build_array(old_w) else '[]'::jsonb end),
    timeout_milliseconds := 20000);
  return new;
exception when others then
  -- Never block a sign-up on this: the daily full sync adds it later.
  raise warning 'alchemy_track_wallet: %', sqlerrm;
  return new;
end $$;

drop trigger if exists users_alchemy_track on public.users;
create trigger users_alchemy_track
  after insert or update of wallet_address on public.users
  for each row execute function public.alchemy_track_wallet();

select cron.unschedule('alchemy-addresses-full') where exists (select 1 from cron.job where jobname = 'alchemy-addresses-full');
select cron.schedule('alchemy-addresses-full', '37 4 * * *', $cron$
  select net.http_post(
    url := 'https://cvvpzfvzweszuuxvaayb.supabase.co/functions/v1/alchemy-addresses',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'claim_worker_service_key')),
    body := jsonb_build_object('mode', 'full'),
    timeout_milliseconds := 60000)
  where exists (select 1 from public.alchemy_webhooks where active);
$cron$);
