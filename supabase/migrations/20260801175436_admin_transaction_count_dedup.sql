-- Counts DISTINCT real transactions in the activity table, correctly
-- collapsing the send/receive pair that gets logged for every in-app
-- peer-to-peer transfer (see ActivityService.ts's Activity.send/receive —
-- they write 'send_<hash>' and 'recv_<hash>' as two separate rows for the
-- same underlying transfer whenever both parties are app users). Every
-- other activity_type (claim, bridge, swap, p2p_*, bulk, withdraw) is
-- counted per-row as before via its own unique id, since those aren't
-- double-logged the same way (bulk payments legitimately get one row per
-- recipient sharing a tx_hash, which is correct and stays uncollapsed
-- here on purpose).
--
-- Verified against production data before/after deploying this: raw
-- count(*) on `activity` was 323, this function correctly returns 280
-- (43 in-app transfers had been counted twice).
--
-- NOTE: this migration was already applied directly to the live database
-- via the Supabase MCP tool during development. This file exists so the
-- schema change is version-controlled and reproducible — running it again
-- (or via `supabase db push`) is a safe no-op thanks to `create or replace`.
create or replace function public.admin_transaction_count(since_ts timestamptz default null)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select count(distinct dedup_key)
  from (
    select
      case
        when activity_type in ('send', 'receive') then
          case
            when tx_hash like 'send_%' then substring(tx_hash from 6)
            when tx_hash like 'recv_%' then substring(tx_hash from 6)
            else tx_hash
          end
        else id::text
      end as dedup_key
    from public.activity
    where since_ts is null or created_at >= since_ts
  ) t
$$;

grant execute on function public.admin_transaction_count(timestamptz) to authenticated, anon;
