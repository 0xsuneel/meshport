-- FIX: "Could Not Create Order" shown while the order actually exists.
--
-- createTrade() inserts the trade row first, then runs later steps (offer
-- lock, on-chain registration...). When a later step fails it is supposed to
-- delete the row it just made. But p2p_trades has no DELETE policy, so the
-- REST DELETE returned 204 and removed nothing: the UI said "could not
-- create" while a live order stayed behind (and the seller was notified).
--
-- This is the narrow, safe way to do that undo: a SECURITY DEFINER function
-- that only removes an order that
--   * the caller is a party to,
--   * was created in the last 5 minutes,
--   * is still in its starting status (nothing paid, nothing released).
-- It also clears the offer's lock if it still points at this trade, because
-- p2p_offers.locked_by_trade_id is a foreign key to the trade row.

create or replace function public.p2p_rollback_new_trade(p_trade_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  me text := public.p2p_current_user_id();
  v_offer uuid;
begin
  if me is null then return false; end if;

  select t.offer_id into v_offer
  from public.p2p_trades t
  where t.id = p_trade_id
    and me in (t.buyer_id, t.seller_id)
    and t.status in ('awaiting_seller_confirmation', 'waiting_for_buyer')
    and t.payment_sent_at is null
    and t.created_at > now() - interval '5 minutes';
  if not found then return false; end if;

  update public.p2p_offers
     set locked_by_trade_id = null
   where id = v_offer and locked_by_trade_id = p_trade_id;

  delete from public.p2p_trades where id = p_trade_id;
  return true;
end;
$$;
revoke all on function public.p2p_rollback_new_trade(uuid) from public;
grant execute on function public.p2p_rollback_new_trade(uuid) to authenticated;
