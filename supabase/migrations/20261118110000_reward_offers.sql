-- Active offers (18 Nov 2026), like Paytm's: an offer is activated by the
-- person, then each confirmed Pay payment that qualifies moves its progress
-- (the ring: 1 of 3, 2 of 3...). Finishing it inside its window wins a bonus
-- scratch card with real USDC inside.
--
-- Progress is counted HERE, by a trigger on transaction_attempts (only the
-- server moves an attempt to CONFIRMED), never by the app. The same limits
-- as scratch cards: personal accounts only, never a payment to yourself.

create table if not exists public.reward_offers (
  id           text primary key,
  title        text not null,          -- "Make 3 payments"
  line         text not null,          -- "of $1 or more in 7 days"
  steps        integer not null check (steps between 1 and 50),
  min_usd      numeric not null default 1,
  window_days  integer not null check (window_days between 1 and 60),
  -- The bonus card's USDC range (cents).
  usdc_min_cents integer not null default 10,
  usdc_max_cents integer not null default 20,
  active       boolean not null default true,
  sort         integer not null default 0,
  check (usdc_min_cents between 1 and usdc_max_cents),
  check (usdc_max_cents <= 100)
);
alter table public.reward_offers enable row level security;
drop policy if exists reward_offers_read on public.reward_offers;
-- No read policy: the app sees offers through my_offers(), without the
-- bonus card's USDC range (the page never lists prize amounts).

insert into public.reward_offers (id, title, line, steps, min_usd, window_days, usdc_min_cents, usdc_max_cents, sort) values
  ('pay3_week', 'Make 3 payments', 'of $1 or more within 7 days', 3, 1, 7, 10, 20, 1),
  ('pay5_big',  'Make 5 payments', 'of $5 or more within 7 days', 5, 5, 7, 20, 50, 2)
on conflict (id) do nothing;

create table if not exists public.user_offers (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null,
  offer_id      text not null references public.reward_offers(id),
  activated_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  progress      integer not null default 0,
  completed_at  timestamptz,
  card_id       uuid
);
-- One running activation of an offer at a time.
create unique index if not exists user_offers_one_open on public.user_offers (user_id, offer_id) where completed_at is null;
create index if not exists user_offers_user on public.user_offers (user_id, activated_at desc);
alter table public.user_offers enable row level security;
-- No policies: the app reads and activates through the functions below.

-- Bonus cards: where a card came from.
alter table public.scratch_cards add column if not exists source text not null default 'payment';

-- ── Progress: a confirmed Pay payment ────────────────────────────────────
create or replace function public.advance_offers()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  it record;
  uid text;
  usd numeric;
  o record;
  cents integer;
  card uuid;
begin
  select i.id, i.user_id, i.wallet_address, i.recipient_address, i.amount_atomic, coalesce(i.decimals, 6) as decimals, i.feature
    into it from public.transaction_intents i where i.id = new.intent_id;
  if it.id is null or it.feature <> 'pay' then return new; end if;
  if it.recipient_address is not null and lower(it.recipient_address) = lower(coalesce(new.wallet_address, it.wallet_address)) then return new; end if;
  select u.id::text into uid from public.users u
    where ((it.user_id is not null and u.id = it.user_id)
        or (it.user_id is null and lower(u.wallet_address) = lower(coalesce(new.wallet_address, it.wallet_address))))
      and coalesce(u.account_type, 'personal') <> 'business'
    limit 1;
  if uid is null then return new; end if;
  usd := coalesce(it.amount_atomic, 0) / power(10::numeric, it.decimals);
  if usd <= 0 then return new; end if;

  for o in
    select uo.id, uo.progress, r.steps, r.usdc_min_cents, r.usdc_max_cents
    from public.user_offers uo join public.reward_offers r on r.id = uo.offer_id
    where uo.user_id = uid and uo.completed_at is null and uo.expires_at > now()
      and uo.activated_at <= now() and usd >= r.min_usd
    for update of uo
  loop
    if o.progress + 1 >= o.steps then
      cents := o.usdc_min_cents + floor(random() * (o.usdc_max_cents - o.usdc_min_cents + 1))::integer;
      insert into public.scratch_cards (user_id, attempt_id, pay_amount, kind, usdc_micro, source)
        values (uid, gen_random_uuid(), usd, 'usdc', cents::bigint * 10000, 'offer')
        returning id into card;
      update public.user_offers set progress = o.steps, completed_at = now(), card_id = card where id = o.id;
    else
      update public.user_offers set progress = o.progress + 1 where id = o.id;
    end if;
  end loop;
  return new;
exception when others then
  -- An offer must never get in the way of confirming a payment.
  raise warning 'advance_offers: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists advance_offers_on_confirm on public.transaction_attempts;
create trigger advance_offers_on_confirm
  after update of status on public.transaction_attempts
  for each row when (new.status = 'CONFIRMED' and old.status is distinct from 'CONFIRMED')
  execute function public.advance_offers();
drop trigger if exists advance_offers_on_insert on public.transaction_attempts;
create trigger advance_offers_on_insert
  after insert on public.transaction_attempts
  for each row when (new.status = 'CONFIRMED')
  execute function public.advance_offers();

-- ── The app's view ────────────────────────────────────────────────────────
-- Every live offer with this person's latest activation of it (if any).
create or replace function public.my_offers()
returns table (
  id text, title text, line text, steps integer, min_usd numeric, window_days integer,
  activated_at timestamptz, expires_at timestamptz, progress integer, completed_at timestamptz
)
language sql stable security definer set search_path to '' as $$
  select r.id, r.title, r.line, r.steps, r.min_usd, r.window_days,
         uo.activated_at, uo.expires_at, uo.progress, uo.completed_at
  from public.reward_offers r
  left join lateral (
    select x.activated_at, x.expires_at, x.progress, x.completed_at
    from public.user_offers x
    where x.user_id = public.reward_me() and x.offer_id = r.id
    order by x.activated_at desc limit 1
  ) uo on true
  where r.active
  order by r.sort, r.id
$$;

-- Activate an offer (again once the last one finished or ran out).
create or replace function public.activate_offer(p_offer text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  me text := public.reward_me();
  r record;
  cur record;
  biz boolean;
begin
  if me is null then raise exception 'not signed in'; end if;
  select coalesce(u.account_type, 'personal') = 'business' into biz from public.users u where u.id::text = me;
  if biz then raise exception 'offers are for personal accounts'; end if;
  select * into r from public.reward_offers where id = p_offer and active;
  if r.id is null then raise exception 'offer not found'; end if;
  select * into cur from public.user_offers where user_id = me and offer_id = r.id and completed_at is null for update;
  if cur.id is not null then
    if cur.expires_at > now() then
      return jsonb_build_object('activated_at', cur.activated_at, 'expires_at', cur.expires_at, 'progress', cur.progress, 'already', true);
    end if;
    -- Ran out unfinished: close it (progress kept for the record).
    update public.user_offers set completed_at = cur.expires_at where id = cur.id;
  end if;
  insert into public.user_offers (user_id, offer_id, expires_at)
    values (me, r.id, now() + make_interval(days => r.window_days))
    returning * into cur;
  return jsonb_build_object('activated_at', cur.activated_at, 'expires_at', cur.expires_at, 'progress', 0, 'already', false);
end;
$$;

revoke all on function public.advance_offers() from public, anon, authenticated;
revoke all on function public.my_offers() from public, anon;
revoke all on function public.activate_offer(text) from public, anon;
grant execute on function public.my_offers() to authenticated;
grant execute on function public.activate_offer(text) to authenticated;
