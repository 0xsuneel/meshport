-- FIX: buyers could not start ANY order on a sell ad ("Could not start trade -
-- please try again.").
--
-- 20261012090000_p2p_binance_flow.sql made p2p_trades_insert_guard() verify the
-- chosen payment account by reading p2p_payment_methods. That function is
-- deliberately NOT SECURITY DEFINER (see security_hardening, section 6), so the
-- read runs as the caller - and p2p_payment_methods is owner-only under RLS.
--
-- On a sell ad the account being checked is the SELLER's, and the caller is the
-- BUYER. RLS hid the row, `not found` was true, and the guard raised
-- 'That payment method is not available' on every attempt. (Buy ads were fine:
-- there the caller is the seller and owns the account.)
--
-- Fix: do just that one lookup through a narrow SECURITY DEFINER helper that
-- returns only non-secret columns (never `details`, i.e. UPI id / account no.),
-- and leave the guard itself un-definer'd, exactly as before.

create or replace function public.p2p_payment_method_for_guard(p_id uuid)
returns table (owner_id text, method text, is_deleted boolean)
language sql stable security definer set search_path = public as $$
  select m.user_id, m.method, (m.deleted_at is not null)
  from public.p2p_payment_methods m
  where m.id = p_id
$$;
revoke all on function public.p2p_payment_method_for_guard(uuid) from public;
grant execute on function public.p2p_payment_method_for_guard(uuid) to anon, authenticated;

create or replace function public.p2p_trades_insert_guard()
returns trigger language plpgsql set search_path = public as $$
declare
  o public.p2p_offers%rowtype;
  me text := public.p2p_current_user_id();
  live_price numeric;
  pm_owner text;
  pm_method text;
  pm_deleted boolean;
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
  -- sell ad) one the ad offers. Looked up via the definer helper: the caller
  -- is usually NOT the account's owner, so a plain SELECT is hidden by RLS.
  if new.payment_method_id is not null then
    select g.owner_id, g.method, g.is_deleted
      into pm_owner, pm_method, pm_deleted
      from public.p2p_payment_method_for_guard(new.payment_method_id) g;
    if pm_owner is null or pm_deleted or pm_owner is distinct from new.seller_id then
      raise exception 'That payment method is not available' using errcode = '22023';
    end if;
    if o.offer_type = 'sell' and not (new.payment_method_id = any (o.payment_method_ids)) then
      raise exception 'That payment method is not on this ad' using errcode = '22023';
    end if;
    new.payment_method := pm_method;
  end if;
  new.admin_frozen := false;
  new.dispute_status := 'none';
  new.admin_note := null;
  return new;
end;
$$;
