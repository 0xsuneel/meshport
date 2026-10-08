-- Merchant chain labels for the bridge-router (CCTP) chains merchant-pay now watches.
create or replace function public.merchant_chain_label(p_chain text)
returns text language sql immutable
as $$
  select case p_chain
    when 'Arc_Testnet' then 'Arc' when 'Ethereum_Sepolia' then 'Ethereum' when 'Base_Sepolia' then 'Base'
    when 'Arbitrum_Sepolia' then 'Arbitrum' when 'Optimism_Sepolia' then 'Optimism' when 'Polygon_Sepolia' then 'Polygon'
    when 'Polygon_Amoy_Testnet' then 'Polygon' when 'Avalanche_Fuji' then 'Avalanche' when 'HyperEVM_Testnet' then 'HyperEVM'
    when 'Sei_Testnet' then 'Sei' when 'Unichain_Sepolia' then 'Unichain'
    when 'Sonic_Testnet' then 'Sonic'
    when 'World_Chain_Sepolia' then 'World Chain'
    when 'Linea_Sepolia' then 'Linea'
    when 'Ink_Testnet' then 'Ink'
    when 'Monad_Testnet' then 'Monad'
    when 'Morph_Testnet' then 'Morph'
    when 'Pharos_Testnet' then 'Pharos'
    when 'Plume_Testnet' then 'Plume'
    when 'Codex_Testnet' then 'Codex'
    when 'Injective_Testnet' then 'Injective'
    when 'XDC_Apothem' then 'XDC'
    else replace(p_chain, '_', ' ') end
$$;
