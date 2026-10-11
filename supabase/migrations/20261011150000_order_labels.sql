-- Orders are named by what they are, not "Order #":
--   Bill ORD-00042 / Request ORD-00043 / Requested Payment ORD-00044
--   paid: Paid Bill ORD-00042 / Request Amount Paid ORD-00043 /
--         Requested Payment Paid ORD-00044
-- Request = a normal user's payment request; Requested Payment = an approved
-- merchant's request from Receive; Bill = a merchant's itemised bill.
-- Numbers are shown from 00001 (the stored ORD-100042 shows as ORD-00042);
-- the stored order_number itself does not change.
-- Same wording as the app (src/lib/orderLabels.ts).

begin;

create or replace function public.merchant_order_display(p_order text)
returns text
language sql
immutable
as $$
  select case
    when p_order ~* '^ORD-[0-9]+$' and substr(p_order, 5)::bigint > 100000
      then 'ORD-' || lpad((substr(p_order, 5)::bigint - 100000)::text, 5, '0')
    else p_order
  end
$$;

create or replace function public.merchant_order_title(p_kind text, p_personal boolean, p_order text, p_paid boolean)
returns text
language sql
immutable
as $$
  select case
    when p_kind = 'invoice' then (case when p_paid then 'Paid Bill ' else 'Bill ' end)
    when coalesce(p_personal, true) then (case when p_paid then 'Request Amount Paid ' else 'Request ' end)
    else (case when p_paid then 'Requested Payment Paid ' else 'Requested Payment ' end)
  end || coalesce(public.merchant_order_display(p_order), '')
$$;

-- Notifications: the title names the order; the body says who / how much.
create or replace function public.merchant_payment_intents_notify()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare
  who text;
  shop text := coalesce(nullif(new.merchant_name, ''), 'the merchant');
  amt text := '$' || trim(to_char(new.received_amount, 'FM999999990.00')) || ' USDC';
  onchain text := case when new.source_chain is not null and new.source_chain <> 'Arc_Testnet'
                       then ' on ' || public.merchant_chain_label(new.source_chain) else '' end;
  paid_title text := public.merchant_order_title(new.kind, new.personal, new.order_number, true);
  open_title text := public.merchant_order_title(new.kind, new.personal, new.order_number, false);
begin
  who := coalesce(nullif(new.customer_username, ''), case when new.customer_wallet is not null
           then substr(new.customer_wallet, 1, 6) || '…' || right(new.customer_wallet, 4) end, 'A customer');

  if new.status = 'paid' and old.status is distinct from 'paid' and old.status is distinct from 'processing'
     and not coalesce(new.completed_by_merchant, false) then
    if new.merchant_user_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.merchant_user_id, 'merchant_payment_received',
              case when onchain <> '' then 'Payment received in Ledger' else paid_title end,
              amt || ' from ' || who
                || case when onchain <> '' then ' · ' || paid_title || ' · ' || public.merchant_chain_label(new.source_chain) || ' Ledger'
                        else coalesce(' · ' || nullif(new.note, ''), '') end, false);
    end if;
    if new.customer_user_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.customer_user_id, 'merchant_order_paid', paid_title,
              'You paid ' || amt || ' to ' || shop || onchain, false);
    end if;
  end if;

  if new.status = 'partially_paid' and new.received_amount is distinct from old.received_amount then
    if new.merchant_user_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.merchant_user_id, 'merchant_payment_partial', 'Partial payment · ' || open_title,
              who || ' paid ' || amt || ' of $' || trim(to_char(new.requested_amount, 'FM999999990.00')) || ' USDC' || onchain, false);
    end if;
    if new.customer_user_id is not null then
      insert into public.notifications (user_id, type, title, message, read)
      values (new.customer_user_id, 'merchant_payment_partial', 'Partial payment · ' || open_title,
              'You paid ' || amt || ' of $' || trim(to_char(new.requested_amount, 'FM999999990.00')) || ' USDC to ' || shop || onchain, false);
    end if;
  end if;

  if new.status = 'paid' and old.status is distinct from 'paid' and coalesce(new.completed_by_merchant, false)
     and new.customer_user_id is not null then
    insert into public.notifications (user_id, type, title, message, read)
    values (new.customer_user_id, 'merchant_order_completed', 'Completed · ' || open_title,
            shop || ' marked ' || open_title || ' as completed', false);
  end if;
  return new;
end;
$function$;

-- The chat's pending strip needs to tell a Request from a Requested Payment.
drop function if exists public.chat_pending_orders(uuid);
create function public.chat_pending_orders(p_other uuid)
returns table (
  code text, order_number text, kind text, amount numeric, received numeric,
  note text, merchant_name text, i_am_merchant boolean, created_at timestamptz, expires_at timestamptz,
  personal boolean
)
language sql
stable
security definer
set search_path to 'public'
as $$
  with me as (select id, username from public.users where auth_uid = auth.uid() limit 1),
       other as (select id, username, auth_uid from public.users where id = p_other limit 1)
  select i.code, i.order_number, i.kind, i.requested_amount, i.received_amount,
         i.note, i.merchant_name, (i.merchant_auth_uid = auth.uid()), i.created_at, i.expires_at,
         coalesce(i.personal, false)
    from public.merchant_payment_intents i, me, other
   where i.status in ('pending', 'partially_paid')
     and (i.expires_at is null or i.expires_at > now())
     and (
       -- I'm the merchant, they're the customer
       (i.merchant_auth_uid = auth.uid()
         and (i.customer_user_id = other.id::text or lower(i.customer_username) = lower(other.username)))
       or
       -- They're the merchant, I'm the customer
       (i.merchant_auth_uid = other.auth_uid
         and (i.customer_user_id = me.id::text or lower(i.customer_username) = lower(me.username)))
     )
   order by i.created_at desc
   limit 20
$$;
revoke all on function public.chat_pending_orders(uuid) from public, anon;
grant execute on function public.chat_pending_orders(uuid) to authenticated;

commit;
