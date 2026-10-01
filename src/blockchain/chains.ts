/**
 * blockchain/chains.ts — single client-side chain & token registry
 *
 * ── Purpose (Phase 0 of docs/BLOCKCHAIN_ARCHITECTURE_PROPOSAL.md) ───────────
 * Before this file, the same chain/RPC/token facts were spelled out in five
 * separate places (see §2.2 of the proposal): src/lib/arc.ts, src/lib/
 * chainRpcs.ts, src/lib/externalChainBalances.ts, api/arc-rpc.js and
 * supabase/functions/_shared/chains.ts. The first three are client-side and
 * are now consolidated here; the modules that used to own them re-export
 * from this file so every existing import keeps working unchanged.
 *
 * ── NETWORK: TESTNET ONLY ───────────────────────────────────────────────────
 * Every value below is Arc Testnet / Circle Testnet. Nothing here points at
 * mainnet, and nothing in this migration changes that. NETWORK_MODE exists so
 * a future mainnet cutover is a *configuration* change (add a sibling
 * registry, flip this constant) rather than another architectural pass —
 * that's the whole reason the data is centralized rather than inlined at 40+
 * call sites.
 *
 * ── Deliberately NOT consolidated ───────────────────────────────────────────
 * api/arc-rpc.js (Vercel serverless, its own 10-upstream list) and
 * supabase/functions/_shared/chains.ts (Deno edge runtime) run in different
 * runtimes and cannot import from src/. The Supabase functions additionally
 * inline their shared code on purpose — see the header of
 * supabase/functions/claim-worker/index.ts for why (the dashboard's
 * single-file editor silently ignores separate shared files). Unifying those
 * is Phase 6 work, via a generated mirror, not a plain import.
 *
 * ── Values are preserved EXACTLY ────────────────────────────────────────────
 * This file began as a pure relocation: no endpoint was added, removed,
 * reordered or "fixed" while moving it here.
 *
 * ONE deliberate exception, made separately and after the relocation was
 * verified byte-identical: HyperEVM's endpoint ORDER in EXTERNAL_CHAINS (see
 * the note there). The two registries genuinely disagreed, and this list was
 * trying a documented-dead endpoint first on every balance scan. Nothing else
 * has been changed from the original lists.
 */

/** Active network. Testnet is the only supported value today. */
export const NETWORK_MODE = 'testnet' as const

// ─── Arc Testnet ────────────────────────────────────────────────────────────
// Canonical descriptor. src/lib/arc.ts and src/lib/arcService.ts both used to
// declare their own copy of this (with arcService's carrying an extra
// faucetUrl); both now derive from here.
export const ARC = {
  chainId:     5042002,
  name:        'Arc Testnet',
  rpcUrl:      'https://rpc.testnet.arc.network',
  explorerUrl: 'https://testnet.arcscan.app',
  faucetUrl:   'https://faucet.circle.com',
} as const

// ─── Arc RPC list — single frontend entry point ──────────────────────────────
// The browser talks to exactly ONE Arc endpoint: our same-origin serverless
// proxy '/api/arc-rpc' (api/arc-rpc.js). The proxy forwards to the
// authenticated dRPC endpoint using DRPC_KEY, which lives server-side only
// and never reaches the client.
//
// IMPORTANT: this deliberately does NOT read any VITE_-prefixed env var for
// the RPC URL. Vite inlines every VITE_* variable into the client bundle at
// build time — anyone can read it straight out of the shipped JS. An
// authenticated URL (e.g. one with a key embedded in the path) put into a
// VITE_ variable is NOT a secret, it's public. If Arc ever issues a
// public-safe endpoint (no embedded credential — e.g. IP-allowlisted or
// CORS-restricted), that could be added here explicitly, but no such
// variable is wired in today, by design.
export const ARC_RPCS: string[] = ['/api/arc-rpc']

