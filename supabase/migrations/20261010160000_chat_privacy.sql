-- Chat privacy: who can message me, and payments from strangers.
--
--   users.msg_privacy       'everyone' (default) | 'contacts'
--       contacts: messages from people you don't know go to Chats → Requests
--       (not All, no alert) until you accept them.
--   users.stranger_payments 'allow' (default)    | 'block'
--       block: MeshPort's Pay / Chat Pay refuse to pay you from someone you
--       don't know (checked before anything is sent), and a payment that still
--       arrives from outside MeshPort sends no alert. On-chain transfers
--       themselves can't be refused by anyone.
--
-- "Know" = they're in your contacts, or you've messaged / paid them yourself.
-- Approved merchants always accept everyone (the settings don't apply).
-- Defaults keep today's behaviour for every existing account.

begin;

alter table public.users
  add column if not exists msg_privacy text not null default 'everyone'
    check (msg_privacy in ('everyone', 'contacts')),
  add column if not exists stranger_payments text not null default 'allow'
    check (stranger_payments in ('allow', 'block'));
-- The users table grants per column: let the app read and change these two.
grant select (msg_privacy, stranger_payments), update (msg_privacy, stranger_payments)
  on public.users to authenticated;

-- Does `owner` know `other`? Server-side only (it reads contacts and chats).
create or replace function public.chat_knows(owner uuid, other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select owner = other
      or exists (select 1 from public.contacts k
                 where k.owner_id = owner and k.contact_id = other)
      or exists (select 1 from public.conversations c
                 join public.messages m on m.conversation_id = c.id
                 where ((c.participant_a = owner and c.participant_b = other)
                     or (c.participant_b = owner and c.participant_a = other))
                   and m.sender_id = owner
                   and m.type in ('text', 'payment_sent'))
$$;
revoke all on function public.chat_knows(uuid, uuid) from public, anon, authenticated;
grant execute on function public.chat_knows(uuid, uuid) to service_role;

create or replace function public.chat_is_merchant(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.merchant_applications a
                 where a.user_id = uid::text and a.status = 'approved')
$$;
revoke all on function public.chat_is_merchant(uuid) from public, anon, authenticated;
grant execute on function public.chat_is_merchant(uuid) to service_role;

-- Before paying / messaging `recipient`: may I (the signed-in user) pay them,
-- and will my messages land in their Requests? Reveals nothing beyond that.
create or replace function public.chat_reach_check(recipient uuid)
returns table (can_pay boolean, to_requests boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid;
  r record;
  known boolean;
begin
  select u.id into me from public.users u where u.auth_uid = auth.uid() limit 1;
  select u.msg_privacy, u.stranger_payments into r from public.users u where u.id = recipient;
  if me is null or r is null or public.chat_is_merchant(recipient) then
    return query select true, false;
    return;
  end if;
  known := public.chat_knows(recipient, me);
  return query select (r.stranger_payments = 'allow' or known),
                      (r.msg_privacy = 'contacts' and not known);
end;
$$;
revoke all on function public.chat_reach_check(uuid) from public, anon;
grant execute on function public.chat_reach_check(uuid) to authenticated;

-- My chats that are message requests (only when I've chosen Contacts only).
create or replace function public.chat_my_requests()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  with me as (select u.id, u.msg_privacy from public.users u where u.auth_uid = auth.uid() limit 1)
  select c.id
  from public.conversations c, me
  where me.msg_privacy = 'contacts'
    and not public.chat_is_merchant(me.id)
    and me.id in (c.participant_a, c.participant_b)
    and not public.chat_knows(me.id, case when c.participant_a = me.id then c.participant_b else c.participant_a end)
$$;
revoke all on function public.chat_my_requests() from public, anon;
grant execute on function public.chat_my_requests() to authenticated;

-- Should an alert to `recipient` about something from wallet `from_wallet`
-- stay quiet? (Server: chat payments and on-chain receive pushes.)
create or replace function public.chat_quiet_from(recipient uuid, from_wallet text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r record;
  sender uuid;
begin
  select u.msg_privacy, u.stranger_payments into r from public.users u where u.id = recipient;
  if r is null or r.stranger_payments <> 'block' or public.chat_is_merchant(recipient) then
    return false;
  end if;
  select u.id into sender from public.users u where lower(u.wallet_address) = lower(from_wallet) limit 1;
  return sender is null or not public.chat_knows(recipient, sender);
end;
$$;
revoke all on function public.chat_quiet_from(uuid, text) from public, anon, authenticated;
grant execute on function public.chat_quiet_from(uuid, text) to service_role;
-- The signed-in user may ask about their OWN alerts only.
create or replace function public.chat_quiet_for_me(from_wallet text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.chat_quiet_from(
    (select u.id from public.users u where u.auth_uid = auth.uid() limit 1), from_wallet), false)
$$;
revoke all on function public.chat_quiet_for_me(text) from public, anon;
grant execute on function public.chat_quiet_for_me(text) to authenticated;

commit;
