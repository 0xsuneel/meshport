-- Split groups: every split is a group - its creator and everyone asked for a
-- share - with its own message thread (shown in Chats like a group chat).
-- Messages are plain text readable by the group's members only (RLS). Paying
-- a share is still the share's own payment request.

-- Who is in a split: its creator, or anyone asked for a share in it.
create or replace function public.is_split_member(p_split uuid)
returns boolean language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.splits s where s.id = p_split and s.creator_auth_uid = auth.uid())
      or exists (select 1 from public.merchant_payment_intents i
                  join public.users u on u.id::text = i.customer_user_id
                 where i.split_id = p_split and u.auth_uid = auth.uid())
$$;
revoke all on function public.is_split_member(uuid) from public, anon;
grant execute on function public.is_split_member(uuid) to authenticated;

create table if not exists public.split_messages (
  id             uuid primary key default gen_random_uuid(),
  split_id       uuid not null references public.splits(id) on delete cascade,
  sender_user_id uuid not null,
  body           text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at     timestamptz not null default now()
);
create index if not exists split_messages_split_idx on public.split_messages (split_id, created_at);
alter table public.split_messages enable row level security;
drop policy if exists split_messages_read on public.split_messages;
create policy split_messages_read on public.split_messages for select using (public.is_split_member(split_id));
drop policy if exists split_messages_send on public.split_messages;
create policy split_messages_send on public.split_messages for insert with check (
  public.is_split_member(split_id)
  and sender_user_id = (select u.id from public.users u where u.auth_uid = (select auth.uid()) limit 1));
-- New messages arrive live in an open group.
do $$ begin
  alter publication supabase_realtime add table public.split_messages;
exception when duplicate_object then null; when undefined_object then null;
end $$;

-- A split for everyone in it: every person with their status (a group sees
-- who has paid), and user ids so the thread can name each sender.
create or replace function public.split_summary(p_split uuid)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  uid uuid := auth.uid();
  s public.splits;
  creator public.users;
  is_creator boolean;
  people jsonb;
  cnt int; paid int; left_amt numeric;
begin
  if uid is null then raise exception 'Split not found'; end if;
  select * into s from public.splits where id = p_split;
  if s.id is null or not public.is_split_member(s.id) then raise exception 'Split not found'; end if;
  is_creator := s.creator_auth_uid = uid;
  select * into creator from public.users where auth_uid = s.creator_auth_uid limit 1;

  select count(*), count(*) filter (where i.status = 'paid'),
         coalesce(sum(greatest(i.requested_amount - i.received_amount, 0)) filter (where i.status in ('pending', 'partially_paid', 'processing')), 0)
    into cnt, paid, left_amt
    from public.merchant_payment_intents i where i.split_id = s.id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id, 'code', i.code, 'userId', u.id, 'isMe', u.auth_uid = uid,
      'username', u.username, 'name', coalesce(nullif(u.display_name, ''), u.username),
      'avatar', u.avatar_url, 'amount', i.requested_amount, 'received', i.received_amount,
      'status', case when i.status = 'pending' and i.expires_at is not null and i.expires_at < now() then 'expired' else i.status end,
      'paidAt', i.paid_at, 'completedByMe', i.completed_by_merchant, 'completedNote', i.completed_note,
      'lastRemindedAt', case when is_creator then i.last_reminded_at end, 'createdAt', i.created_at) order by i.created_at), '[]'::jsonb)
    into people
    from public.merchant_payment_intents i left join public.users u on u.id::text = i.customer_user_id
   where i.split_id = s.id;

  return jsonb_build_object(
    'id', s.id, 'title', s.title, 'emoji', s.emoji, 'total', s.total, 'myShare', s.my_share, 'currency', s.currency,
    'createdAt', s.created_at, 'isCreator', is_creator, 'sourceTx', case when is_creator then s.source_tx_hash end,
    'creator', jsonb_build_object('userId', creator.id, 'username', creator.username, 'name', coalesce(nullif(creator.display_name, ''), creator.username), 'avatar', creator.avatar_url),
    'people', cnt + 1, 'requests', cnt, 'paidCount', paid, 'owedLeft', left_amt,
    'members', people);
end $$;
revoke all on function public.split_summary(uuid) from public, anon;
grant execute on function public.split_summary(uuid) to authenticated;

-- Every split group you're in, newest activity first, for the Chats list.
create or replace function public.my_split_groups()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare uid uuid := auth.uid(); my_id uuid; out jsonb;
begin
  if uid is null then return '[]'::jsonb; end if;
  select id into my_id from public.users where auth_uid = uid limit 1;
  with mine as (
    select s.* from public.splits s
     where s.creator_auth_uid = uid
        or exists (select 1 from public.merchant_payment_intents i where i.split_id = s.id and i.customer_user_id = my_id::text)
  ), last_msg as (
    select distinct on (m.split_id) m.split_id, m.body, m.created_at, m.sender_user_id,
           coalesce(nullif(u.display_name, ''), u.username) as sender_name
      from public.split_messages m join mine on mine.id = m.split_id
      left join public.users u on u.id = m.sender_user_id
     order by m.split_id, m.created_at desc
  ), last_pay as (
    select i.split_id, max(i.paid_at) as at from public.merchant_payment_intents i join mine on mine.id = i.split_id group by i.split_id
  )
  select coalesce(jsonb_agg(g order by (g->>'at') desc), '[]'::jsonb) into out from (
    select jsonb_build_object(
      'id', mine.id, 'title', mine.title, 'emoji', mine.emoji, 'total', mine.total, 'isCreator', mine.creator_auth_uid = uid,
      'people', 1 + (select count(*) from public.merchant_payment_intents i where i.split_id = mine.id),
      'paidCount', (select count(*) from public.merchant_payment_intents i where i.split_id = mine.id and i.status = 'paid'),
      'requests', (select count(*) from public.merchant_payment_intents i where i.split_id = mine.id),
      'lastBody', lm.body, 'lastSender', lm.sender_name, 'lastIsMe', lm.sender_user_id = my_id,
      'at', greatest(mine.created_at, coalesce(lm.created_at, mine.created_at), coalesce(lp.at, mine.created_at))) as g
      from mine left join last_msg lm on lm.split_id = mine.id left join last_pay lp on lp.split_id = mine.id
     limit 200) t;
  return out;
end $$;
revoke all on function public.my_split_groups() from public, anon;
grant execute on function public.my_split_groups() to authenticated;
