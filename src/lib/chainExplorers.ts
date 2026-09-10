// src/lib/chainExplorers.ts
//
// Canonical per-chain block-explorer base URLs, sourced directly from
// @circle-fin/bridge-kit's own shipped chain definitions (chains.mjs) —
// installed and inspected directly, not guessed or found via web search.
//
// This app previously had FOUR independent, hand-maintained copies of this
// map (MultichainTransferPage.tsx, features/multichain/MultichainPage.tsx,
// features/activity/ActivityPage.tsx, and an ad-hoc claim-side usage) that
// had drifted out of sync with each other AND with the SDK's own values:
//   - Optimism Sepolia: 3 of the 4 copies used 'sepolia-optimism.etherscan.io'
//     — the real domain is 'sepolia-optimistic.etherscan.io'.
//   - HyperEVM Testnet: multiple different URLs across the app
//     (app.hyperliquid-testnet.xyz/explorer, testnet.purrsec.com). Confirmed
//     directly against a real transaction that explore-testnet.hyperpc.app
//     is the one that actually resolves correctly — the SDK-sourced value
//     used here previously did not, despite matching bridge-kit's own data.
//   - Unichain Sepolia: all copies pointed at sepolia.uniscan.xyz — the SDK's
//     real explorer is unichain-sepolia.blockscout.com.
//   - Avalanche Fuji: all copies used snowtrace.io — SDK's canonical value
//     is subnets-test.avax.network/c-chain.
//   - Injective Testnet: right domain, but every copy used the generic
//     `/tx/{hash}` path — Injective's real path segment is `/transaction/`.
// A hash paired with a wrong base URL is just as broken a link as a wrong
// hash — this file exists so there's exactly one place to fix, not four.
//
// Import EXPLORER_BASE / ARC_EXPLORER and build links with explorerTxUrl()
// rather than hand-rolling `${base}/tx/${hash}` at each call site.

export const ARC_EXPLORER = 'https://testnet.arcscan.app'

export const EXPLORER_BASE: Record<string, string> = {
  Ethereum_Sepolia:     'https://sepolia.etherscan.io',
  Base_Sepolia:         'https://sepolia.basescan.org',
  Arbitrum_Sepolia:     'https://sepolia.arbiscan.io',
  Optimism_Sepolia:     'https://sepolia-optimistic.etherscan.io',
  Polygon_Amoy_Testnet: 'https://amoy.polygonscan.com',
  // Claims key `source_chain` using this app's OLDER internal chain id
  // (Polygon_Sepolia — see supabase/functions/_shared/chains.ts and
  // MultichainClaimPage.tsx's CHAIN_CONFIG), while transfers key it via
  // chain.sdk (Polygon_Amoy_Testnet, the real Circle SDK id). Same chain,
  // two different naming conventions already in use elsewhere in this
  // codebase — alias both here rather than have one silently miss.
  Polygon_Sepolia:      'https://amoy.polygonscan.com',
  Avalanche_Fuji:       'https://subnets-test.avax.network/c-chain',
  HyperEVM_Testnet:     'https://explore-testnet.hyperpc.app',
  Sei_Testnet:          'https://testnet.seiscan.io',
  Sonic_Testnet:        'https://testnet.sonicscan.org',
  Unichain_Sepolia:     'https://unichain-sepolia.blockscout.com',
  World_Chain_Sepolia:  'https://sepolia.worldscan.org',
  Linea_Sepolia:        'https://sepolia.lineascan.build',
  Ink_Testnet:          'https://explorer-sepolia.inkonchain.com',
  XDC_Apothem:          'https://testnet.xdcscan.com',
  Injective_Testnet:    'https://testnet.explorer.injective.network',
  Plume_Testnet:        'https://testnet-explorer.plume.org',
  Monad_Testnet:        'https://testnet.monadscan.com',
  Morph_Testnet:        'https://explorer-hoodi.morphl2.io',
  Pharos_Testnet:       'https://atlantic.pharosscan.xyz',
  Codex_Testnet:        'https://explorer.codex-stg.xyz',
  Edge_Testnet:         'https://edge-testnet.explorer.alchemy.com',
  Arc_Testnet:          ARC_EXPLORER,
}

// A small number of chains use a different URL path segment for
// transactions than the near-universal `/tx/{hash}` — each verified against
// the SDK's own explorerUrl template for that chain, not assumed.
const TX_PATH_OVERRIDE: Record<string, string> = {
  Injective_Testnet: 'transaction',
}

/** Build a transaction explorer link for `chainId`, or null if unknown/no hash. */
export function explorerTxUrl(chainId: string, txHash: string | undefined | null): string | null {
  if (!txHash) return null
  const base = EXPLORER_BASE[chainId]
  if (!base) return null
  const segment = TX_PATH_OVERRIDE[chainId] ?? 'tx'
  return `${base}/${segment}/${txHash}`
}

/** Same as explorerTxUrl but always resolves against Arc's own explorer. */
export function arcExplorerTxUrl(txHash: string | undefined | null): string | null {
  if (!txHash) return null
  return `${ARC_EXPLORER}/tx/${txHash}`
}
