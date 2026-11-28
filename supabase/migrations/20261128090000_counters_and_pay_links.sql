-- Counters and payment links (28 Nov, like Paytm for Business).
--  · Counters: each has its own Shop QR (/paylink/<shop>?counter=<id>); a
--    payment on it is tagged with the counter, so the business sees which
--    counter took it - no order number needed.
--  · Payment links: a link for a product or a fixed price (or any amount),
--    paid once or many times (/l/<shop>/<slug>), optionally asking for the
--    payer's name and phone. Paid like a Shop QR payment, tagged with the link.

-- ── Counters ────────────────────────────────────────────────────────────────
create table if not exists public.business_counters (
  id             uuid primary key default gen_random_uuid(),
  owner_auth_uid uuid not null default auth.uid(),
  store_id       uuid references public.business_stores(id) on delete set null,
  name           text not null check (char_length(trim(name)) between 1 and 40),
  staff_uids     uuid[] not null default '{}',
  created_at     timestamptz not null default now()
);
create index if not exists business_counters_owner_idx on public.business_counters(owner_auth_uid);
alter table public.business_counters enable row level security;
drop policy if exists business_counters_owner on public.business_counters;
create policy business_counters_owner on public.business_counters for all to authenticated
  using (owner_auth_uid = auth.uid()) with check (owner_auth_uid = auth.uid());
drop policy if exists business_counters_staff_read on public.business_counters;
create policy business_counters_staff_read on public.business_counters for select to authenticated
  using (auth.uid() = any(staff_uids));

-- ── Payment links ───────────────────────────────────────────────────────────
create table if not exists public.business_pay_links (
  id             uuid primary key default gen_random_uuid(),
  owner_auth_uid uuid not null default auth.uid(),
  slug           text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  title          text not null check (char_length(trim(title)) between 1 and 80),
  description    text check (description is null or char_length(description) <= 200),
  amount         numeric check (amount is null or (amount >= 0.01 and amount <= 100000)),
  multi          boolean not null default true,
  ask_contact    boolean not null default false,
  counter_id     uuid references public.business_counters(id) on delete set null,
  store_id       uuid references public.business_stores(id) on delete set null,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (owner_auth_uid, slug)
);
alter table public.business_pay_links enable row level security;
drop policy if exists business_pay_links_owner on public.business_pay_links;
create policy business_pay_links_owner on public.business_pay_links for all to authenticated
  using (owner_auth_uid = auth.uid()) with check (owner_auth_uid = auth.uid());

-- ── Orders know their counter / link, and a link payer's name and phone ───
alter table public.merchant_payment_intents
  add column if not exists counter_id    uuid references public.business_counters(id) on delete set null,
  add column if not exists link_id       uuid references public.business_pay_links(id) on delete set null,
  add column if not exists payer_name    text check (payer_name is null or char_length(payer_name) <= 80),
  add column if not exists payer_contact text check (payer_contact is null or char_length(payer_contact) <= 120);
create index if not exists merchant_intents_link_idx on public.merchant_payment_intents(link_id) where link_id is not null;

-- ── Shop QR order: now with an optional counter (its store when none given) ─
drop function if exists public.shop_open_order(text, numeric, uuid, text);
create or replace function public.shop_open_order(p_username text, p_amount numeric, p_store uuid default null, p_note text default null,
  p_counter uuid default null, p_link uuid default null, p_payer_name text default null, p_payer_contact text default null)
returns text language plpgsql security definer set search_path to '' as $function$
declare u record; ok boolean; st uuid; ct uuid; r public.merchant_payment_intents; me uuid := auth.uid();
        amt numeric; nt text; existing text;
begin
  if p_amount is null or p_amount < 0.01 or p_amount > 100000 then raise exception 'Enter an amount between $0.01 and $100,000'; end if;
  amt := round(p_amount, 6);
  nt := nullif(left(trim(coalesce(p_note, '')), 140), '');
  select auth_uid, account_type, shop_min_amount, shop_max_amount into u from public.users
   where lower(username) = lower(regexp_replace(trim(coalesce(p_username, '')), '\.arc$', '')) limit 1;
  if u.auth_uid is null then raise exception 'Shop not found'; end if;
  ok := exists (select 1 from public.merchant_applications where auth_uid = u.auth_uid and status = 'approved');
  if not ok then raise exception 'Shop not found'; end if;
  -- A payment link sets its own price; the shop's min/max is for the Shop QR.
  if p_link is null and u.shop_min_amount is not null and p_amount < u.shop_min_amount then
    raise exception 'The smallest payment here is $%', to_char(u.shop_min_amount, 'FM999,999,990.00');
  end if;
  if p_link is null and u.shop_max_amount is not null and p_amount > u.shop_max_amount then
    raise exception 'The largest payment here is $%', to_char(u.shop_max_amount, 'FM999,999,990.00');
  end if;
  if p_counter is not null then
    select c.id, c.store_id into ct, st from public.business_counters c where c.id = p_counter and c.owner_auth_uid = u.auth_uid;
  end if;
  if st is null and p_store is not null then
    select id into st from public.business_stores where id = p_store and owner_auth_uid = u.auth_uid;
  end if;

  if me is not null then
    select code into existing from public.merchant_payment_intents
     where merchant_auth_uid = u.auth_uid and via = 'shop_qr' and opened_by = me
       and status = 'pending' and received_amount = 0 and expires_at > now() + interval '5 minutes'
       and requested_amount = amt and store_id is not distinct from st and note is not distinct from nt
       and counter_id is not distinct from ct and link_id is not distinct from p_link
     order by created_at desc limit 1;
    if existing is not null then return existing; end if;
    if (select count(*) from public.merchant_payment_intents
         where merchant_auth_uid = u.auth_uid and via = 'shop_qr' and opened_by = me
           and created_at > now() - interval '10 minutes') >= 5 then
      raise exception 'Too many orders from you right now - try again in a few minutes';
    end if;
  end if;
  if (select count(*) from public.merchant_payment_intents
       where merchant_auth_uid = u.auth_uid and via = 'shop_qr' and status = 'pending'
         and expires_at > now() and requested_amount = amt) >= 5 then
    raise exception 'Too many open orders for this amount right now - try again in a few minutes';
  end if;
  if (select count(*) from public.merchant_payment_intents
       where merchant_auth_uid = u.auth_uid and via = 'shop_qr' and status = 'pending' and expires_at > now()) >= 30 then
    raise exception 'This shop has too many open orders right now - try again in a few minutes';
  end if;
  if (select count(*) from public.merchant_payment_intents
       where merchant_auth_uid = u.auth_uid and via = 'shop_qr' and created_at > now() - interval '10 minutes') >= 200 then
    raise exception 'Too many orders right now - try again in a minute';
  end if;

  perform set_config('meshport.shop_qr', '1', true);
  insert into public.merchant_payment_intents (merchant_auth_uid, requested_amount, note, expires_at, store_id, via, opened_by,
                                               counter_id, link_id, payer_name, payer_contact)
  values (u.auth_uid, amt, nt, now() + interval '30 minutes', st, 'shop_qr', me, ct, p_link,
          nullif(left(trim(coalesce(p_payer_name, '')), 80), ''), nullif(left(trim(coalesce(p_payer_contact, '')), 120), ''))
  returning * into r;
  perform set_config('meshport.shop_qr', '', true);
  return r.code;
