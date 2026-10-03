// Logo files under public/logos/chains/ for each scanned external chain id.
export const CHAIN_LOGO_FILE: Record<string, string> = {
  Ethereum_Sepolia: 'ethereum', Base_Sepolia: 'base', Arbitrum_Sepolia: 'arbitrum',
  Optimism_Sepolia: 'optimism', Polygon_Sepolia: 'polygon', Avalanche_Fuji: 'avalanche',
  HyperEVM_Testnet: 'hyperevm', Sei_Testnet: 'sei', Sonic_Testnet: 'sonic',
  Unichain_Sepolia: 'unichain', World_Chain_Sepolia: 'world', Linea_Sepolia: 'linea',
  Ink_Testnet: 'ink', Monad_Testnet: 'monad', Morph_Testnet: 'morph',
  Pharos_Testnet: 'pharos', Plume_Testnet: 'plume', XDC_Apothem: 'xdc',
  Codex_Testnet: 'codex', Edge_Testnet: 'edge', Injective_Testnet: 'injective',
}
export const chainLogoSrc = (id: string) => `/logos/chains/${CHAIN_LOGO_FILE[id] ?? '_fallback'}.svg`
