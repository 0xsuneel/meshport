-- On-chain names (MeshPortNames on Arc testnet).
--
-- Every username ("name.arc") - personal or business - is also registered in
-- the MeshPortNames contract. Supabase stays the app's working copy; the
-- name-register edge function writes the chain and records the result here.
--
--   account_type   personal | business. Chosen at sign-up; written only by
--                  name-register (after the user's signature), never by the
--                  client, so nobody can label themselves a business.
--   store_name     business display name ("Sharma Chai Corner"); the
--                  username is the store's handle (sharmachai.arc).
--   name_onchain_* where the on-chain registration stands.
--
-- The registrar key (pays Arc gas for every registration, and owns the
-- contract on testnet) is generated here inside Vault and only readable by
-- the service role - it never leaves the database / edge function.

alter table public.users
  add column if not exists account_type       text not null default 'personal',
  add column if not exists store_name         text,
  add column if not exists name_onchain_status text not null default 'none',
  add column if not exists name_onchain_tx    text,
  add column if not exists name_onchain_at    timestamptz,
  add column if not exists name_onchain_error text,
  -- The user's signed Register request (name, kind, displayName, deadline,
  -- signature), kept so a failed send can be retried until its deadline.
  -- Never granted to clients.
  add column if not exists name_onchain_request jsonb;

do $$ begin
  alter table public.users add constraint users_account_type_chk check (account_type in ('personal', 'business'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.users add constraint users_name_onchain_status_chk check (name_onchain_status in ('none', 'pending', 'registered', 'failed'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.users add constraint users_store_name_len_chk check (store_name is null or char_length(store_name) between 2 and 64);
exception when duplicate_object then null; end $$;

-- Readable like the rest of the public profile; never client-writable.
grant select (account_type, store_name, name_onchain_status, name_onchain_tx, name_onchain_at)
  on public.users to anon, authenticated;

create index if not exists users_name_onchain_status_idx
  on public.users (name_onchain_status) where name_onchain_status in ('none', 'pending', 'failed');

-- ── Registrar key ───────────────────────────────────────────────────────────
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'name_registrar_key') then
    perform vault.create_secret(
      '0x' || encode(extensions.gen_random_bytes(32), 'hex'),
      'name_registrar_key',
      'MeshPortNames registrar (and testnet owner) private key - read only by the name-register edge function');
  end if;
end $$;

create or replace function public.name_registrar_key()
returns text
language sql
security definer
set search_path = ''
as $$ select decrypted_secret from vault.decrypted_secrets where name = 'name_registrar_key' limit 1 $$;

revoke all on function public.name_registrar_key() from public, anon, authenticated;
grant execute on function public.name_registrar_key() to service_role;

-- ── Merchant review → chain ─────────────────────────────────────────────────
-- When an admin approves, rejects or revokes a merchant, the name's Business
-- kind / verified flag follows on-chain. name-register reads the application
-- itself, so the call carries no decision - only "look at this wallet".
create or replace function public.merchant_applications_sync_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status and new.wallet_address is not null then
    perform net.http_post(
      url     := 'https://cvvpzfvzweszuuxvaayb.supabase.co/functions/v1/name-register',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'claim_worker_service_key')),
      body    := jsonb_build_object('action', 'business-sync', 'wallet', new.wallet_address),
      timeout_milliseconds := 30000
    );
  end if;
  return new;
end $$;

drop trigger if exists merchant_applications_sync_name on public.merchant_applications;
create trigger merchant_applications_sync_name
  after update of status on public.merchant_applications
  for each row execute function public.merchant_applications_sync_name();

-- ── Retry job ───────────────────────────────────────────────────────────────
-- Picks up registrations that are still pending (slow receipt) or failed
-- (RPC hiccup, registrar out of gas) every 10 minutes. Same auth as the other
-- cron-called functions (claim_worker_service_key in Vault).
do $$ begin
  perform cron.unschedule('name-register-sync');
exception when others then null; end $$;

select cron.schedule(
  'name-register-sync',
  '*/10 * * * *',
  $cron$
  select net.http_post(
    url     := 'https://cvvpzfvzweszuuxvaayb.supabase.co/functions/v1/name-register',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'claim_worker_service_key')),
    body    := jsonb_build_object('action', 'sync'),
    timeout_milliseconds := 55000
  );
  $cron$
);
