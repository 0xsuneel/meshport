-- Merchant payments on other chains + scheduled auto-convert.
--
-- 1. Every USDC payment to an approved merchant's address on another chain
--    (Base, Ethereum, …) is recorded by the deposit watcher as a chain
--    receipt and notified at once: "Payment received on Base". Orders paid
--    on another chain are marked PAID straight away (the money has arrived —
--    only its conversion to Arc waits).
-- 2. Nothing is converted instantly. Merchants choose Auto-convert:
--      off → funds stay on their chains (manual collect still possible)
--      on  → every 6 hours: deposit all chains into the Ledger (UB) in one
--            run, then ONE Ledger → Arc transfer an hour later (pre-signed,
--            submitted by the server at its time). Under $2 in total → left
--            for the next run. Each run happens once per slot.
-- 3. When the transfer lands: "Merchant funds moved to Arc".

-- ── Chain receipts ─────────────────────────────────────────────────────────
create table if not exists public.merchant_chain_receipts (
  id uuid primary key default gen_random_uuid(),
  merchant_wallet text not null,
  source_chain text not null,
  tx_hash text not null,
  from_address text,
  amount numeric not null,
  order_number text,
  status text not null default 'received' check (status in ('received', 'converting', 'converted')),
  ub_intent_id uuid,
  arc_tx_hash text,
  converted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (source_chain, tx_hash, merchant_wallet)
);
create index if not exists merchant_chain_receipts_wallet on public.merchant_chain_receipts (merchant_wallet, created_at desc);
alter table public.merchant_chain_receipts enable row level security;
drop policy if exists mcr_select_own on public.merchant_chain_receipts;
create policy mcr_select_own on public.merchant_chain_receipts for select using (
  merchant_wallet in (select lower(a.wallet_address) from public.merchant_applications a where a.auth_uid = auth.uid() and a.status = 'approved')
  or exists (select 1 from public.admin_users x where x.id = auth.uid())
);

-- ── Auto-convert schedule ──────────────────────────────────────────────────
create table if not exists public.merchant_auto_convert (
  auth_uid uuid primary key,
  wallet_address text not null,
  enabled boolean not null default false,
  next_run_at timestamptz,
  last_run_at timestamptz,
  running_until timestamptz,
  last_result text,
  updated_at timestamptz not null default now()
);
alter table public.merchant_auto_convert enable row level security;
drop policy if exists mac_select_own on public.merchant_auto_convert;
create policy mac_select_own on public.merchant_auto_convert for select using (auth_uid = auth.uid());

-- Turn auto-convert on/off. Turning it on schedules the first run: funds
-- into the Ledger in 5 hours, to Arc an hour after that.
create or replace function public.merchant_auto_convert_set(p_enabled boolean)
returns public.merchant_auto_convert
language plpgsql security definer set search_path to 'public'
as $$
declare w text; r public.merchant_auto_convert;
begin
  select lower(wallet_address) into w from public.merchant_applications
   where auth_uid = auth.uid() and status = 'approved' order by created_at desc limit 1;
  if w is null then raise exception 'Only approved merchants can use auto-convert'; end if;
  insert into public.merchant_auto_convert as m (auth_uid, wallet_address, enabled, next_run_at, updated_at)
  values (auth.uid(), w, p_enabled, case when p_enabled then now() + interval '5 hours' end, now())
  on conflict (auth_uid) do update
    set wallet_address = excluded.wallet_address,
        enabled = p_enabled,
        next_run_at = case when not p_enabled then null
                           when m.enabled and m.next_run_at is not null then m.next_run_at
                           else now() + interval '5 hours' end,
        running_until = case when p_enabled then m.running_until end,
        updated_at = now()
  returning * into r;
  return r;
end $$;

