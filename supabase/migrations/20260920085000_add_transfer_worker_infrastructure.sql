-- MeshPort: backend worker for outbound Multichain Transfer (Arc -> destination
-- chain), the reverse direction of Multichain Claim.
--
-- Root cause of "transfer stuck, funds not minting": there was NO backend
-- process for this direction at all. Claims have claim-submit -> claim-worker
-- (continuous polling) -> claim-recovery-scan (backstop). Transfers had
-- nothing after the initial burn got written to `activity` — confirmed live:
-- every pending bridge-type activity row had updated_at == created_at,
-- including rows from over a month ago, meaning literally nothing had ever
-- touched them again. The CCTP burn itself was fine; nothing was left
-- watching for the mint once the browser tab that submitted it moved on.
--
-- This adds the same columns/locking primitives claims already have,
-- scoped to activity_type = 'bridge' rows, so transfer-worker (a new edge
-- function, deployed separately) can safely poll and complete them the same
-- way claim-worker does for claims — continuously, via pg_cron, independent
-- of whether anyone has the app open.

alter table activity
  add column if not exists message_hash   text,
  add column if not exists attempts       integer not null default 0,
  add column if not exists error          text,
  add column if not exists last_error_at  timestamptz,
  add column if not exists needs_review   boolean not null default false;

comment on column activity.message_hash is
  'CCTP message bytes for a bridge-type (outbound Multichain Transfer) row, once Circle has attested the Arc burn. Mirrors claims.message_hash for the reverse direction.';

-- Scoped to bridge rows only — claim-type activity rows already write their
-- own destination_tx_hash and must not be constrained by this index.
create unique index if not exists activity_bridge_destination_tx_hash_unique
  on activity (destination_tx_hash)
  where activity_type = 'bridge' and destination_tx_hash is not null;

-- Same FOR UPDATE SKIP LOCKED pattern as fetch_and_lock_due_claims — safe
-- under concurrent sweep + single-transfer kicks.
create or replace function fetch_and_lock_due_transfers(
  p_transfer_id uuid default null,
  p_stale_cutoff timestamptz default (now() - interval '6 seconds'),
  p_limit integer default 200
)
returns setof activity
language sql
security definer
set search_path to 'public'
as $$
  update public.activity
  set updated_at = now()
  where id in (
    select id
    from public.activity
    where activity_type = 'bridge'
      and status = 'pending'
      and (
        (p_transfer_id is not null and id = p_transfer_id and updated_at < p_stale_cutoff)
        or (p_transfer_id is null and updated_at < p_stale_cutoff)
      )
    order by updated_at asc
    limit p_limit
    for update skip locked
  )
  returning *;
$$;

create or replace function increment_transfer_attempts(p_transfer_id uuid)
returns activity
language sql
as $$
  update public.activity
  set attempts = attempts + 1
  where id = p_transfer_id
  returning *;
$$;

-- Runs every minute, same cadence and auth pattern as claim-worker-sweep
-- (reuses the same vault secret — no new secret needed).
select cron.schedule(
  'transfer-worker-sweep',
  '* * * * *',
  $$
    select net.http_post(
      url := 'https://cvvpzfvzweszuuxvaayb.supabase.co/functions/v1/transfer-worker',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'claim_worker_service_key')
      )
    );
  $$
);
