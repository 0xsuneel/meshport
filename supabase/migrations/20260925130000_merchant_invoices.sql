-- Invoices (bills) from merchant chat: a payment request with line items.
-- items = [{ "name": text, "qty": number, "price": number }]
-- The total is always computed here from the items (qty × price), never
-- taken from the client, so a bill can't say one thing and charge another.

alter table public.merchant_payment_intents add column if not exists items jsonb;
alter table public.merchant_payment_intents add column if not exists kind text not null default 'request'
  check (kind in ('request', 'invoice'));

create or replace function public.merchant_payment_intents_before_write()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare a record; it jsonb; clean jsonb := '[]'::jsonb; total numeric := 0; q numeric; p numeric; nm text;
begin
  if tg_op = 'INSERT' then
    select user_id, wallet_address, business_name into a
      from public.merchant_applications
     where auth_uid = new.merchant_auth_uid and status = 'approved'
     order by created_at desc limit 1;
    if a.wallet_address is null then
      raise exception 'Only approved merchants can create payment requests';
    end if;
    new.merchant_user_id := a.user_id;
    new.merchant_wallet  := lower(a.wallet_address);
    new.merchant_name    := a.business_name;
    new.status := 'pending'; new.received_amount := 0; new.paid_at := null;
    new.source_tx_hash := null; new.destination_tx_hash := null; new.payment_method := null;
    new.customer_wallet := null; new.ub_intent_id := null; new.failure_reason := null;
    new.customer_username := nullif(lower(regexp_replace(coalesce(new.customer_username, ''), '\.arc$', '')), '');
    new.customer_user_id := null;
    if new.customer_username is not null then
      select id::text into new.customer_user_id from public.users where lower(username) = new.customer_username limit 1;
    end if;

    if new.items is not null then
      if jsonb_typeof(new.items) <> 'array' or jsonb_array_length(new.items) = 0 or jsonb_array_length(new.items) > 50 then
        raise exception 'An invoice needs 1 to 50 items';
      end if;
      for it in select * from jsonb_array_elements(new.items) loop
        nm := left(trim(coalesce(it->>'name', '')), 80);
        q  := (it->>'qty')::numeric;
        p  := (it->>'price')::numeric;
        if nm = '' or q is null or q <= 0 or q > 100000 or p is null or p < 0 or p > 1000000 then
          raise exception 'Invalid invoice item';
        end if;
        q := round(q, 3); p := round(p, 6);
        clean := clean || jsonb_build_array(jsonb_build_object('name', nm, 'qty', q, 'price', p, 'total', round(q * p, 6)));
        total := total + round(q * p, 6);
      end loop;
      if total <= 0 then raise exception 'Invoice total must be more than 0'; end if;
      new.items := clean;
      new.requested_amount := round(total, 6);
      new.kind := 'invoice';
    else
      new.kind := 'request';
    end if;
  else
    new.items := old.items; new.kind := old.kind; new.requested_amount := old.requested_amount;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
