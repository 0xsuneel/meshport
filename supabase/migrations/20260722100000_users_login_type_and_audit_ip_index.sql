-- ============================================================
-- ArcPay: persisted login_type + audit-log IP index
--
-- 1) login_type — until now, "social vs. self-custodial" only existed as
--    CLIENT-side Zustand state (src/store/index.ts), never persisted to
--    public.users. That meant the wallet-key Edge Function had no
--    server-verifiable way to confirm an account is actually a
--    social-login account before generating/restoring a server-custodial
--    wallet for it (see docs/SECURITY_AUDIT_FINAL.md, "authorization-
--    scope gap"). This column makes that check possible server-side.
--
--    Nullable, no default: existing rows (created before this column
--    existed) start out unknown. The Edge Function self-heals this over
--    time — every successful generate-wallet/restore-full-key call
--    opportunistically sets login_type = 'social' on that user's row —
--    and src/lib/supabase.ts's upsertUserProfile now accepts and writes
--    a loginType so create/import-wallet accounts get tagged 'wallet'
--    the next time they touch their profile. No bulk backfill script:
--    same lazy-migration pattern already used for wallet_vault itself.
--
--    Until a row has a login_type, the Edge Function falls back to a
--    pragmatic heuristic (does this account already have a wallet_address
--    without a matching wallet_vault row?) rather than refusing outright
--    — see that function's own comments for the exact logic.
--
-- 2) wallet_audit_log_ip_idx — supports the new per-IP rate limit, which
--    counts recent rows by ip_address; without this index that query
--    would be a sequential scan as the table grows.
-- ============================================================

alter table public.users
  add column if not exists login_type text;

alter table public.users
  add constraint users_login_type_check check (login_type is null or login_type in ('social', 'wallet'));

comment on column public.users.login_type is
  'Account type: ''social'' (Google/Email-OTP, server-custodial wallet via wallet-key Edge Function) or ''wallet'' (create/import, self-custodial, never touches wallet-key). Null = not yet known (row predates this column) — the Edge Function and upsertUserProfile both self-heal it lazily rather than requiring a backfill.';

create index if not exists wallet_audit_log_ip_idx on public.wallet_audit_log (ip_address, occurred_at desc);