-- Claims the due run (once): true only if auto-convert is on, the run is
-- due and no other device/tab is running it.
create or replace function public.merchant_auto_convert_claim()
returns boolean
language plpgsql security definer set search_path to 'public'
as $$
declare n int;
begin
  update public.merchant_auto_convert
     set running_until = now() + interval '20 minutes', updated_at = now()
   where auth_uid = auth.uid() and enabled and next_run_at is not null and next_run_at <= now()
     and (running_until is null or running_until < now());
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- Finishes the run and books the next one: 6 hours later (or a single retry
-- in 30 minutes when the run couldn't finish, e.g. no network).
create or replace function public.merchant_auto_convert_done(p_result text, p_retry boolean default false)
returns public.merchant_auto_convert
language plpgsql security definer set search_path to 'public'
as $$
declare r public.merchant_auto_convert;
begin
  update public.merchant_auto_convert
     set running_until = null, last_run_at = now(), last_result = left(p_result, 200),
         next_run_at = case when not enabled then null
                            when p_retry then now() + interval '30 minutes'
                            else now() + interval '6 hours' end,
         updated_at = now()
   where auth_uid = auth.uid()
  returning * into r;
  return r;
end $$;

revoke all on function public.merchant_auto_convert_set(boolean) from public, anon;
revoke all on function public.merchant_auto_convert_claim() from public, anon;
revoke all on function public.merchant_auto_convert_done(text, boolean) from public, anon;
grant execute on function public.merchant_auto_convert_set(boolean) to authenticated;
grant execute on function public.merchant_auto_convert_claim() to authenticated;
grant execute on function public.merchant_auto_convert_done(text, boolean) to authenticated;

-- ── Scheduled combined Ledger → Arc transfers ──────────────────────────────
alter table public.ub_claim_intents
  add column if not exists not_before timestamptz,
  add column if not exists source_chains text[],
  add column if not exists auto_convert boolean not null default false;

-- "Payment received on Base" for payments that aren't an order (orders get
-- their own "Payment received · Order #…").
create or replace function public.merchant_chain_receipts_notify()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare lbl text := public.merchant_chain_label(new.source_chain); auto boolean;
begin
  if new.order_number is null then
    select enabled into auto from public.merchant_auto_convert where wallet_address = new.merchant_wallet limit 1;
    perform public.merchant_notify(new.merchant_wallet, 'merchant_chain_payment', 'Payment received on ' || lbl,
      '$' || trim(to_char(new.amount, 'FM999999990.00')) || ' USDC from '
        || coalesce(substr(new.from_address, 1, 6) || '…' || right(new.from_address, 4), 'a wallet') || ' on ' || lbl
        || case when coalesce(auto, false) then ' — auto-convert moves it to your Arc balance at the next run'
                else ' — it stays on ' || lbl || ' (turn on auto-convert in Ledger to move it to Arc)' end);
  end if;
  return new;
end $$;
drop trigger if exists merchant_chain_receipts_notify on public.merchant_chain_receipts;
create trigger merchant_chain_receipts_notify after insert on public.merchant_chain_receipts
  for each row execute function public.merchant_chain_receipts_notify();

-- Link the payments/receipts a new Ledger → Arc transfer covers.
create or replace function public.ub_claim_intents_link_merchant_payments()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare chains text[];
begin
  if new.merchant then
    select array_agg(case when c = 'Polygon_Amoy_Testnet' then 'Polygon_Sepolia' else c end)
      into chains from unnest(coalesce(new.source_chains, array[new.source_chain])) c;
    update public.merchant_payments
       set ub_intent_id = new.id
     where merchant_wallet = lower(new.wallet_address) and source_chain = any(chains)
       and method = 'external_ub' and status = 'confirmed' and ub_intent_id is null;
    update public.merchant_chain_receipts
       set status = 'converting', ub_intent_id = new.id
     where merchant_wallet = lower(new.wallet_address) and source_chain = any(chains)
       and status = 'received' and created_at <= new.created_at + interval '2 minutes';
  end if;
  return new;
end $$;

-- Transfer progress → payments/receipts, and the "moved to Arc" notification.
create or replace function public.merchant_payments_mark_collected()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare
  chains text[];
  total numeric;
  names text;
begin
  if new.status is not distinct from old.status then return new; end if;
  select array_agg(case when c = 'Polygon_Amoy_Testnet' then 'Polygon_Sepolia' else c end)
    into chains from unnest(coalesce(new.source_chains, array[new.source_chain])) c;
  select string_agg(distinct public.merchant_chain_label(c), ', ') into names from unnest(chains) c;

  if new.status = 'submitted' then
    with moved as (
      update public.merchant_payments p
         set status = 'in_ledger', ub_intent_id = coalesce(p.ub_intent_id, new.id)
       where p.merchant_wallet = lower(new.wallet_address) and p.source_chain = any(chains)
         and p.method = 'external_ub' and p.status = 'confirmed'
         and (p.ub_intent_id = new.id or (p.ub_intent_id is null and p.created_at <= new.created_at + interval '2 minutes'))
      returning p.amount
    )
    select sum(amount) into total from moved;
    if total > 0 and not new.auto_convert then
      perform public.merchant_notify(new.wallet_address, 'merchant_ledger_credited', 'Credited to Ledger',
        '$' || trim(to_char(total, 'FM999999990.00')) || ' USDC from ' || names
          || ' is in your Ledger — moving it to your Arc balance');
    end if;
  end if;

  if new.status = 'completed' then
    update public.merchant_payments p
       set status = 'collected', collected_at = now(), ub_intent_id = coalesce(p.ub_intent_id, new.id), arc_tx_hash = lower(new.mint_tx)
     where p.merchant_wallet = lower(new.wallet_address) and p.source_chain = any(chains)
       and p.method = 'external_ub' and p.status in ('confirmed', 'in_ledger')
       and (p.ub_intent_id = new.id or (p.ub_intent_id is null and p.created_at <= new.created_at + interval '2 minutes'));

    update public.merchant_chain_receipts r
       set status = 'converted', converted_at = now(), arc_tx_hash = lower(new.mint_tx), ub_intent_id = coalesce(r.ub_intent_id, new.id)
     where r.merchant_wallet = lower(new.wallet_address)
       and (r.ub_intent_id = new.id or (r.status in ('received', 'converting') and r.source_chain = any(chains) and r.created_at <= new.created_at + interval '2 minutes'));

    -- Older orders still waiting in 'processing' (before orders were marked
    -- paid on arrival).
    update public.merchant_payment_intents i
       set status = 'paid', paid_at = coalesce(i.paid_at, now()),
           destination_tx_hash = coalesce(i.destination_tx_hash, lower(new.mint_tx)),
           ub_intent_id = coalesce(i.ub_intent_id, new.id)
     where i.merchant_wallet = lower(new.wallet_address)
       and i.status = 'processing'
       and i.received_amount >= i.requested_amount * 0.999
       and not exists (select 1 from public.merchant_payments p where p.intent_id = i.id and p.method = 'external_ub' and p.status <> 'collected');

    if new.merchant then
      perform public.merchant_notify(new.wallet_address, 'merchant_funds_moved', 'Merchant funds moved to Arc',
        '$' || trim(to_char(coalesce(new.send_amount, new.amount), 'FM999999990.00')) || ' USDC from ' || names
          || ' is now in your Arc main balance');
    end if;
  end if;

  if new.status in ('failed', 'expired') then
    -- Not converted: back to waiting so the next run picks them up.
    update public.merchant_chain_receipts
       set status = 'received', ub_intent_id = null
     where ub_intent_id = new.id and status = 'converting';
  end if;
  return new;
