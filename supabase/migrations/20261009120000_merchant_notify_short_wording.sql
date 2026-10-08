-- Merchant notifications: short one-line titles and bodies (the long
-- "... · use Claim All to move it back to Arc" texts made tall cards).
create or replace function public.merchant_chain_receipts_notify()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare
  lbl text := public.merchant_chain_label(new.source_chain);
  amt text := '$' || trim(to_char(new.amount, 'FM999999990.00')) || ' USDC';
begin
  if new.order_number is not null then return new; end if;
  if new.from_address is null or new.from_address = new.merchant_wallet then
    perform public.merchant_notify(new.merchant_wallet, 'merchant_chain_payment', 'Own payment received',
      amt || ' · ' || lbl || ' Ledger');
  else
    perform public.merchant_notify(new.merchant_wallet, 'merchant_chain_payment', 'Payment received in Ledger',
      amt || ' from '
        || case when new.from_address = '0x0000000000000000000000000000000000000000' then 'a bridge'
                else substr(new.from_address, 1, 6) || '…' || right(new.from_address, 4) end
        || ' · ' || lbl || ' Ledger');
  end if;
  return new;
end $$;

create or replace function public.merchant_payment_intents_notify()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare
  who text;
  ord text := coalesce(' · #' || new.order_number, '');
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
              case when onchain <> '' then 'Payment received in Ledger'
                   when coalesce(new.personal, false) then 'Requested amount received'
                   when new.kind = 'invoice' then 'Bill payment received'
                   else 'Requested payment received' end,
              amt || ' from ' || who || ord
                || case when onchain <> '' then ' · ' || public.merchant_chain_label(new.source_chain) || ' Ledger'
                        else coalesce(' · ' || nullif(new.note, ''), '') end, false);
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
$function$;
