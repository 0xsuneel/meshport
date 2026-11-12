-- Split expense: one bill shared with friends.
--
-- A split is a title + total + the creator's own share. Every friend's share is
-- an ordinary personal payment request (merchant_payment_intents, kind
-- 'request') linked by split_id - the same request card in chat, the same
-- contact rule (chat_can_request), the same passcode-confirmed payment and
-- "Paid" / "Payment received". A split moves no money itself.

create table if not exists public.splits (
  id               uuid primary key default gen_random_uuid(),
  creator_auth_uid uuid not null default auth.uid(),
  title            text not null check (char_length(title) between 1 and 60),
  emoji            text check (emoji is null or char_length(emoji) <= 8),
  total            numeric not null check (total > 0 and total <= 1000000),
  my_share         numeric not null default 0 check (my_share >= 0),
  currency         text not null default 'USDC',
  source_tx_hash   text check (source_tx_hash is null or source_tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  created_at       timestamptz not null default now()
);
alter table public.splits enable row level security;
drop policy if exists splits_select_own on public.splits;
create policy splits_select_own on public.splits for select using (creator_auth_uid = (select auth.uid()));
-- Created only through split_create (atomic with its requests): no direct insert policy.
create index if not exists splits_creator_idx on public.splits (creator_auth_uid, created_at desc);

alter table public.merchant_payment_intents add column if not exists split_id uuid references public.splits(id) on delete set null;
create index if not exists merchant_payment_intents_split_idx on public.merchant_payment_intents (split_id) where split_id is not null;

-- A request can only belong to its own creator's split, and never moves to another.
create or replace function public.merchant_intents_split_guard()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if tg_op = 'UPDATE' then
    new.split_id := old.split_id;
    return new;
  end if;
  if new.split_id is not null and not exists (
    select 1 from public.splits s where s.id = new.split_id and s.creator_auth_uid = new.merchant_auth_uid) then
    raise exception 'Split not found';
  end if;
  return new;
end $$;
drop trigger if exists merchant_intents_split_guard on public.merchant_payment_intents;
create trigger merchant_intents_split_guard before insert or update on public.merchant_payment_intents
  for each row execute function public.merchant_intents_split_guard();

-- ── Create a split and every friend's request, all or nothing ─────────────
-- p_members: [{ "username": "rohit", "amount": 8.33 }, ...]
create or replace function public.split_create(p_title text, p_emoji text, p_total numeric, p_my_share numeric, p_members jsonb, p_source_tx text default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  uid uuid := auth.uid();
  me public.users;
  sid uuid;
  m jsonb;
  uname text;
  amt numeric;
  seen text[] := '{}';
  total_members numeric := 0;
  ttl text := btrim(coalesce(p_title, ''));
  emo text := nullif(btrim(coalesce(p_emoji, '')), '');
  note text;
  req public.merchant_payment_intents;
  out jsonb := '[]'::jsonb;
begin
  if uid is null then raise exception 'Sign in to split a bill'; end if;
  select * into me from public.users where auth_uid = uid limit 1;
  if me.id is null then raise exception 'Set up your wallet first'; end if;
  if char_length(ttl) < 1 or char_length(ttl) > 60 then raise exception 'Give the bill a name (up to 60 characters)'; end if;
  if emo is not null and char_length(emo) > 8 then emo := null; end if;
  p_total := round(coalesce(p_total, 0), 6);
  p_my_share := round(coalesce(p_my_share, 0), 6);
  if not (p_total > 0 and p_total <= 1000000) then raise exception 'Enter the bill''s total'; end if;
  if p_my_share < 0 then raise exception 'Your share can''t be negative'; end if;
  if jsonb_typeof(p_members) <> 'array' or jsonb_array_length(p_members) < 1 then raise exception 'Add at least one person'; end if;
  if jsonb_array_length(p_members) > 20 then raise exception 'Split with up to 20 people'; end if;
  if p_source_tx is not null and p_source_tx !~ '^0x[0-9a-fA-F]{64}$' then p_source_tx := null; end if;

  for m in select * from jsonb_array_elements(p_members) loop
    uname := nullif(lower(regexp_replace(btrim(coalesce(m->>'username', '')), '^@|\.arc$', '', 'g')), '');
    amt := round((m->>'amount')::numeric, 6);
    if uname is null then raise exception 'A person is missing'; end if;
    if uname = lower(coalesce(me.username, '')) then raise exception 'Your own share isn''t requested - leave yourself out'; end if;
    if uname = any(seen) then raise exception '%.arc is in the split twice', uname; end if;
    if amt is null or amt <= 0 then raise exception '%.arc needs a share above 0', uname; end if;
    seen := seen || uname;
    total_members := total_members + amt;
  end loop;
  if abs(total_members + p_my_share - p_total) > 0.000001 then
    raise exception 'The shares add up to % - the bill is %', trim(to_char(total_members + p_my_share, 'FM999999990.00')), trim(to_char(p_total, 'FM999999990.00'));
  end if;

  insert into public.splits (creator_auth_uid, title, emoji, total, my_share, source_tx_hash)
  values (uid, ttl, emo, p_total, p_my_share, p_source_tx) returning id into sid;
  note := left('Split · ' || coalesce(emo || ' ', '') || ttl, 140);

  for m in select * from jsonb_array_elements(p_members) loop
    uname := lower(regexp_replace(btrim(m->>'username'), '^@|\.arc$', '', 'g'));
    amt := round((m->>'amount')::numeric, 6);
    -- The same insert a chat request makes: its triggers set the requester,
    -- find the person and apply the contact rule.
    insert into public.merchant_payment_intents (merchant_auth_uid, requested_amount, customer_username, note, split_id)
    values (uid, amt, uname, note, sid) returning * into req;
    if req.customer_user_id is null then raise exception '%.arc isn''t on MeshPort', uname; end if;
    out := out || jsonb_build_object('code', req.code, 'orderNumber', req.order_number, 'username', uname,
      'userId', req.customer_user_id, 'amount', req.requested_amount, 'note', req.note);
  end loop;
  return jsonb_build_object('splitId', sid, 'requests', out);
end $$;
revoke all on function public.split_create(text, text, numeric, numeric, jsonb, text) from public, anon;
grant execute on function public.split_create(text, text, numeric, numeric, jsonb, text) to authenticated;

-- ── One split, for its creator (every person) or a person in it (counts + own share)
create or replace function public.split_summary(p_split uuid)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  uid uuid := auth.uid();
  my_id text;
  s public.splits;
  creator public.users;
  is_creator boolean;
  people jsonb;
  cnt int; paid int; left_amt numeric;
begin
  if uid is null then raise exception 'Split not found'; end if;
  select * into s from public.splits where id = p_split;
  if s.id is null then raise exception 'Split not found'; end if;
  select id::text into my_id from public.users where auth_uid = uid limit 1;
  is_creator := s.creator_auth_uid = uid;
  if not is_creator and not exists (select 1 from public.merchant_payment_intents i where i.split_id = s.id and i.customer_user_id = my_id) then
    raise exception 'Split not found';
  end if;
  select * into creator from public.users where auth_uid = s.creator_auth_uid limit 1;

  select count(*), count(*) filter (where i.status = 'paid'),
         coalesce(sum(greatest(i.requested_amount - i.received_amount, 0)) filter (where i.status in ('pending', 'partially_paid', 'processing')), 0)
    into cnt, paid, left_amt
    from public.merchant_payment_intents i where i.split_id = s.id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id, 'code', i.code, 'username', u.username, 'name', coalesce(nullif(u.display_name, ''), u.username),
      'avatar', u.avatar_url, 'amount', i.requested_amount, 'received', i.received_amount,
      'status', case when i.status = 'pending' and i.expires_at is not null and i.expires_at < now() then 'expired' else i.status end,
      'paidAt', i.paid_at, 'completedByMe', i.completed_by_merchant, 'completedNote', i.completed_note,
      'lastRemindedAt', i.last_reminded_at, 'createdAt', i.created_at) order by i.created_at), '[]'::jsonb)
    into people
    from public.merchant_payment_intents i left join public.users u on u.id::text = i.customer_user_id
   where i.split_id = s.id and (is_creator or i.customer_user_id = my_id);

  return jsonb_build_object(
    'id', s.id, 'title', s.title, 'emoji', s.emoji, 'total', s.total, 'myShare', s.my_share, 'currency', s.currency,
    'createdAt', s.created_at, 'isCreator', is_creator, 'sourceTx', case when is_creator then s.source_tx_hash end,
    'creator', jsonb_build_object('username', creator.username, 'name', coalesce(nullif(creator.display_name, ''), creator.username), 'avatar', creator.avatar_url),
    'people', cnt + 1, 'requests', cnt, 'paidCount', paid, 'owedLeft', left_amt,
    'members', people);