end $$;

-- Orders paid on another chain are PAID on arrival — no separate "arriving"
-- notification (the order's own "Payment received · Order #… on Base" covers it).
create or replace function public.merchant_payments_after_insert()
returns trigger language plpgsql security definer set search_path to 'public'
as $$ begin return new; end $$;

-- Order notifications name the chain when it isn't Arc.
create or replace function public.merchant_payment_intents_notify()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  who text;
  ord text := coalesce(' · Order #' || new.order_number, '');
  shop text := coalesce(nullif(new.merchant_name, ''), 'the merchant');
  amt text := '$' || trim(to_char(new.received_amount, 'FM999999990.00')) || ' USDC';
  onchain text := case when new.source_chain is not null and new.source_chain <> 'Arc_Testnet'
                       then ' on ' || public.merchant_chain_label(new.source_chain) else '' end;
begin
  who := coalesce(nullif(new.customer_username, ''), case when new.customer_wallet is not null
           then substr(new.customer_wallet, 1, 6) || '…' || right(new.customer_wallet, 4) end, 'A customer');

  if new.status = 'paid' and old.status is distinct from 'paid' and old.status is distinct from 'processing'
     and not coalesce(new.completed_by_merchant, false) then
    if new.merchant_user_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.merchant_user_id, 'merchant_payment_received', 'Payment received' || onchain,
              who || ' paid you ' || amt || onchain || ord || coalesce(' · ' || nullif(new.note, ''), ''), false);
    end if;
    if new.customer_user_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.customer_user_id, 'merchant_order_paid', 'Order paid',
              'You paid ' || amt || ' to ' || shop || onchain || ord, false);
    end if;
  end if;

  if new.status = 'partially_paid' and new.received_amount is distinct from old.received_amount then
    if new.merchant_user_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.merchant_user_id, 'merchant_payment_partial', 'Partial payment',
              who || ' paid ' || amt || ' of $' || trim(to_char(new.requested_amount, 'FM999999990.00')) || ' USDC' || onchain || ord, false);
    end if;
    if new.customer_user_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.customer_user_id, 'merchant_payment_partial', 'Partial payment',
              'You paid ' || amt || ' of $' || trim(to_char(new.requested_amount, 'FM999999990.00')) || ' USDC to ' || shop || onchain || ord, false);
    end if;
  end if;

  if new.status = 'paid' and old.status is distinct from 'paid' and coalesce(new.completed_by_merchant, false)
     and new.customer_user_id is not null then
    insert into public.notifications (user_id, type, title, message, read)
    values (new.customer_user_id, 'merchant_order_completed', 'Order completed',
            shop || ' marked' || coalesce(' Order #' || new.order_number, ' your order') || ' as completed', false);
  end if;
  return new;
end;
$$;

-- Activity row for an auto-convert transfer carries the chains it covered.
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
  extra jsonb := (case when new.merchant then jsonb_build_object('merchant', true) else '{}'::jsonb end)
              || (case when new.auto_convert then jsonb_build_object('auto_convert', true, 'chains', to_jsonb(new.source_chains)) else '{}'::jsonb end);
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
