-- Scratched cards with their prizes, for Activity → Rewards and the Rewards
-- page history (18 Nov 2026). Only cards already scratched: an unscratched
-- card's prize stays hidden (my_scratch_cards lists those without prizes).
create or replace function public.my_scratch_history(p_limit integer default 100)
returns table (id uuid, kind text, points integer, usdc_micro bigint, pay_amount numeric, scratched_at timestamptz)
language sql stable security definer set search_path to '' as $$
  select c.id, c.kind, c.points, c.usdc_micro, c.pay_amount, c.scratched_at
  from public.scratch_cards c
  where c.user_id = public.reward_me() and c.scratched_at is not null
  order by c.scratched_at desc
  limit least(greatest(coalesce(p_limit, 100), 1), 200)
$$;
revoke all on function public.my_scratch_history(integer) from public, anon;
grant execute on function public.my_scratch_history(integer) to authenticated;
