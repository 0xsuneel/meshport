-- ============================================================
-- MeshPort: drop wallet_auth_share — dead column, design changed
--
-- Added in 20260720100000_google_sss_auth_share.sql for a Google-account
-- Shamir's Secret Sharing (2-of-3) recovery scheme: one share here, one in
-- the browser, one in the user's own Google Drive. That design was
-- replaced with a simpler, unified model for BOTH Google and Email-OTP
-- accounts: the private key is generated server-side at account creation
-- and backed up as a single encrypted blob in encrypted_wallet_key (see
-- supabase/functions/wallet-key, action=generate-wallet /
-- restore-full-key). No shares, no Drive integration, no SSS math.
--
-- This is a considered simplicity-over-security-property tradeoff, not an
-- oversight — the SSS design had no single reconstructable point of
-- failure; this one does (WALLET_KEY_ENCRYPTION_SECRET + a database dump
-- of encrypted_wallet_key together can reconstruct any social-login
-- account's key). See that Edge Function's header comment for the full
-- reasoning. Dropping this column here because leaving unused, never-
-- written columns around is needless attack surface for zero benefit.
-- ============================================================

alter table public.users
  drop column if exists wallet_auth_share;
