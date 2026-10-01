-- ─────────────────────────────────────────────────────────────────────────
-- P2P trades/offers: ownership-scoped RLS + a hard backstop on who may
-- release/complete a trade.
--
-- Bug this closes (/cso finding #3, CRITICAL): p2p_trades_select_all /
-- p2p_trades_update_all / p2p_trades_insert_all (and the equivalent
-- p2p_offers policies) were `USING (true)` for the `public` role — i.e.
-- ANY caller, including one using nothing but the public anon key with no
-- session at all, could read every trade, fabricate new trades, or
-- directly PATCH an existing trade's status to 'released'/'completed'.
-- Verified live: neither existing guard trigger
-- (p2p_enforce_trade_cancellation, p2p_enforce_dispute_lock) gates a
-- transition INTO 'released' or 'completed' — that transition had NO
-- backstop at all before this migration.
--
-- buyer_id / seller_id / p2p_offers.user_id all store the caller's own
-- auth.uid() (as text) — confirmed by the existing
-- p2p_enforce_trade_cancellation() trigger, which compares
-- `auth.uid()::text` directly against `seller_id`. RLS below uses the same
-- comparison.
--
-- Admin bypass mirrors the exact pattern already used by
-- p2p_enforce_dispute_lock() and support_tickets_admin_all: membership in
-- public.admin_users, checked by auth.uid().
-- ─────────────────────────────────────────────────────────────────────────

begin;

-- ── p2p_trades: participants + admin only ──────────────────────────────────
drop policy if exists p2p_trades_select_all on public.p2p_trades;
drop policy if exists p2p_trades_insert_all on public.p2p_trades;
drop policy if exists p2p_trades_update_all on public.p2p_trades;

create policy p2p_trades_select_participant on public.p2p_trades
  for select using (
    auth.uid()::text = buyer_id
    or auth.uid()::text = seller_id
    or exists (select 1 from public.admin_users a where a.id = auth.uid())
  );

-- A trade can only be inserted by one of the two parties it names — closes
-- the "fabricate a trade you're not part of at all" hole. (Deeper
-- validation that offer_id/amount genuinely match the referenced offer is
-- existing application-layer logic, unchanged by this migration.)
create policy p2p_trades_insert_participant on public.p2p_trades
  for insert with check (
    auth.uid() is not null
    and (auth.uid()::text = buyer_id or auth.uid()::text = seller_id)
  );

create policy p2p_trades_update_participant on public.p2p_trades
  for update using (
    auth.uid()::text = buyer_id
    or auth.uid()::text = seller_id
    or exists (select 1 from public.admin_users a where a.id = auth.uid())
  )
  with check (
    auth.uid()::text = buyer_id
    or auth.uid()::text = seller_id
    or exists (select 1 from public.admin_users a where a.id = auth.uid())
  );

-- ── Hard backstop: only the seller (the party who actually holds/deposited
-- the escrow) may claim a release, and only from 'payment_sent'; only that
-- same claim may be finalized to 'completed', and only from 'released'.
-- Mirrors the existing p2p_enforce_trade_cancellation /
-- p2p_enforce_dispute_lock triggers exactly: current_user check exempts
-- server code (service role — used by releaseTrade()'s own follow-up
-- writes via the browser's anon/authenticated role are STILL covered,
-- since the browser always runs as anon/authenticated; only the
-- p2p-release-reconcile edge function and any future service-role code
-- path are exempt).
create or replace function public.p2p_enforce_release_authorization()
returns trigger
language plpgsql
as $$
declare
  is_admin boolean;
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if NEW.status = 'released' and OLD.status is distinct from 'released' then
    is_admin := exists (select 1 from public.admin_users a where a.id = auth.uid());
    if OLD.status is distinct from 'payment_sent' and not is_admin then
      raise exception 'A trade can only move to released from payment_sent.'
        using errcode = '22023';
    end if;
    if auth.uid()::text is distinct from OLD.seller_id and not is_admin then
      raise exception 'Only the seller may release this trade.'
        using errcode = '22023';
    end if;
  end if;

  if NEW.status = 'completed' and OLD.status is distinct from 'completed' then
    is_admin := exists (select 1 from public.admin_users a where a.id = auth.uid());
    if OLD.status is distinct from 'released' and not is_admin then
      raise exception 'A trade can only move to completed from released.'
        using errcode = '22023';
    end if;
    if auth.uid()::text is distinct from OLD.seller_id and not is_admin then
      raise exception 'Only the seller may complete this trade.'
        using errcode = '22023';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_p2p_enforce_release_authorization on public.p2p_trades;
create trigger trg_p2p_enforce_release_authorization
  before update on public.p2p_trades
  for each row execute function public.p2p_enforce_release_authorization();

comment on function public.p2p_enforce_release_authorization is
  'Hard backstop: a transition to released only from payment_sent by the seller, and to completed only from released by the seller (or an admin_users member in either case). Closes the gap where RLS alone could not distinguish "the right party, right transition" from "any participant, any transition" — added alongside the ownership-scoped RLS in this same migration.';

-- ── p2p_offers: public can still browse (marketplace), but only the owner
-- or an active trade counterparty may write ─────────────────────────────────
drop policy if exists p2p_offers_insert_all on public.p2p_offers;
drop policy if exists p2p_offers_update_all on public.p2p_offers;
-- p2p_offers_select_all (USING true) is intentionally left as-is — offers
-- are a public marketplace listing, not private data.

create policy p2p_offers_insert_owner on public.p2p_offers
  for insert with check (auth.uid() is not null and auth.uid()::text = user_id);

create policy p2p_offers_update_owner_or_trade_party on public.p2p_offers
  for update using (
    auth.uid()::text = user_id
    or exists (
      select 1 from public.p2p_trades t
      where t.offer_id = p2p_offers.id
        and (auth.uid()::text = t.buyer_id or auth.uid()::text = t.seller_id)
    )
    or exists (select 1 from public.admin_users a where a.id = auth.uid())
  )
  with check (
    auth.uid()::text = user_id
    or exists (
      select 1 from public.p2p_trades t
      where t.offer_id = p2p_offers.id
        and (auth.uid()::text = t.buyer_id or auth.uid()::text = t.seller_id)
    )
    or exists (select 1 from public.admin_users a where a.id = auth.uid())
  );

commit;
