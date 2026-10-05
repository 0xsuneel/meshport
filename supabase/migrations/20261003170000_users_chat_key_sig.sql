-- Wallet signature over the user's chat public key (see src/lib/chatCrypto.ts).
-- Clients only use a chat key whose signature recovers to the user's
-- wallet_address, so a key swapped in the database is ignored.
alter table public.users add column if not exists chat_key_sig text;
