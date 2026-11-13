-- "Split again with group" adds the new split to the SAME group (one entry in
-- Chats, one message thread), instead of starting a new group each time.
--
-- A group is its first split: splits.group_id points at it (null = the split
-- is a group's first, or alone). Messages stay keyed by that first split's id,
-- so a group's existing thread simply continues. split_create is unchanged:
-- the app calls split_join_group right after it, for the split it just made.

alter table public.splits add column if not exists group_id uuid references public.splits(id) on delete set null;
create index if not exists splits_group_idx on public.splits (group_id) where group_id is not null;

-- The group a split belongs to (its first split's id).
create or replace function public.split_group_of(p_split uuid)
returns uuid language sql stable security definer set search_path to '' as $$
  select coalesce(s.group_id, s.id) from public.splits s where s.id = p_split
$$;
revoke all on function public.split_group_of(uuid) from public, anon;
grant execute on function public.split_group_of(uuid) to authenticated;

-- Who is in a split: its creator or anyone asked for a share in it - or in any
-- other split of the same group (a group is everyone across its splits).
create or replace function public.is_split_member(p_split uuid)
returns boolean language sql stable security definer set search_path to '' as $$
  with g as (select coalesce(s.group_id, s.id) as gid from public.splits s where s.id = p_split),
       grp as (select s.* from public.splits s, g where coalesce(s.group_id, s.id) = g.gid)
  select exists (select 1 from grp where grp.creator_auth_uid = auth.uid())
      or exists (select 1 from public.merchant_payment_intents i
                  join grp on grp.id = i.split_id
                  join public.users u on u.id::text = i.customer_user_id
                 where u.auth_uid = auth.uid())
$$;
revoke all on function public.is_split_member(uuid) from public, anon;
grant execute on function public.is_split_member(uuid) to authenticated;

-- Put a split you just made into a group you are in. Only your own split, only
-- one not yet in a group, only within 10 minutes of making it.
create or replace function public.split_join_group(p_split uuid, p_group uuid)
returns uuid language plpgsql security definer set search_path to '' as $$
declare uid uuid := auth.uid(); s public.splits; gid uuid;
begin
  if uid is null then raise exception 'Sign in first'; end if;
  select * into s from public.splits where id = p_split for update;
  if s.id is null or s.creator_auth_uid <> uid then raise exception 'Split not found'; end if;
  gid := public.split_group_of(p_group);
  if gid is null or not public.is_split_member(gid) then raise exception 'Group not found'; end if;
  if gid = s.id then return s.id; end if;
  if s.group_id is not null then return s.group_id; end if;
  if s.created_at < now() - interval '10 minutes' then raise exception 'Split not found'; end if;
  -- Only a split that is nobody's group yet (no earlier split points at it).
  if exists (select 1 from public.splits x where x.group_id = s.id) then raise exception 'Split not found'; end if;
  update public.splits set group_id = gid where id = s.id;
  return gid;
end $$;
revoke all on function public.split_join_group(uuid, uuid) from public, anon;
grant execute on function public.split_join_group(uuid, uuid) to authenticated;

-- A split for everyone in it (as before), plus its group: the group's id (for
-- the thread) and the group's other splits (shown in the thread).
create or replace function public.split_summary(p_split uuid)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  uid uuid := auth.uid();
  s public.splits;
  creator public.users;
  is_creator boolean;
  people jsonb;
  others jsonb;
  gid uuid;
  cnt int; paid int; left_amt numeric;
begin
  if uid is null then raise exception 'Split not found'; end if;
  select * into s from public.splits where id = p_split;
  if s.id is null or not public.is_split_member(s.id) then raise exception 'Split not found'; end if;
  is_creator := s.creator_auth_uid = uid;
  gid := coalesce(s.group_id, s.id);
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

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', o.id, 'title', o.title, 'emoji', o.emoji, 'total', o.total, 'createdAt', o.created_at,
      'isCreator', o.creator_auth_uid = uid,
      'creatorName', coalesce(nullif(cu.display_name, ''), cu.username),
      'requests', (select count(*) from public.merchant_payment_intents i where i.split_id = o.id),
      'paidCount', (select count(*) from public.merchant_payment_intents i where i.split_id = o.id and i.status = 'paid')
    ) order by o.created_at), '[]'::jsonb)
    into others
    from public.splits o left join public.users cu on cu.auth_uid = o.creator_auth_uid
   where coalesce(o.group_id, o.id) = gid and o.id <> s.id;

  return jsonb_build_object(
    'id', s.id, 'title', s.title, 'emoji', s.emoji, 'total', s.total, 'myShare', s.my_share, 'currency', s.currency,
    'createdAt', s.created_at, 'isCreator', is_creator, 'sourceTx', case when is_creator then s.source_tx_hash end,
    'creator', jsonb_build_object('userId', creator.id, 'username', creator.username, 'name', coalesce(nullif(creator.display_name, ''), creator.username), 'avatar', creator.avatar_url),
    'people', cnt + 1, 'requests', cnt, 'paidCount', paid, 'owedLeft', left_amt,
    'members', people,
    'groupId', gid, 'groupSplits', others);
