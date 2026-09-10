-- ============================================================
-- MeshPort: Clean up double-prefixed 'recv_recv_' activity rows
--
-- ROOT CAUSE (fixed separately in src/features/home/HomePage.tsx):
-- HomePage.tsx's two chat-payment receive handlers were passing an
-- already-'recv_'-prefixed tx_hash into Activity.receive(), which itself
-- ALSO prepends 'recv_' internally (see src/lib/ActivityService.ts).
-- Every payment received from another MeshPort user via chat therefore got
-- saved under 'recv_recv_<hash>' instead of the intended 'recv_<hash>'.
--
-- Two knock-on effects this migration cleans up:
--
--  1. deposit-scan-all (supabase/functions/deposit-scan-all) only ever
--     checks for a plain 'recv_<hash>' row before recording an incoming
--     transfer as an "External deposit" — it never recognized
--     'recv_recv_<hash>' as the same event, so its independent chain
--     sweep went ahead and recorded a SECOND, address-only row for the
--     exact same payment. Every affected payment therefore has TWO rows:
--     the correctly-labeled one (sender's username in metadata) under
--     'recv_recv_<hash>', and a spurious duplicate under 'recv_<hash>'
--     with no username — this is the "double" transactions in Activity
--     and the "shows address instead of username" notification bug.
--
--  2. The double-prefixed row's explorer_url was built from the
--     once-prefixed string too (ActivityService.ts's explorerUrl() does
--     no prefix-stripping of its own), so it points at a broken URL
--     ('.../tx/recv_<hash>') instead of the real transaction.
--
-- Per affected pair, this migration:
--  (a) deletes the spurious 'External deposit' duplicate when one exists
--      for the same wallet under the corresponding single-prefixed hash
--      — keeping the correctly-labeled row, not the address-only one
--  (b) renames the correctly-labeled row's tx_hash down to the intended
--      single-prefixed form
--  (c) rebuilds its explorer_url from the real, unprefixed hash
--
-- Safe to re-run: each step only matches rows still in the broken state,
-- so running this again after it's already applied is a no-op.
-- ============================================================

-- (a) Remove the spurious 'External deposit' duplicate wherever a
--     correctly-labeled recv_recv_ row exists for the same underlying tx.
--     'recv_' is 5 chars, so substring(... from 6) strips exactly one
--     prefix layer: 'recv_recv_<hash>' -> 'recv_<hash>'.
delete from activity spurious
using activity correct
where correct.wallet_address = spurious.wallet_address
  and correct.tx_hash like 'recv\_recv\_%' escape '\'
  and spurious.tx_hash = substring(correct.tx_hash from 6)
  and spurious.id <> correct.id;

-- (b) + (c) Normalize the correctly-labeled rows down to the intended
--     single-prefixed tx_hash and rebuild their explorer_url from the
--     real, unprefixed hash ('recv_recv_' is 10 chars, so
--     substring(... from 11) gives the raw hash with both prefixes gone).
--     Guarded with NOT EXISTS so this can never violate the
--     (tx_hash, wallet_address) unique constraint even in an edge case
--     step (a) didn't already resolve.
update activity a
set
  tx_hash      = substring(a.tx_hash from 6),
  explorer_url = 'https://testnet.arcscan.app/tx/' || substring(a.tx_hash from 11)
where a.tx_hash like 'recv\_recv\_%' escape '\'
  and not exists (
    select 1 from activity b
    where b.wallet_address = a.wallet_address
      and b.tx_hash = substring(a.tx_hash from 6)
      and b.id <> a.id
  );

-- Verify: should return 0. Any row still here means two DIFFERENT real
-- transactions collided on the normalized hash for the same wallet after
-- step (a) — not expected in practice (tx hashes are unique per
-- transaction) but left for manual review rather than silently deleted.
select count(*) as remaining_double_prefixed
from activity
where tx_hash like 'recv\_recv\_%' escape '\';

select 'Double-prefixed receive rows cleaned up' as status;
