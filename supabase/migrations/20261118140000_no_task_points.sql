-- Task points removed (18 Nov 2026): an action's one reward is its scratch
-- card (points OR USDC OR better luck). The app no longer writes
-- `tx_reward:` rows; this refuses them from app copies still open on the old
-- version, so no action earns task points on top of its card.
create or replace function public.cap_task_points()
returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if new.reason like 'tx_reward:%' then
    raise exception 'Task points are no longer awarded' using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke all on function public.cap_task_points() from public, anon, authenticated;
