-- Security hardening (audit 2026-10-04).
-- Each block closes a hole that was reachable with only the public anon key
-- or a normal signed-in session. Nothing here changes what the app itself
-- does; it removes what a hand-crafted API call could do.

-- ── 1. Server-only SECURITY DEFINER functions: not callable by clients ──────
-- (Postgres grants EXECUTE to PUBLIC by default.)
revoke execute on function public.merchant_notify(text, text, text, text) from public, anon, authenticated;
revoke execute on function public.fetch_and_lock_due_claims(uuid, timestamptz, integer) from public, anon, authenticated;
revoke execute on function public.fetch_and_lock_due_transfers(uuid, timestamptz, integer) from public, anon, authenticated;
revoke execute on function public.send_p2p_expiry_reminders() from public, anon, authenticated;
revoke execute on function public.merchant_order_meta(text, uuid) from public, anon, authenticated;
revoke execute on function public.admin_transaction_count(timestamptz) from public, anon;
grant execute on function public.merchant_notify(text, text, text, text) to service_role;
grant execute on function public.fetch_and_lock_due_claims(uuid, timestamptz, integer) to service_role;
grant execute on function public.fetch_and_lock_due_transfers(uuid, timestamptz, integer) to service_role;
grant execute on function public.send_p2p_expiry_reminders() to service_role;
grant execute on function public.merchant_order_meta(text, uuid) to service_role;

-- ── 2. Claim notifications: only for the caller's own wallet ───────────────
create or replace function public.get_and_mark_unnotified_claims(p_wallet_address text)
returns table(id uuid, amount numeric, arrived_amount numeric, source_chain text, completed_at timestamptz)
language plpgsql security definer set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and not exists (
    select 1 from public.users u where u.auth_uid = auth.uid() and lower(u.wallet_address) = lower(p_wallet_address)
  ) then
    return;
  end if;
  return query
  update public.claims c
  set user_notified_at = now()
  where c.wallet_address = lower(p_wallet_address)
    and c.status = 'completed'
    and c.user_notified_at is null
  returning c.id, c.amount, c.arrived_amount, c.source_chain, c.completed_at;
end;
$$;

create or replace function public.mark_claim_notified(p_claim_id uuid)
returns void language sql security definer set search_path = public
as $$
  update public.claims c
  set user_notified_at = now()
  where c.id = p_claim_id
    and c.user_notified_at is null
    and (auth.role() = 'service_role' or exists (
      select 1 from public.users u where u.auth_uid = auth.uid() and lower(u.wallet_address) = c.wallet_address
    ));
$$;

