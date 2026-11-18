-- Scratch cards (18 Nov 2026): every confirmed Pay payment wins one card,
-- shown on the success page and kept on the Rewards page until scratched.
-- Inside: random points (5-20) or real USDC cashback.
--
-- Prizes are decided HERE, when the server confirms the payment (a trigger
-- on transaction_attempts, which only the server moves to CONFIRMED - never
-- the app), and stored out of the app's reach: scratch_cards has no read
-- policy; the app only ever sees a card's prize after scratching it, through
-- scratch_card(). Scratching credits the prize: points to user_points, USDC
-- to reward_usdc (claimed to the wallet through MeshPortRewards, see
-- rewards-claim-sign's source = 'usdc').
--
-- Limits (real money): personal accounts only (as Rewards), no card for a
-- payment to yourself, at most 10 cards a day, and USDC only on payments of
-- $1 or more - a smaller one wins points.

create table if not exists public.scratch_cards (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null,
  attempt_id  uuid not null unique,
  pay_amount  numeric not null,
  kind        text not null check (kind in ('points', 'usdc')),
  points      integer not null default 0 check (points >= 0),
  usdc_micro  bigint not null default 0 check (usdc_micro >= 0),
  created_at  timestamptz not null default now(),
  scratched_at timestamptz
);
create index if not exists scratch_cards_user_open on public.scratch_cards (user_id, created_at) where scratched_at is null;
create index if not exists scratch_cards_user_day on public.scratch_cards (user_id, created_at);
alter table public.scratch_cards enable row level security;
-- No policies: the app reads cards only through the functions below.

create table if not exists public.reward_usdc (
  user_id        text primary key,
  balance_micro  bigint not null default 0 check (balance_micro >= 0),
  lifetime_micro bigint not null default 0,
  updated_at     timestamptz not null default now()
);
alter table public.reward_usdc enable row level security;
drop policy if exists reward_usdc_select on public.reward_usdc;
create policy reward_usdc_select on public.reward_usdc for select using (public.session_may_use_user(user_id));

-- ── Granting: a confirmed Pay payment ─────────────────────────────────────
create or replace function public.grant_scratch_card()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  it record;
  uid text;
  usd numeric;
  today_count integer;
  top_cents integer;
  is_usdc boolean;
begin
  select i.id, i.user_id, i.wallet_address, i.recipient_address, i.amount_atomic, coalesce(i.decimals, 6) as decimals, i.feature
    into it from public.transaction_intents i where i.id = new.intent_id;
  if it.id is null or it.feature <> 'pay' then return new; end if;
  -- Paying yourself wins nothing.
  if it.recipient_address is not null and lower(it.recipient_address) = lower(coalesce(new.wallet_address, it.wallet_address)) then return new; end if;
  select u.id::text into uid from public.users u
    where ((it.user_id is not null and u.id = it.user_id)
        or (it.user_id is null and lower(u.wallet_address) = lower(coalesce(new.wallet_address, it.wallet_address))))
      and coalesce(u.account_type, 'personal') <> 'business'
    limit 1;
  if uid is null then return new; end if;
  select count(*) into today_count from public.scratch_cards c
    where c.user_id = uid and c.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  if today_count >= 10 then return new; end if;
  usd := coalesce(it.amount_atomic, 0) / power(10::numeric, it.decimals);
  if usd <= 0 then return new; end if;
  is_usdc := usd >= 1 and random() < 0.3;
  if is_usdc then
    top_cents := case when usd < 10 then 10 when usd < 100 then 15 else 20 end;
    insert into public.scratch_cards (user_id, attempt_id, pay_amount, kind, usdc_micro)
      values (uid, new.id, usd, 'usdc', (5 + floor(random() * (top_cents - 5 + 1)))::bigint * 10000)
      on conflict (attempt_id) do nothing;
  else
    insert into public.scratch_cards (user_id, attempt_id, pay_amount, kind, points)
      values (uid, new.id, usd, 'points', 5 + floor(random() * 16)::integer)
      on conflict (attempt_id) do nothing;
  end if;
  return new;
exception when others then
  -- A card must never get in the way of confirming a payment.
  raise warning 'grant_scratch_card: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists grant_scratch_card_on_confirm on public.transaction_attempts;
create trigger grant_scratch_card_on_confirm
  after update of status on public.transaction_attempts
  for each row when (new.status = 'CONFIRMED' and old.status is distinct from 'CONFIRMED')
  execute function public.grant_scratch_card();
drop trigger if exists grant_scratch_card_on_insert on public.transaction_attempts;
create trigger grant_scratch_card_on_insert
  after insert on public.transaction_attempts
  for each row when (new.status = 'CONFIRMED')
  execute function public.grant_scratch_card();

-- ── The signed-in user ────────────────────────────────────────────────────
create or replace function public.reward_me()
returns text language sql stable security definer set search_path to '' as $$
  select u.id::text from public.users u where u.auth_uid = auth.uid() limit 1
$$;

-- Cards waiting to be scratched - never their prizes.
create or replace function public.my_scratch_cards()
returns table (id uuid, created_at timestamptz)
language sql stable security definer set search_path to '' as $$
  select c.id, c.created_at from public.scratch_cards c
  where c.user_id = public.reward_me() and c.scratched_at is null
  order by c.created_at asc
  limit 50
$$;

-- The Rewards page's three numbers.
create or replace function public.my_reward_summary()
returns jsonb
language sql stable security definer set search_path to '' as $$
  select jsonb_build_object(
    'usdc_micro', coalesce((select r.balance_micro from public.reward_usdc r where r.user_id = public.reward_me()), 0),
    'usdc_lifetime_micro', coalesce((select r.lifetime_micro from public.reward_usdc r where r.user_id = public.reward_me()), 0),
    'points', coalesce((select p.total_points from public.user_points p where p.user_id = public.reward_me()), 0),
    'cards', (select count(*) from public.scratch_cards c where c.user_id = public.reward_me() and c.scratched_at is null)
  )
$$;

-- Scratch one card: reveals and credits its prize (once - scratching it
-- again returns the same prize and credits nothing).
create or replace function public.scratch_card(p_card uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
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
  if c.kind = 'points' then
    insert into public.point_transactions (user_id, wallet_address, points, reason, tx_hash)
      values (me, w, c.points, 'scratch_card', c.id::text);
    insert into public.user_points (user_id, wallet_address, total_points, lifetime_points, updated_at)
      values (me, w, c.points, c.points, now())
      on conflict (user_id) do update set total_points = public.user_points.total_points + excluded.total_points,
        lifetime_points = public.user_points.lifetime_points + excluded.lifetime_points, updated_at = now();
  else
    insert into public.reward_usdc (user_id, balance_micro, lifetime_micro, updated_at)
      values (me, c.usdc_micro, c.usdc_micro, now())
      on conflict (user_id) do update set balance_micro = public.reward_usdc.balance_micro + excluded.balance_micro,
        lifetime_micro = public.reward_usdc.lifetime_micro + excluded.lifetime_micro, updated_at = now();
  end if;
  return jsonb_build_object('kind', c.kind, 'points', c.points, 'usdc_micro', c.usdc_micro, 'already', false);
end;
$$;

revoke all on function public.grant_scratch_card() from public, anon, authenticated;
revoke all on function public.reward_me() from public, anon;
revoke all on function public.my_scratch_cards() from public, anon;
revoke all on function public.my_reward_summary() from public, anon;
revoke all on function public.scratch_card(uuid) from public, anon;
grant execute on function public.my_scratch_cards() to authenticated;
grant execute on function public.my_reward_summary() to authenticated;
grant execute on function public.scratch_card(uuid) to authenticated;

-- A claim reservation is the server's alone (rewards-claim-sign): the app may
-- never write one, for points or for USDC.
alter policy pt_insert on public.point_transactions
  with check ((reason not like 'claim_reserved%') and ((points >= 0) and (points <= 20)) and public.session_may_use_user(user_id));
