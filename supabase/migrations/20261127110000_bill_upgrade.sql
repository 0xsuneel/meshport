-- Bills (27 Nov): discount, tax set once per store (name, rate, prices
-- include tax or not), billing people who aren't on MeshPort (a name and a
-- phone or email, sent a pay link), and a footer note on every bill.
-- The database still works out every bill's amounts; the app only shows them.

-- ── The store's bill settings ──────────────────────────────────────────────
alter table public.business_stores
  add column if not exists tax_enabled   boolean not null default false,
  add column if not exists tax_name      text,
  add column if not exists tax_rate      numeric,
  add column if not exists tax_inclusive boolean not null default false,
  add column if not exists bill_footer   text;
do $$ begin
  alter table public.business_stores add constraint business_stores_tax_rate_chk check (tax_rate is null or (tax_rate >= 0 and tax_rate <= 100));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.business_stores add constraint business_stores_tax_name_chk check (tax_name is null or char_length(tax_name) <= 20);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.business_stores add constraint business_stores_bill_footer_chk check (bill_footer is null or char_length(bill_footer) <= 200);
exception when duplicate_object then null; end $$;

-- ── What each bill keeps ───────────────────────────────────────────────────
alter table public.merchant_payment_intents
  add column if not exists subtotal_amount numeric,
  add column if not exists discount_type   text,      -- 'percent' | 'amount'
  add column if not exists discount_value  numeric,
  add column if not exists discount_amount numeric,
  add column if not exists tax_name        text,
  add column if not exists tax_inclusive   boolean not null default false,
  add column if not exists tax_amount      numeric,
  add column if not exists bill_to_name    text,      -- someone not on MeshPort
  add column if not exists bill_to_contact text,      -- their phone or email
  add column if not exists footer_note     text;      -- the store's footer, as it was

-- Bills: items → subtotal → discount → tax (added on top, or already in the
-- prices) → total. Everything else unchanged from before.
do $do$
declare d text;
  old_calc text := $q$      new.items := clean;
      txp := least(greatest(coalesce(new.tax_percent, 0), 0), 100);
      new.requested_amount := round(total * (1 + txp / 100), 6);
      new.tax_percent := nullif(round(txp, 2), 0);
      new.kind := 'invoice';
    else
      new.kind := 'request';
      new.tax_percent := null;
    end if;
  else
    new.items := old.items; new.kind := old.kind; new.requested_amount := old.requested_amount;
    new.personal := old.personal;
    new.tax_percent := old.tax_percent;
  end if;$q$;
  new_calc text := $q$      new.items := clean;
      new.subtotal_amount := total;
      -- Discount: a percent of the subtotal, or an amount (never more than it).
      if new.discount_type = 'percent' and coalesce(new.discount_value, 0) > 0 then
        new.discount_value := round(least(new.discount_value, 100), 2);
        new.discount_amount := round(total * new.discount_value / 100, 6);
      elsif new.discount_type = 'amount' and coalesce(new.discount_value, 0) > 0 then
        new.discount_value := round(least(new.discount_value, total), 6);
        new.discount_amount := new.discount_value;
      else
        new.discount_type := null; new.discount_value := null; new.discount_amount := null;
      end if;
      total := total - coalesce(new.discount_amount, 0);
      if total <= 0 then raise exception 'The discount can''t be the whole bill'; end if;
      txp := least(greatest(coalesce(new.tax_percent, 0), 0), 100);
      if txp > 0 and new.tax_inclusive then
        new.requested_amount := round(total, 6);
        new.tax_amount := round(total - total / (1 + txp / 100), 6);
      else
        new.tax_inclusive := false;
        new.requested_amount := round(total * (1 + txp / 100), 6);
        new.tax_amount := nullif(round(new.requested_amount - total, 6), 0);
      end if;
      new.tax_percent := nullif(round(txp, 2), 0);
      new.tax_name := case when txp > 0 then nullif(left(trim(coalesce(new.tax_name, '')), 20), '') end;
      -- Someone not on MeshPort: a name and a phone or email (a MeshPort
      -- customer is named by username instead).
      if new.customer_username is not null then
        new.bill_to_name := null; new.bill_to_contact := null;
      else
        new.bill_to_name := nullif(left(trim(coalesce(new.bill_to_name, '')), 80), '');
        new.bill_to_contact := case when new.bill_to_name is null then null
                                    else nullif(left(trim(coalesce(new.bill_to_contact, '')), 120), '') end;
      end if;
      -- The store's footer note, as it is now.
      new.footer_note := (select nullif(trim(s.bill_footer), '') from public.business_stores s
                           where s.owner_auth_uid = new.merchant_auth_uid
                             and (s.id = new.store_id or (new.store_id is null and s.is_default)) limit 1);
      new.kind := 'invoice';
    else
      new.kind := 'request';
      new.tax_percent := null;
      new.subtotal_amount := null; new.discount_type := null; new.discount_value := null; new.discount_amount := null;
      new.tax_name := null; new.tax_inclusive := false; new.tax_amount := null;
      new.bill_to_name := null; new.bill_to_contact := null; new.footer_note := null;
    end if;
  else
    new.items := old.items; new.kind := old.kind; new.requested_amount := old.requested_amount;
    new.personal := old.personal;
    new.tax_percent := old.tax_percent;
    new.subtotal_amount := old.subtotal_amount; new.discount_type := old.discount_type;
    new.discount_value := old.discount_value; new.discount_amount := old.discount_amount;
    new.tax_name := old.tax_name; new.tax_inclusive := old.tax_inclusive; new.tax_amount := old.tax_amount;
    new.bill_to_name := old.bill_to_name; new.bill_to_contact := old.bill_to_contact; new.footer_note := old.footer_note;
  end if;$q$;