end $$;
revoke all on function public.split_summary(uuid) from public, anon;
grant execute on function public.split_summary(uuid) to authenticated;

-- Every split group you're in, newest activity first, for the Chats list: ONE
-- row per group, showing its latest split (opening it opens that split).
create or replace function public.my_split_groups()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare uid uuid := auth.uid(); my_id uuid; out jsonb;
begin
  if uid is null then return '[]'::jsonb; end if;
  select id into my_id from public.users where auth_uid = uid limit 1;
  with mine as (
    select s.*, coalesce(s.group_id, s.id) as gid from public.splits s
     where s.creator_auth_uid = uid
        or exists (select 1 from public.merchant_payment_intents i where i.split_id = s.id and i.customer_user_id = my_id::text)
  ), latest as (
    select distinct on (mine.gid) mine.* from mine order by mine.gid, mine.created_at desc
  ), last_msg as (
    select distinct on (m.split_id) m.split_id, m.body, m.created_at, m.sender_user_id,
           coalesce(nullif(u.display_name, ''), u.username) as sender_name
      from public.split_messages m join (select distinct gid from mine) g on g.gid = m.split_id
      left join public.users u on u.id = m.sender_user_id
     order by m.split_id, m.created_at desc
  ), last_pay as (
    select mine.gid, max(i.paid_at) as at from public.merchant_payment_intents i join mine on mine.id = i.split_id group by mine.gid
  ), first_at as (
    select mine.gid, max(mine.created_at) as at from mine group by mine.gid
  )
  select coalesce(jsonb_agg(g order by (g->>'at') desc), '[]'::jsonb) into out from (
    select jsonb_build_object(
      'id', l.id, 'title', l.title, 'emoji', l.emoji, 'total', l.total, 'isCreator', l.creator_auth_uid = uid,
      'people', 1 + (select count(*) from public.merchant_payment_intents i where i.split_id = l.id),
      'paidCount', (select count(*) from public.merchant_payment_intents i where i.split_id = l.id and i.status = 'paid'),
      'requests', (select count(*) from public.merchant_payment_intents i where i.split_id = l.id),
      'lastBody', lm.body, 'lastSender', lm.sender_name, 'lastIsMe', lm.sender_user_id = my_id,
      'at', greatest(fa.at, coalesce(lm.created_at, fa.at), coalesce(lp.at, fa.at))) as g
      from latest l
      join first_at fa on fa.gid = l.gid
      left join last_msg lm on lm.split_id = l.gid
      left join last_pay lp on lp.gid = l.gid
     limit 200) t;
  return out;
end $$;
revoke all on function public.my_split_groups() from public, anon;
grant execute on function public.my_split_groups() to authenticated;