// ─── Static network descriptor for ethers JsonRpcProvider ───────────────────
// Pass this + { staticNetwork: true } to every Arc JsonRpcProvider/
// FallbackProvider constructor. Without it, ethers calls eth_chainId to
// auto-detect the network on every provider construction, and if that one
// call ever fails (e.g. a transient RPC hiccup or rate limit), ethers v6
// schedules an internal retry every ~1s FOREVER — even for a provider we
// keep in a module-level cache. That silent retry loop is itself a stream
// of eth_chainId requests hitting /api/arc-rpc → drpc.live, which can be
// enough on its own to exhaust a rate-limited API key and produce
// "request limit reached" (-32011) errors on real calls (swap/bridge).
// Since Arc Testnet's chain ID is fixed and known, there's nothing to
// detect — pinning it skips that call (and its retry loop) entirely.
export const ARC_NETWORK = { chainId: ARC.chainId, name: 'arc-testnet' } as const

// ─── Arc token registry ─────────────────────────────────────────────────────
// USDC is Arc's NATIVE gas currency: plain sends are 18-decimal value
// transfers (eth_getBalance), and the contract below is a SEPARATE, opt-in
// 6-decimal ERC-20 wrapper that plain sends never touch. That split is load-
// bearing for deposit detection — see supabase/functions/deposit-scan-all.
// EURC and cirBTC are genuine ERC-20s and emit Transfer logs normally.
export const ARC_TOKENS = {
  USDC: {
    symbol:          'USDC',
    contract:        '0x3600000000000000000000000000000000000000',
    decimals:        6,   // ERC-20 wrapper interface
    nativeDecimals:  18,  // native value transfers (eth_getBalance)
    isNative:        true,
  },
  EURC: {
    symbol:   'EURC',
    contract: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    decimals: 6,
    isNative: false,
  },
  cirBTC: {
    symbol:   'cirBTC',
    contract: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
    decimals: 8,
    isNative: false,
  },
} as const

export type ArcTokenSymbol = keyof typeof ARC_TOKENS

/** viem chain config for Arc. nativeCurrency.decimals MUST be 18 — gas is
 *  denominated in 18-decimal USDC wei (Arc docs). The ERC-20 interface uses
 *  6 decimals for transfers, but chain config reflects the native form.
 *
 *  ── Fixes a latent bug in the original code ────────────────────────────────
 *  This object previously lived in arcService.ts, which imported ARC_RPCS from
 *  arc.ts while arc.ts re-exported from arcService.ts — a circular import. At
 *  module-init time arcService evaluated before arc.ts had finished, so
 *  `rpcUrls.default.http` was assigned `undefined` rather than the RPC list,
 *  despite the source clearly intending `http: ARC_RPCS`. Verified by running
 *  the pristine baseline commit: `rpcUrls.default` really was `{}` at runtime.
 *
 *  It was dormant, not dangerous: every consumer (arcService's sendUSDC/sendEURC,
 *  p2pEscrowContract's sendContractTx) passes this only as viem's `chain:`
 *  argument, which uses it for chain id and signing metadata — never for
 *  transport. The actual endpoint always came from arcTransport(). So no call
 *  ever depended on the missing value.
 *
 *  Defining it here breaks the cycle, so the field now holds what it always
 *  should have. Documented rather than silently corrected, because it is the
 *  one runtime difference between the pristine baseline and this registry.
 */
export const ARC_CHAIN_INLINE = {
  id:             ARC.chainId,
  name:           ARC.name,
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls:        { default: { http: ARC_RPCS } },
} as const

