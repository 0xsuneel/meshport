-- MeshPort's own Order ID (28 Nov, like Paytm's order IDs): every order -
-- a bill, a charge, a personal request, a Shop QR or payment-link payment -
-- gets a unique system ID: MP + the date (YYMMDD, UTC) + 6 random letters
-- and digits (no 0/O/1/I/L), e.g. MP261128K7Q2XA. It's a reference for
-- refunds, support and the bank - never a running count, and never the
-- order's name: titles read "Bill", "Payment Request", "Shop Payment".
-- Older orders keep their ORD-… number.

create or replace function public.new_order_id()
returns text language plpgsql volatile set search_path to '' as $function$
declare abc constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; v_id text; i int;
begin
  loop
    v_id := 'MP' || to_char(now() at time zone 'UTC', 'YYMMDD');
    for i in 1..6 loop v_id := v_id || substr(abc, 1 + floor(random() * length(abc))::int, 1); end loop;
    exit when not exists (select 1 from public.merchant_payment_intents where order_number = v_id);
  end loop;
  return v_id;
end $function$;
revoke execute on function public.new_order_id() from anon, authenticated, public;

create or replace function public.merchant_intents_order_number()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  if tg_op = 'INSERT' then
    new.order_number := public.new_order_id();
  else
    new.order_number := old.order_number;
  end if;
  return new;
end;
$function$;

-- Titles never carry the number.
create or replace function public.merchant_order_title(p_kind text, p_personal boolean, p_order text, p_paid boolean)
returns text language sql immutable set search_path to '' as $function$
  select case
      when p_kind = 'shop' then (case when p_paid then 'Payment Paid' else 'Payment' end)
      when p_kind = 'invoice' then (case when p_paid then 'Paid Bill' else 'Bill' end)
      when coalesce(p_personal, true) then (case when p_paid then 'Request Paid' else 'Payment Request' end)
      else (case when p_paid then 'Payment Request Paid' else 'Payment Request' end)
    end
$function$;

create or replace function public.merchant_order_received_title(p_kind text, p_personal boolean, p_order text)
returns text language sql immutable set search_path to '' as $function$
  select case
      when p_kind = 'invoice' then 'Bill Received'
      when p_kind = 'shop' then 'Payment Received'
      when coalesce(p_personal, true) then 'Request Received'
      else 'Charge Received'
    end
$function$;
