-- The MPC (keyless) wallet test was removed - MeshPort is moving to Circle
-- user-controlled wallets. Drops the tables 20261024140000_wallet_mpc.sql made.
-- They held only testnet data: sealed server key shares, the co-sign log and
-- one-time step markers.

drop table if exists public.wallet_mpc_steps;
drop table if exists public.wallet_mpc_sign_log;
drop table if exists public.wallet_mpc_shares;