// ─── RPC list resolution ────────────────────────────────────────────────────
// Alchemy was REMOVED from the client balance path (2026-08-19). It used to sit
// at position [0] of every external chain's RPC list, via two resolution styles
// (alchemyUrl() at module load, '__alchemy__' placeholders per call) both keyed
// on VITE_ALCHEMY_KEY.
//
// Why it went: readChainUSDCBalance iterates the RPC list and `continue`s on any
// non-OK response, so when the shared Alchemy account hit its rate limit every
// external chain returned HTTP 429 and then silently fell through to the next
// endpoint. Verified on live data — Ethereum Sepolia 37.348659, Base Sepolia
// 4.885553, Arbitrum Sepolia 24.797225, Unichain Sepolia 10.002332 USDC — all
// served correctly by the keyless public RPCs with Alchemy contributing nothing.
// So it was never load-bearing here: it cost one guaranteed failure plus up to
// 6s of timeout budget per chain per scan, produced the console 429/CORS noise,
// and shipped a live API key inside the client bundle (every VITE_* var is
// inlined and publicly readable).
//
// Server-side Alchemy is UNAFFECTED and still required: api/arc-rpc.js,
// api/swap-proxy.js and api/relay-rpc.js read process.env ALCHEMY_ARC_KEY /
// ALCHEMY_KEY, which are never exposed to the browser. Keyless *.g.alchemy.com
// /public endpoints (World Chain, EDGE) also stay — no key, not quota-billed.
//
// If Alchemy is reintroduced later it must go through a server proxy, never a
// VITE_-prefixed variable.

/**
 * Normalise an RPC list: drop empty/falsy entries.
 *
 * Retains the defensive `.filter(Boolean)` that the old placeholder resolver
 * provided, so a chain config with a conditional entry cannot yield a fetch to
 * an empty URL. No longer resolves any provider placeholder.
 */
export function resolveRpcList(rpcs: readonly string[]): string[] {
  return rpcs.filter(Boolean)
}

// ─── External chains — balance-scan registry ────────────────────────────────
// Keyed by MeshPort's own internal chain id (NOT the Circle SDK's chain.name —
// that's SDK_CHAIN_RPCS below). Consumed by externalChainBalances.ts to read
// each chain's USDC balance for the connected wallet.
//
// This list was itself the result of consolidating three drifted copies (Home,
// Hub and Claim each had their own); the per-chain RPC fallbacks here are the
// battle-tested set from the Claim page. Verified against Circle's own SDK
// source / developers.circle.com — do not reorder or prune casually.
export interface ExternalChainConfig {
  rpcs:     string[]
  usdc:     string
  decimals: number
  /**
   * Numeric EVM chain id, where it has been VERIFIED against the network's own
   * documentation. Optional on purpose — see the block comment below.
   */
  chainId?: number
}