-- ── 3. Reward points can't be minted by clients ────────────────────────────
-- Balances change only through increment_user_points (own account, ≤20 per
-- award, ≤5 awards per UTC day — the app's real maximum) and the
-- rewards-claim-sign function (service role).
drop policy if exists points_insert on public.user_points;
drop policy if exists points_update on public.user_points;

create table if not exists public.point_awards_log (
  id bigint generated always as identity primary key,
  user_id text not null,
  award_day date not null,
  created_at timestamptz not null default now()
);
create index if not exists point_awards_log_user_day on public.point_awards_log (user_id, award_day);
alter table public.point_awards_log enable row level security;  -- no policies: server only

create or replace function public.increment_user_points(p_user_id text, p_wallet_address text, p_amount integer)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
begin
  if auth.role() <> 'service_role' then
    if not exists (select 1 from public.users u where u.id::text = p_user_id and u.auth_uid = auth.uid()) then
      raise exception 'Not your account' using errcode = '42501';
    end if;
    if p_amount is null or p_amount < 1 or p_amount > 20 then
      raise exception 'Invalid points amount' using errcode = '22023';
    end if;
    if (select count(*) from public.point_awards_log where user_id = p_user_id and award_day = v_day) >= 5 then
      raise exception 'Daily points limit reached' using errcode = '22023';
    end if;
    insert into public.point_awards_log (user_id, award_day) values (p_user_id, v_day);
  end if;
  insert into public.user_points (user_id, wallet_address, total_points, lifetime_points, updated_at)
  values (p_user_id, p_wallet_address, p_amount, p_amount, now())
  on conflict (user_id) do update set
    total_points    = public.user_points.total_points + p_amount,
    lifetime_points = public.user_points.lifetime_points + p_amount,
    updated_at      = now();
end;
$$;

-- Clients may log their own tx rewards, but never a claim reservation (that
-- record is what the rewards-claim-sign function trusts) or a big number.
drop policy if exists pt_insert on public.point_transactions;
create policy pt_insert on public.point_transactions for insert
with check (
  reason <> 'claim_reserved'
  and points between 0 and 20
  and exists (
    select 1 from public.users u
    where u.id::text = point_transactions.user_id
      and (u.auth_uid = auth.uid() or u.auth_uid is null)
  )
);

-- ── 4. Chat: payment cards only through /api/chat (verified on-chain) ───────
drop policy if exists msg_insert on public.messages;
create policy msg_insert on public.messages for insert
with check (
  type = 'text'
  and exists (select 1 from public.users u where u.id = messages.sender_id and u.auth_uid = auth.uid())
  and exists (
    select 1 from public.conversations c
    where c.id = messages.conversation_id
      and (messages.sender_id = c.participant_a or messages.sender_id = c.participant_b)
  )
);

-- A participant can't re-point a conversation at a third user.
create or replace function public.conversations_pin_participants()
returns trigger language plpgsql
as $$
begin
  if current_user in ('anon', 'authenticated') then
    new.id := old.id;
    new.participant_a := old.participant_a;
    new.participant_b := old.participant_b;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;
drop trigger if exists conversations_pin_participants on public.conversations;
create trigger conversations_pin_participants before update on public.conversations
for each row execute function public.conversations_pin_participants();

-- ── 5. P2P trade chat: only the two parties (and admins) ───────────────────
drop policy if exists p2p_messages_select_all on public.p2p_trade_messages;
drop policy if exists p2p_messages_insert_all on public.p2p_trade_messages;
drop policy if exists p2p_messages_select_party on public.p2p_trade_messages;
drop policy if exists p2p_messages_insert_party on public.p2p_trade_messages;
create policy p2p_messages_select_party on public.p2p_trade_messages for select
using (
  exists (select 1 from public.p2p_trades t
          where t.id = p2p_trade_messages.trade_id
            and public.p2p_current_user_id() in (t.buyer_id, t.seller_id))
  or exists (select 1 from public.admin_users a where a.id = auth.uid())
);
create policy p2p_messages_insert_party on public.p2p_trade_messages for insert
with check (
  (
    exists (select 1 from public.p2p_trades t
            where t.id = p2p_trade_messages.trade_id
              and public.p2p_current_user_id() in (t.buyer_id, t.seller_id))
    and (
      (sender_id = public.p2p_current_user_id() and coalesce(is_system, false) = false)
      or (sender_id = 'system' and is_system = true)
    )
  )
  or exists (select 1 from public.admin_users a where a.id = auth.uid())
);

-- ── 6. P2P trades are created exactly as the offer says ─────────────────────
-- Not SECURITY DEFINER: auth.role() is the caller's role from the request
-- JWT ('anon'/'authenticated' for app users, 'service_role' for servers).
create or replace function public.p2p_trades_insert_guard()
returns trigger language plpgsql set search_path = public
as $$
declare
  o public.p2p_offers%rowtype;
  me text := public.p2p_current_user_id();
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
  new.price_per_usdc := o.price_per_usdc;
  if o.min_amount is not null and new.amount_usdc < o.min_amount
     or o.max_amount is not null and new.amount_usdc > o.max_amount
     or new.amount_usdc <= 0 then
    raise exception 'Amount is outside this offer''s limits' using errcode = '22023';
  end if;
  new.amount_fiat := round(new.amount_usdc * o.price_per_usdc, 2);
  new.admin_frozen := false;
  new.dispute_status := 'none';
  new.admin_note := null;
  return new;
end;
$$;
drop trigger if exists p2p_trades_insert_guard on public.p2p_trades;
create trigger p2p_trades_insert_guard before insert on public.p2p_trades
for each row execute function public.p2p_trades_insert_guard();

-- Trade parties (not the owner) may only move the offer's lock/availability
-- fields — never its price, terms, limits, payment methods or escrow data.
-- Clients can never self-mark an offer as a verified merchant.
create or replace function public.p2p_offers_client_guard()
returns trigger language plpgsql set search_path = public
as $$
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
    then
      raise exception 'Only the offer owner can change this offer' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists p2p_offers_client_guard on public.p2p_offers;
create trigger p2p_offers_client_guard before insert or update on public.p2p_offers
for each row execute function public.p2p_offers_client_guard();

-- ── 7. Usernames: plain ASCII handles only (no look-alike characters) ──────
alter table public.users drop constraint if exists users_username_format;
alter table public.users add constraint users_username_format
  check (username is null or username ~ '^[a-z0-9_]{3,20}$') not valid;
