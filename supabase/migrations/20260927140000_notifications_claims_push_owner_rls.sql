-- ─────────────────────────────────────────────────────────────────────────
-- Owner-scoped RLS for notifications, claims, push_subscriptions.
--
-- Bugs this closes (/cso findings #6, #9, #10 — all HIGH/MEDIUM, all
-- confirmed live via pg_policies + information_schema.role_table_grants):
--
--   notifications      — `notifications_all` was FOR ALL USING(true) to the
--                         `public` role. Anyone (anon or authenticated,
--                         unrelated to the row) could read every user's P2P
--                         trade notifications and rewrite any notification's
--                         content. INSERT/DELETE were already correctly
--                         revoked from anon/authenticated at the grant level
--                         — only SELECT/UPDATE were actually exploitable —
--                         and the table is populated exclusively by the
--                         SECURITY DEFINER trigger p2p_notify_trade_event()
--                         (see 20260730031528), so no client-facing INSERT
--                         policy is needed at all.
--
--   claims              — `claims_select` was USING(true) to `public`.
--                         Anyone could read every user's wallet_address +
--                         bridge amount + tx_hash platform-wide (financial
--                         PII). `claims_service_all` (service_role only) is
--                         untouched — background workers are unaffected.
--
--   push_subscriptions — `push_subs_all` was FOR ALL USING(true) to
--                         `public`, AND the grantee had full CRUD. Anyone
--                         could read, overwrite, or delete any other user's
--                         push subscription (device push endpoint + keys) —
--                         a notification-hijack vector. (The separate bug
--                         where api/push.ts's own subscribe handler trusted
--                         a client-supplied userId with no auth check at
--                         all — bypassing RLS entirely via the service key
--                         — is fixed in application code, not here.)
--
-- Ownership conventions (confirmed by tracing each table's own writer):
--   notifications.user_id  = auth.uid()::text  (set by p2p_notify_trade_event()
--                             from p2p_offers.user_id, which is auth.uid()::text)
--   claims.user_id          = auth.uid()        (set by claim-submit from
--                             supabase.auth.getUser().data.user.id directly)
--   push_subscriptions.user_id = public.users.id (set by api/push.ts using
--                             the same "real users.id" the rest of the push
--                             system keys off — see src/lib/rewards.ts)
-- ─────────────────────────────────────────────────────────────────────────

begin;

-- ── notifications: owner reads/marks-read only, no client insert/delete ────
drop policy if exists notifications_all on public.notifications;

create policy notifications_select_owner on public.notifications
  for select using (auth.uid()::text = user_id);

create policy notifications_update_owner on public.notifications
  for update using (auth.uid()::text = user_id) with check (auth.uid()::text = user_id);

-- ── claims: owner or admin only ──────────────────────────────────────────
drop policy if exists claims_select on public.claims;

create policy claims_select_owner_or_admin on public.claims
  for select using (
    auth.uid() = user_id
    or exists (select 1 from public.admin_users a where a.id = auth.uid())
  );
-- claims_service_all (service_role, FOR ALL) is untouched — claim-submit,
-- claim-worker, and every background reconciler keep working unchanged.

-- ── push_subscriptions: owner (via public.users.auth_uid) only ─────────────
drop policy if exists push_subs_all on public.push_subscriptions;

create policy push_subscriptions_select_owner on public.push_subscriptions
  for select using (
    exists (select 1 from public.users u where u.auth_uid = auth.uid() and u.id = push_subscriptions.user_id)
  );

create policy push_subscriptions_insert_owner on public.push_subscriptions
  for insert with check (
    exists (select 1 from public.users u where u.auth_uid = auth.uid() and u.id = push_subscriptions.user_id)
  );

create policy push_subscriptions_update_owner on public.push_subscriptions
  for update using (
    exists (select 1 from public.users u where u.auth_uid = auth.uid() and u.id = push_subscriptions.user_id)
  ) with check (
    exists (select 1 from public.users u where u.auth_uid = auth.uid() and u.id = push_subscriptions.user_id)
  );

create policy push_subscriptions_delete_owner on public.push_subscriptions
  for delete using (
    exists (select 1 from public.users u where u.auth_uid = auth.uid() and u.id = push_subscriptions.user_id)
  );
-- Note: the app's own write path (api/push.ts) uses the service_role key,
-- which bypasses RLS entirely regardless of these policies — they exist to
-- close DIRECT PostgREST access with the anon/authenticated key, which was
-- the actual exploit (see finding #10).

commit;
