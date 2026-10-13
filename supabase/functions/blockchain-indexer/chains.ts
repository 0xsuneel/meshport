// supabase/functions/blockchain-indexer/chains.ts
//
// Which chains the indexer observes, and how. Server-side only - Deno cannot
// import the frontend's src/lib/chains.ts (Vite `import.meta.env`), so this is
// a deliberate second registry with the SAME shape, matching how
// deposit-scan-all already keeps its own ARC_RPCS copy.
//
// ── Why only Arc is enabled in Phase 3 ──────────────────────────────────────
// The indexer's per-chain scan strategy is the expensive part: native block
// scanning costs one eth_getBlockByNumber(full) per block. On Arc (~2s blocks,
// one chain) that is affordable and it replaces work deposit-scan-all is
// ALREADY doing. Turning it on for 21 chains at once would multiply RPC spend
// before anything consumes the events - the exact "optimize where the
// bottleneck is" mistake Phase 3 was scoped to avoid. Other chains are
// declared here (so the registry is complete and cursors exist) but flagged
// enabled:false until a consumer justifies the spend.
//
// TESTNET ONLY.

export interface IndexedChain {
  /** Stable id - matches the frontend's chain ids. */
  id: string
  name: string
  /** RPC endpoints in priority order. Empty = chain cannot be indexed. */
  rpcs: string[]
  /**
   * Blocks below (head - confirmationDepth) are final.
   *
   * Arc: 0. Its docs state one confirmation is final with no reorgs, and
   * deposit-scan-all already relies on that (it scans to `latest`). Keeping 0
   * preserves current detection latency exactly; the reorg machinery is still
   * present and becomes active the moment this is raised.
   *
   * Everything else: conservative real-world values, NOT copied from the
   * frontend (which has no notion of finality). Polygon PoS is deliberately
   * high - it has produced reorgs well past 100 blocks.
   */
  confirmationDepth: number
  /** Max blocks one pass may scan, so a stale cursor cannot run unboundedly. */
  maxBlocksPerPass: number
  /** eth_getLogs range cap for this endpoint family. */
  logChunkSize: number
  /** Off = cursor is tracked but no scanning happens. */
  enabled: boolean
  /** Native currency is the asset we care about (Arc: USDC is native gas). */
  nativeAsset: string | null
  /**
   * Contract that emits a Transfer log for EVERY movement of the native asset,
   * including credits that carry no top-level `tx.value` because the transfer
   * was made through a contract call.
   *
   * On Arc this is 0xffff…fffe. Scanning it is what closes the "contract-
   * mediated USDC" gap: a transfer routed through the 0x3600 ERC-20 wrapper has
   * tx.to = 0x3600…, tx.value = 0, so the native block scan cannot see it, yet
   * the wallet is genuinely credited.
   *
   * Left null for chains where the relationship has not been verified on real
   * data - guessing here would create phantom deposits.
   */
  nativeTransferLogContract: string | null
  /** ERC-20s worth watching via eth_getLogs. */
  tokens: Array<{ symbol: string; contract: string; decimals: number }>
}

const DRPC_KEY = Deno.env.get('DRPC_KEY') ?? ''
const CONFIGURED_ARC_RPC_URL = (Deno.env.get('ARC_RPC_URL') ?? '').trim()
const ALCHEMY_KEY = Deno.env.get('ALCHEMY_KEY') ?? ''

// Authenticated-only Arc endpoints - identical policy and ordering to
// deposit-scan-all/index.ts. Public gateways are deliberately excluded: that
// is how a scan could end up on arc-testnet.rpc.thirdweb.com despite an
// authenticated RPC being configured.
const ARC_RPCS = [
  ...(CONFIGURED_ARC_RPC_URL ? [CONFIGURED_ARC_RPC_URL] : []),
  ...(DRPC_KEY ? [`https://lb.drpc.live/arc-testnet/${DRPC_KEY}`] : []),
]

const alchemy = (net: string) => ALCHEMY_KEY ? `https://${net}.g.alchemy.com/v2/${ALCHEMY_KEY}` : ''

