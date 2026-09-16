-- ============================================================
-- MeshPort: Auth share column for Google-account Shamir's Secret Sharing
-- (2-of-3) wallet recovery.
--
-- This is DELIBERATELY a separate column from encrypted_wallet_key (added
-- in 20260720090000_social_wallet_key_backup.sql):
--
--   encrypted_wallet_key  — the FULL private key, encrypted server-side.
--                           Still used for Email-OTP accounts (see
--                           restoreWallet.ts / AutoWalletPage.tsx), which
--                           have no Google Drive token to hold a third
--                           share, so they fall back to this
--                           server-custodial-with-extra-steps model.
--                           A compromised WALLET_KEY_ENCRYPTION_SECRET +
--                           this column together IS enough to reconstruct
--                           those accounts' keys.
--
--   wallet_auth_share      — ONE of THREE Shamir's Secret Sharing shares
--   (this column)           for Google accounts. The other two live in
--                           the browser (Device share, localStorage only)
--                           and the user's own Google Drive appDataFolder
--                           (Recovery share, never touches MeshPort's
--                           servers at all). This column ALONE is
--                           information-theoretically useless — even a
--                           full database dump plus a compromised
--                           WALLET_KEY_ENCRYPTION_SECRET reveals nothing,
--                           because reconstruction needs 2 of the 3
--                           shares and the server only ever holds 1.
--
-- No server-side encryption is applied to this column's contents — by
-- design, not omission. A single SSS share carries zero information about
-- the secret on its own (a mathematical property of the scheme, not an
-- assumption), so encrypting it server-side would add complexity without
-- adding real confidentiality. Revoking direct client access below is
-- still done anyway, purely so the ONLY write path is the identity-
-- verified server endpoint (supabase/functions/wallet-key, action=save-auth-share),
-- consistent with every other sensitive column in this table.
-- ============================================================

alter table public.users
  add column if not exists wallet_auth_share text;

comment on column public.users.wallet_auth_share is
  'ONE of three Shamir Secret Sharing shares (2-of-3 threshold) of the private key, for Google-account (not Email-OTP) social-login wallets only. Alone, this value is information-theoretically useless — reconstruction requires also having either the Device share (browser localStorage) or the Recovery share (users own Google Drive appDataFolder). Never encrypted server-side; that would add nothing, since a lone share already reveals nothing. Reachable only via supabase/functions/wallet-key (action: save-auth-share / restore-auth-share) using the service role.';

revoke select (wallet_auth_share) on public.users from anon, authenticated;
revoke insert (wallet_auth_share) on public.users from anon, authenticated;
revoke update (wallet_auth_share) on public.users from anon, authenticated;