// ─── On the optional chainId ────────────────────────────────────────────────
// Values below are copied from api/relay-gas.ts's CHAIN_DEFS, which states they
// were "verified against each network's own docs (not guessed) since a wrong id
// here would silently sign+broadcast against the wrong chain."
//
// Six chains in this registry have NO entry there: Sonic, World Chain, Linea,
// Ink, Monad and Edge. relay-gas.ts documents the reasoning for Edge
// explicitly — its id could not be confirmed from an authoritative source, so
// it was left out rather than guessed. That same standard is applied here: the
// field is simply absent for those six.
//
// Consumers must therefore treat chainId as optional. ProviderManager pins the
// network when it is present (which skips ethers' eth_chainId auto-detect and
// its ~1s-forever retry loop — see ARC_NETWORK above) and falls back to
// auto-detection when it is not. Auto-detection is exactly what the Multichain
// pages already do for every external chain today, so the absent case is no
// worse than current behavior, and the present case is strictly better.
//
// To fill one in: confirm the id against the network's official docs or
// chainlist, add it here AND to api/relay-gas.ts. Do not infer it from an RPC
// response alone.
export const EXTERNAL_CHAINS: Record<string, ExternalChainConfig> = {
  Ethereum_Sepolia: {
    chainId:  11155111,
    rpcs:     ['https://ethereum-sepolia-rpc.publicnode.com', 'https://rpc.sepolia.org'],
    usdc:     '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    decimals: 6,
  },
  Base_Sepolia: {
    chainId:  84532,
    rpcs:     ['https://base-sepolia-rpc.publicnode.com', 'https://sepolia.base.org'],
    usdc:     '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    decimals: 6,
  },
  Arbitrum_Sepolia: {
    chainId:  421614,
    rpcs:     ['https://arbitrum-sepolia-rpc.publicnode.com', 'https://sepolia-rollup.arbitrum.io/rpc'],
    usdc:     '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    decimals: 6,
  },
  Optimism_Sepolia: {
    chainId:  11155420,
    rpcs:     ['https://optimism-sepolia-rpc.publicnode.com', 'https://sepolia.optimism.io'],
    usdc:     '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
    decimals: 6,
  },
  Polygon_Sepolia: {
    chainId:  80002,
    rpcs:     ['https://polygon-amoy-bor-rpc.publicnode.com'],
    usdc:     '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
    decimals: 6,
  },
  Avalanche_Fuji: {
    chainId:  43113,
    rpcs:     ['https://api.avax-test.network/ext/bc/C/rpc', 'https://avalanche-fuji-c-chain-rpc.publicnode.com'],
    usdc:     '0x5425890298aed601595a70AB815c96711a31Bc65',
    decimals: 6,
  },
  HyperEVM_Testnet: {
    chainId:  998,
    // 2026-08-07: reordered so Chainlink's endpoint is tried FIRST.
    //
    // These two registries disagreed about HyperEVM. SDK_CHAIN_RPCS dropped
    // rpc.hyperliquid-testnet.xyz on 2026-07-18 after it showed two distinct
    // failure modes across two observations (a TLS cert mismatch, then a
    // connection reset) — see the note there. This list was never updated to
    // match, so it still tried that endpoint first on every balance scan,
    // paying a guaranteed-failing round trip (and console noise) before
    // falling through to the endpoint that actually answers. With three pages
    // scanning on 60s timers, that cost was paid continuously.
    //
    // Reordered rather than deleted, deliberately. The two lists have
    // different failure consequences: in SDK_CHAIN_RPCS a bad endpoint can
    // stall a transfer, so dropping it there was right. Here the fallback is
    // sequential and read-only, and losing the last candidate would make a
    // chain silently report $0 — which reads as "no funds" rather than "could
    // not check", the more dangerous outcome for a balance. Keeping it as a
    // backup preserves that safety net while removing the wasted first
    // attempt. Drop it entirely only if it proves to still be dead.
    rpcs:     ['https://rpcs.chain.link/hyperevm/testnet', 'https://rpc.hyperliquid-testnet.xyz/evm'],
    usdc:     '0x2B3370eE501B4a559b57D449569354196457D8Ab',
    decimals: 6,
  },
  Sei_Testnet: {
    chainId:  1328,
    rpcs:     ['https://evm-rpc-testnet.sei-apis.com'],
    usdc:     '0x4fCF1784B31630811181f670Aea7A7bEF803eaED',
    decimals: 6,
  },
  Sonic_Testnet: {
    // chainId not in api/relay-gas.ts — left unset rather than guessed.
    // Second endpoint copied verbatim from api/relay-rpc.js's own
    // CHAIN_DEFS.Sonic_Testnet (already trusted + in production there) — NOT
    // a web-search guess. Needed because rpc.testnet.soniclabs.com returns a
    // sustained 503 during outages and this registry previously had no
    // fallback, so Sonic silently reported $0 and logged a console error on
    // every Home/Hub balance scan. thirdweb's public RPCs send CORS headers.
    rpcs:     ['https://rpc.testnet.soniclabs.com', 'https://sonic-testnet.rpc.thirdweb.com'],
    usdc:     '0x0BA304580ee7c9a980CF72e55f5Ed2E9fd30Bc51',
    decimals: 6,
  },
  Unichain_Sepolia: {
    chainId:  1301,
    rpcs:     ['https://sepolia.unichain.org'],
    usdc:     '0x31d0220469e10c4E71834a79b1f276d740d3768F',
    decimals: 6,
  },
  World_Chain_Sepolia: {
    // chainId not in api/relay-gas.ts — left unset rather than guessed.
    rpcs:     ['https://worldchain-sepolia.g.alchemy.com/public', 'https://worldchain-sepolia.rpc.thirdweb.com'],
    usdc:     '0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88',
    decimals: 6,
  },
  Linea_Sepolia: {
    // chainId not in api/relay-gas.ts — left unset rather than guessed.
    rpcs:     ['https://rpc.sepolia.linea.build'],
    usdc:     '0xFEce4462D57bD51A6A552365A011b95f0E16d9B7',
    decimals: 6,
  },
  Ink_Testnet: {
    // chainId not in api/relay-gas.ts — left unset rather than guessed.
    rpcs:     ['https://rpc-gel-sepolia.inkonchain.com', 'https://rpc-qnd-sepolia.inkonchain.com'],
    usdc:     '0xFabab97dCE620294D2B0b0e46C68964e326300Ac',
    decimals: 6,
  },
  Monad_Testnet: {
    // chainId not in api/relay-gas.ts — left unset rather than guessed.
    rpcs:     ['https://testnet-rpc.monad.xyz'],
    usdc:     '0x534b2f3A21130d7a60830c2Df862319e593943A3',
    decimals: 6,
  },
  Morph_Testnet: {
    chainId:  2910,
    rpcs:     ['https://rpc-hoodi.morphl2.io'],
    usdc:     '0x7433b41C6c5e1d58D4Da99483609520255ab661B',
    decimals: 6,
  },
  Pharos_Testnet: {
    chainId:  688689,
    rpcs:     ['https://atlantic.dplabs-internal.com'],
    usdc:     '0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B',
    decimals: 6,
  },
  Plume_Testnet: {
    chainId:  98867,
    rpcs:     ['https://testnet-rpc.plume.org'],
    usdc:     '0xcB5f30e335672893c7eb944B374c196392C19D18',
    decimals: 6,
  },
  XDC_Apothem: {
    chainId:  51,
    rpcs:     ['https://rpc.apothem.network', 'https://erpc.apothem.network'],
    usdc:     '0xb5AB69F7bBada22B28e79C8FFAECe55eF1c771D4',
    decimals: 6,
  },
  Codex_Testnet: {
    chainId:  812242,
    rpcs:     ['https://rpc.codex-stg.xyz'],
    usdc:     '0x6d7f141b6819C2c9CC2f818e6ad549E7Ca090F8f',
    decimals: 6,
  },
  Edge_Testnet: {
    // chainId deliberately absent: api/relay-gas.ts documents that Edge's
    // numeric id could not be confirmed from an authoritative source, and
    // omitted it for that reason. Same standard applied here.
    rpcs:     ['https://edge-testnet.g.alchemy.com/public'],
    usdc:     '0x2d9F7CAD728051AA35Ecdc472a14cf8cDF5CFD6B',
    decimals: 6,
  },
  Injective_Testnet: {
    chainId:  1439,
    rpcs:     ['https://k8s.testnet.json-rpc.injective.network'],
    usdc:     '0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d',
    decimals: 6,
  },
}

