-- Fixes the real root cause of "P2P activity not showing at all" — every
-- saveActivity() call for p2p_sell_order/p2p_refund/p2p_purchase (added in
-- src/lib/ActivityService.ts) was being silently rejected by this table's
-- own CHECK constraint, since it only ever allowed the original 8 activity
-- types (send, receive, swap, bridge, claim, deposit, withdraw, bulk).
-- saveActivity()'s own error handling swallows REST errors on failed
-- inserts, so this was completely invisible client-side — nothing ever
-- surfaced it, which is why P2P entries never showed up anywhere despite
-- the code that creates them running correctly.
ALTER TABLE public.activity DROP CONSTRAINT activity_activity_type_check;
ALTER TABLE public.activity ADD CONSTRAINT activity_activity_type_check
  CHECK (activity_type = ANY (ARRAY[
    'send'::text, 'receive'::text, 'swap'::text, 'bridge'::text, 'claim'::text,
    'deposit'::text, 'withdraw'::text, 'bulk'::text,
    'p2p_sell_order'::text, 'p2p_refund'::text, 'p2p_purchase'::text
  ]));
