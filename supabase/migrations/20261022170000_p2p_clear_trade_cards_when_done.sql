-- P2P: once a trade is over, its Home order cards go away on every device.
--
-- Home's floating order cards are a trade's unread "step" notifications
-- (new order, seller confirmed, payment marked, reminders, release failed).
-- The app hides a card when it sees the trade finish, but an app that was
-- opened earlier (an older build, a phone left on Home, another device)
-- kept showing e.g. "Payment Marked as Sent" after the trade completed
-- (trade e541998a, 2026-10-22), because those notifications stayed unread.
-- Now finishing a trade marks them read in the table itself, so every
-- device drops the card on its next sync. The outcome notifications
-- (funds released, cancelled, expired, disputes) are left alone.
--
-- Added to p2p_notify_trade_event (already AFTER UPDATE on p2p_trades),
-- edited in place as earlier migrations do: creating a new trigger on
-- p2p_trades needs a table lock that couldn't be taken.
do $migration$
declare
  d text := pg_get_functiondef('public.p2p_notify_trade_event'::regproc);
  anchor text := $q$  IF TG_OP = 'UPDATE' THEN
$q$;
  clear_block text := $q$
    -- The trade is over: its step cards (unread step notifications) go away.
    IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('completed', 'cancelled', 'expired') THEN
      UPDATE public.notifications SET read = true
       WHERE trade_id = NEW.id AND read = false
         AND type IN ('buy_order_placed', 'sell_order_placed', 'seller_confirmed', 'payment_marked_completed',
                      'trade_expiring_soon', 'grace_period_ending', 'release_failed');
    END IF;
$q$;
begin
  if position('The trade is over: its step cards' in d) > 0 then return; end if;
  if position(anchor in d) = 0 then
    raise exception 'p2p_notify_trade_event: UPDATE branch anchor not found - definition changed, update this migration';
  end if;
  execute replace(d, anchor, anchor || clear_block);
end
$migration$;

-- Trades that already finished: clear the cards they left behind.
update public.notifications n
   set read = true
  from public.p2p_trades t
 where n.trade_id = t.id
   and n.read = false
   and t.status in ('completed', 'cancelled', 'expired')
   and n.type in ('buy_order_placed', 'sell_order_placed', 'seller_confirmed', 'payment_marked_completed',
                  'trade_expiring_soon', 'grace_period_ending', 'release_failed');