// ─── External chains — Circle SDK provider registry ─────────────────────────
// Keyed by the Circle SDK's `chain.name` (NOT our internal chain ids above) —
// several entries appear twice because the SDK's actual runtime value doesn't
// always match its own documented/expected name (see the Ink/Morph/Edge notes
// below); both spellings are kept in sync intentionally, not by accident.
//
// ── Why this is a SEPARATE list from EXTERNAL_CHAINS ────────────────────────
// These two registries are keyed differently AND their RPC sets genuinely
// disagree for some chains. The clearest case is HyperEVM: this list carries
// only Chainlink's endpoint, because rpc.hyperliquid-testnet.xyz showed two
// distinct failure modes in production (a TLS cert mismatch, then a connection
// reset) and was dropped on 2026-07-18 — while EXTERNAL_CHAINS above still
// lists it first. Unifying them here would silently change which endpoint the
// balance scan hits, so the divergence is preserved verbatim and flagged
// instead. Reconciling it is a deliberate follow-up decision, not a
// side effect of moving files around.
export const SDK_CHAIN_RPCS: Record<string, string[]> = {
  'Ethereum Sepolia':    ['https://ethereum-sepolia-rpc.publicnode.com','https://rpc.sepolia.org'].filter(Boolean) as string[],
  'Base Sepolia':        ['https://base-sepolia-rpc.publicnode.com','https://sepolia.base.org'].filter(Boolean) as string[],
  'Arbitrum Sepolia':    ['https://arbitrum-sepolia-rpc.publicnode.com','https://sepolia-rollup.arbitrum.io/rpc','https://arbitrum-sepolia.drpc.org'].filter(Boolean) as string[],
  'OP Sepolia':          ['https://optimism-sepolia-rpc.publicnode.com','https://sepolia.optimism.io'].filter(Boolean) as string[],
  'Optimism Sepolia':    ['https://optimism-sepolia-rpc.publicnode.com','https://sepolia.optimism.io'].filter(Boolean) as string[],
  // 2026-07-18: removed rpc-amoy.polygon.technology — Polygon's own forum
  // (forum.polygon.technology) confirmed this public endpoint was deprecated
  // and stopped responding as of 2026-07-17. Not a transient outage; ethers'
  // FallbackProvider was still functionally recovering via the publicnode.com
  // fallback (quorum:1 means one working candidate is enough), but every call
  // was paying the cost of a guaranteed-failing first attempt and filling the
  // console with red errors for something permanently dead, not down.
  // Re-check Polygon's forum before re-adding any polygon.technology endpoint.
  'Polygon PoS Amoy':    ['https://polygon-amoy-bor-rpc.publicnode.com'].filter(Boolean) as string[],
  'Polygon Amoy':        ['https://polygon-amoy-bor-rpc.publicnode.com'].filter(Boolean) as string[],
  'Avalanche Fuji':      ['https://api.avax-test.network/ext/bc/C/rpc','https://avalanche-fuji-c-chain-rpc.publicnode.com'],
  // 2026-07-18: dropped rpc.hyperliquid-testnet.xyz entirely — after
  // reordering it behind Chainlink's endpoint, it showed TWO separate kinds of
  // failure across two observations (a TLS cert mismatch, then a connection
  // reset). That's not "occasionally flaky", that's this specific endpoint
  // being unreliable outright. Chainlink's hosted endpoint has been the one
  // actually serving successful calls. Re-add only if Chainlink's endpoint
  // itself ever proves unreliable and something is needed as backup.
  'HyperEVM Testnet':    ['https://rpcs.chain.link/hyperevm/testnet'],
  'Sei Testnet':         ['https://evm-rpc-testnet.sei-apis.com'],
  'Sonic Testnet':       ['https://rpc.testnet.soniclabs.com'],
  'Unichain Sepolia':    ['https://sepolia.unichain.org'].filter(Boolean) as string[],
  'World Chain Sepolia': ['https://worldchain-sepolia.g.alchemy.com/public'],
  'Linea Sepolia':       ['https://rpc.sepolia.linea.build'],
  'Ink Testnet':         ['https://rpc-gel-sepolia.inkonchain.com', 'https://rpc-qnd-sepolia.inkonchain.com'],
  // Circle's SDK actually returns "Ink Sepolia" as chain.name (confirmed
  // directly from @circle-fin/bridge-kit source) — 'Ink Testnet' above was
  // never being matched at runtime, silently disabling fallback for it.
  'Ink Sepolia':         ['https://rpc-gel-sepolia.inkonchain.com', 'https://rpc-qnd-sepolia.inkonchain.com'],
  'Monad Testnet':       ['https://testnet-rpc.monad.xyz', 'https://monad-testnet.drpc.org', 'https://10143.rpc.thirdweb.com'],
  'Morph Testnet':       ['https://rpc-hoodi.morphl2.io'],
  // Circle's SDK actually returns "Morph Hoodi" as chain.name — same silent
  // lookup-miss issue as Ink above.
  'Morph Hoodi':         ['https://rpc-hoodi.morphl2.io'],
  'Pharos Testnet':      ['https://atlantic.dplabs-internal.com'],
  'Pharos Atlantic':     ['https://atlantic.dplabs-internal.com'],
  'Plume Testnet':       ['https://testnet-rpc.plume.org'],
  'XDC Apothem':         ['https://rpc.apothem.network', 'https://erpc.apothem.network'],
  'Apothem Network':     ['https://rpc.apothem.network', 'https://erpc.apothem.network'],
  'Codex Testnet':       ['https://rpc.codex-stg.xyz'],
  'EDGE Testnet':        ['https://edge-testnet.g.alchemy.com/public'],
  // Circle's SDK actually returns "Edge Testnet" (not all-caps EDGE) as
  // chain.name — same silent lookup-miss issue as Ink/Morph above.
  'Edge Testnet':        ['https://edge-testnet.g.alchemy.com/public'],
  'Injective Testnet':   ['https://k8s.testnet.json-rpc.injective.network'],
}

