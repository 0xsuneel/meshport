-- Chat blocking (Chats → your profile picture → Chat privacy → Blocked).
--
--   chat_blocks (owner_id blocks blocked_id) - yours only, read/write by you.
--   · A blocked person can't send you messages: the messages insert rule
--     refuses them (server code checks too - api/chat).
--   · Their Pay / Chat Pay shows "<you> has blocked you" before anything is
--     sent (chat_reach_check.blocked). An on-chain transfer can't be refused,
--     but it lands without an alert (chat_quiet_from).
--   · Blocking also takes them out of your Requests.

begin;

create table if not exists public.chat_blocks (
  owner_id   uuid not null references public.users(id) on delete cascade,
  blocked_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, blocked_id),
  check (owner_id <> blocked_id)
);
alter table public.chat_blocks enable row level security;

drop policy if exists chat_blocks_select on public.chat_blocks;
drop policy if exists chat_blocks_insert on public.chat_blocks;
drop policy if exists chat_blocks_delete on public.chat_blocks;
create policy chat_blocks_select on public.chat_blocks for select using (
  exists (select 1 from public.users u where u.id = chat_blocks.owner_id and u.auth_uid = auth.uid()));
create policy chat_blocks_insert on public.chat_blocks for insert with check (
  exists (select 1 from public.users u where u.id = chat_blocks.owner_id and u.auth_uid = auth.uid()));
create policy chat_blocks_delete on public.chat_blocks for delete using (
  exists (select 1 from public.users u where u.id = chat_blocks.owner_id and u.auth_uid = auth.uid()));
grant select, insert, delete on public.chat_blocks to authenticated;

-- Has the other person in this chat blocked `sender`? (Used by the messages rule.)
create or replace function public.chat_blocked_in(conv uuid, sender uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.conversations c
    join public.chat_blocks b
      on b.owner_id = case when c.participant_a = sender then c.participant_b else c.participant_a end
     and b.blocked_id = sender
    where c.id = conv)
$$;
revoke all on function public.chat_blocked_in(uuid, uuid) from public, anon;
grant execute on function public.chat_blocked_in(uuid, uuid) to authenticated, service_role;

-- Messages: same rule as before, plus "not blocked by the other person".
drop policy if exists msg_insert on public.messages;
create policy msg_insert on public.messages for insert with check (
  type = 'text'
  and exists (select 1 from public.users u
              where u.id = messages.sender_id and u.auth_uid = auth.uid())
  and exists (select 1 from public.conversations c
              where c.id = messages.conversation_id
                and messages.sender_id in (c.participant_a, c.participant_b))
  and not public.chat_blocked_in(messages.conversation_id, messages.sender_id));

-- Reach check now also says whether they blocked me.
drop function if exists public.chat_reach_check(uuid);
create function public.chat_reach_check(recipient uuid)
returns table (can_pay boolean, to_requests boolean, blocked boolean)
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
  if me is null or r is null then
    return query select true, false, false;
    return;
  end if;
  if exists (select 1 from public.chat_blocks b where b.owner_id = recipient and b.blocked_id = me) then
    return query select false, false, true;
    return;
  end if;
  if public.chat_is_merchant(recipient) then
    return query select true, false, false;
    return;
  end if;
  known := public.chat_knows(recipient, me);
  return query select (r.stranger_payments = 'allow' or known),
                      (r.msg_privacy = 'contacts' and not known),
                      false;
end;
$$;
revoke all on function public.chat_reach_check(uuid) from public, anon;
grant execute on function public.chat_reach_check(uuid) to authenticated;

-- Requests never include people I blocked.
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
    and not exists (select 1 from public.chat_blocks b
                    where b.owner_id = me.id
                      and b.blocked_id = case when c.participant_a = me.id then c.participant_b else c.participant_a end)
$$;

-- Alerts: nothing from someone I blocked (any setting), else as before.
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
  select u.id into sender from public.users u where lower(u.wallet_address) = lower(from_wallet) limit 1;
  if sender is not null and exists (select 1 from public.chat_blocks b
                                    where b.owner_id = recipient and b.blocked_id = sender) then
    return true;
  end if;
  select u.msg_privacy, u.stranger_payments into r from public.users u where u.id = recipient;
  if r is null or r.stranger_payments <> 'block' or public.chat_is_merchant(recipient) then
    return false;
  end if;
  return sender is null or not public.chat_knows(recipient, sender);
end;
$$;

commit;
