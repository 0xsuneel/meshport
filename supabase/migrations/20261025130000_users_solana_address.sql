-- Each account's Solana address (docs/SOLANA.md), so payment links and
-- request QRs can offer Solana: the pay page shows where to send, and
-- merchant-pay checks a Solana payment reached this address.
--
-- Written by the account itself (wallet/solana.ts → publishSolanaAddress),
-- like chat_public_key: users_update already limits a row to its own
-- auth_uid. Not unique on purpose - nobody can block someone else's address
-- by claiming it first; payments are matched by order reference, not by it.
alter table public.users add column if not exists solana_address text;

alter table public.users drop constraint if exists users_solana_address_format;
alter table public.users add constraint users_solana_address_format
  check (solana_address is null or solana_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');

grant select (solana_address), insert (solana_address), update (solana_address)
  on public.users to anon, authenticated;
