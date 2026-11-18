-- Scratch cards for Swap and Bulk pay too (18 Nov 2026), not only Pay / Chat
-- pay: every flow whose transaction the server confirms (transaction_attempts).
-- Self-payments still win nothing; a swap's recipient is the wallet itself by
-- design, so that check is for payments only. Same 10-a-day cap.
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
  if it.id is null or it.feature not in ('pay', 'bulkpay', 'swap') then return new; end if;
  -- Paying yourself wins nothing (a swap pays the wallet itself by design).
  if it.feature <> 'swap' and it.recipient_address is not null
     and lower(it.recipient_address) = lower(coalesce(new.wallet_address, it.wallet_address)) then return new; end if;
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
  raise warning 'grant_scratch_card: %', sqlerrm;
  return new;
end;
$$;
revoke all on function public.grant_scratch_card() from public, anon, authenticated;
