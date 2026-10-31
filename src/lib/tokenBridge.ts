// ── EURC and cirBTC across chains (Circle CCTPx) ────────────────────────────
// Bridge Kit ≥ 1.15 moves non-USDC tokens through Circle's CCTPx
// (CrossChainTokenService). Which chains a token can go to / come from is not
// fixed in code: Circle's token registry (IRIS, /v2/cctpx/tokens) lists each
// token's deployments, chain by chain (by CCTP domain), each with an on / off
// switch. A route needs the token deployed and on at BOTH ends, and both
// chains CCTPx-eligible (the kit's chain definitions carry that).
//
// Transfer (Arc → another chain) and Bring (another chain → Arc) show only
// the chains this returns for the token picked; USDC keeps its own routes.
//
// Fees: CCTPx charges its fee in the SOURCE chain's native currency (on Arc
// that is USDC, elsewhere ETH / AVAX / POL), not in the token sent - the
// recipient gets exactly the amount sent.

import { useEffect, useState } from 'react'

export type BridgeToken = 'USDC' | 'EURC' | 'cirBTC'
export type CctpxToken = Exclude<BridgeToken, 'USDC'>

export const BRIDGE_TOKENS: ReadonlyArray<{ id: BridgeToken; label: string; logo: string; decimals: number; sub: string }> = [
  { id: 'USDC',   label: 'USDC',   logo: '/logos/tokens/usdc.png',   decimals: 6, sub: 'USD Coin' },
  { id: 'EURC',   label: 'EURC',   logo: '/logos/tokens/eurc.png',   decimals: 6, sub: 'Euro Coin' },
  { id: 'cirBTC', label: 'cirBTC', logo: '/logos/tokens/cirbtc.png', decimals: 8, sub: 'Circle Bitcoin' },
]

export const bridgeTokenInfo = (t: BridgeToken) => BRIDGE_TOKENS.find(x => x.id === t)!
export const bridgeTokenDecimals = (t: BridgeToken) => bridgeTokenInfo(t).decimals

/** MeshPort's chain ids (Circle SDK names) → the kit's chain definition exports, for the CCTPx-eligible testnets. */
export const CCTPX_CHAIN_DEFS: Readonly<Record<string, string>> = {
  Arc_Testnet: 'ArcTestnet',
  Ethereum_Sepolia: 'EthereumSepolia',
  Base_Sepolia: 'BaseSepolia',
  Arbitrum_Sepolia: 'ArbitrumSepolia',
  Optimism_Sepolia: 'OptimismSepolia',
  Avalanche_Fuji: 'AvalancheFuji',
  Polygon_Amoy_Testnet: 'PolygonAmoy',
  // EURC on World Chain: in Circle's CCTPx, but not yet in the kit's CCTPx
  // chain list (App Kit 1.20) - so Bring only, through MeshPort's router.
  World_Chain_Sepolia: 'WorldChainSepolia',
}
export const ARC_SDK = 'Arc_Testnet'

/** Chains the kit itself can move EURC / cirBTC on (kit.bridge - Transfer, and Bring paid by the wallet). */
export const KIT_CCTPX_CHAINS: ReadonlySet<string> = new Set([
  'Arc_Testnet', 'Ethereum_Sepolia', 'Base_Sepolia', 'Arbitrum_Sepolia', 'Optimism_Sepolia', 'Avalanche_Fuji', 'Polygon_Amoy_Testnet',
])

/** One registry token, as the registry lists it (only what is used here). */
export type RegistryToken = {
  tokenId: string
  deployments: Array<{ domainId: number; tokenAddress: string; enabled?: boolean }>
}

/**
 * Where `token` is deployed and switched on: chain id → its contract address
 * there. `symbolOf` maps a registry token id to MeshPort's symbol (symbols
 * aren't unique in the registry; the kit's canonical id per symbol is).
 * `domains`: chain id → CCTP domain. Pure - tested on its own.
 */
export function deploymentsFromRegistry(
  tokens: RegistryToken[], token: CctpxToken,
  symbolOf: (tokenId: string) => string | undefined, domains: Record<string, number>,
): Map<string, string> {
  const byDomain = new Map<number, string>()
  for (const [sdk, d] of Object.entries(domains)) byDomain.set(d, sdk)
  const out = new Map<string, string>()
  for (const t of tokens) {
    if (symbolOf(t.tokenId) !== token) continue
    for (const d of t.deployments) {
      if (d.enabled === false) continue
      const sdk = byDomain.get(d.domainId)
      if (sdk && d.tokenAddress) out.set(sdk, d.tokenAddress)
    }
  }
  return out
}

