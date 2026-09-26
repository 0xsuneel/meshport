-- Two reminders before a P2P trade's payment window (and its grace period)
-- actually expires — both fire when 5 minutes are left, but for two
-- different deadlines:
--   1. reminder_expiry_sent — 5 min before expires_at (the base payment
--      window the buyer has to mark payment sent by)
--   2. reminder_grace_sent  — 5 min before expires_at + GRACE_PERIOD_MINUTES
--      (the TRUE final deadline — see p2pService.ts's own GRACE_PERIOD_MINUTES
--      comment: a trade past expires_at isn't actually expired yet, it's in
--      a 15-minute grace window; only after that does it really expire)
--
-- Scoped to status='waiting_for_buyer' only, matching every other
-- expiry-related check already in this codebase (p2pService.ts's own
-- comment: "Timeout expiry is deliberately scoped to 'waiting_for_buyer'").
-- GRACE_PERIOD_MINUTES is hardcoded to 15 here to match that same
-- constant in src/lib/p2pService.ts — if that constant ever changes, this
-- needs updating too (no single source of truth between DB and app code
-- for this value currently).

alter table p2p_trades
  add column if not exists reminder_expiry_sent boolean not null default false,
  add column if not exists reminder_grace_sent  boolean not null default false;

comment on column p2p_trades.reminder_expiry_sent is
  'Whether the "5 minutes left on your payment window" reminder has been sent for this trade. Set once by send_p2p_expiry_reminders() so it never fires twice.';
comment on column p2p_trades.reminder_grace_sent is
  'Whether the "5 minutes left in your grace period" reminder has been sent for this trade.';

create or replace function send_p2p_expiry_reminders()
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r record;
begin
  -- Reminder 1: 5 minutes left on the base payment window.
  for r in
    update p2p_trades
    set reminder_expiry_sent = true
    where status = 'waiting_for_buyer'
      and dispute_status = 'none'
      and admin_frozen = false
      and reminder_expiry_sent = false
      and expires_at > now()
      and expires_at <= now() + interval '5 minutes'
    returning id, buyer_id, amount_usdc
  loop
    insert into notifications (user_id, type, title, message, trade_id)
    values (
      r.buyer_id, 'trade_expiring_soon', 'Payment window closing soon',
      format('About 5 minutes left to pay %s USDC before this offer expires.', r.amount_usdc),
      r.id
    );
  end loop;

  -- Reminder 2: 5 minutes left in the grace period — the real, final
  -- deadline. Naturally only reachable once expires_at has already
  -- passed (expires_at + 15min - 5min = expires_at + 10min > expires_at),
  -- so no separate "already past the base window" condition is needed.
  for r in
    update p2p_trades
    set reminder_grace_sent = true
    where status = 'waiting_for_buyer'
      and dispute_status = 'none'
      and admin_frozen = false
      and reminder_grace_sent = false
      and expires_at + (15 * interval '1 minute') > now()
      and expires_at + (15 * interval '1 minute') <= now() + interval '5 minutes'
    returning id, buyer_id, amount_usdc
  loop
    insert into notifications (user_id, type, title, message, trade_id)
    values (
      r.buyer_id, 'grace_period_ending', 'Grace period ending soon',
      format('About 5 minutes left before this trade for %s USDC expires and is cancelled.', r.amount_usdc),
      r.id
    );
  end loop;
end;
$$;

-- Every minute, same cadence as claim-worker-sweep/transfer-worker-sweep —
-- pure SQL though, no HTTP call needed since this only reads/writes the DB.
select cron.schedule(
  'p2p-expiry-reminders',
  '* * * * *',
  $$select send_p2p_expiry_reminders();$$
);