// ─── Circle Forwarding Service support ──────────────────────────────────────
// Source: https://developers.circle.com/cctp/concepts/supported-chains-and-domains
// ("Forwarding Service" column). Keep in sync with Circle's docs as they roll
// out more destinations — check that table before adding here, don't assume a
// new chain has forwarder support just because CCTP supports it at all.
//
// Still NOT supported per that table: Injective, Morph, Pharos — these fall
// back to claim-worker's own polling to finish the mint after burn+attestation.
export const FORWARDER_SUPPORTED_SDK_CHAINS = new Set<string>([
  'Arbitrum_Sepolia', 'Avalanche_Fuji', 'Base_Sepolia', 'Ethereum_Sepolia',
  'HyperEVM_Testnet', 'Ink_Testnet', 'Linea_Sepolia', 'Monad_Testnet',
  'Optimism_Sepolia', 'Polygon_Amoy_Testnet', 'Sei_Testnet', 'Sonic_Testnet',
  'Unichain_Sepolia', 'World_Chain_Sepolia',
  'Codex_Testnet', 'Edge_Testnet', 'Plume_Testnet', 'XDC_Apothem',
])

export function chainSupportsForwarder(sdk: string): boolean {
  return FORWARDER_SUPPORTED_SDK_CHAINS.has(sdk)
}

