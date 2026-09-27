-- ============================================================
-- MeshPort: Permanently fix duplicate activity rows
--
-- ROOT CAUSE: ActivityService.saveActivity() has always POSTed with
--   ?on_conflict=tx_hash,wallet_address  +  Prefer: resolution=ignore-duplicates
-- expecting PostgREST to silently drop repeat writes for the same
-- (tx_hash, wallet_address) pair (e.g. from a double-fired burn event,
-- a retried request, etc).
--
-- But `on_conflict` only works if a matching UNIQUE constraint actually
-- exists on those columns. It never did — so every "ignore-duplicates"
-- request has silently been a no-op, and duplicate rows have kept
-- accumulating. A prior one-off cleanup (supabase-fix-duplicates.sql)
-- deleted existing dupes but never added the constraint, so the same
-- issue quietly came back.
--
-- This migration (1) removes current duplicates the same way the prior
-- script did, then (2) adds the constraint for real, so the app's
-- existing on_conflict logic finally works and this stops recurring.
-- ============================================================

-- 1. Remove existing duplicates, keeping the earliest row per (tx_hash, wallet_address)
delete from activity
where id in (
  select id from (
    select
      id,
      row_number() over (
        partition by tx_hash, wallet_address
        order by created_at asc  -- keep the FIRST inserted row
      ) as rn
    from activity
    where tx_hash is not null
  ) ranked
  where rn > 1
);

-- 2. Add the unique constraint the app has been assuming exists all along.
--    Without this, ?on_conflict=tx_hash,wallet_address has no conflict
--    target and PostgREST just inserts a fresh duplicate row every time.
alter table activity
  add constraint activity_tx_hash_wallet_address_key
  unique (tx_hash, wallet_address);

-- Verify: should show total_rows === unique_tx_wallet_pairs now
select count(*) as total_rows, count(distinct (tx_hash, wallet_address)) as unique_tx_wallet_pairs
from activity
where tx_hash is not null;

select 'Duplicates cleaned up and unique constraint added — will not recur' as status;