end $function$;
grant execute on function public.shop_open_order(text, numeric, uuid, text, uuid, uuid, text, text) to anon, authenticated;

-- ── A payment link, for whoever opens it ───────────────────────────────────
create or replace function public.pay_link_info(p_username text, p_slug text)
returns jsonb language plpgsql stable security definer set search_path to '' as $function$
declare u record; l public.business_pay_links; paid boolean;
begin
  select auth_uid into u from public.users
   where lower(username) = lower(regexp_replace(trim(coalesce(p_username, '')), '\.arc$', '')) limit 1;
  if u.auth_uid is null then return null; end if;
  select * into l from public.business_pay_links where owner_auth_uid = u.auth_uid and slug = lower(trim(coalesce(p_slug, ''))) limit 1;
  if l.id is null then return null; end if;
  paid := exists (select 1 from public.merchant_payment_intents i where i.link_id = l.id and i.received_amount > 0);
  return jsonb_build_object('id', l.id, 'title', l.title, 'description', l.description, 'amount', l.amount,
    'multi', l.multi, 'askContact', l.ask_contact, 'storeId', l.store_id, 'counterId', l.counter_id,
    'open', l.active and (l.multi or not paid));
end $function$;
grant execute on function public.pay_link_info(text, text) to anon, authenticated;

-- Pays a link: checks it's open and the amount, then opens a Shop QR order tagged with it.
create or replace function public.pay_link_open(p_username text, p_slug text, p_amount numeric default null,
  p_payer_name text default null, p_payer_contact text default null)
returns text language plpgsql security definer set search_path to '' as $function$
declare u record; l public.business_pay_links; amt numeric;
begin
  select auth_uid into u from public.users
   where lower(username) = lower(regexp_replace(trim(coalesce(p_username, '')), '\.arc$', '')) limit 1;
  if u.auth_uid is null then raise exception 'Link not found'; end if;
  select * into l from public.business_pay_links where owner_auth_uid = u.auth_uid and slug = lower(trim(coalesce(p_slug, ''))) limit 1;
  if l.id is null then raise exception 'Link not found'; end if;
  if not l.active then raise exception 'This link is paused - ask the business for a new one'; end if;
  if not l.multi and exists (select 1 from public.merchant_payment_intents i where i.link_id = l.id and i.received_amount > 0) then
    raise exception 'This link has already been paid';
  end if;
  amt := coalesce(l.amount, p_amount);
  if l.ask_contact and nullif(trim(coalesce(p_payer_name, '')), '') is null then raise exception 'Add your name'; end if;
  return public.shop_open_order(p_username, amt, l.store_id, l.title, l.counter_id, l.id, p_payer_name, p_payer_contact);
end $function$;
grant execute on function public.pay_link_open(text, text, numeric, text, text) to anon, authenticated;

-- Wholesale joins the business categories (MCC 5099, wholesale goods).
create or replace function public.business_mcc(p_category text)
returns text language sql immutable set search_path to '' as $function$
  select case p_category
    when 'Retail store'           then '5399'
    when 'Grocery / Supermarket'  then '5411'
    when 'Restaurant / Café'      then '5812'
    when 'Online shop'            then '5999'
    when 'Pharmacy'               then '5912'
    when 'Salon / Beauty'         then '7230'
    when 'Clinic / Healthcare'    then '8099'
    when 'Education / Tutoring'   then '8299'
    when 'Hotel / Stay'           then '7011'
    when 'Events / Tickets'       then '7922'
    when 'Repair / Workshop'      then '7699'
    when 'Transport / Delivery'   then '4215'
    when 'Services'               then '7299'
    when 'Freelancer'             then '8999'
    when 'Kiosk / Counter'        then '5499'
    when 'Non-profit / Donations' then '8398'
    when 'Wholesale'              then '5099'
    else '5999'
  end
$function$;