end $$;
revoke all on function public.split_summary(uuid) from public, anon;
grant execute on function public.split_summary(uuid) to authenticated;

-- The split a request card belongs to (null when it isn't a split request or not yours to see).
create or replace function public.split_summary_by_code(p_code text)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare sid uuid;
begin
  select split_id into sid from public.merchant_payment_intents where code = lower(btrim(coalesce(p_code, ''))) limit 1;
  if sid is null then return null; end if;
  begin
    return public.split_summary(sid);
  exception when others then return null;
  end;
end $$;
revoke all on function public.split_summary_by_code(text) from public, anon;
grant execute on function public.split_summary_by_code(text) to authenticated;

-- ── Every split you made, and every split share you owe ────────────────────
create or replace function public.my_splits()
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare uid uuid := auth.uid(); my_id text; made jsonb; owe jsonb;
begin
  if uid is null then return jsonb_build_object('made', '[]'::jsonb, 'owe', '[]'::jsonb); end if;
  select id::text into my_id from public.users where auth_uid = uid limit 1;
  select coalesce(jsonb_agg(x order by (x->>'createdAt') desc), '[]'::jsonb) into made from (
    select jsonb_build_object('id', s.id, 'title', s.title, 'emoji', s.emoji, 'total', s.total, 'myShare', s.my_share,
      'createdAt', s.created_at, 'requests', count(i.id), 'paidCount', count(i.id) filter (where i.status = 'paid'),
      'owedLeft', coalesce(sum(greatest(i.requested_amount - i.received_amount, 0)) filter (where i.status in ('pending', 'partially_paid', 'processing')), 0),
      'members', coalesce(jsonb_agg(jsonb_build_object('username', u.username, 'name', coalesce(nullif(u.display_name, ''), u.username), 'avatar', u.avatar_url)) filter (where u.id is not null), '[]'::jsonb)) as x
      from public.splits s
      left join public.merchant_payment_intents i on i.split_id = s.id
      left join public.users u on u.id::text = i.customer_user_id
     where s.creator_auth_uid = uid
     group by s.id
     order by s.created_at desc limit 100) t;
  select coalesce(jsonb_agg(x order by (x->>'createdAt') desc), '[]'::jsonb) into owe from (
    select jsonb_build_object('splitId', s.id, 'title', s.title, 'emoji', s.emoji, 'total', s.total, 'code', i.code,
      'amount', i.requested_amount, 'left', greatest(i.requested_amount - i.received_amount, 0), 'status', i.status,
      'createdAt', i.created_at, 'paidAt', i.paid_at,
      'creator', jsonb_build_object('username', c.username, 'name', coalesce(nullif(c.display_name, ''), c.username), 'avatar', c.avatar_url)) as x
      from public.merchant_payment_intents i
      join public.splits s on s.id = i.split_id
      left join public.users c on c.auth_uid = s.creator_auth_uid
     where my_id is not null and i.customer_user_id = my_id
     order by i.created_at desc limit 100) t;
  return jsonb_build_object('made', made, 'owe', owe);
end $$;
revoke all on function public.my_splits() from public, anon;
grant execute on function public.my_splits() to authenticated;

-- ── Remind one person in your split (once every 12 hours) ─────────────────
create or replace function public.split_remind(p_intent uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare i public.merchant_payment_intents; s public.splits; me public.users; wait interval; who text;
begin
  select * into i from public.merchant_payment_intents where id = p_intent and merchant_auth_uid = auth.uid() and split_id is not null for update;
  if i.id is null then raise exception 'Not found'; end if;
  select * into s from public.splits where id = i.split_id;
  if i.customer_user_id is null then raise exception 'Not found'; end if;
  if i.status not in ('pending', 'partially_paid') or i.requested_amount <= i.received_amount then raise exception 'Already paid'; end if;
  if i.last_reminded_at is not null and i.last_reminded_at > now() - interval '12 hours' then
    wait := i.last_reminded_at + interval '12 hours' - now();
    raise exception 'Reminded recently - you can remind again in % h', greatest(1, ceil(extract(epoch from wait) / 3600)::int);
  end if;
  select * into me from public.users where auth_uid = auth.uid() limit 1;
  who := coalesce(nullif(me.display_name, ''), me.username || '.arc', 'A friend');
  insert into public.notifications (user_id, type, title, message, read)
  values (i.customer_user_id, 'split_reminder', 'Reminder · ' || coalesce(s.emoji || ' ', '') || s.title,
          who || ': $' || trim(to_char(greatest(i.requested_amount - i.received_amount, 0), 'FM999999990.00')) || ' USDC is your share. Open your chat with ' || who || ' to pay.', false);
  update public.merchant_payment_intents set reminder_count = reminder_count + 1, last_reminded_at = now() where id = i.id;
  return jsonb_build_object('remindedAt', now());
end $$;
revoke all on function public.split_remind(uuid) from public, anon;
grant execute on function public.split_remind(uuid) to authenticated;
