-- Chat privacy: who can request money from me.
--
--   users.request_privacy 'everyone' (default) | 'contacts'
--       contacts: only people you know can send you a payment request
--       (chat + → Request, or Receive → Request payment with your username).
--
-- Also, payment requests are between people, not with merchants:
--   · a merchant can't send a request (they send a Bill instead), and
--   · nobody can send a request to a merchant.
--
-- chat_reach_check gains can_request so the app hides Request for that
-- person; the insert guard below enforces the same rule for any request
-- that names a customer. "Know" = chat_knows (contacts, or you messaged /
-- paid them yourself). Defaults keep today's behaviour for every account.

begin;

alter table public.users
  add column if not exists request_privacy text not null default 'everyone'
    check (request_privacy in ('everyone', 'contacts'));
grant select (request_privacy), update (request_privacy) on public.users to authenticated;

-- May `requester` send `recipient` a payment request?
create or replace function public.chat_can_request(requester uuid, recipient uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select requester is not null and recipient is not null and requester <> recipient
     and not public.chat_is_merchant(requester)
     and not public.chat_is_merchant(recipient)
     and not exists (select 1 from public.chat_blocks b where b.owner_id = recipient and b.blocked_id = requester)
     and exists (select 1 from public.users u where u.id = recipient
                 and (u.request_privacy = 'everyone' or public.chat_knows(recipient, requester)))
$$;
revoke all on function public.chat_can_request(uuid, uuid) from public, anon, authenticated;
grant execute on function public.chat_can_request(uuid, uuid) to service_role;

drop function if exists public.chat_reach_check(uuid);
create function public.chat_reach_check(recipient uuid)
returns table (can_pay boolean, to_requests boolean, blocked boolean, can_request boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid;
  r record;
  known boolean;
  can_req boolean;
begin
  select u.id into me from public.users u where u.auth_uid = auth.uid() limit 1;
  select u.msg_privacy, u.stranger_payments into r from public.users u where u.id = recipient;
  if me is null or r is null then
    return query select true, false, false, false;
    return;
  end if;
  if exists (select 1 from public.chat_blocks b where b.owner_id = recipient and b.blocked_id = me) then
    return query select false, false, true, false;
    return;
  end if;
  can_req := public.chat_can_request(me, recipient);
  if public.chat_is_merchant(recipient) then
    return query select true, false, false, can_req;
    return;
  end if;
  known := public.chat_knows(recipient, me);
  return query select (r.stranger_payments = 'allow' or known),
                      (r.msg_privacy = 'contacts' and not known),
                      false,
                      can_req;
end;
$$;
revoke all on function public.chat_reach_check(uuid) from public, anon;
grant execute on function public.chat_reach_check(uuid) to authenticated;

-- Enforce it on every personal request that names a customer. Runs after
-- merchant_payment_intents_before_write (triggers fire in name order), which
-- has already resolved personal / merchant_user_id / customer_user_id.
-- Merchant requests (personal = false) are their own Ledger flow.
create or replace function public.merchant_payment_intents_request_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requester uuid;
  recipient uuid;
begin
  if not coalesce(new.personal, false) or new.customer_user_id is null then
    return new;
  end if;
  requester := new.merchant_user_id::uuid;
  recipient := new.customer_user_id::uuid;
  if public.chat_is_merchant(recipient) then
    raise exception 'You can''t send a payment request to a merchant';
  end if;
  if not public.chat_can_request(requester, recipient) then
    raise exception '%.arc only accepts payment requests from their contacts', new.customer_username;
  end if;
  return new;
end;
$$;
revoke all on function public.merchant_payment_intents_request_guard() from public, anon, authenticated;

drop trigger if exists merchant_payment_intents_request_guard on public.merchant_payment_intents;
create trigger merchant_payment_intents_request_guard
  before insert on public.merchant_payment_intents
  for each row execute function public.merchant_payment_intents_request_guard();

commit;
