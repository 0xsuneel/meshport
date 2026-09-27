-- ═══════════════════════════════════════════════════════════════════════════
-- MeshPort: claim-worker recovery runbook
-- Run AFTER deploying the code fix + 20260706100000_claim_worker_hardening.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. Confirm the schema fix landed ────────────────────────────────────────
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.claims'::regclass and contype = 'c';

select proname from pg_proc where proname = 'increment_claim_attempts';

-- ── 1. Re-check the four known claims ───────────────────────────────────────
-- Just deploying the fix is enough for these to self-heal on the NEXT sweep:
-- confirmArrival() will now try event-based detection first. Give it 1-2
-- cron cycles (up to ~2 min) before doing anything manual.
select id, status, attempts, updated_at, message_hash, bridge_tx_hash,
       destination_tx_hash, error, needs_review
from public.claims
where id in (
  '3eec5020-1243-414c-b6e5-ff65da12c7d5',
  '56a3cabc-5537-4c52-b97f-1e10a049a36d',
  '524c9060-f2ae-4bbb-abad-3b2bc688a6de',
  '67989368-ab32-405e-92c2-5ad5fc9ff9e6'
);

-- ── 2. Force an immediate re-check instead of waiting for cron ──────────────
-- Run once per claim id (replace <PROJECT_REF> and the secret name if
-- different from the cron migration's setup).
select net.http_post(
  url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/claim-worker',
  headers := jsonb_build_object(
    'Content-Type',  'application/json',
    'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'claim_worker_service_key')
  ),
  body    := jsonb_build_object('mode', 'single', 'claimId', '3eec5020-1243-414c-b6e5-ff65da12c7d5')
);
-- repeat for the other three ids.

-- ── 3. If ARC_MESSAGE_TRANSMITTER isn't configured yet (event detection ────
-- can't run) or the RPC log window doesn't go back far enough to find an
-- old mint, verify manually via a block explorer / Circle's IRIS status for
-- the stored message_hash, THEN complete by hand. Do not do this without
-- independently confirming the mint actually happened.
--
-- update public.claims
-- set status = 'completed',
--     destination_tx_hash = '<verified mint tx hash>',
--     completed_at = now(),
--     needs_review = false
-- where id = '<claim id>'
--   and status = 'settling';  -- guard: only touches rows still mid-flight

-- ── 4. Backfill destination_tx_hash for already-completed claims where possible
-- (best-effort — only where a message_hash exists to decode a nonce from,
-- and ARC_MESSAGE_TRANSMITTER is configured). This does not change any
-- status, only fills in a previously-null field for historical/reporting
-- purposes. Run via a one-off script that calls decodeCctpMessageNonce +
-- findCctpReceiveLog per row and writes back destination_tx_hash /
-- receiver_block / relay_timestamp — not expressible as pure SQL since it
-- needs an RPC call per row.
select id, message_hash
from public.claims
where status = 'completed'
  and destination_tx_hash is null
  and message_hash is not null;

-- ── 5. Ongoing health checks ─────────────────────────────────────────────────
-- Anything the watchdog has flagged:
select * from public.claims where needs_review = true order by updated_at asc;

-- Live view of anything currently over the 10-minute stuck threshold:
select * from public.stuck_claims order by seconds_since_update desc;

-- Sanity check cron is still scheduled and succeeding:
select jobname, schedule, active from cron.job where jobname = 'claim-worker-sweep';
select status, return_message, start_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'claim-worker-sweep')
order by start_time desc
limit 20;

-- ── 6. Clear needs_review once a flagged claim is confirmed resolved ────────
-- update public.claims set needs_review = false where id = '<claim id>';
