-- Business → refunds: the owner gets "Refund sent" in their notifications
-- (the customer's "Refund from <shop>" is sent by merchant-refund).
create or replace function public.merchant_refunds_notify_owner()
returns trigger language plpgsql security definer set search_path = 'public' as $$
declare uid text; who text;
begin
  select u.id::text into uid from public.users u where u.auth_uid = new.merchant_auth_uid limit 1;
  if uid is null then return new; end if;
  select coalesce(u.username || '.arc', null) into who from public.users u where u.id::text = new.customer_user_id limit 1;
  who := coalesce(who, substr(new.customer_wallet, 1, 6) || '…' || right(new.customer_wallet, 4));
  insert into public.notifications (user_id, type, title, message, read)
  values (uid, 'merchant_refund_sent', 'Refund sent',
          '$' || trim(to_char(new.amount, 'FM999999990.00')) || ' USDC to ' || who
          || case when coalesce(new.refund_chain, 'Arc_Testnet') <> 'Arc_Testnet' then ' on ' || public.merchant_chain_label(new.refund_chain) else '' end
          || coalesce(' · ' || nullif(new.reason, ''), ''), false);
  return new;
end $$;

drop trigger if exists merchant_refunds_notify_owner on public.merchant_refunds;
create trigger merchant_refunds_notify_owner after insert on public.merchant_refunds
  for each row execute function public.merchant_refunds_notify_owner();
