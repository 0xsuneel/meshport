-- ─────────────────────────────────────────────────────────────────────────
-- FIX: 20260927130000_p2p_ownership_rls.sql compared auth.uid() directly to
-- p2p_trades.buyer_id / seller_id and p2p_offers.user_id.
--
-- Those columns hold the MeshPort account id (users.id — the app passes
-- useAuthStore().user.id everywhere in p2pService.ts). auth.uid() is the
-- Supabase *session* id, a different UUID, linked to the account only via
-- users.auth_uid (see 20260926170000_lock_users_and_chat.sql and the
-- bind-session edge function). So the two never matched, and every P2P
-- insert / update / participant-select was rejected by RLS.
--
-- This migration resolves the caller's account id through users.auth_uid and
-- uses that in the policies and the release-authorization trigger.
--
-- Also fixes p2p_enforce_trade_cancellation(), which had the same
-- auth.uid()::text vs seller_id comparison. (p2p_enforce_dispute_lock only
-- compares auth.uid() to admin_users.id, which is correct.)
-- ─────────────────────────────────────────────────────────────────────────

begin;

-- Caller's MeshPort account id (users.id) as text; NULL if the session is not
-- bound to an account. SECURITY DEFINER because users is column/row-locked.
create or replace function public.p2p_current_user_id()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select u.id::text from public.users u where u.auth_uid = auth.uid() limit 1
$$;

revoke all on function public.p2p_current_user_id() from public;
grant execute on function public.p2p_current_user_id() to anon, authenticated;

-- ── p2p_trades ─────────────────────────────────────────────────────────────
drop policy if exists p2p_trades_select_participant on public.p2p_trades;
drop policy if exists p2p_trades_insert_participant on public.p2p_trades;
drop policy if exists p2p_trades_update_participant on public.p2p_trades;

create policy p2p_trades_select_participant on public.p2p_trades
  for select using (
    public.p2p_current_user_id() in (buyer_id, seller_id)
    or exists (select 1 from public.admin_users a where a.id = auth.uid())
  );

create policy p2p_trades_insert_participant on public.p2p_trades
  for insert with check (
    public.p2p_current_user_id() is not null
    and public.p2p_current_user_id() in (buyer_id, seller_id)
  );

create policy p2p_trades_update_participant on public.p2p_trades
  for update using (
    public.p2p_current_user_id() in (buyer_id, seller_id)
    or exists (select 1 from public.admin_users a where a.id = auth.uid())
  )
  with check (
    public.p2p_current_user_id() in (buyer_id, seller_id)
    or exists (select 1 from public.admin_users a where a.id = auth.uid())
  );

-- ── release / complete backstop ────────────────────────────────────────────
create or replace function public.p2p_enforce_release_authorization()
returns trigger
language plpgsql
as $$
declare
  is_admin boolean;
  me text;
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  me := public.p2p_current_user_id();

  if NEW.status = 'released' and OLD.status is distinct from 'released' then
    is_admin := exists (select 1 from public.admin_users a where a.id = auth.uid());
    if OLD.status is distinct from 'payment_sent' and not is_admin then
      raise exception 'A trade can only move to released from payment_sent.' using errcode = '22023';
    end if;
    if me is distinct from OLD.seller_id and not is_admin then
      raise exception 'Only the seller may release this trade.' using errcode = '22023';
    end if;
  end if;

  if NEW.status = 'completed' and OLD.status is distinct from 'completed' then
    is_admin := exists (select 1 from public.admin_users a where a.id = auth.uid());
    if OLD.status is distinct from 'released' and not is_admin then
      raise exception 'A trade can only move to completed from released.' using errcode = '22023';
    end if;
    if me is distinct from OLD.seller_id and not is_admin then
      raise exception 'Only the seller may complete this trade.' using errcode = '22023';
    end if;
  end if;

  return new;
end;
$$;

-- ── p2p_offers ─────────────────────────────────────────────────────────────
drop policy if exists p2p_offers_insert_owner on public.p2p_offers;
drop policy if exists p2p_offers_update_owner_or_trade_party on public.p2p_offers;

create policy p2p_offers_insert_owner on public.p2p_offers
  for insert with check (
    public.p2p_current_user_id() is not null
    and public.p2p_current_user_id() = user_id
  );

create policy p2p_offers_update_owner_or_trade_party on public.p2p_offers
  for update using (
    public.p2p_current_user_id() = user_id
    or exists (
      select 1 from public.p2p_trades t
      where t.offer_id = p2p_offers.id
        and public.p2p_current_user_id() in (t.buyer_id, t.seller_id)
    )
    or exists (select 1 from public.admin_users a where a.id = auth.uid())
  )
  with check (
    public.p2p_current_user_id() = user_id
    or exists (
      select 1 from public.p2p_trades t
      where t.offer_id = p2p_offers.id
        and public.p2p_current_user_id() in (t.buyer_id, t.seller_id)
    )
    or exists (select 1 from public.admin_users a where a.id = auth.uid())
  );

-- ── cancellation backstop ──────────────────────────────────────────────────
create or replace function public.p2p_enforce_trade_cancellation()
returns trigger
language plpgsql
as $$
declare
  is_privileged boolean;
  counterparty_fulfilled boolean;
begin
  if NEW.status = 'cancelled' and OLD.status is distinct from 'cancelled' then
    is_privileged := (OLD.admin_frozen is true) or (OLD.dispute_status = 'open');

    counterparty_fulfilled :=
      (OLD.status = 'payment_sent')
      or (OLD.offer_type = 'buy' and public.p2p_current_user_id() is distinct from OLD.seller_id);

    if counterparty_fulfilled and not is_privileged then
      raise exception
        'This trade can no longer be cancelled because the counterparty has already fulfilled their obligation. Please complete the trade or open a dispute.'
        using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;

commit;
