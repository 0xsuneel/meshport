-- ============================================================
-- MeshPort: remove server-side wallet backup entirely
--
-- WHY THIS EXISTS: this is the final step of a full design change, not
-- just another access-control tightening. Earlier migrations (see
-- 20260719140000_revoke_wallet_secret_columns.sql) restricted who could
-- READ encrypted_private_key/mnemonic_hint. This migration removes the
-- columns entirely, because the decision was made to stop collecting this
-- material server-side at all — not "store it more carefully," but don't
-- store it, full stop.
--
-- What this means in practice: MeshPort's servers now hold nothing that
-- can reconstruct a user's wallet. Recovery on a new device, or after this
-- device's local storage is cleared, depends entirely on the user's own
-- copy of their recovery phrase or private key — there is no
-- MeshPort-side fallback anymore, encrypted or otherwise. This is the
-- accepted tradeoff for the privacy policy being able to say, truthfully,
-- "we never collect your seed phrase or private key" — not "we store an
-- encrypted copy," a materially weaker claim.
--
-- The application code that wrote to and read from these columns has
-- already been removed (see restoreWallet.ts, AuthPages.tsx,
-- AutoWalletPage.tsx, and the deletion of api/wallet-backup.ts and
-- saveWalletToCloud()) — this migration is the last step, removing the
-- storage itself so there's nothing left to secure, breach, or subpoena.
--
-- Existing accounts created before this change: if their
-- encrypted_private_key/mnemonic_hint had a real value, that value is
-- gone after this runs. Anyone relying on cloud recovery for an
-- already-registered wallet needs their own saved recovery phrase or
-- private key going forward, same as everyone else.
-- ============================================================

alter table users
  drop column if exists encrypted_private_key,
  drop column if exists mnemonic_hint;
