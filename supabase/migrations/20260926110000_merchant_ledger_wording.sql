-- Merchant Ledger wording:
--   money arrives on another chain → "Payment credited to your Base Ledger"
--   Ledger → Arc transfer starts   → "Ledger funds moving to Arc"
--   it lands on Arc                → "Ledger payment received"

create or replace function public.merchant_chain_receipts_notify()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare lbl text := public.merchant_chain_label(new.source_chain); auto boolean;
begin
  if new.order_number is null then
    select enabled into auto from public.merchant_auto_convert where wallet_address = new.merchant_wallet limit 1;
    perform public.merchant_notify(new.merchant_wallet, 'merchant_chain_payment', 'Payment credited to your ' || lbl || ' Ledger',
      '$' || trim(to_char(new.amount, 'FM999999990.00')) || ' USDC from '
        || coalesce(substr(new.from_address, 1, 6) || '…' || right(new.from_address, 4), 'a wallet') || ' is in your ' || lbl || ' Ledger'
        || case when coalesce(auto, false) then ' · it moves to your Arc main balance at the next auto-convert'
                else ' · turn on auto-convert in Ledger to move it to Arc' end);
  end if;
  return new;
end $$;

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
    if new.merchant then
      perform public.merchant_notify(new.wallet_address, 'merchant_ledger_moving', 'Ledger funds moving to Arc',
        'Your Ledger funds — $' || trim(to_char(coalesce(new.send_amount, new.amount), 'FM999999990.00')) || ' USDC from ' || names
          || ' — are moving to your Arc main balance');
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
      perform public.merchant_notify(new.wallet_address, 'merchant_funds_moved', 'Ledger payment received',
        '$' || trim(to_char(coalesce(new.send_amount, new.amount), 'FM999999990.00')) || ' USDC from your ' || names
          || ' Ledger is now in your Arc main balance');
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
      values (new.merchant_user_id, 'merchant_payment_received',
              case when onchain <> '' then 'Payment credited to your ' || public.merchant_chain_label(new.source_chain) || ' Ledger' else 'Payment received' end,
              who || ' paid you ' || amt || ord || coalesce(' · ' || nullif(new.note, ''), '')
                || case when onchain <> '' then ' · in your ' || public.merchant_chain_label(new.source_chain) || ' Ledger' else '' end, false);
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
