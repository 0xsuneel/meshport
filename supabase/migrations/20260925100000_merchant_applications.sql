-- ═══════════════════════════════════════════════════════════════════════════
-- Merchant accounts
--
-- A user applies from Profile → Apply for merchant. An admin approves or
-- rejects it from Admin → Merchants. Only an APPROVED application unlocks the
-- merchant flow (Ledger in the Multichain Hub, auto-collect, "Payment
-- received" history). Pending / rejected / revoked users keep the normal flow.
--
-- Nothing here touches the normal user flow: no existing table changes shape
-- except ub_claim_intents gaining a `merchant` flag (default false).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.merchant_applications (
  id              uuid        primary key default gen_random_uuid(),
  auth_uid        uuid        not null default auth.uid(),
  user_id         text,                    -- users.id (filled server-side)
  wallet_address  text,                    -- users.wallet_address (filled server-side)
  username        text,                    -- users.username (filled server-side)
  business_name   text        not null check (length(trim(business_name)) between 2 and 80),
  business_type   text        check (business_type is null or length(business_type) <= 60),
  contact         text        check (contact is null or length(contact) <= 120),
  description     text        check (description is null or length(description) <= 500),
  status          text        not null default 'pending'
                              check (status in ('pending', 'approved', 'rejected', 'revoked')),
  review_note     text,
  reviewed_by     text,
  reviewed_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One open application (pending or approved) per user at a time.
create unique index if not exists merchant_applications_one_open
  on public.merchant_applications (auth_uid) where status in ('pending', 'approved');
create index if not exists merchant_applications_status
  on public.merchant_applications (status, created_at desc);

-- Identity comes from the users table, never from the client.
create or replace function public.merchant_applications_before_write()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare u record;
begin
  if tg_op = 'INSERT' then
    select id, wallet_address, username into u from public.users where auth_uid = new.auth_uid limit 1;
    if u.id is null then
      raise exception 'No MeshPort account found for this session';
    end if;
    new.user_id        := u.id::text;
    new.wallet_address := lower(u.wallet_address);
    new.username       := u.username;
    new.status         := 'pending';
    new.review_note    := null;
    new.reviewed_by    := null;
    new.reviewed_at    := null;
  else
    -- Applicant details never change after submission.
    new.auth_uid := old.auth_uid; new.user_id := old.user_id;
    new.wallet_address := old.wallet_address; new.username := old.username;
    new.business_name := old.business_name; new.business_type := old.business_type;
    new.contact := old.contact; new.description := old.description;
    if new.status is distinct from old.status then new.reviewed_at := now(); end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists merchant_applications_before_write on public.merchant_applications;
create trigger merchant_applications_before_write
  before insert or update on public.merchant_applications
  for each row execute function public.merchant_applications_before_write();

-- Tell the user when an admin decides.
create or replace function public.merchant_applications_notify()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.status is distinct from old.status and new.user_id is not null then
    if new.status = 'approved' then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.user_id, 'merchant_approved', 'Merchant account approved',
              'You can now receive payments as ' || new.business_name || '. Open Multichain Hub → Ledger.', false);
    elsif new.status = 'rejected' then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.user_id, 'merchant_rejected', 'Merchant application not approved',
              coalesce(nullif(trim(new.review_note), ''), 'Your merchant application was not approved.'), false);
    elsif new.status = 'revoked' then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.user_id, 'merchant_revoked', 'Merchant access removed',
              coalesce(nullif(trim(new.review_note), ''), 'Your merchant access was removed by MeshPort.'), false);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists merchant_applications_notify on public.merchant_applications;
create trigger merchant_applications_notify
  after update on public.merchant_applications
  for each row execute function public.merchant_applications_notify();

alter table public.merchant_applications enable row level security;

drop policy if exists merchant_applications_insert_own on public.merchant_applications;
drop policy if exists merchant_applications_select_own on public.merchant_applications;
drop policy if exists merchant_applications_admin_all on public.merchant_applications;

create policy merchant_applications_insert_own on public.merchant_applications
  for insert with check (auth.uid() is not null and auth_uid = auth.uid() and status = 'pending');

