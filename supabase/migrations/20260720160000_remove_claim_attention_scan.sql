-- ============================================================
-- MeshPort: remove claim-attention-scan entirely
--
-- Feature (background scan for external-chain deposits, push notification
-- on balance increase) removed by explicit decision — not needed. This
-- unschedules the cron job and drops the table it exclusively used.
-- Function code itself removed separately (supabase/functions/claim-attention-scan
-- deleted from the repo — this migration only handles the database side).
-- ============================================================

select cron.unschedule('claim-attention-scan-sweep');

drop table if exists external_balance_snapshots;
