-- A split group has its own name (Google Pay / PhonePe style): "🛍️ Shopping"
-- stays the group's name when a 🍕 Dinner expense is added - before, the group
-- showed as its latest expense's title, so its name kept changing.
--
-- Stored on the group's first split (group_name / group_emoji); null = the
-- first split's own title and emoji, so existing groups keep the name they
-- started with. Anyone in the group can rename it (split_group_rename); the
-- rename is posted in the group's thread so everyone sees who changed it.
-- Each expense keeps its own title / category.

alter table public.splits add column if not exists group_name text check (group_name is null or char_length(group_name) between 1 and 40);
alter table public.splits add column if not exists group_emoji text check (group_emoji is null or char_length(group_emoji) <= 8);

create or replace function public.split_group_rename(p_split uuid, p_name text, p_emoji text default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare gid uuid; n text := btrim(coalesce(p_name, '')); e text := nullif(btrim(coalesce(p_emoji, '')), ''); me uuid; old_name text;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  gid := public.split_group_of(p_split);
  if gid is null or not public.is_split_member(gid) then raise exception 'Group not found'; end if;
  if char_length(n) < 1 or char_length(n) > 40 then raise exception 'Give the group a name (up to 40 characters)'; end if;
  if e is not null and char_length(e) > 8 then e := null; end if;
  select coalesce(group_name, title) into old_name from public.splits where id = gid;
  if old_name = n and e is not distinct from (select case when group_name is not null then group_emoji else emoji end from public.splits where id = gid) then
    return jsonb_build_object('groupId', gid, 'groupName', n, 'groupEmoji', e);
  end if;
  update public.splits set group_name = n, group_emoji = e where id = gid;
  select id into me from public.users where auth_uid = auth.uid() limit 1;
  if me is not null then
    insert into public.split_messages (split_id, sender_user_id, body)
    values (gid, me, left('✎ renamed the group to “' || coalesce(e || ' ', '') || n || '”', 1000));
  end if;
  return jsonb_build_object('groupId', gid, 'groupName', n, 'groupEmoji', e);
end $$;
revoke all on function public.split_group_rename(uuid, text, text) from public, anon;
grant execute on function public.split_group_rename(uuid, text, text) to authenticated;

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
  root public.splits;
  cnt int; paid int; left_amt numeric;
begin
  if uid is null then raise exception 'Split not found'; end if;
  select * into s from public.splits where id = p_split;
  if s.id is null or not public.is_split_member(s.id) then raise exception 'Split not found'; end if;
  is_creator := s.creator_auth_uid = uid;
  gid := coalesce(s.group_id, s.id);
  select * into root from public.splits where id = gid;
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
    'groupId', gid, 'groupSplits', others,
    'groupName', coalesce(root.group_name, root.title), 'groupEmoji', case when root.group_name is not null then root.group_emoji else root.emoji end);
end $$;
revoke all on function public.split_summary(uuid) from public, anon;
grant execute on function public.split_summary(uuid) to authenticated;

-- Chats: one row per group, with the group's own name and its latest expense.
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
  ), roots as (
    select r.id as gid, coalesce(r.group_name, r.title) as gname, case when r.group_name is not null then r.group_emoji else r.emoji end as gemoji
      from public.splits r where r.id in (select distinct gid from mine)
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
      'id', l.id, 'groupId', l.gid, 'groupName', rt.gname, 'groupEmoji', rt.gemoji, 'title', l.title, 'emoji', l.emoji, 'total', l.total, 'isCreator', l.creator_auth_uid = uid,
      'people', 1 + (select count(*) from public.merchant_payment_intents i where i.split_id = l.id),
      'paidCount', (select count(*) from public.merchant_payment_intents i where i.split_id = l.id and i.status = 'paid'),
      'requests', (select count(*) from public.merchant_payment_intents i where i.split_id = l.id),
      'lastBody', lm.body, 'lastSender', lm.sender_name, 'lastIsMe', lm.sender_user_id = my_id,
      'at', greatest(fa.at, coalesce(lm.created_at, fa.at), coalesce(lp.at, fa.at))) as g
      from latest l
      join first_at fa on fa.gid = l.gid
      join roots rt on rt.gid = l.gid
      left join last_msg lm on lm.split_id = l.gid
      left join last_pay lp on lp.gid = l.gid
     limit 200) t;
  return out;
end $$;
revoke all on function public.my_split_groups() from public, anon;
grant execute on function public.my_split_groups() to authenticated;
