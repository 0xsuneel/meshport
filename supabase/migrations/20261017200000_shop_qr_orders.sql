-- Business → Shop QR. A shop's QR now opens an open-amount order for that
-- exact store: the customer types the amount, shop_open_order creates a
-- normal merchant_payment_intents row for the owner (via = 'shop_qr'), and
-- the existing pay page records the payment - so Shop QR payments show in
-- Business totals, Payments, the payment pop-up, voice alerts, store
-- breakdowns and refunds like any order.
alter table public.merchant_payment_intents add column if not exists via text;

-- Public: the name and store a Shop QR belongs to (no wallet, no balances).
create or replace function public.shop_info(p_username text, p_store uuid default null)
returns table (business_name text, username text, store_id uuid, store_name text, avatar_url text, verified boolean)
language plpgsql stable security definer set search_path = '' as $$
declare u record; a record; s record;
begin
  select x.id, x.auth_uid, x.username, x.display_name, x.store_name, x.avatar_url, x.account_type into u
    from public.users x where lower(x.username) = lower(regexp_replace(trim(coalesce(p_username, '')), '\.arc$', '')) limit 1;
  if u.id is null then return; end if;
  select m.business_name into a from public.merchant_applications m
   where m.auth_uid = u.auth_uid and m.status = 'approved' order by m.created_at desc limit 1;
  if coalesce(u.account_type, 'personal') <> 'business' and a.business_name is null then return; end if;
  select b.id, b.name into s from public.business_stores b
   where p_store is not null and b.id = p_store and b.owner_auth_uid = u.auth_uid;
  return query select coalesce(nullif(a.business_name, ''), nullif(u.store_name, ''), nullif(u.display_name, ''), u.username || '.arc')::text,
                      u.username::text, s.id, s.name::text, u.avatar_url::text, a.business_name is not null;
end $$;

-- Public: open a store order for the amount the customer typed.
create or replace function public.shop_open_order(p_username text, p_amount numeric, p_store uuid default null, p_note text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare u record; ok boolean; st uuid; r public.merchant_payment_intents;
begin
  if p_amount is null or p_amount < 0.01 or p_amount > 100000 then raise exception 'Enter an amount between $0.01 and $100,000'; end if;
  select auth_uid, account_type into u from public.users
   where lower(username) = lower(regexp_replace(trim(coalesce(p_username, '')), '\.arc$', '')) limit 1;
  if u.auth_uid is null then raise exception 'Shop not found'; end if;
  ok := coalesce(u.account_type, 'personal') = 'business' or exists (
    select 1 from public.merchant_applications where auth_uid = u.auth_uid and status = 'approved');
  if not ok then raise exception 'Shop not found'; end if;
  if (select count(*) from public.merchant_payment_intents
       where merchant_auth_uid = u.auth_uid and via = 'shop_qr' and created_at > now() - interval '10 minutes') >= 200 then
    raise exception 'Too many orders right now - try again in a minute';
  end if;
  if p_store is not null then
    select id into st from public.business_stores where id = p_store and owner_auth_uid = u.auth_uid;
  end if;
  insert into public.merchant_payment_intents (merchant_auth_uid, requested_amount, note, expires_at, store_id, via)
  values (u.auth_uid, round(p_amount, 6), nullif(left(trim(coalesce(p_note, '')), 140), ''), now() + interval '30 minutes', st, 'shop_qr')
  returning * into r;
  return r.code;
end $$;

revoke all on function public.shop_info(text, uuid) from public;
revoke all on function public.shop_open_order(text, numeric, uuid, text) from public;
grant execute on function public.shop_info(text, uuid) to anon, authenticated;
grant execute on function public.shop_open_order(text, numeric, uuid, text) to anon, authenticated;
