-- ============================================================
-- MeshPort: retire the server-secret-based wallet backup design
--
-- Superseded by wallet_backups (20260720120000_passkey_wallet_backup.sql).
-- encrypted_wallet_key required a server-held secret
-- (WALLET_KEY_ENCRYPTION_SECRET) to encrypt/decrypt — a real, documented
-- single point of failure (that secret + a DB dump together could
-- reconstruct any social-login account's key). The passkey-based design
-- has no server secret anywhere, so this column — and the Edge Function
-- that read/wrote it (supabase/functions/wallet-key) — are both dead.
--
-- Existing accounts using the old design: this DROPS their backup. Any
-- account created before this migration needs to re-establish a backup by
-- opening the app again post-deploy (triggers passkey registration) or,
-- if that fails on their device/browser, use their recovery phrase (shown
-- once at that point, same fallback new signups get — see
-- AutoWalletPage.tsx). This is an accepted one-time migration cost for
-- moving off a design with a real single point of failure.
-- ============================================================

alter table public.users
  drop column if exists encrypted_wallet_key;
