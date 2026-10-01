// supabase/functions/blockchain-indexer/chains.ts
//
// Which chains the indexer observes, and how. Server-side only — Deno cannot
// import the frontend's src/lib/chains.ts (Vite `import.meta.env`), so this is
// a deliberate second registry with the SAME shape, matching how
// deposit-scan-all already keeps its own ARC_RPCS copy.
//
// ── Why only Arc is enabled in Phase 3 ──────────────────────────────────────
// The indexer's per-chain scan strategy is the expensive part: native block
// scanning costs one eth_getBlockByNumber(full) per block. On Arc (~2s blocks,
// one chain) that is affordable and it replaces work deposit-scan-all is
// ALREADY doing. Turning it on for 21 chains at once would multiply RPC spend
// before anything consumes the events — the exact "optimize where the
// bottleneck is" mistake Phase 3 was scoped to avoid. Other chains are
// declared here (so the registry is complete and cursors exist) but flagged
// enabled:false until a consumer justifies the spend.
//
// TESTNET ONLY.

export interface IndexedChain {
  /** Stable id — matches the frontend's chain ids. */
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
   * high — it has produced reorgs well past 100 blocks.
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
   * data — guessing here would create phantom deposits.
   */
  nativeTransferLogContract: string | null
  /** ERC-20s worth watching via eth_getLogs. */
  tokens: Array<{ symbol: string; contract: string; decimals: number }>
}

const DRPC_KEY = Deno.env.get('DRPC_KEY') ?? ''
const CONFIGURED_ARC_RPC_URL = (Deno.env.get('ARC_RPC_URL') ?? '').trim()
const ALCHEMY_KEY = Deno.env.get('ALCHEMY_KEY') ?? ''

// Authenticated-only Arc endpoints — identical policy and ordering to
// deposit-scan-all/index.ts. Public gateways are deliberately excluded: that
// is how a scan could end up on arc-testnet.rpc.thirdweb.com despite an
// authenticated RPC being configured.
const ARC_RPCS = [
  ...(CONFIGURED_ARC_RPC_URL ? [CONFIGURED_ARC_RPC_URL] : []),
  ...(DRPC_KEY ? [`https://lb.drpc.live/arc-testnet/${DRPC_KEY}`] : []),
]

const alchemy = (net: string) => ALCHEMY_KEY ? `https://${net}.g.alchemy.com/v2/${ALCHEMY_KEY}` : ''

export const INDEXED_CHAINS: IndexedChain[] = [
  {
    id: 'arc',
    name: 'Arc Testnet',
    rpcs: ARC_RPCS,
    confirmationDepth: 0,          // see note above — Arc docs: 1 conf = final
    maxBlocksPerPass: 3000,
    logChunkSize: 5000,
    enabled: true,
    nativeAsset: 'USDC',           // Arc's native gas currency is USDC
    // ── Why 0xffff…fffe and NOT the 0x3600 ERC-20 wrapper ────────────────────
    // Arc exposes native USDC two ways, and BOTH emit a Transfer log:
    //   0xffff…fffe  — 18 decimals, the native representation
    //   0x3600…0000  — 6 decimals, the ERC-20 wrapper view
    //
    // Measured over 3,000 live blocks (20,098 wrapper logs):
    //   * every wrapper log carrying a REAL credit also has an identical
    //     0xffff…fffe log in the same tx, same from, same to, differing only
    //     by the 1e12 decimal scale
    //   * the 510 wrapper logs WITHOUT such a twin are, after the scanner's
    //     existing filters, 100% self-transfers (from == to) or zero-value —
    //     already rejected, so nothing real is lost
    //   * 11,268 fffe logs had no wrapper twin: ordinary native transfers
    //
    // So 0xffff…fffe is a strict superset of real credits. Scanning it alone
    // captures contract-mediated deposits AND plain native transfers, with no
    // double-count. Scanning BOTH would emit two events per wrapper credit;
    // scanning only 0x3600 would miss every plain native transfer.
    //
    // An earlier 5-transaction sample suggested the two were always paired.
    // The 3,000-block sample disproved that (346 orphans), which is why the
    // conclusion rests on the wide sample, not the small one.
    nativeTransferLogContract: '0xfffffffffffffffffffffffffffffffffffffffe',
    tokens: [
      { symbol: 'EURC',   contract: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', decimals: 6 },
      { symbol: 'cirBTC', contract: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF', decimals: 8 },
    ],
  },
  // ── Declared, cursor-tracked, NOT scanned in Phase 3 ──────────────────────
  // These exist so chain_cursors is complete and enabling one is a flag flip
  // rather than a code change. Depths are real finality estimates.
  {
    id: 'ethereum-sepolia', name: 'Ethereum Sepolia',
    rpcs: [alchemy('eth-sepolia'), 'https://ethereum-sepolia-rpc.publicnode.com'].filter(Boolean),
    confirmationDepth: 12, maxBlocksPerPass: 2000, logChunkSize: 500,
    enabled: false, nativeAsset: null, nativeTransferLogContract: null, tokens: [],
  },
  {
    id: 'base-sepolia', name: 'Base Sepolia',
    rpcs: [alchemy('base-sepolia'), 'https://base-sepolia-rpc.publicnode.com'].filter(Boolean),
    confirmationDepth: 20, maxBlocksPerPass: 3000, logChunkSize: 1000,
    enabled: false, nativeAsset: null, nativeTransferLogContract: null, tokens: [],
  },
  {
    id: 'polygon-amoy', name: 'Polygon PoS Amoy',
    rpcs: [alchemy('polygon-amoy'), 'https://polygon-amoy-bor-rpc.publicnode.com'].filter(Boolean),
    // Polygon PoS has reorged >100 blocks in production. Not a padded guess.
    confirmationDepth: 128, maxBlocksPerPass: 3000, logChunkSize: 1000,
    enabled: false, nativeAsset: null, nativeTransferLogContract: null, tokens: [],
  },
  {
    id: 'arbitrum-sepolia', name: 'Arbitrum Sepolia',
    rpcs: [alchemy('arb-sepolia'), 'https://arbitrum-sepolia-rpc.publicnode.com'].filter(Boolean),
    confirmationDepth: 20, maxBlocksPerPass: 5000, logChunkSize: 1000,
    enabled: false, nativeAsset: null, nativeTransferLogContract: null, tokens: [],
  },
]

export const enabledChains = () => INDEXED_CHAINS.filter(c => c.enabled && c.rpcs.length > 0)
export const chainById = (id: string) => INDEXED_CHAINS.find(c => c.id === id)
