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

// Logo for a chain shown by its display name ("Ethereum", "Arc", "World
// Chain", "Base Sepolia"…) - the first word, matched against the files above
// (plus Arc). Null when there's no match (e.g. "3 chains").
const LOGO_FILES = new Set([...Object.values(CHAIN_LOGO_FILE), 'arc'])
export function chainLogoByName(name: string): string | null {
  const key = String(name || '').trim().split(/\s+/)[0].toLowerCase()
  return LOGO_FILES.has(key) ? `/logos/chains/${key}.svg` : null
}
