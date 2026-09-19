-- ============================================================
-- MeshPort: server-side "notifications cleared" watermark
--
-- WHY THIS EXISTS: tapping "Clear" on the Notifications page only ever
-- wiped LOCAL state (the in-memory list, the localStorage slot, the
-- "seen ids" ledger). None of that survives the user clearing their
-- browser's history/site data — at that point the app has no memory of
-- "already cleared" left anywhere, and every catch-up scan (chat payments,
-- external deposits, bulk payouts, claims) re-discovers old, already-seen
-- events from the server's own data and re-notifies for all of them at
-- once, indistinguishable from a flood of brand-new activity.
--
-- This column is a single, simple watermark: the moment the user last
-- tapped Clear. Every catch-up scan now filters out anything that
-- happened at or before this timestamp, checked server-side — so even a
-- fully wiped browser correctly shows nothing before the last clear,
-- because the boundary itself lives on the server, not in local storage.
-- ============================================================

alter table users add column if not exists notifications_cleared_at timestamptz;

comment on column users.notifications_cleared_at is
  'Timestamp of the most recent "Clear" tap on the Notifications page. Catch-up scans (chat payment messages, external deposits, bulk payouts, claims) filter out anything at or before this, so a cleared browser does not resurrect notifications for events that happened before the user last cleared their history — the boundary survives clearing local storage because it lives here, server-side.';