/** Every internal chain id known to the balance-scan registry. */
export function externalChainIds(): string[] {
  return Object.keys(EXTERNAL_CHAINS)
}

// ─── Chain identity helpers ─────────────────────────────────────────────────
// MeshPort refers to Arc by several spellings across the codebase depending on
// origin: 'Arc_Testnet' in activity/claims rows and chainExplorers, 'Arc
// Testnet' in Circle SDK chain.name values, and 'arc' in a few ad-hoc places.
// Anything that branches on "is this Arc?" must accept all of them, or a lookup
// silently misses and falls through to an external-chain code path.

/** Canonical internal id for Arc. Matches the value used in Supabase rows. */
export const ARC_CHAIN_ID = 'Arc_Testnet'

const ARC_ALIASES = new Set(['arc', 'arc_testnet', 'arc testnet', 'arctestnet'])

export function isArc(chain: string | null | undefined): boolean {
  return ARC_ALIASES.has((chain ?? '').toLowerCase())
}

/** True when this id is a known external (non-Arc) chain. */
export function isExternalChain(chain: string): boolean {
  return !isArc(chain) && chain in EXTERNAL_CHAINS
}

/** Chain ids the app can currently read balances for, Arc included. */
export function allChainIds(): string[] {
  return [ARC_CHAIN_ID, ...externalChainIds()]
}


