-- Which Circle chain code the remembered wallet is on. MeshPort now uses a
-- generic EVM wallet (EVM-TESTNET, Circle signs and MeshPort broadcasts); a
-- row remembered from the Arc-only test wallet (blockchain null) is looked
-- up again instead of being used for signing.
alter table public.circle_wallet_users add column if not exists blockchain text;
