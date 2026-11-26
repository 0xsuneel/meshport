-- Phase 5 (docs/SUPABASE_LIGHT_PLAN.md): log tables stop growing with users.
-- The database is 71 MB of the Free plan's 500 MB, but these tables grow with
-- every user and every request and nothing ever removed their old rows:
--   rpc_usage        ~1,400 rows/day  admin System page reads 7 days   -> keep 14
--   client_errors    app errors       admin System page reads 7 days   -> keep 30
--   wallet_events    wallet diagnostics, written only                  -> keep 30
--   move_timings     transfer timings, written only                    -> keep 90
-- Kept on purpose: fx_rate_history (rate charts need old rates), activity and
-- everything a user owns. Already pruned elsewhere: chain_events +
-- indexer_shadow_reports (chain-events-retention), cron history
-- (purge-cron-history, hourly), push_subscriptions, net._http_response (pg_net).

create or replace function public.prune_logs()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare a int; b int; c int; d int;
begin
  delete from rpc_usage     where bucket     < now() - interval '14 days'; get diagnostics a = row_count;
  delete from client_errors where created_at < now() - interval '30 days'; get diagnostics b = row_count;
  delete from wallet_events where created_at < now() - interval '30 days'; get diagnostics c = row_count;
  delete from move_timings  where created_at < now() - interval '90 days'; get diagnostics d = row_count;
  return jsonb_build_object('rpc_usage', a, 'client_errors', b, 'wallet_events', c, 'move_timings', d);
end
$$;
revoke all on function public.prune_logs() from public, anon, authenticated;

select cron.unschedule('logs-retention') where exists (select 1 from cron.job where jobname = 'logs-retention');
select cron.schedule('logs-retention', '29 3 * * *', $cron$ select public.prune_logs(); $cron$);
