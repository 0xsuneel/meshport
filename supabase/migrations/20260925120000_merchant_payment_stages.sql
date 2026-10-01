-- Merchant payments paid on another chain now go through three visible
-- stages, each with a notification to the merchant:
--
--   confirmed  "Payment arriving"          customer paid the merchant's address
--                                           on e.g. Base (verified on-chain)
--   in_ledger  "Credited to Ledger"        the merchant's auto-collect put it in
--                                           Unified Balance and Gateway confirmed
--                                           it (ub_claim_intents waiting→submitted)
--   collected  "Moved to Arc balance"      the signed spend landed on Arc
--                                           (ub_claim_intents → completed); the
--                                           request is marked paid
--
-- Direct Arc payments skip the middle stages (paid immediately).

alter table public.merchant_payments drop constraint if exists merchant_payments_status_check;
alter table public.merchant_payments add constraint merchant_payments_status_check
  check (status in ('confirmed', 'in_ledger', 'collected'));

create or replace function public.merchant_notify(p_wallet text, p_type text, p_title text, p_message text)
returns void
language sql
security definer
set search_path to 'public'
as $$
  insert into public.notifications (user_id, type, title, message, read)
  select a.user_id, p_type, p_title, p_message, false
    from public.merchant_applications a
   where a.wallet_address = lower(p_wallet) and a.status = 'approved' and a.user_id is not null
   limit 1
$$;

create or replace function public.merchant_chain_label(p_chain text)
returns text
language sql
immutable
as $$
  select case p_chain
    when 'Arc_Testnet' then 'Arc' when 'Ethereum_Sepolia' then 'Ethereum' when 'Base_Sepolia' then 'Base'
    when 'Arbitrum_Sepolia' then 'Arbitrum' when 'Optimism_Sepolia' then 'Optimism' when 'Polygon_Sepolia' then 'Polygon'
    when 'Polygon_Amoy_Testnet' then 'Polygon' when 'Avalanche_Fuji' then 'Avalanche' when 'HyperEVM_Testnet' then 'HyperEVM'
    when 'Sei_Testnet' then 'Sei' when 'Unichain_Sepolia' then 'Unichain'
    else replace(p_chain, '_', ' ') end
$$;

-- Stage 1: customer paid on another chain → "Payment arriving".
create or replace function public.merchant_payments_after_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare who text;
begin
  if new.method = 'external_ub' then
    who := coalesce(nullif(new.customer_username, ''), substr(new.from_address, 1, 6) || '…' || right(new.from_address, 4));
    perform public.merchant_notify(new.merchant_wallet, 'merchant_payment_arriving', 'Payment arriving',
      who || ' paid you $' || trim(to_char(new.amount, 'FM999999990.00')) || ' USDC on '
        || public.merchant_chain_label(new.source_chain) || ' — moving it to your Ledger');
  end if;
  return new;
end;
$$;

drop trigger if exists merchant_payments_after_insert on public.merchant_payments;
create trigger merchant_payments_after_insert
  after insert on public.merchant_payments
  for each row execute function public.merchant_payments_after_insert();

-- Auto-collect started a Unified Balance claim on a chain: link the waiting
-- payments on that chain to it, so each stage is tracked exactly.
create or replace function public.ub_claim_intents_link_merchant_payments()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare chain text := case when new.source_chain = 'Polygon_Amoy_Testnet' then 'Polygon_Sepolia' else new.source_chain end;
begin
  if new.merchant then
    update public.merchant_payments
       set ub_intent_id = new.id
     where merchant_wallet = lower(new.wallet_address) and source_chain = chain
       and method = 'external_ub' and status = 'confirmed' and ub_intent_id is null;
  end if;
  return new;
end;
$$;

drop trigger if exists ub_claim_intents_link_merchant_payments on public.ub_claim_intents;
create trigger ub_claim_intents_link_merchant_payments
  after insert on public.ub_claim_intents
  for each row execute function public.ub_claim_intents_link_merchant_payments();

-- Stages 2 and 3.
create or replace function public.merchant_payments_mark_collected()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  chain text := case when new.source_chain = 'Polygon_Amoy_Testnet' then 'Polygon_Sepolia' else new.source_chain end;
  total numeric;
begin
  if new.status is not distinct from old.status then return new; end if;

  -- Gateway confirmed the deposit and the spend to Arc was submitted.
  if new.status = 'submitted' then
    with moved as (
      update public.merchant_payments p
         set status = 'in_ledger', ub_intent_id = coalesce(p.ub_intent_id, new.id)
       where p.merchant_wallet = lower(new.wallet_address) and p.source_chain = chain
         and p.method = 'external_ub' and p.status = 'confirmed'
         and (p.ub_intent_id = new.id or (p.ub_intent_id is null and p.created_at <= new.created_at + interval '2 minutes'))
      returning p.amount
    )
    select sum(amount) into total from moved;
    if total > 0 then
      perform public.merchant_notify(new.wallet_address, 'merchant_ledger_credited', 'Credited to Ledger',
        '$' || trim(to_char(total, 'FM999999990.00')) || ' USDC from ' || public.merchant_chain_label(chain)
          || ' is in your Ledger — moving it to your Arc balance');
    end if;
  end if;

  -- The spend landed on Arc.
  if new.status = 'completed' then
    update public.merchant_payments p
       set status = 'collected', collected_at = now(), ub_intent_id = coalesce(p.ub_intent_id, new.id), arc_tx_hash = lower(new.mint_tx)
     where p.merchant_wallet = lower(new.wallet_address) and p.source_chain = chain
       and p.method = 'external_ub' and p.status in ('confirmed', 'in_ledger')
       and (p.ub_intent_id = new.id or (p.ub_intent_id is null and p.created_at <= new.created_at + interval '2 minutes'));

    update public.merchant_payment_intents i
       set status = 'paid', paid_at = coalesce(i.paid_at, now()),
           destination_tx_hash = coalesce(i.destination_tx_hash, lower(new.mint_tx)),
           ub_intent_id = coalesce(i.ub_intent_id, new.id)
     where i.merchant_wallet = lower(new.wallet_address)
       and i.status = 'processing'
       and i.received_amount >= i.requested_amount * 0.999
       and not exists (select 1 from public.merchant_payments p where p.intent_id = i.id and p.method = 'external_ub' and p.status <> 'collected');
  end if;
  return new;
end;
$$;

-- Final notification wording: say where the money is now.
create or replace function public.merchant_payment_intents_notify()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare who text;
begin
  if new.status = 'paid' and old.status is distinct from 'paid' and new.merchant_user_id is not null then
    who := coalesce(nullif(new.customer_username, ''), case when new.customer_wallet is not null
             then substr(new.customer_wallet, 1, 6) || '…' || right(new.customer_wallet, 4) end, 'A customer');
    insert into public.notifications (user_id, type, title, message, read)
    values (new.merchant_user_id, 'merchant_payment_received', 'Payment received',
            who || ' paid you $' || trim(to_char(new.received_amount, 'FM999999990.00')) || ' USDC'
              || coalesce(' · ' || nullif(new.note, ''), '')
              || case when new.payment_method = 'external_ub' then ' · now in your Arc balance' else '' end, false);
  end if;
  return new;
end;
$$;
