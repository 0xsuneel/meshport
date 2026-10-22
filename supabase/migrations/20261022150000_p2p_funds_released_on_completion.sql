-- P2P: "Funds Released" only once the USDC has actually moved; tell the
-- seller when a release didn't go through.
--
-- releaseTrade() (src/lib/p2pService.ts) claims the release first
-- (payment_sent -> released) so two taps or two tabs can't release twice,
-- then sends the escrow release, then completes the trade (released ->
-- completed). The buyer's 'funds_released' notification fired on the CLAIM,
-- before anything moved. On 2026-10-22 (trade bd8b1945…) the seller's app
-- stopped between the claim and the send: the buyer was told "released" at
-- 00:42, p2p-release-reconcile put the trade back to payment_sent at 00:50
-- (nothing had moved on-chain), the seller released again at 01:38 and the
-- buyer was told "released" a second time - and the seller was never told
-- the first release hadn't gone through.
--
-- Now:
--   - 'funds_released' (buyer) fires when the trade becomes 'completed'
--     from payment_sent or released - the release is confirmed on-chain.
--   - 'release_failed' (seller) fires when a claimed release is put back
--     (released -> payment_sent): nothing moved, release it again.
--
-- Applied as an edit of the live definition (it has been revised by several
-- migrations); fails loudly if the expected text isn't there.
do $migration$
declare
  d text := pg_get_functiondef('public.p2p_notify_trade_event'::regproc);
  old_cond text := $q$IF OLD.status = 'payment_sent' AND NEW.status IN ('released', 'completed') THEN$q$;
  new_cond text := $q$IF OLD.status IN ('payment_sent', 'released') AND NEW.status = 'completed' THEN$q$;
  anchor text := $q$    -- Trade cancelled$q$;
  failed_block text := $q$    -- A claimed release was put back (the release transaction never went
    -- through - the seller's app stopped, or p2p-release-reconcile found
    -- nothing moved on-chain): the seller needs to release again.
    IF OLD.status = 'released' AND NEW.status = 'payment_sent' THEN
      INSERT INTO public.notifications (user_id, type, title, message, trade_id)
      VALUES (NEW.seller_id, 'release_failed', 'Release Didn''t Go Through',
              format('Your release of %s USDC didn''t go through - no USDC moved. Open the trade and release it again.', NEW.amount_usdc), NEW.id);
    END IF;

$q$;
begin
  if position(old_cond in d) = 0 then
    raise exception 'p2p_notify_trade_event: funds_released condition not found - definition changed, update this migration';
  end if;
  if position(anchor in d) = 0 then
    raise exception 'p2p_notify_trade_event: "-- Trade cancelled" anchor not found';
  end if;
  d := replace(d, old_cond, new_cond);
  d := replace(d, anchor, failed_block || anchor);
  execute d;
end
$migration$;
