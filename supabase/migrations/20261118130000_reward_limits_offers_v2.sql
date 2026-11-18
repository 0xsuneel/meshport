-- Reward limits and offers v2 (18 Nov 2026)
--   • Points: at most 50 a day per person - daily tasks and scratch cards
--     together. A task or card that would go over gets what's left.
--   • USDC: at most $1.00 a day per person in scratch cards (offers too).
--   • "Better luck next time" cards (kind 'none'): ~15% of payment cards,
--     and any card once both of today's limits are used up.
--   • Offers move at most one step a day (no finishing one in a day).
--   • New offers: pay at shops (merchant payments, server-recorded) and
--     multichain transfers (verified on-chain by multichain-reward).

-- ── Cards: 'none' = better luck next time ─────────────────────────────────
alter table public.scratch_cards drop constraint if exists scratch_cards_kind_check;
alter table public.scratch_cards add constraint scratch_cards_kind_check check (kind in ('points', 'usdc', 'none'));

-- Today (UTC) for one person: points earned (tasks + cards) and USDC in cards.
create or replace function public.reward_today(p_user text)
returns table (points integer, usdc_micro bigint, cards integer)
language sql stable security definer set search_path to '' as $$
  with d as (select date_trunc('day', now() at time zone 'utc') at time zone 'utc' as start)
  select
    (coalesce((select sum(t.points) from public.point_transactions t, d
               where t.user_id = p_user and t.points > 0 and t.reason like 'tx_reward:%' and t.created_at >= d.start), 0)
     + coalesce((select sum(c.points) from public.scratch_cards c, d
               where c.user_id = p_user and c.created_at >= d.start), 0))::integer,
    coalesce((select sum(c.usdc_micro) from public.scratch_cards c, d where c.user_id = p_user and c.created_at >= d.start), 0)::bigint,
    (select count(*) from public.scratch_cards c, d where c.user_id = p_user and c.created_at >= d.start and c.source <> 'offer')::integer
$$;
revoke all on function public.reward_today(text) from public, anon, authenticated;

