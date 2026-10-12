-- P2P rebuild (Binance-style flow): saved payment accounts with pay-to
-- details, the buyer's chosen method on each trade, floating prices from a
-- live FX rate, auto-reply, and the escrow-V3 auto-accept flag.
--
-- Security model:
--   * Pay-to details (UPI id, account number) live in p2p_payment_methods,
--     readable ONLY by their owner. The other party of a live trade reads
--     the one account chosen for that trade through p2p_trade_pay_to(),
--     never the table itself. Nothing here is on the public offer row.
--   * A trade's price is still set by the database (p2p_trades_insert_guard),
--     never by the client: fixed ads use their price, floating ads use the
--     live FX rate here x (1 + margin). A buyer can't send their own price.

-- ── Offers ──────────────────────────────────────────────────────────────
alter table public.p2p_offers
  add column if not exists auto_accept boolean not null default false,
  add column if not exists price_type text not null default 'fixed',
  add column if not exists float_margin_pct numeric,
  add column if not exists auto_reply text,
  add column if not exists payment_method_ids uuid[] not null default '{}';

do $$ begin
  alter table public.p2p_offers add constraint p2p_offers_price_type_chk check (price_type in ('fixed', 'floating'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.p2p_offers add constraint p2p_offers_float_margin_chk
    check (price_type = 'fixed' or (float_margin_pct is not null and float_margin_pct between -20 and 20));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.p2p_offers add constraint p2p_offers_auto_reply_len_chk check (auto_reply is null or char_length(auto_reply) <= 280);
exception when duplicate_object then null; end $$;

-- ── Trades: which account the buyer pays ────────────────────────────────
alter table public.p2p_trades add column if not exists payment_method_id uuid;

-- ── Saved payment accounts (private) ────────────────────────────────────
create table if not exists public.p2p_payment_methods (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  method text not null,               -- 'UPI', 'IMPS', 'Bank Transfer', 'SEPA', ...
  holder_name text not null,
  details jsonb not null default '{}', -- e.g. {"upi_id": "..."} or {"account": "...", "ifsc": "...", "bank": "..."}
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint p2p_payment_methods_method_len check (char_length(method) between 1 and 40),
  constraint p2p_payment_methods_holder_len check (char_length(holder_name) between 1 and 80),
  constraint p2p_payment_methods_details_size check (pg_column_size(details) < 2000)
);
create index if not exists p2p_payment_methods_user_idx on public.p2p_payment_methods (user_id) where deleted_at is null;

alter table public.p2p_payment_methods enable row level security;
drop policy if exists p2p_payment_methods_own_select on public.p2p_payment_methods;
create policy p2p_payment_methods_own_select on public.p2p_payment_methods
  for select using (user_id = public.p2p_current_user_id());
drop policy if exists p2p_payment_methods_own_insert on public.p2p_payment_methods;
create policy p2p_payment_methods_own_insert on public.p2p_payment_methods
  for insert with check (public.p2p_current_user_id() is not null and user_id = public.p2p_current_user_id());
drop policy if exists p2p_payment_methods_own_update on public.p2p_payment_methods;
create policy p2p_payment_methods_own_update on public.p2p_payment_methods
  for update using (user_id = public.p2p_current_user_id()) with check (user_id = public.p2p_current_user_id());
-- No delete policy: accounts are soft-deleted (deleted_at) so a live trade
-- that points at one can still show it.

-- The pay-to account of one trade, for that trade's buyer or seller only,
-- while the trade is open (or just finished, for the receipt).
create or replace function public.p2p_trade_pay_to(p_trade_id uuid)
returns table (method text, holder_name text, details jsonb)
language sql stable security definer set search_path = public as $$
  select m.method, m.holder_name, m.details
  from public.p2p_trades t
  join public.p2p_payment_methods m on m.id = t.payment_method_id
  where t.id = p_trade_id
    and public.p2p_current_user_id() in (t.buyer_id, t.seller_id)
    and t.status in ('awaiting_seller_confirmation', 'waiting_for_buyer', 'payment_sent', 'released', 'completed')
$$;
revoke all on function public.p2p_trade_pay_to(uuid) from public;
grant execute on function public.p2p_trade_pay_to(uuid) to authenticated;

-- ── Live FX rates (for floating prices) ─────────────────────────────────
-- Refreshed every 15 minutes from open.er-api.com (USD base, daily ECB-style
-- rates) through pg_net: each run applies the previous request's response,
-- then sends the next request.
create table if not exists public.p2p_fx_rates (
  currency text primary key,
  usd_rate numeric not null check (usd_rate > 0),
  updated_at timestamptz not null default now()
);
alter table public.p2p_fx_rates enable row level security;
drop policy if exists p2p_fx_rates_read on public.p2p_fx_rates;
create policy p2p_fx_rates_read on public.p2p_fx_rates for select using (true);

create table if not exists public.p2p_fx_state (id int primary key default 1 check (id = 1), request_id bigint);
alter table public.p2p_fx_state enable row level security;
insert into public.p2p_fx_state (id, request_id) values (1, null) on conflict (id) do nothing;

create or replace function public.p2p_fx_refresh()
returns void language plpgsql security definer set search_path = public, net as $$
declare
  rid bigint;
  body jsonb;
begin
  select request_id into rid from public.p2p_fx_state where id = 1;
  if rid is not null then
    select content::jsonb into body from net._http_response where id = rid and status_code = 200;
    if body is not null and body->>'result' = 'success' and jsonb_typeof(body->'rates') = 'object' then
      insert into public.p2p_fx_rates (currency, usd_rate, updated_at)
      select k, v::text::numeric, now() from jsonb_each(body->'rates') as r(k, v)
      where jsonb_typeof(v) = 'number' and v::text::numeric > 0 and k ~ '^[A-Z]{3}$'
      on conflict (currency) do update set usd_rate = excluded.usd_rate, updated_at = excluded.updated_at;
    end if;
  end if;
  update public.p2p_fx_state set request_id = net.http_get('https://open.er-api.com/v6/latest/USD') where id = 1;
end;
$$;
revoke all on function public.p2p_fx_refresh() from public;

do $$ begin
  perform cron.unschedule('p2p-fx-refresh');
exception when others then null; end $$;
select cron.schedule('p2p-fx-refresh', '*/15 * * * *', 'select public.p2p_fx_refresh()');
select public.p2p_fx_refresh();

-- The price a NEW trade on this ad gets right now (null = no live rate).
create or replace function public.p2p_offer_live_price(o public.p2p_offers)
returns numeric language sql stable set search_path = public as $$
  select case
    when o.price_type = 'floating' then (
      select round(r.usd_rate * (1 + o.float_margin_pct / 100.0), 2)
      from public.p2p_fx_rates r
      where r.currency = upper(o.currency) and r.updated_at > now() - interval '2 days')
    else o.price_per_usdc
  end
$$;

-- ── Trade insert guard: + floating price, + chosen payment account ──────
create or replace function public.p2p_trades_insert_guard()
returns trigger language plpgsql set search_path = public as $$
declare
  o public.p2p_offers%rowtype;
  me text := public.p2p_current_user_id();
  live_price numeric;
  pm public.p2p_payment_methods%rowtype;
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then return new; end if;
  select * into o from public.p2p_offers where id = new.offer_id;
  if not found then raise exception 'Offer not found' using errcode = '22023'; end if;
  if new.buyer_id = new.seller_id then raise exception 'You cannot trade with yourself' using errcode = '22023'; end if;
  if o.offer_type = 'sell' then
    if new.seller_id is distinct from o.user_id or new.buyer_id is distinct from me then
      raise exception 'Trade parties do not match the offer' using errcode = '42501';
    end if;
    if new.status is distinct from 'awaiting_seller_confirmation' then raise exception 'Invalid starting status' using errcode = '22023'; end if;
  else
    if new.buyer_id is distinct from o.user_id or new.seller_id is distinct from me then
      raise exception 'Trade parties do not match the offer' using errcode = '42501';
    end if;
    if new.status is distinct from 'waiting_for_buyer' then raise exception 'Invalid starting status' using errcode = '22023'; end if;
  end if;
  new.offer_type := o.offer_type;
  new.currency := o.currency;
  live_price := public.p2p_offer_live_price(o);
  if live_price is null or live_price <= 0 then
    raise exception 'The live price for this ad is unavailable right now - try again in a minute' using errcode = '22023';
  end if;
  new.price_per_usdc := live_price;
  if o.min_amount is not null and new.amount_usdc < o.min_amount
     or o.max_amount is not null and new.amount_usdc > o.max_amount
     or new.amount_usdc <= 0 then
    raise exception 'Amount is outside this offer''s limits' using errcode = '22023';
  end if;
  new.amount_fiat := round(new.amount_usdc * live_price, 2);
  -- The account the buyer pays must be the seller's own, live, and (on a
  -- sell ad) one the ad offers.
  if new.payment_method_id is not null then
    select * into pm from public.p2p_payment_methods where id = new.payment_method_id;
    if not found or pm.deleted_at is not null or pm.user_id is distinct from new.seller_id then
      raise exception 'That payment method is not available' using errcode = '22023';
    end if;
    if o.offer_type = 'sell' and not (new.payment_method_id = any (o.payment_method_ids)) then
      raise exception 'That payment method is not on this ad' using errcode = '22023';
    end if;
    new.payment_method := pm.method;
  end if;
  new.admin_frozen := false;
  new.dispute_status := 'none';
  new.admin_note := null;
  return new;
end;
$$;

-- ── Offer guard: the new fields are owner-only too ──────────────────────
create or replace function public.p2p_offers_client_guard()
returns trigger language plpgsql set search_path = public as $$
declare
  me text := public.p2p_current_user_id();
  is_admin boolean := exists (select 1 from public.admin_users a where a.id = auth.uid());
begin
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') or is_admin then return new; end if;
  if tg_op = 'INSERT' then
    new.is_verified_merchant := coalesce(public.is_approved_merchant(new.wallet_address), false);
    return new;
  end if;
  new.is_verified_merchant := old.is_verified_merchant;
  if me is distinct from old.user_id then
    if new.price_per_usdc is distinct from old.price_per_usdc
       or new.min_amount is distinct from old.min_amount
       or new.max_amount is distinct from old.max_amount
       or new.payment_methods is distinct from old.payment_methods
       or new.terms is distinct from old.terms
       or new.country_region is distinct from old.country_region
       or new.trade_window_minutes is distinct from old.trade_window_minutes
       or new.offer_expires_at is distinct from old.offer_expires_at
       or new.total_amount is distinct from old.total_amount
       or new.escrow_balance is distinct from old.escrow_balance
       or new.escrow_deposit_tx_hash is distinct from old.escrow_deposit_tx_hash
       or new.escrow_withdraw_tx_hash is distinct from old.escrow_withdraw_tx_hash
       or new.auto_accept is distinct from old.auto_accept
       or new.price_type is distinct from old.price_type
       or new.float_margin_pct is distinct from old.float_margin_pct
       or new.auto_reply is distinct from old.auto_reply
       or new.payment_method_ids is distinct from old.payment_method_ids
    then
      raise exception 'Only the offer owner can change this offer' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- ── Merchant stats for the market list, many sellers at once ────────────
create or replace function public.p2p_merchant_stats(p_user_ids text[])
returns table (user_id text, orders bigint, completion_pct numeric, avg_release_seconds numeric)
language sql stable security definer set search_path = public as $$
  with t as (
    select x.uid, tr.status, tr.payment_sent_at, tr.released_at
    from unnest(p_user_ids) as x(uid)
    join public.p2p_trades tr on tr.seller_id = x.uid or tr.buyer_id = x.uid
    where tr.created_at > now() - interval '90 days'
  )
  select uid,
    count(*) filter (where status in ('completed', 'released')),
    case when count(*) filter (where status in ('completed', 'released', 'cancelled', 'expired')) = 0 then null
      else round(100.0 * count(*) filter (where status in ('completed', 'released'))
        / count(*) filter (where status in ('completed', 'released', 'cancelled', 'expired')), 1) end,
    round(avg(extract(epoch from (released_at - payment_sent_at))) filter (where released_at is not null and payment_sent_at is not null))
  from t group by uid
$$;
grant execute on function public.p2p_merchant_stats(text[]) to anon, authenticated;

-- ── An ad's payment options for the buyer's picker: id + method name only
-- (never the account details - those come from p2p_trade_pay_to once an
-- order exists).
create or replace function public.p2p_offer_payment_options(p_offer_id uuid)
returns table (id uuid, method text)
language sql stable security definer set search_path = public as $$
  select m.id, m.method
  from public.p2p_offers o
  join public.p2p_payment_methods m on m.id = any (o.payment_method_ids)
  where o.id = p_offer_id and m.user_id = o.user_id and m.deleted_at is null
$$;
grant execute on function public.p2p_offer_payment_options(uuid) to anon, authenticated;