begin
  d := pg_get_functiondef('public.merchant_payment_intents_before_write()'::regprocedure);
  if position(new_calc in d) > 0 then return; end if;
  if position(old_calc in d) = 0 then raise exception 'merchant_payment_intents_before_write changed - update this migration'; end if;
  execute replace(d, old_calc, new_calc);
end $do$;

-- ── A bill's extra lines for whoever holds its pay link ───────────────────
-- (The pay page and the chat card already get the bill from merchant-pay;
-- this adds the discount, tax name, the store's address and the footer.)
create or replace function public.bill_details(p_code text)
returns jsonb language sql stable security definer set search_path to '' as $$
  select jsonb_build_object(
    'subtotal', i.subtotal_amount, 'discountType', i.discount_type, 'discountValue', i.discount_value,
    'discountAmount', i.discount_amount, 'taxName', i.tax_name, 'taxInclusive', i.tax_inclusive,
    'taxAmount', i.tax_amount, 'billToName', i.bill_to_name, 'footer', i.footer_note,
    'storeAddress', case when i.personal = false then (
        select nullif(trim(s.address), '') from public.business_stores s
         where s.owner_auth_uid = i.merchant_auth_uid
           and (s.id = i.store_id or (i.store_id is null and s.is_default)) limit 1) end)
    from public.merchant_payment_intents i
   where i.code = p_code and i.kind = 'invoice'
$$;
revoke execute on function public.bill_details(text) from public;
grant execute on function public.bill_details(text) to anon, authenticated;

-- Bill money in cents, as invoices are: the discount and the tax round to
-- the cent, and the total is the rest plus that tax.
do $do$
declare d text; n text;
begin
  d := pg_get_functiondef('public.merchant_payment_intents_before_write()'::regprocedure);
  if position('-- Bill money in cents' in d) > 0 then return; end if;
  n := replace(d, $q$new.discount_amount := round(total * new.discount_value / 100, 6);$q$,
                  $q$new.discount_amount := round(total * new.discount_value / 100, 2); -- Bill money in cents$q$);
  n := replace(n, $q$new.tax_amount := round(total - total / (1 + txp / 100), 6);$q$,
                  $q$new.tax_amount := round(total - total / (1 + txp / 100), 2);$q$);
  n := replace(n, $q$new.requested_amount := round(total * (1 + txp / 100), 6);
        new.tax_amount := nullif(round(new.requested_amount - total, 6), 0);$q$,
                  $q$new.tax_amount := nullif(round(total * txp / 100, 2), 0);
        new.requested_amount := round(total + coalesce(new.tax_amount, 0), 6);$q$);
  if n = d or position('round(total * txp / 100, 2)' in n) = 0 then raise exception 'pattern not found'; end if;
  execute n;
end $do$;