-- ── One card, within today's limits ───────────────────────────────────────
-- source 'payment' | 'multichain': up to 10 a day; ~30% USDC on $1+, ~15%
-- better luck, else 5-20 points. source 'offer': USDC (the offer's range).
create or replace function public.reward_grant_card(p_user text, p_usd numeric, p_source text, p_ref uuid,
  p_usdc_min_cents integer default 5, p_usdc_max_cents integer default null)
returns uuid
language plpgsql security definer set search_path to '' as $$
declare
  today record;
  pts_left integer;
  usdc_left bigint;
  top_cents integer;
  micro bigint;
  pts integer;
  roll double precision := random();
  kind text;
  card uuid;
begin
  select * into today from public.reward_today(p_user);
  if p_source <> 'offer' and today.cards >= 10 then return null; end if;
  pts_left := greatest(0, 50 - today.points);
  usdc_left := greatest(0, 1000000 - today.usdc_micro);

  if p_source = 'offer' then
    kind := 'usdc';
    micro := (coalesce(p_usdc_min_cents, 10) + floor(random() * (coalesce(p_usdc_max_cents, 20) - coalesce(p_usdc_min_cents, 10) + 1)))::bigint * 10000;
  elsif p_usd >= 1 and roll < 0.30 then
    kind := 'usdc';
    top_cents := coalesce(p_usdc_max_cents, case when p_usd < 10 then 10 when p_usd < 100 then 15 else 20 end);
    micro := (5 + floor(random() * (top_cents - 5 + 1)))::bigint * 10000;
  elsif roll < 0.45 then
    kind := 'none';
  else
    kind := 'points';
  end if;

  -- Today's limits: USDC trimmed to what's left (else points), points trimmed
  -- to what's left (else better luck).
  if kind = 'usdc' then
    micro := least(micro, usdc_left);
    if micro < 10000 then kind := 'points'; micro := 0; end if;
  end if;
  if kind = 'points' then
    pts := least(5 + floor(random() * 16)::integer, pts_left);
    if pts < 1 then kind := 'none'; pts := 0; end if;
  end if;

  insert into public.scratch_cards (user_id, attempt_id, pay_amount, kind, points, usdc_micro, source)
    values (p_user, p_ref, coalesce(p_usd, 0), kind, coalesce(pts, 0), coalesce(micro, 0), p_source)
    on conflict (attempt_id) do nothing
    returning id into card;
  return card;
end;
$$;
revoke all on function public.reward_grant_card(text, numeric, text, uuid, integer, integer) from public, anon, authenticated;

-- ── Offers: kinds, one step a day ─────────────────────────────────────────
alter table public.reward_offers add column if not exists kind text not null default 'pay';
alter table public.reward_offers drop constraint if exists reward_offers_kind_check;
alter table public.reward_offers add constraint reward_offers_kind_check check (kind in ('pay', 'merchant', 'multichain'));
alter table public.user_offers add column if not exists last_step_day date;

update public.reward_offers set line = 'of $1 or more on 3 different days within 7 days' where id = 'pay3_week';
update public.reward_offers set line = 'of $5 or more on 5 different days within 7 days' where id = 'pay5_big';
insert into public.reward_offers (id, title, line, steps, min_usd, window_days, usdc_min_cents, usdc_max_cents, sort, kind) values
  ('shop3_week', 'Pay at shops 3 times', 'of $1 or more on 3 different days within 7 days', 3, 1, 7, 10, 25, 3, 'merchant'),
  ('multi2_week', 'Make 2 multichain transfers', 'of $1 or more on 2 different days within 7 days', 2, 1, 7, 10, 25, 4, 'multichain')
on conflict (id) do nothing;

-- One qualifying action: moves each running offer of that kind by one step
-- (at most one a day); the last step wins the offer's USDC card.
create or replace function public.reward_offer_step(p_user text, p_usd numeric, p_kind text)
returns void
language plpgsql security definer set search_path to '' as $$
declare
  o record;
  day date := (now() at time zone 'utc')::date;
  card uuid;
begin
  for o in
    select uo.id, uo.progress, r.steps, r.usdc_min_cents, r.usdc_max_cents
    from public.user_offers uo join public.reward_offers r on r.id = uo.offer_id
    where uo.user_id = p_user and uo.completed_at is null and uo.expires_at > now()
      and r.kind = p_kind and p_usd >= r.min_usd
      and uo.last_step_day is distinct from day
    for update of uo
  loop
    if o.progress + 1 >= o.steps then
      card := public.reward_grant_card(p_user, p_usd, 'offer', gen_random_uuid(), o.usdc_min_cents, o.usdc_max_cents);
      update public.user_offers set progress = o.steps, last_step_day = day, completed_at = now(), card_id = card where id = o.id;
    else
      update public.user_offers set progress = o.progress + 1, last_step_day = day where id = o.id;
    end if;
  end loop;
end;
$$;
revoke all on function public.reward_offer_step(text, numeric, text) from public, anon, authenticated;

-- The person behind an intent, if a personal account.
create or replace function public.reward_person(p_user_id uuid, p_wallet text)
returns text language sql stable security definer set search_path to '' as $$
  select u.id::text from public.users u
  where ((p_user_id is not null and u.id = p_user_id) or (p_user_id is null and lower(u.wallet_address) = lower(p_wallet)))
    and coalesce(u.account_type, 'personal') <> 'business'
  limit 1
$$;
revoke all on function public.reward_person(uuid, text) from public, anon, authenticated;

-- ── Confirmed Pay / Chat pay / Swap / Bulk pay ────────────────────────────
create or replace function public.grant_scratch_card()
returns trigger
language plpgsql security definer set search_path to '' as $$
declare
  it record;
  uid text;
  usd numeric;
begin
  select i.id, i.user_id, i.wallet_address, i.recipient_address, i.amount_atomic, coalesce(i.decimals, 6) as decimals, i.feature
    into it from public.transaction_intents i where i.id = new.intent_id;
  if it.id is null or it.feature not in ('pay', 'bulkpay', 'swap') then return new; end if;
  if it.feature <> 'swap' and it.recipient_address is not null
     and lower(it.recipient_address) = lower(coalesce(new.wallet_address, it.wallet_address)) then return new; end if;
  uid := public.reward_person(it.user_id, coalesce(new.wallet_address, it.wallet_address));
  if uid is null then return new; end if;
  usd := coalesce(it.amount_atomic, 0) / power(10::numeric, it.decimals);
  if usd <= 0 then return new; end if;
  perform public.reward_grant_card(uid, usd, 'payment', new.id);
  return new;
exception when others then
  raise warning 'grant_scratch_card: %', sqlerrm;
  return new;
end;
$$;

create or replace function public.advance_offers()
returns trigger
language plpgsql security definer set search_path to '' as $$
declare
  it record;
  uid text;
  usd numeric;
begin
  select i.id, i.user_id, i.wallet_address, i.recipient_address, i.amount_atomic, coalesce(i.decimals, 6) as decimals, i.feature
    into it from public.transaction_intents i where i.id = new.intent_id;
  if it.id is null or it.feature <> 'pay' then return new; end if;
  if it.recipient_address is not null and lower(it.recipient_address) = lower(coalesce(new.wallet_address, it.wallet_address)) then return new; end if;
  uid := public.reward_person(it.user_id, coalesce(new.wallet_address, it.wallet_address));
  if uid is null then return new; end if;
  usd := coalesce(it.amount_atomic, 0) / power(10::numeric, it.decimals);
  if usd <= 0 then return new; end if;
  perform public.reward_offer_step(uid, usd, 'pay');
  return new;
exception when others then
  raise warning 'advance_offers: %', sqlerrm;
  return new;
end;
$$;

-- ── Merchant payments (server-recorded): the shop offer ───────────────────
create or replace function public.merchant_offer_step()
returns trigger
language plpgsql security definer set search_path to '' as $$
declare
  uid text;
begin
  if new.status <> 'confirmed' or new.customer_user_id is null or coalesce(new.amount, 0) <= 0 then return new; end if;
  select u.id::text into uid from public.users u
    where u.id::text = new.customer_user_id and coalesce(u.account_type, 'personal') <> 'business'
      and lower(coalesce(u.wallet_address, '')) <> lower(coalesce(new.merchant_wallet, ''));
  if uid is null then return new; end if;
  perform public.reward_offer_step(uid, new.amount, 'merchant');
  return new;
exception when others then
  raise warning 'merchant_offer_step: %', sqlerrm;
  return new;
end;
$$;
drop trigger if exists merchant_offer_step_on_insert on public.merchant_payments;
create trigger merchant_offer_step_on_insert after insert on public.merchant_payments
  for each row execute function public.merchant_offer_step();
revoke all on function public.merchant_offer_step() from public, anon, authenticated;

-- ── Multichain transfers, verified on-chain by the multichain-reward function
create table if not exists public.verified_transfers (
  id          uuid primary key default gen_random_uuid(),
  tx_hash     text not null unique,
  user_id     text not null,
  wallet      text not null,
  amount_usd  numeric not null,
  kind        text not null default 'multichain',
  created_at  timestamptz not null default now()
);
alter table public.verified_transfers enable row level security;
-- No policies: only the server (service role) writes or reads it.

create or replace function public.verified_transfer_reward()
returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if exists (select 1 from public.users u where u.id::text = new.user_id and coalesce(u.account_type, 'personal') = 'business') then return new; end if;
  perform public.reward_grant_card(new.user_id, new.amount_usd, 'multichain', new.id);
  perform public.reward_offer_step(new.user_id, new.amount_usd, 'multichain');
  return new;
exception when others then
  raise warning 'verified_transfer_reward: %', sqlerrm;
  return new;
end;
$$;
drop trigger if exists verified_transfer_reward_on_insert on public.verified_transfers;
create trigger verified_transfer_reward_on_insert after insert on public.verified_transfers
  for each row execute function public.verified_transfer_reward();
revoke all on function public.verified_transfer_reward() from public, anon, authenticated;

-- ── Task points: 50 a day with scratch cards ──────────────────────────────
-- A task's points row is trimmed to what's left today; none left: refused.
create or replace function public.cap_task_points()
returns trigger
language plpgsql security definer set search_path to '' as $$
declare
  left_today integer;
begin
  if new.reason not like 'tx_reward:%' or coalesce(new.points, 0) <= 0 then return new; end if;
  select greatest(0, 50 - t.points) into left_today from public.reward_today(new.user_id) t;
  if left_today < 1 then raise exception 'Daily points limit reached' using errcode = '22023'; end if;
  new.points := least(new.points, left_today);
  return new;
end;
$$;
drop trigger if exists cap_task_points_before_insert on public.point_transactions;
create trigger cap_task_points_before_insert before insert on public.point_transactions
  for each row execute function public.cap_task_points();
revoke all on function public.cap_task_points() from public, anon, authenticated;

-- The balance follows the (trimmed) rows: a task adds at most what its
-- points rows today still haven't added.
alter table public.point_awards_log add column if not exists amount integer not null default 0;
create or replace function public.increment_user_points(p_user_id text, p_wallet_address text, p_amount integer)
returns void
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_start timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  v_allowed integer;
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
    v_allowed := coalesce((select sum(points) from public.point_transactions
                           where user_id = p_user_id and reason like 'tx_reward:%' and points > 0 and created_at >= v_start), 0)
               - coalesce((select sum(amount) from public.point_awards_log where user_id = p_user_id and award_day = v_day), 0);
    p_amount := least(p_amount, v_allowed);
    if p_amount < 1 then
      raise exception 'Daily points limit reached' using errcode = '22023';
    end if;
    insert into public.point_awards_log (user_id, award_day, amount) values (p_user_id, v_day, p_amount);
  end if;
  insert into public.user_points (user_id, wallet_address, total_points, lifetime_points, updated_at)
  values (p_user_id, p_wallet_address, p_amount, p_amount, now())
  on conflict (user_id) do update set
    total_points    = public.user_points.total_points + p_amount,
    lifetime_points = public.user_points.lifetime_points + p_amount,
    updated_at      = now();
end;
$function$;

-- ── Scratching a 'none' card ──────────────────────────────────────────────
create or replace function public.scratch_card(p_card uuid)
returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  me text := public.reward_me();
  c record;
  w text;
begin
  if me is null then raise exception 'not signed in'; end if;
  select * into c from public.scratch_cards where id = p_card and user_id = me for update;
  if c.id is null then raise exception 'card not found'; end if;
  if c.scratched_at is not null then
    return jsonb_build_object('kind', c.kind, 'points', c.points, 'usdc_micro', c.usdc_micro, 'already', true);
  end if;
  update public.scratch_cards set scratched_at = now() where id = c.id;
  select lower(u.wallet_address) into w from public.users u where u.id::text = me;
  if c.kind = 'points' and c.points > 0 then
    insert into public.point_transactions (user_id, wallet_address, points, reason, tx_hash)
      values (me, w, c.points, 'scratch_card', c.id::text);
    insert into public.user_points (user_id, wallet_address, total_points, lifetime_points, updated_at)
      values (me, w, c.points, c.points, now())
      on conflict (user_id) do update set total_points = public.user_points.total_points + excluded.total_points,
        lifetime_points = public.user_points.lifetime_points + excluded.lifetime_points, updated_at = now();
  elsif c.kind = 'usdc' and c.usdc_micro > 0 then
    insert into public.reward_usdc (user_id, balance_micro, lifetime_micro, updated_at)
      values (me, c.usdc_micro, c.usdc_micro, now())
      on conflict (user_id) do update set balance_micro = public.reward_usdc.balance_micro + excluded.balance_micro,
        lifetime_micro = public.reward_usdc.lifetime_micro + excluded.lifetime_micro, updated_at = now();
  end if;
  return jsonb_build_object('kind', c.kind, 'points', c.points, 'usdc_micro', c.usdc_micro, 'already', false);
end;
$$;

-- History lists prizes only (not better-luck cards).
create or replace function public.my_scratch_history(p_limit integer default 100)
returns table (id uuid, kind text, points integer, usdc_micro bigint, pay_amount numeric, scratched_at timestamptz)
language sql stable security definer set search_path to '' as $$
  select c.id, c.kind, c.points, c.usdc_micro, c.pay_amount, c.scratched_at
  from public.scratch_cards c
  where c.user_id = public.reward_me() and c.scratched_at is not null and c.kind <> 'none'
  order by c.scratched_at desc
  limit least(greatest(coalesce(p_limit, 100), 1), 200)
$$;

-- What's left today, for the Rewards page.
create or replace function public.my_reward_today()
returns jsonb
language sql stable security definer set search_path to '' as $$
  select jsonb_build_object('points', t.points, 'points_limit', 50, 'usdc_micro', t.usdc_micro, 'usdc_limit_micro', 1000000, 'cards', t.cards, 'cards_limit', 10)
  from public.reward_today(public.reward_me()) t
$$;
revoke all on function public.my_reward_today() from public, anon;
grant execute on function public.my_reward_today() to authenticated;

-- my_offers: the offer's kind too.
drop function if exists public.my_offers();
create or replace function public.my_offers()
returns table (
  id text, kind text, title text, line text, steps integer, min_usd numeric, window_days integer,
  activated_at timestamptz, expires_at timestamptz, progress integer, completed_at timestamptz, last_step_day date
)
language sql stable security definer set search_path to '' as $$
  select r.id, r.kind, r.title, r.line, r.steps, r.min_usd, r.window_days,
         uo.activated_at, uo.expires_at, uo.progress, uo.completed_at, uo.last_step_day
  from public.reward_offers r
  left join lateral (
    select x.activated_at, x.expires_at, x.progress, x.completed_at, x.last_step_day
    from public.user_offers x
    where x.user_id = public.reward_me() and x.offer_id = r.id
    order by x.activated_at desc limit 1
  ) uo on true
  where r.active
  order by r.sort, r.id
$$;
revoke all on function public.my_offers() from public, anon;
grant execute on function public.my_offers() to authenticated;