/** The chains `token` can be moved to from Arc (or brought from to Arc) - deployed and on at both ends. */
export function routeChains(deployments: Map<string, string>): string[] {
  if (!deployments.has(ARC_SDK)) return []
  return Object.keys(CCTPX_CHAIN_DEFS).filter(sdk => sdk !== ARC_SDK && deployments.has(sdk))
}

// ── Live registry (browser) ─────────────────────────────────────────────────
const IRIS_SANDBOX = 'https://iris-api-sandbox.circle.com' // testnet chains
let fetcherP: Promise<{ getStaleWhileRevalidate(): Promise<{ tokens: RegistryToken[] }> }> | null = null
let domainsP: Promise<Record<string, number>> | null = null

function registryFetcher() {
  fetcherP ??= import('@circle-fin/provider-cctpx').then(m => m.createCCTPXTokenRegistryFetcher({ baseUrl: IRIS_SANDBOX, ttlMs: 5 * 60_000 }) as never)
  fetcherP.catch(() => { fetcherP = null })
  return fetcherP
}

function chainDomains(): Promise<Record<string, number>> {
  domainsP ??= import('@circle-fin/app-kit/chains').then(m => {
    const defs = m as unknown as Record<string, { cctp?: { domain?: number } } | undefined>
    const out: Record<string, number> = {}
    for (const [sdk, name] of Object.entries(CCTPX_CHAIN_DEFS)) {
      const d = defs[name]?.cctp?.domain
      if (typeof d === 'number') out[sdk] = d
    }
    return out
  })
  domainsP.catch(() => { domainsP = null })
  return domainsP
}

/** `token`'s live deployments (chain id → contract address). Throws when the registry can't be read. */
export async function tokenDeployments(token: CctpxToken): Promise<Map<string, string>> {
  const [fetcher, domains, { resolveToKnownTokenSymbol }] = await Promise.all([
    registryFetcher(), chainDomains(), import('@circle-fin/provider-cctpx'),
  ])
  const reg = await fetcher.getStaleWhileRevalidate()
  return deploymentsFromRegistry(reg.tokens ?? [], token, id => resolveToKnownTokenSymbol(id, 'testnet'), domains)
}

// The last routes looked up per token: a screen opening again (or a chip
// switched back) shows them at once and refreshes in the background, like
// USDC's chain list - no "Finding chains…" every time.
const lastRoutes = new Map<CctpxToken, { chains: string[]; deployments: Map<string, string> }>()
const lookups = new Map<CctpxToken, Promise<{ chains: string[]; deployments: Map<string, string> }>>()

function lookupRoutes(token: CctpxToken) {
  let p = lookups.get(token)
  if (!p) {
    p = tokenDeployments(token)
      .then(dep => { const r = { chains: routeChains(dep), deployments: dep }; lastRoutes.set(token, r); return r })
      .finally(() => lookups.delete(token))
    lookups.set(token, p)
  }
  return p
}

/** Look up EURC's and cirBTC's routes in the background (a payment screen opening). */
export function prewarmTokenRoutes(): void {
  for (const t of ['EURC', 'cirBTC'] as const) if (!lastRoutes.has(t)) lookupRoutes(t).catch(() => {})
}

/**
 * The chains `token` can travel between with Arc right now, for a screen.
 * USDC: null (the screen keeps its own chain list). `error`: the registry
 * couldn't be read and nothing was known before - no chain is offered rather
 * than one that may not work.
 */
export function useTokenRouteChains(token: BridgeToken): { chains: string[] | null; deployments: Map<string, string> | null; loading: boolean; error: boolean } {
  const known = token === 'USDC' ? undefined : lastRoutes.get(token)
  const [state, setState] = useState<{ token: BridgeToken; chains: string[] | null; deployments: Map<string, string> | null; error: boolean }>(
    () => ({ token, chains: known?.chains ?? null, deployments: known?.deployments ?? null, error: false }))
  useEffect(() => {
    if (token === 'USDC') { setState({ token, chains: null, deployments: null, error: false }); return }
    let cancelled = false
    const cached = lastRoutes.get(token)
    if (cached) setState({ token, chains: cached.chains, deployments: cached.deployments, error: false })
    lookupRoutes(token)
      .then(r => { if (!cancelled) setState({ token, chains: r.chains, deployments: r.deployments, error: false }) })
      .catch(() => { if (!cancelled && !lastRoutes.has(token)) setState({ token, chains: [], deployments: null, error: true }) })
    return () => { cancelled = true }
  }, [token])
  const current = state.token === token && (state.chains !== null || token === 'USDC' || state.error)
  return {
    chains: token === 'USDC' ? null : current ? state.chains : (known?.chains ?? null),
    deployments: current ? state.deployments : (known?.deployments ?? null),
    loading: token !== 'USDC' && !current && !known,
    error: state.token === token && state.error,
  }
}