export const INDEXED_CHAINS: IndexedChain[] = [
  // ── Arc Testnet ──────────────────────────────────────────────────────────
  {
    id: 'arc',
    name: 'Arc Testnet',
    rpcs: ARC_RPCS,
    confirmationDepth: 0,          // Arc docs: 1 conf = final, no reorgs
    maxBlocksPerPass: 3000,
    logChunkSize: 5000,
    enabled: true,
    nativeAsset: 'USDC',
    // 0xffff…fffe is a strict superset of real USDC credits on Arc (native +
    // contract-mediated). See the 3,000-block measurement in the original comment.
    nativeTransferLogContract: '0xfffffffffffffffffffffffffffffffffffffffe',
    tokens: [
      { symbol: 'EURC',   contract: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', decimals: 6 },
      { symbol: 'cirBTC', contract: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF', decimals: 8 },
    ],
  },

  // ── External chains ──────────────────────────────────────────────────────
  // All enabled. Each fires one eth_getLogs call per cron tick (~30s) per
  // chain, triggering a targeted single-chain RPC read on the client via
  // Supabase Realtime → shadowEventBus → EXTERNAL_BALANCE_EVENT. This is
  // 40× fewer RPC calls than a 30s client poll and delivers instant UI updates.
  // USDC addresses match src/blockchain/chains.ts EXTERNAL_CHAINS exactly.
  {
    id: 'ethereum-sepolia', name: 'Ethereum Sepolia',
    rpcs: [alchemy('eth-sepolia'), 'https://ethereum-sepolia-rpc.publicnode.com', 'https://rpc.sepolia.org'].filter(Boolean),
    confirmationDepth: 12, maxBlocksPerPass: 2000, logChunkSize: 500,
    enabled: true, nativeAsset: null, nativeTransferLogContract: null,
    tokens: [{ symbol: 'USDC', contract: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', decimals: 6 }],
  },
  {
    id: 'base-sepolia', name: 'Base Sepolia',
    rpcs: [alchemy('base-sepolia'), 'https://base-sepolia-rpc.publicnode.com', 'https://sepolia.base.org'].filter(Boolean),
    confirmationDepth: 20, maxBlocksPerPass: 3000, logChunkSize: 1000,
    enabled: true, nativeAsset: null, nativeTransferLogContract: null,
    tokens: [{ symbol: 'USDC', contract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6 }],
  },
  {
    id: 'arbitrum-sepolia', name: 'Arbitrum Sepolia',
    rpcs: [alchemy('arb-sepolia'), 'https://arbitrum-sepolia-rpc.publicnode.com', 'https://sepolia-rollup.arbitrum.io/rpc'].filter(Boolean),
    confirmationDepth: 20, maxBlocksPerPass: 5000, logChunkSize: 1000,
    enabled: true, nativeAsset: null, nativeTransferLogContract: null,
    tokens: [{ symbol: 'USDC', contract: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', decimals: 6 }],
  },
  {
    id: 'optimism-sepolia', name: 'Optimism Sepolia',
    rpcs: [alchemy('opt-sepolia'), 'https://optimism-sepolia-rpc.publicnode.com', 'https://sepolia.optimism.io'].filter(Boolean),
    confirmationDepth: 20, maxBlocksPerPass: 3000, logChunkSize: 1000,
    enabled: true, nativeAsset: null, nativeTransferLogContract: null,
    tokens: [{ symbol: 'USDC', contract: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7', decimals: 6 }],
  },
  {
    id: 'polygon-amoy', name: 'Polygon PoS Amoy',
    rpcs: [alchemy('polygon-amoy'), 'https://polygon-amoy-bor-rpc.publicnode.com'].filter(Boolean),
    // Polygon PoS has reorged >100 blocks in production. Not a padded guess.
    confirmationDepth: 128, maxBlocksPerPass: 3000, logChunkSize: 1000,
    enabled: true, nativeAsset: null, nativeTransferLogContract: null,
    tokens: [{ symbol: 'USDC', contract: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582', decimals: 6 }],
  },
  {
    id: 'avalanche-fuji', name: 'Avalanche Fuji',
    rpcs: ['https://api.avax-test.network/ext/bc/C/rpc', 'https://avalanche-fuji-c-chain-rpc.publicnode.com'],
    confirmationDepth: 1, maxBlocksPerPass: 3000, logChunkSize: 2048,
    enabled: true, nativeAsset: null, nativeTransferLogContract: null,
    tokens: [{ symbol: 'USDC', contract: '0x5425890298aed601595a70AB815c96711a31Bc65', decimals: 6 }],
  },
  {
    id: 'hyperevm-testnet', name: 'HyperEVM Testnet',
    // Chainlink endpoint tried first - rpc.hyperliquid-testnet.xyz showed two
    // separate failure modes (TLS mismatch, then connection reset) in production.
    rpcs: ['https://rpcs.chain.link/hyperevm/testnet', 'https://rpc.hyperliquid-testnet.xyz/evm'],
    confirmationDepth: 5, maxBlocksPerPass: 3000, logChunkSize: 1000,
    enabled: true, nativeAsset: null, nativeTransferLogContract: null,
    tokens: [{ symbol: 'USDC', contract: '0x2B3370eE501B4a559b57D449569354196457D8Ab', decimals: 6 }],
  },
  {
    id: 'sei-testnet', name: 'Sei Testnet',
    rpcs: ['https://evm-rpc-testnet.sei-apis.com'],
    confirmationDepth: 1, maxBlocksPerPass: 3000, logChunkSize: 1000,
    enabled: true, nativeAsset: null, nativeTransferLogContract: null,
    tokens: [{ symbol: 'USDC', contract: '0x4fCF1784B31630811181f670Aea7A7bEF803eaED', decimals: 6 }],
  },
  {
    id: 'sonic-testnet', name: 'Sonic Testnet',
    rpcs: ['https://rpc.testnet.soniclabs.com', 'https://sonic-testnet.rpc.thirdweb.com'],
    confirmationDepth: 1, maxBlocksPerPass: 3000, logChunkSize: 1000,
    enabled: true, nativeAsset: null, nativeTransferLogContract: null,
    tokens: [{ symbol: 'USDC', contract: '0x0BA304580ee7c9a980CF72e55f5Ed2E9fd30Bc51', decimals: 6 }],
  },
  {
    id: 'unichain-sepolia', name: 'Unichain Sepolia',
    rpcs: ['https://sepolia.unichain.org'],
    confirmationDepth: 20, maxBlocksPerPass: 3000, logChunkSize: 1000,
    enabled: true, nativeAsset: null, nativeTransferLogContract: null,
    tokens: [{ symbol: 'USDC', contract: '0x31d0220469e10c4E71834a79b1f276d740d3768F', decimals: 6 }],
  },
  {
    id: 'world-chain-sepolia', name: 'World Chain Sepolia',
    rpcs: ['https://worldchain-sepolia.g.alchemy.com/public', 'https://worldchain-sepolia.rpc.thirdweb.com'],
    confirmationDepth: 20, maxBlocksPerPass: 3000, logChunkSize: 1000,
    enabled: true, nativeAsset: null, nativeTransferLogContract: null,
    tokens: [{ symbol: 'USDC', contract: '0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88', decimals: 6 }],
  },
  {
    id: 'linea-sepolia', name: 'Linea Sepolia',
    rpcs: ['https://rpc.sepolia.linea.build'],
    confirmationDepth: 20, maxBlocksPerPass: 3000, logChunkSize: 1000,
    enabled: true, nativeAsset: null, nativeTransferLogContract: null,
    tokens: [{ symbol: 'USDC', contract: '0xFEce4462D57bD51A6A552365A011b95f0E16d9B7', decimals: 6 }],
  },
  {
    id: 'ink-testnet', name: 'Ink Testnet',
    rpcs: ['https://rpc-gel-sepolia.inkonchain.com', 'https://rpc-qnd-sepolia.inkonchain.com'],
    confirmationDepth: 20, maxBlocksPerPass: 3000, logChunkSize: 1000,
    enabled: true, nativeAsset: null, nativeTransferLogContract: null,
    tokens: [{ symbol: 'USDC', contract: '0xFabab97dCE620294D2B0b0e46C68964e326300Ac', decimals: 6 }],
  },
  {
    id: 'monad-testnet', name: 'Monad Testnet',
    rpcs: ['https://testnet-rpc.monad.xyz', 'https://monad-testnet.drpc.org'],
    confirmationDepth: 1, maxBlocksPerPass: 3000, logChunkSize: 1000,
    enabled: true, nativeAsset: null, nativeTransferLogContract: null,
    tokens: [{ symbol: 'USDC', contract: '0x534b2f3A21130d7a60830c2Df862319e593943A3', decimals: 6 }],
  },
  {
    id: 'morph-testnet', name: 'Morph Testnet',
    rpcs: ['https://rpc-hoodi.morphl2.io'],
    confirmationDepth: 20, maxBlocksPerPass: 3000, logChunkSize: 1000,
    enabled: true, nativeAsset: null, nativeTransferLogContract: null,
    tokens: [{ symbol: 'USDC', contract: '0x7433b41C6c5e1d58D4Da99483609520255ab661B', decimals: 6 }],
  },
  {
    id: 'pharos-testnet', name: 'Pharos Testnet',
    rpcs: ['https://atlantic.dplabs-internal.com'],
    confirmationDepth: 5, maxBlocksPerPass: 3000, logChunkSize: 1000,
    enabled: true, nativeAsset: null, nativeTransferLogContract: null,
    tokens: [{ symbol: 'USDC', contract: '0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B', decimals: 6 }],
  },
  {
    id: 'plume-testnet', name: 'Plume Testnet',
    rpcs: ['https://testnet-rpc.plume.org'],
    confirmationDepth: 5, maxBlocksPerPass: 3000, logChunkSize: 1000,
    enabled: true, nativeAsset: null, nativeTransferLogContract: null,
    tokens: [{ symbol: 'USDC', contract: '0xcB5f30e335672893c7eb944B374c196392C19D18', decimals: 6 }],
  },
  {
    id: 'xdc-apothem', name: 'XDC Apothem',
    rpcs: ['https://rpc.apothem.network', 'https://erpc.apothem.network'],
    confirmationDepth: 5, maxBlocksPerPass: 3000, logChunkSize: 1000,
    enabled: true, nativeAsset: null, nativeTransferLogContract: null,
    tokens: [{ symbol: 'USDC', contract: '0xb5AB69F7bBada22B28e79C8FFAECe55eF1c771D4', decimals: 6 }],
  },
  {
    id: 'codex-testnet', name: 'Codex Testnet',
    rpcs: ['https://rpc.codex-stg.xyz'],
    confirmationDepth: 5, maxBlocksPerPass: 3000, logChunkSize: 1000,
    enabled: true, nativeAsset: null, nativeTransferLogContract: null,
    tokens: [{ symbol: 'USDC', contract: '0x6d7f141b6819C2c9CC2f818e6ad549E7Ca090F8f', decimals: 6 }],
  },
  {
    id: 'edge-testnet', name: 'EDGE Testnet',
    rpcs: ['https://edge-testnet.g.alchemy.com/public'],
    confirmationDepth: 5, maxBlocksPerPass: 3000, logChunkSize: 1000,
    enabled: true, nativeAsset: null, nativeTransferLogContract: null,
    tokens: [{ symbol: 'USDC', contract: '0x2d9F7CAD728051AA35Ecdc472a14cf8cDF5CFD6B', decimals: 6 }],
  },
  {
    id: 'injective-testnet', name: 'Injective Testnet',
    rpcs: ['https://k8s.testnet.json-rpc.injective.network'],
    confirmationDepth: 5, maxBlocksPerPass: 3000, logChunkSize: 1000,
    enabled: true, nativeAsset: null, nativeTransferLogContract: null,
    tokens: [{ symbol: 'USDC', contract: '0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d', decimals: 6 }],
  },
]

export const enabledChains = () => INDEXED_CHAINS.filter(c => c.enabled && c.rpcs.length > 0)
export const chainById = (id: string) => INDEXED_CHAINS.find(c => c.id === id)
