-- Indexer I/O in bulk, and wallet matching in SQL.
--
-- The indexers (blockchain-indexer, indexer-fast) read and wrote each chain's
-- cursor with its own REST call and loaded EVERY user's wallet address several
-- times a minute. ~98% of the project's API requests (and so its egress and
-- log volume) came from that - and the wallet load grows with every sign-up.
--
--   indexer_cursors_save(rows)  one call saves every dirty cursor
--   indexer_match_wallets(addrs) which of these on-chain recipients are ours:
--                               cost follows transfers, not the user count

create or replace function public.indexer_cursors_save(p_rows jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  r jsonb;
  n integer := 0;
  hit integer;
begin
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    if coalesce(r->>'chain_id', '') = '' then continue; end if;
    -- Same rule as the one-row write: never move a cursor backwards (another
    -- writer may already be ahead). Keys missing from the row keep their value.
    update chain_cursors c set
      last_indexed_block    = case when r ? 'last_indexed_block'    then (r->>'last_indexed_block')::bigint else c.last_indexed_block end,
      last_indexed_hash     = case when r ? 'last_indexed_hash'     then r->>'last_indexed_hash' else c.last_indexed_hash end,
      latest_observed_block = case when r ? 'latest_observed_block' then (r->>'latest_observed_block')::bigint else c.latest_observed_block end,
      confirmation_depth    = case when r ? 'confirmation_depth' and r->>'confirmation_depth' is not null then (r->>'confirmation_depth')::int else c.confirmation_depth end,
      sync_state            = case when r ? 'sync_state' and r->>'sync_state' is not null then r->>'sync_state' else c.sync_state end,
      consecutive_failures  = case when r ? 'consecutive_failures' and r->>'consecutive_failures' is not null then (r->>'consecutive_failures')::int else c.consecutive_failures end,
      reorg_count           = case when r ? 'reorg_count' and r->>'reorg_count' is not null then (r->>'reorg_count')::int else c.reorg_count end,
      last_reorg_at         = case when r ? 'last_reorg_at'         then (r->>'last_reorg_at')::timestamptz else c.last_reorg_at end,
      last_success_at       = case when r ? 'last_success_at'       then (r->>'last_success_at')::timestamptz else c.last_success_at end,
      last_error            = case when r ? 'last_error'            then r->>'last_error' else c.last_error end,
      updated_at            = now()
    where c.chain_id = r->>'chain_id'
      and (r->>'last_indexed_block' is null or c.last_indexed_block <= (r->>'last_indexed_block')::bigint);
    get diagnostics hit = row_count;
    if hit = 0 then
      insert into chain_cursors (chain_id, last_indexed_block, last_indexed_hash, latest_observed_block,
                                 confirmation_depth, sync_state, updated_at)
      values (r->>'chain_id', coalesce((r->>'last_indexed_block')::bigint, 0), r->>'last_indexed_hash',
              (r->>'latest_observed_block')::bigint, coalesce((r->>'confirmation_depth')::int, 12),
              coalesce(r->>'sync_state', 'idle'), now())
      on conflict (chain_id) do nothing;
      get diagnostics hit = row_count;
    end if;
    n := n + hit;
  end loop;
  return n;
end $$;

create or replace function public.indexer_match_wallets(p_addrs text[])
returns text[]
language sql
stable
set search_path = public
as $$
  select coalesce(array_agg(distinct lower(u.wallet_address)), '{}')
  from users u
  where lower(u.wallet_address) = any (select lower(a) from unnest(p_addrs) a)
    and coalesce(u.wallet_address, '') <> ''
$$;

-- Server-only (service role). Not for app users.
revoke all on function public.indexer_cursors_save(jsonb) from public, anon, authenticated;
revoke all on function public.indexer_match_wallets(text[]) from public, anon, authenticated;
grant execute on function public.indexer_cursors_save(jsonb) to service_role;
grant execute on function public.indexer_match_wallets(text[]) to service_role;
