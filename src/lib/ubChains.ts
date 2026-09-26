// SDK chain ids that support Unified Balance deposits (same set the
// Transfer page marks ub: true). Kept in its own tiny module so light
// screens (Home) can check it without loading the UB claim code.
export const UB_CLAIM_CHAINS = new Set([
  'Ethereum_Sepolia', 'Base_Sepolia', 'Arbitrum_Sepolia', 'Polygon_Amoy_Testnet',
  'Optimism_Sepolia', 'Avalanche_Fuji', 'HyperEVM_Testnet', 'Sei_Testnet',
  'Sonic_Testnet', 'Unichain_Sepolia', 'World_Chain_Sepolia',
])

/** True when the app's chain id (Polygon_Sepolia = Amoy) supports UB. */
export function isUbChain(chainId: string): boolean {
  return UB_CLAIM_CHAINS.has(chainId === 'Polygon_Sepolia' ? 'Polygon_Amoy_Testnet' : chainId)
}