create policy merchant_applications_select_own on public.merchant_applications
  for select using (auth_uid = auth.uid());

-- Only admins review (approve / reject / revoke).
create policy merchant_applications_admin_all on public.merchant_applications
  for all using (exists (select 1 from public.admin_users a where a.id = auth.uid()))
  with check (exists (select 1 from public.admin_users a where a.id = auth.uid()));

-- Server-side check any function can use.
create or replace function public.is_approved_merchant(p_wallet text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.merchant_applications
     where wallet_address = lower(p_wallet) and status = 'approved'
  )
$$;

alter publication supabase_realtime add table public.merchant_applications;

-- ── UB claims made by a merchant are shown as "Payment received" ──────────
alter table public.ub_claim_intents add column if not exists merchant boolean not null default false;

-- Only an approved merchant can flag a claim as a merchant payment.
create or replace function public.ub_claim_intents_merchant_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.merchant and not public.is_approved_merchant(new.wallet_address) then
    new.merchant := false;
  end if;
  return new;
end;
$$;

drop trigger if exists ub_claim_intents_merchant_guard on public.ub_claim_intents;
create trigger ub_claim_intents_merchant_guard
  before insert on public.ub_claim_intents
  for each row execute function public.ub_claim_intents_merchant_guard();

create or replace function public.ub_claim_intents_sync_activity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  k text := coalesce(lower(new.deposit_tx), 'ubclaim_' || new.id::text);
  chain text := case when new.source_chain = 'Polygon_Amoy_Testnet' then 'Polygon_Sepolia' else new.source_chain end;
  amt numeric := coalesce(new.send_amount, new.amount);
  extra jsonb := case when new.merchant then jsonb_build_object('merchant', true) else '{}'::jsonb end;
  n int;
begin
  begin
    if tg_op = 'INSERT' then
      insert into activity (wallet_address, tx_hash, activity_type, amount, usd_value, token_symbol,
                            source_chain, destination_chain, status, explorer_url, metadata, created_at)
      values (lower(new.wallet_address), k, 'claim', amt, amt, 'USDC',
              chain, 'Arc_Testnet', 'pending', null,
              jsonb_build_object('route', 'ub', 'claimed_amount', new.amount, 'ub_intent_id', new.id) || extra,
              coalesce(new.created_at, now()))
      on conflict do nothing;
      return new;
    end if;

    if new.status is distinct from old.status then
      if new.status = 'completed' then
        update activity
           set status = 'completed',
               error = null,
               destination_tx_hash = coalesce(lower(new.mint_tx), destination_tx_hash),
               explorer_url = case when new.mint_tx is not null then 'https://testnet.arcscan.app/tx/' || new.mint_tx else explorer_url end,
               amount = amt, usd_value = amt, arrived_amount = amt,
               metadata = coalesce(metadata, '{}'::jsonb)
                          || jsonb_build_object('route', 'ub', 'claimed_amount', new.amount, 'ub_intent_id', new.id, 'server_finished', true)
                          || extra
         where tx_hash = k and wallet_address = lower(new.wallet_address);
        get diagnostics n = row_count;
        if n = 0 then
          insert into activity (wallet_address, tx_hash, destination_tx_hash, activity_type, amount, usd_value, arrived_amount,
                                token_symbol, source_chain, destination_chain, status, explorer_url, metadata)
          values (lower(new.wallet_address), k, lower(new.mint_tx), 'claim', amt, amt, amt,
                  'USDC', chain, 'Arc_Testnet', 'completed',
                  case when new.mint_tx is not null then 'https://testnet.arcscan.app/tx/' || new.mint_tx end,
                  jsonb_build_object('route', 'ub', 'claimed_amount', new.amount, 'ub_intent_id', new.id, 'server_finished', true) || extra)
          on conflict do nothing;
        end if;
      elsif new.status in ('failed', 'expired') then
        update activity
           set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('ub_held', true)
         where tx_hash = k and wallet_address = lower(new.wallet_address) and status = 'pending';
      end if;
    end if;
  exception when others then
    raise warning 'ub_claim_intents_sync_activity: %', sqlerrm;
  end;
  return new;
end;
$function$;
