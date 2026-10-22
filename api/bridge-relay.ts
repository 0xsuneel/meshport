// api/bridge-relay.ts - MeshPort's gasless bridge relayer (Vercel).
//
// Stateless: it holds no user funds, keeps no job state, and can only submit
// what a user signed (or what Circle attested). Three actions:
//
//   GET  ?action=quote&chain=Base_Sepolia&amount=<USDC base units>
//        → { fee, maxFee, usdcName, usdcVersion }
//        fee    = MeshPort fee (relayer's source-chain gas, in USDC)
//        maxFee = CCTP V2 maxFee (protocol fee + Circle forwarding fee, + margin)
//
//   POST { action:'relay', chain, bridge, authorization }
//        Checks the request, simulates MeshPortBridgeRouter.bridgeWithAuthorization,
//        submits it with the relayer key (paying source-chain gas) and returns
//        { txHash } - the CCTP burn. Idempotent: an authorization that was
//        already used returns the transaction that used it.
//
//   POST { action:'call', chain, to, data }
//        Submits, from the relayer wallet, one of a few calls whose outcome
//        doesn't depend on who sends them - so the user needs no gas:
//          · Circle Gateway Wallet deposits signed by the user
//            (depositWithAuthorization / depositWithPermit; the depositor
//            must be the signed-in user's wallet)
//          · Gateway Minter gatewayMint(attestation, signature)
//          · CCTP V2 MessageTransmitter receiveMessage(message, attestation)
//          · USDC transferWithAuthorization (EIP-3009) for a Business refund
//            on the chain the customer paid on: from = the signed-in
//            merchant, to/amount = a real payment from that customer to
//            them on that chain that isn't refunded yet (refundFor)
//        The recipient is fixed by the user's signature or Circle's
//        attestation, so the relayer can't redirect anything. → { txHash }
//
// The router (contracts/MeshPortBridgeRouter.sol) makes the relayer unable to
// change anything the user signed; this endpoint additionally only relays
// self-bridges to Arc through Circle's forwarder, for signed-in users, at a
// fee that covers its gas.
//
// Env:
//   BRIDGE_RELAYER_PRIVATE_KEY  relayer key (pays gas; never holds user funds)
//   BRIDGE_ROUTERS              {"Base_Sepolia":"0x…","Ethereum_Sepolia":"0x…"}
//   BRIDGE_RPC_<CHAIN>          optional RPC override per chain
//   BRIDGE_NATIVE_USD_<CHAIN>   optional gas-token USD price per chain (defaults in CHAINS)
//   BRIDGE_MAX_FEE_UNITS        optional fee cap in USDC base units (default 100000 = 0.10)
//   SUPABASE_URL, SUPABASE_SERVICE_KEY  session → wallet ownership check

import type { VercelRequest, VercelResponse } from '@vercel/node'

const ARC_DOMAIN = 26
const FORWARD_HOOK = '0x636374702d666f72776172640000000000000000000000000000000000000000'
// Use production Iris by default; set IRIS_ENV=sandbox in Vercel for testnet deployments.
const IRIS = (process.env.IRIS_ENV || '') === 'sandbox'
  ? 'https://iris-api-sandbox.circle.com'
  : 'https://iris-api.circle.com'
const ROUTER_GAS = 260_000n           // receiveWithAuthorization + transfer + approve + depositForBurnWithHook
const MAX_AUTH_WINDOW_SEC = 2 * 60 * 60
const MIN_TOTAL_UNITS = 1_000_000n    // 1 USDC

// Chain id, USDC and CCTP domain per chain - from src/blockchain/chains.ts
// (EXTERNAL_CHAINS, verified ids only) and Circle's domain table;
// src/lib/gaslessBridge.test.ts checks this stays in sync. `gasUsd` is a rough
// USD price of the chain's gas token, only used to turn gas into a USDC fee
// (override per chain with BRIDGE_NATIVE_USD_<CHAIN>; the fee cap applies anyway).
export const CHAINS: Record<string, { id: number; name: string; rpc: string; usdc: `0x${string}`; domain: number; gasUsd: number }> = {
  Ethereum_Sepolia:  { id: 11155111, name: 'Ethereum Sepolia',  rpc: 'https://ethereum-sepolia-rpc.publicnode.com', usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', domain: 0,  gasUsd: 3000 },
  Base_Sepolia:      { id: 84532,    name: 'Base Sepolia',      rpc: 'https://sepolia.base.org',                   usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', domain: 6,  gasUsd: 3000 },
  Arbitrum_Sepolia:  { id: 421614,   name: 'Arbitrum Sepolia',  rpc: 'https://sepolia-rollup.arbitrum.io/rpc',     usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', domain: 3,  gasUsd: 3000 },
  Optimism_Sepolia:  { id: 11155420, name: 'OP Sepolia',        rpc: 'https://sepolia.optimism.io',                usdc: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7', domain: 2,  gasUsd: 3000 },
  Polygon_Sepolia:   { id: 80002,    name: 'Polygon Amoy',      rpc: 'https://polygon-amoy-bor-rpc.publicnode.com', usdc: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582', domain: 7,  gasUsd: 0.5 },
  Avalanche_Fuji:    { id: 43113,    name: 'Avalanche Fuji',    rpc: 'https://api.avax-test.network/ext/bc/C/rpc', usdc: '0x5425890298aed601595a70AB815c96711a31Bc65', domain: 1,  gasUsd: 30 },
  HyperEVM_Testnet:  { id: 998,      name: 'HyperEVM Testnet',  rpc: 'https://rpcs.chain.link/hyperevm/testnet',   usdc: '0x2B3370eE501B4a559b57D449569354196457D8Ab', domain: 19, gasUsd: 30 },
  Sei_Testnet:       { id: 1328,     name: 'Sei Testnet',       rpc: 'https://evm-rpc-testnet.sei-apis.com',       usdc: '0x4fCF1784B31630811181f670Aea7A7bEF803eaED', domain: 16, gasUsd: 0.5 },
  Unichain_Sepolia:  { id: 1301,     name: 'Unichain Sepolia',  rpc: 'https://sepolia.unichain.org',               usdc: '0x31d0220469e10c4E71834a79b1f276d740d3768F', domain: 10, gasUsd: 3000 },
  Morph_Testnet:     { id: 2910,     name: 'Morph Hoodi',       rpc: 'https://rpc-hoodi.morphl2.io',               usdc: '0x7433b41C6c5e1d58D4Da99483609520255ab661B', domain: 30, gasUsd: 3000 },
  Pharos_Testnet:    { id: 688689,   name: 'Pharos Atlantic',   rpc: 'https://atlantic.dplabs-internal.com',       usdc: '0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B', domain: 31, gasUsd: 1 },
  Plume_Testnet:     { id: 98867,    name: 'Plume Testnet',     rpc: 'https://testnet-rpc.plume.org',              usdc: '0xcB5f30e335672893c7eb944B374c196392C19D18', domain: 22, gasUsd: 0.2 },
  XDC_Apothem:       { id: 51,       name: 'XDC Apothem',       rpc: 'https://rpc.apothem.network',                usdc: '0xb5AB69F7bBada22B28e79C8FFAECe55eF1c771D4', domain: 18, gasUsd: 0.1 },
  Codex_Testnet:     { id: 812242,   name: 'Codex Testnet',     rpc: 'https://rpc.codex-stg.xyz',                  usdc: '0x6d7f141b6819C2c9CC2f818e6ad549E7Ca090F8f', domain: 12, gasUsd: 3000 },
  Monad_Testnet:     { id: 10143,    name: 'Monad Testnet',     rpc: 'https://testnet-rpc.monad.xyz',              usdc: '0x534b2f3A21130d7a60830c2Df862319e593943A3', domain: 15, gasUsd: 1 },
  // RELIABILITY FIX (Sonic): rpc.testnet.soniclabs.com returns 503 during
  // outages with no fallback here, silently failing every Sonic bridge relay.
  // Added a secondary endpoint matching the client-side chains.ts fallback.
  // Override either endpoint with BRIDGE_RPC_SONIC_TESTNET / BRIDGE_RPC_SONIC_TESTNET_2.
  Sonic_Testnet:     { id: 14601,    name: 'Sonic Testnet',     rpc: process.env.BRIDGE_RPC_SONIC_TESTNET || 'https://rpc.testnet.soniclabs.com', usdc: '0x0BA304580ee7c9a980CF72e55f5Ed2E9fd30Bc51', domain: 13, gasUsd: 0.5 }, // arc-studio-allow-onchain-literal
  World_Chain_Sepolia: { id: 4801,   name: 'World Chain Sepolia', rpc: 'https://worldchain-sepolia.g.alchemy.com/public', usdc: '0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88', domain: 14, gasUsd: 3000 }, // arc-studio-allow-onchain-literal
  Linea_Sepolia:     { id: 59141,    name: 'Linea Sepolia',     rpc: 'https://rpc.sepolia.linea.build',            usdc: '0xFEce4462D57bD51A6A552365A011b95f0E16d9B7', domain: 11, gasUsd: 3000 }, // arc-studio-allow-onchain-literal
  // RELIABILITY FIX (Ink): added second RPC to match client-side chains.ts.
  Ink_Testnet:       { id: 763373,   name: 'Ink Sepolia',       rpc: process.env.BRIDGE_RPC_INK_TESTNET || 'https://rpc-gel-sepolia.inkonchain.com',     usdc: '0xFabab97dCE620294D2B0b0e46C68964e326300Ac', domain: 21, gasUsd: 3000 }, // arc-studio-allow-onchain-literal
  Edge_Testnet:      { id: 33431,    name: 'Edge Testnet',      rpc: process.env.BRIDGE_RPC_EDGE_TESTNET || 'https://edge-testnet.g.alchemy.com/public',   usdc: '0x2d9F7CAD728051AA35Ecdc472a14cf8cDF5CFD6B', domain: 28, gasUsd: 1 }, // arc-studio-allow-onchain-literal
  Injective_Testnet: { id: 1439,     name: 'Injective Testnet', rpc: 'https://k8s.testnet.json-rpc.injective.network', usdc: '0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d', domain: 29, gasUsd: 20 },
}

const ROUTER_ABI = [
  {
    type: 'function', name: 'bridgeWithAuthorization', stateMutability: 'nonpayable',
    inputs: [
      { name: 'b', type: 'tuple', components: [
        { name: 'token', type: 'address' },
        { name: 'destinationDomain', type: 'uint32' }, { name: 'mintRecipient', type: 'bytes32' },
        { name: 'fee', type: 'uint256' }, { name: 'maxFee', type: 'uint256' },
        { name: 'minFinalityThreshold', type: 'uint32' }, { name: 'hookData', type: 'bytes' }, { name: 'salt', type: 'bytes32' },
      ] },
      { name: 'a', type: 'tuple', components: [
        { name: 'from', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' },
        { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' },
      ] },
    ],
    outputs: [{ name: 'nonce', type: 'bytes32' }],
  },
  {
    type: 'function', name: 'bridgeNonce', stateMutability: 'view',
    inputs: [{ name: 'b', type: 'tuple', components: [
      { name: 'token', type: 'address' },
      { name: 'destinationDomain', type: 'uint32' }, { name: 'mintRecipient', type: 'bytes32' },
      { name: 'fee', type: 'uint256' }, { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' }, { name: 'hookData', type: 'bytes' }, { name: 'salt', type: 'bytes32' },
    ] }],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'event', name: 'Bridged', inputs: [
      { name: 'from', type: 'address', indexed: true }, { name: 'nonce', type: 'bytes32', indexed: true },
      { name: 'destinationDomain', type: 'uint32', indexed: false }, { name: 'mintRecipient', type: 'bytes32', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false }, { name: 'fee', type: 'uint256', indexed: false },
      { name: 'maxFee', type: 'uint256', indexed: false },
    ],
  },
] as const

const USDC_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'authorizationState', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'bytes32' }], outputs: [{ type: 'bool' }] },
] as const

const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim()
const SERVICE_KEY  = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
if (!SUPABASE_URL) console.warn('[bridge-relay] SUPABASE_URL is not set - session verification will fail')

const isHex = (v: unknown, bytes?: number): v is `0x${string}` =>
  typeof v === 'string' && (bytes ? new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`) : /^0x([0-9a-fA-F]{2})*$/).test(v)
const isUint = (v: unknown): v is string => typeof v === 'string' && /^\d{1,30}$/.test(v)

function routers(): Record<string, `0x${string}`> {
  try {
    const parsed = JSON.parse(process.env.BRIDGE_ROUTERS || '{}') as Record<string, string>
    const out: Record<string, `0x${string}`> = {}
    for (const [k, v] of Object.entries(parsed)) if (CHAINS[k] && isHex(v, 20)) out[k] = v
    return out
  } catch { return {} }
}

// Session cache: token → { wallet, exp }
// PERF FIX: the original sessionWallet() made two sequential Supabase HTTP
// requests on EVERY call - one to /auth/v1/user and one to /rest/v1/users.
// sessionOwns() called sessionWallet() once per request, so every relay
// (quote, bridge, relayCall) paid those two round-trips. For a fast chain
// like Arc that doubled the perceived latency of every Gateway deposit.
// Cache keyed on the session token with a 5-minute TTL - identical to the
// pattern already in swap-proxy.js. The cache lives per warm Lambda instance
// (resets on cold start); 5 min is safe because a JWT that expires mid-TTL
// still fails the auth/v1/user check at next cache miss.
//
// B-3 FIX: previously _sessionCache.clear() evicted ALL entries when the map
// exceeded 500 entries, resetting every cached session simultaneously and
// forcing a double Supabase round-trip on every subsequent relay until the
// cache refilled. Replaced with LRU: only the oldest entry is evicted, so
// the 499 most-recently-used sessions stay warm.
const _sessionCache = new Map<string, { wallet: string; canSpend: boolean; exp: number }>()
const SESSION_CACHE_TTL_MS = 5 * 60_000
const SESSION_CACHE_MAX = 500

function _evictOldestSession() {
  const firstKey = _sessionCache.keys().next().value
  if (firstKey !== undefined) _sessionCache.delete(firstKey)
}

/** Business accounts can't spend until MeshPort approves them. */
export const ACCOUNT_LOCKED_ERROR = 'Available after your business is approved'

/**
 * The caller's Supabase session: its wallet, and whether the account may
 * spend (public.account_can_spend - false for a business that isn't approved
 * yet, null when it couldn't be checked). Null when not signed in. Only an
 * account that can spend is cached, so an approval/revocation is seen on the
 * next relay rather than after the cache TTL.
 */
async function sessionInfo(req: VercelRequest): Promise<{ wallet: string; canSpend: boolean | null } | null> {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token || !SERVICE_KEY) return null
  const hit = _sessionCache.get(token)
  if (hit && hit.exp > Date.now()) return { wallet: hit.wallet, canSpend: hit.canSpend }
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } })
  if (!r.ok) return null
  const u = await r.json().catch(() => null) as { id?: string } | null
  if (!u?.id) return null
  const [ur, cr] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/users?auth_uid=eq.${u.id}&select=wallet_address`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    }),
    fetch(`${SUPABASE_URL}/rest/v1/rpc/account_can_spend`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_auth_uid: u.id }),
    }).catch(() => null),
  ])
  const rows = ur.ok ? await ur.json().catch(() => []) as Array<{ wallet_address?: string }> : []
  const wallet = rows[0]?.wallet_address ? rows[0].wallet_address.toLowerCase() : null
  const canSpendRaw = cr && cr.ok ? await cr.json().catch(() => null) : null
  const canSpend = typeof canSpendRaw === 'boolean' ? canSpendRaw : null
  if (!wallet) return null
  if (canSpend === true) {
    if (_sessionCache.size >= SESSION_CACHE_MAX) _evictOldestSession()
    _sessionCache.set(token, { wallet, canSpend, exp: Date.now() + SESSION_CACHE_TTL_MS })
  }
  return { wallet, canSpend }
}

/** The wallet of the caller's Supabase session, or null when not signed in. */
async function sessionWallet(req: VercelRequest): Promise<string | null> {
  return (await sessionInfo(req))?.wallet ?? null
}

/** 403/503 for an account that can't spend (business not approved yet); null when it can. */
function spendBlock(canSpend: boolean | null | undefined): { status: number; error: string } | null {
  if (canSpend === true) return null
  if (canSpend === false) return { status: 403, error: ACCOUNT_LOCKED_ERROR }
  return { status: 503, error: 'Could not check your account - please try again' }
}

/** The caller's Supabase session must own `address`. */
async function sessionOwns(req: VercelRequest, address: string): Promise<boolean> {
  return (await sessionWallet(req)) === address.toLowerCase()
}

/** Receipt polling interval: Arc finalizes in under a second. */
function pollMsFor(chainId: number): number {
  return chainId === 5042002 ? 250 : 1000
}

// Lowest priority fee (tip) the relayer offers, per chain id. Ethereum
// Sepolia's RPCs suggest a tip of ~12 wei (its base fee is ~16 wei), but many
// proposers there only include tips of at least 0.001 gwei - so a mint sent
// with the suggested tip waited 1-2 minutes for a proposer that would take
// it, while the median tip in those blocks was ~1 gwei. The floor costs about
// 0.0001 Sepolia ETH per mint.
const MIN_PRIORITY_FEE: Record<number, bigint> = {
  11155111: 500_000_000n, // 0.5 gwei
}

/** EIP-1559 fees for a relayed transaction on a chain with a tip floor: the
 *  RPC's suggested tip raised to the floor, and room for the base fee to
 *  double. Passed explicitly - viem otherwise lets the node fill in the fees
 *  (eth_fillTransaction), which ignores the floor. {} elsewhere. */
async function relayFees(pub: any, chainId: number): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }> {
  const floor = MIN_PRIORITY_FEE[chainId]
  if (!floor) return {}
  let suggested = 0n
  try { suggested = BigInt(await pub.request({ method: 'eth_maxPriorityFeePerGas' })) } catch { /* use the floor */ }
  const tip = suggested > floor ? suggested : floor
  const block = await pub.getBlock()
  const base = BigInt(block.baseFeePerGas ?? 0n)
  return { maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip }
}

async function clients(chainKey: string) {
  const { createPublicClient, createWalletClient, http, defineChain } = await import('viem')
  const c = CHAINS[chainKey]
  const rpc = process.env[`BRIDGE_RPC_${chainKey.toUpperCase()}`] || c.rpc
  // Arc's native currency is USDC, not Ether (18 native decimals on both).
  const nativeCurrency = c.id === 5042002 ? { name: 'USDC', symbol: 'USDC', decimals: 18 } : { name: 'Ether', symbol: 'ETH', decimals: 18 }
  const chain = defineChain({ id: c.id, name: c.name, nativeCurrency, rpcUrls: { default: { http: [rpc] } } })
  // Receipt waits check every 250ms on Arc (sub-second blocks) and every 1s
  // elsewhere - viem's 4s default added seconds to every relayed step.
  const pub: any = createPublicClient({ chain, transport: http(rpc, { timeout: 15_000 }), pollingInterval: pollMsFor(c.id) })
  let key = (process.env.BRIDGE_RELAYER_PRIVATE_KEY || '').trim()
  if (key && !key.startsWith('0x')) key = '0x' + key
  let wallet: any = null
  if (/^0x[0-9a-fA-F]{64}$/.test(key)) {
    const { privateKeyToAccount } = await import('viem/accounts')
    wallet = createWalletClient({ chain, transport: http(rpc, { timeout: 15_000 }), account: privateKeyToAccount(key as `0x${string}`) })
  }
  return { pub, wallet }
}

// ── Relayed calls (action:'call') ──────────────────────────────────────────
// Extra chains a relayed call can run on, beyond CHAINS (public RPCs).
// Arc_Testnet: prefer the env-configured RPC (higher rate limits); fall back
// to Circle's official public endpoints. A single hardcoded endpoint was a
// single point of failure - every Arc-facing relayed call failed when it was
// rate-limited. ARC_RPC_URL is set in Vercel environment variables.
const EXTRA_RPCS: Record<string, string> = {
  // Prefer the env-overridden URL; the public fallback is documented at
  // https://docs.arc.io/arc/references/rpc-endpoints.
  Arc_Testnet:         (process.env.ARC_RPC_URL || process.env.BRIDGE_RPC_ARC_TESTNET || 'https://rpc.testnet.arc.io'), // arc-studio-allow-onchain-literal
  Edge_Testnet:        (process.env.BRIDGE_RPC_EDGE_TESTNET || 'https://edge-testnet.g.alchemy.com/public'), // arc-studio-allow-onchain-literal
  // Injective_Testnet is in CHAINS for bridging but was missing from EXTRA_RPCS,
  // so relayed calls (receiveMessage) failed on that chain.
  Injective_Testnet:   (process.env.BRIDGE_RPC_INJECTIVE_TESTNET || CHAINS.Injective_Testnet?.rpc),
}
// Circle's SDK names a few chains differently from the app.
const CHAIN_ALIASES: Record<string, string> = { Polygon_Amoy_Testnet: 'Polygon_Sepolia' }

// Same address on every testnet chain.
const GATEWAY_WALLET = '0x0077777d7eba4688bdef3e311b846f25870a19b9'
const GATEWAY_MINTER = '0x0022222abe238cc2c7bb1f21003f0a260052475b'
const MESSAGE_TRANSMITTER_V2 = '0xe737e5cebeeba77efe34d4aa090756590b1ce275'

const RELAYABLE_ABI = [
  { type: 'function', name: 'depositWithAuthorization', stateMutability: 'nonpayable', outputs: [], inputs: [
    { name: 'token', type: 'address' }, { name: 'from', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }] },
  { type: 'function', name: 'depositWithAuthorization', stateMutability: 'nonpayable', outputs: [], inputs: [
    { name: 'token', type: 'address' }, { name: 'from', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    { name: 'signature', type: 'bytes' }] },
  { type: 'function', name: 'depositWithPermit', stateMutability: 'nonpayable', outputs: [], inputs: [
    { name: 'token', type: 'address' }, { name: 'owner', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }, { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }] },
  { type: 'function', name: 'depositWithPermit', stateMutability: 'nonpayable', outputs: [], inputs: [
    { name: 'token', type: 'address' }, { name: 'owner', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }, { name: 'signature', type: 'bytes' }] },
  { type: 'function', name: 'transferWithAuthorization', stateMutability: 'nonpayable', outputs: [], inputs: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }] },
  { type: 'function', name: 'gatewayMint', stateMutability: 'nonpayable', outputs: [], inputs: [
    { name: 'attestationPayload', type: 'bytes' }, { name: 'signature', type: 'bytes' }] },
  { type: 'function', name: 'receiveMessage', stateMutability: 'nonpayable', outputs: [{ type: 'bool' }], inputs: [
    { name: 'message', type: 'bytes' }, { name: 'attestation', type: 'bytes' }] },
  { type: 'function', name: 'markPaidFor', stateMutability: 'nonpayable', outputs: [], inputs: [
    { name: 'tradeKey', type: 'bytes32' }, { name: 'signature', type: 'bytes' }] },
  // P2P escrow V3 (auto-accept) - see contracts/P2PMeshportEscrowV3.sol.
  { type: 'function', name: 'registerTrade', stateMutability: 'nonpayable', outputs: [], inputs: [
    { name: 'tradeKey', type: 'bytes32' }, { name: 'offerKey', type: 'bytes32' }, { name: 'buyer', type: 'address' }, { name: 'amount', type: 'uint256' }] },
  { type: 'function', name: 'cancelTradeFor', stateMutability: 'nonpayable', outputs: [], inputs: [
    { name: 'tradeKey', type: 'bytes32' }, { name: 'signature', type: 'bytes' }] },
  { type: 'function', name: 'cancelTrade', stateMutability: 'nonpayable', outputs: [], inputs: [{ name: 'tradeKey', type: 'bytes32' }] },
] as const

const P2P_TRADES_ABI = [{ type: 'function', name: 'trades', stateMutability: 'view', inputs: [{ name: '', type: 'bytes32' }], outputs: [
  { name: 'offerKey', type: 'bytes32' }, { name: 'seller', type: 'address' }, { name: 'buyer', type: 'address' }, { name: 'amount', type: 'uint256' },
  { name: 'state', type: 'uint8' }, { name: 'investigatedApproveRelease', type: 'bool' }, { name: 'frozenBy', type: 'address' },
  { name: 'investigatedBy', type: 'address' }, { name: 'resolvedBy', type: 'address' }, { name: 'buyerPaid', type: 'bool' }, { name: 'registeredAt', type: 'uint64' }] }] as const

function p2pEscrowAddress(): string {
  return (process.env.P2P_ESCROW_CONTRACT || process.env.VITE_P2P_ESCROW_CONTRACT || '').trim().toLowerCase()
}

/**
 * Checks that `to`/`data` is one of the relayable calls. Returns null when it
 * is, or the reason it isn't. A deposit must be the caller's own.
 */
export async function checkRelayable(to: string, data: `0x${string}`, caller: string): Promise<string | null> {
  const { decodeFunctionData } = await import('viem')
  let call: { functionName: string; args: readonly unknown[] }
  try { call = decodeFunctionData({ abi: RELAYABLE_ABI, data }) as any } catch { return 'This call cannot be relayed' }
  const target = to.toLowerCase()
  if (call.functionName === 'depositWithAuthorization' || call.functionName === 'depositWithPermit') {
    if (target !== GATEWAY_WALLET) return 'This call cannot be relayed'
    if (String(call.args[1]).toLowerCase() !== caller) return 'You can only deposit from your own wallet'
    // Dust deposits would let anyone burn relayer gas for free.
    if (BigInt(call.args[2] as bigint) < MIN_TOTAL_UNITS) return 'Amount is below the minimum'
    return null
  }
  // Business refund on the payment's own chain (USDC and payment checked in relayCall).
  if (call.functionName === 'transferWithAuthorization') {
    if (String(call.args[0]).toLowerCase() !== caller) return 'You can only send from your own wallet'
    return null
  }
  if (call.functionName === 'gatewayMint') return target === GATEWAY_MINTER ? null : 'This call cannot be relayed'
  if (call.functionName === 'receiveMessage') return target === MESSAGE_TRANSMITTER_V2 ? null : 'This call cannot be relayed'
  // P2P buyer marking a trade paid (signature checked by the escrow contract).
  if (call.functionName === 'markPaidFor') {
    const escrow = p2pEscrowAddress()
    return escrow && target === escrow ? null : 'This call cannot be relayed'
  }
  // P2P V3 instant order: the relayer (the ad's auto-accept operator)
  // registers a trade, but only for the signed-in buyer's own wallet. The
  // contract checks the amount against the seller's own limits.
  if (call.functionName === 'registerTrade') {
    const escrow = p2pEscrowAddress()
    if (!escrow || target !== escrow) return 'This call cannot be relayed'
    if (String(call.args[2]).toLowerCase() !== caller) return 'You can only order for your own wallet'
    return null
  }
  // Buyer's gas-free cancel: the contract checks the buyer's signature.
  if (call.functionName === 'cancelTradeFor') {
    const escrow = p2pEscrowAddress()
    return escrow && target === escrow ? null : 'This call cannot be relayed'
  }
  // Operator cancel of an unpaid, past-window trade - only when the
  // trade's own seller asks (checked on-chain in relayCall below).
  if (call.functionName === 'cancelTrade') {
    const escrow = p2pEscrowAddress()
    return escrow && target === escrow ? null : 'This call cannot be relayed'
  }
  return 'This call cannot be relayed'
}

// Static chain-id map for every chain reachable by a relayed call -
// combining CHAINS (bridgeable) and EXTRA_RPCS (Arc, Edge, Injective).
// PERF FIX: callClients() used to call probe.getChainId() (a live eth_chainId
// round-trip) on EVERY relayed call - Gateway deposits, gatewayMint, and
// receiveMessage are called once per bridge, and Gateway operations happen
// on chains that poll every few seconds on some pages.  For Arc that extra
// round-trip was going through arc-rpc, eating one of the 3-concurrent-race
// slots; for external chains it added a full 15s-timeout-class request in
// front of the real work.  Chain ids here are the same values already in
// CHAINS (verified) and the known static ids for EXTRA_RPCS chains.
const EXTRA_CHAIN_IDS: Record<string, number> = {
  Arc_Testnet:       5042002,
  Edge_Testnet:      33431, // eth_chainId on Edge's RPC (0x8297); 1116 was Core DAO's id
  Injective_Testnet: 1439,
}

/** Public + relayer wallet client for any chain a relayed call can run on. */
async function callClients(chainKey: string) {
  const { createPublicClient, createWalletClient, http, defineChain } = await import('viem')
  const rpc = process.env[`BRIDGE_RPC_${chainKey.toUpperCase()}`] || CHAINS[chainKey]?.rpc || EXTRA_RPCS[chainKey]
  if (!rpc) return null
  // Use the known static chain id when available - skips a live eth_chainId
  // round-trip (and its 15s timeout class) on every relayed call.
  const knownId = CHAINS[chainKey]?.id ?? EXTRA_CHAIN_IDS[chainKey]
  let id: number
  if (knownId !== undefined) {
    id = knownId
  } else {
    const probe: any = createPublicClient({ transport: http(rpc, { timeout: 15_000 }) })
    id = await probe.getChainId()
  }
  const chain = defineChain({ id, name: chainKey, nativeCurrency: { name: 'Native', symbol: 'NATIVE', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } })
  const pub: any = createPublicClient({ chain, transport: http(rpc, { timeout: 15_000 }), pollingInterval: pollMsFor(id) })
  let key = (process.env.BRIDGE_RELAYER_PRIVATE_KEY || '').trim()
  if (key && !key.startsWith('0x')) key = '0x' + key
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) return { pub, wallet: null as any }
  const { privateKeyToAccount } = await import('viem/accounts')
  const wallet: any = createWalletClient({ chain, transport: http(rpc, { timeout: 15_000 }), account: privateKeyToAccount(key as `0x${string}`) })
  return { pub, wallet }
}

// Per-wallet limit on relayed calls (per warm instance): a real bridge needs
// a handful, so this only stops scripted gas-draining.
//
// B-2 FIX: previously _relayHits.clear() evicted ALL entries when the map
// exceeded 5000, which reset every wallet's rate-limit window simultaneously
// and allowed a coordinated burst immediately after the clear. Replaced with
// LRU: only the oldest wallet entry is evicted so all other limits stay intact.
const _relayHits = new Map<string, number[]>()
const RELAY_HITS_MAX = 5000
function allowRelay(wallet: string): boolean {
  const now = Date.now(), win = 10 * 60_000
  const hits = (_relayHits.get(wallet) || []).filter(t => now - t < win)
  if (hits.length >= 20) return false
  hits.push(now)
  _relayHits.set(wallet, hits)
  if (_relayHits.size > RELAY_HITS_MAX) {
    const firstKey = _relayHits.keys().next().value
    if (firstKey !== undefined) _relayHits.delete(firstKey)
  }
  return true
}

// The GET ?action=quote path is unauthenticated by design (a fee estimate is
// shown before sign-in), but each hit makes a live getGasPrice() + Circle
// IRIS call. Without a limit it can be flooded to exhaust the source-chain RPC
// and Circle's API at no cost, so cap it per client IP (generous for real use,
// cheap to hold). Same LRU eviction as _relayHits.
const _quoteHits = new Map<string, number[]>()
function allowQuote(ip: string): boolean {
  const now = Date.now(), win = 60_000
  const hits = (_quoteHits.get(ip) || []).filter(t => now - t < win)
  if (hits.length >= 30) return false
  hits.push(now)
  _quoteHits.set(ip, hits)
  if (_quoteHits.size > RELAY_HITS_MAX) {
    const firstKey = _quoteHits.keys().next().value
    if (firstKey !== undefined) _quoteHits.delete(firstKey)
  }
  return true
}

// transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)
const TRANSFER_WITH_AUTH_SELECTOR = '0xe3ee160e'

/**
 * A relayed USDC transfer must be a Business refund (null = ok): the chain's
 * USDC, from the merchant to the wallet that paid them on this chain, no more
 * than what is still left on that payment after its earlier refunds.
 */
async function checkRefundTransfer(chainKey: string, to: string, data: `0x${string}`, caller: string, refundFor: any): Promise<string | null> {
  const usdc = CHAINS[chainKey]?.usdc
  if (!usdc || to.toLowerCase() !== usdc.toLowerCase()) return 'Not this chain\'s USDC'
  const { decodeFunctionData } = await import('viem')
  const call = decodeFunctionData({ abi: RELAYABLE_ABI, data }) as any
  const customer = String(call.args[1]).toLowerCase()
  const value = BigInt(call.args[2])
  const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim()
  const svcKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim()
  if (!supabaseUrl || !svcKey) return 'Server misconfigured'
  const get = async (path: string) => {
    const r = await fetch(`${supabaseUrl}/rest/v1/${path}`, { headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` } })
    return r.ok ? ((await r.json().catch(() => [])) as any[]) : null
  }
  const id = String(refundFor?.paymentId || refundFor?.receiptId || '')
  if (!/^[0-9a-f-]{36}$/i.test(id)) return 'Missing payment'
  const isReceipt = !!refundFor?.receiptId
  const rows = await get(isReceipt
    ? `merchant_chain_receipts?id=eq.${id}&select=merchant_wallet,from_address,source_chain,amount&limit=1`
    : `merchant_payments?id=eq.${id}&select=merchant_wallet,from_address,source_chain,amount&limit=1`)
  if (!rows) return 'Could not verify this payment - please try again'
  const p = rows[0]
  if (!p) return 'Unknown payment'
  if (String(p.merchant_wallet).toLowerCase() !== caller) return 'Not your payment'
  if (String(p.from_address).toLowerCase() !== customer) return 'Refunds go back to the wallet that paid'
  if ((CHAIN_ALIASES[p.source_chain] ?? p.source_chain) !== chainKey) return 'Refund on the chain it was paid on'
  if (value <= 0n || value > BigInt(Math.ceil(Number(p.amount) * 1e6))) return 'More than this payment'
  // Several refunds per payment: no more than what is still left on it
  // (all refunds of the same transfer, whichever row they were recorded on).
  const r = await fetch(`${supabaseUrl}/rest/v1/rpc/merchant_refund_remaining`, {
    method: 'POST', headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(isReceipt ? { p_receipt: id } : { p_payment: id }),
  }).catch(() => null)
  const left = r?.ok ? Number(await r.json().catch(() => NaN)) : NaN
  if (!Number.isFinite(left)) return 'Could not verify this payment - please try again'
  if (left < 0.01 - 1e-9) return 'Already refunded'
  if (value > BigInt(Math.ceil(left * 1e6))) return `More than what's left on this payment ($${left.toFixed(2)})`
  return null
}

// cancelTrade(bytes32) - see the seller check in relayCall.
const CANCEL_TRADE_SELECTOR = '0x7cfb41b8'
// registerTrade(bytes32,bytes32,address,uint256) - see checkP2PRegistration.
const REGISTER_TRADE_SELECTOR = '0x74b1edd7'

/** A relayed registerTrade must match a real, open order row (null = ok). */
async function checkP2PRegistration(tradeId: string, data: `0x${string}`, caller: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(tradeId)) return 'Missing order'
  const { decodeFunctionData, keccak256, toBytes, parseUnits } = await import('viem')
  const call = decodeFunctionData({ abi: RELAYABLE_ABI, data }) as any
  if (String(call.args[0]).toLowerCase() !== keccak256(toBytes(tradeId)).toLowerCase()) return 'Order does not match'
  const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim()
  const svcKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim()
  if (!supabaseUrl || !svcKey) return 'Server misconfigured'
  const r = await fetch(`${supabaseUrl}/rest/v1/p2p_trades?id=eq.${tradeId}&select=buyer_wallet,status,amount_usdc,offer:p2p_offers!p2p_trades_offer_id_fkey(auto_accept)&limit=1`,
    { headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` } })
  if (!r.ok) {
    // A failed lookup (e.g. PostgREST 300 "ambiguous relationship") is NOT a missing order.
    console.error('[bridge-relay] p2p_trades lookup failed', r.status, await r.text().catch(() => ''))
    return 'Could not verify this order - please try again'
  }
  const t = ((await r.json().catch(() => [])) as any[])[0]
  if (!t) return 'Unknown order'
  if (String(t.buyer_wallet).toLowerCase() !== caller) return 'You can only order for your own wallet'
  if (t.status !== 'awaiting_seller_confirmation') return 'This order is no longer waiting to start'
  if (!t.offer?.auto_accept) return 'This ad does not start orders instantly'
  // Escrow amounts are native USDC (18 decimals) - see p2pEscrowContract toNativeUnits.
  if (BigInt(call.args[3]) !== parseUnits(String(t.amount_usdc), 18)) return 'Order amount does not match'
  return null
}

// Relayable calls that spend the caller's funds or start a P2P order.
const SPEND_CALLS = new Set(['depositWithAuthorization', 'depositWithPermit', 'transferWithAuthorization', 'registerTrade', 'markPaidFor'])

async function relayCall(req: VercelRequest, res: VercelResponse) {
  const { chain, to, data } = (req.body ?? {}) as any
  const chainKey = CHAIN_ALIASES[chain] ?? String(chain || '')
  if (!isHex(to, 20) || !isHex(data) || data.length < 10) return res.status(400).json({ error: 'Malformed call' })
  const session = await sessionInfo(req)
  const caller = session?.wallet ?? null
  if (!caller) return res.status(403).json({ error: 'Not signed in' })
  if (!allowRelay(caller)) return res.status(429).json({ error: 'Too many requests - try again in a few minutes' })
  const reason = await checkRelayable(to, data, caller)
  if (reason) return res.status(400).json({ error: reason })
  // Calls that move the caller's money or start a P2P order need an account
  // that can spend; finishing an incoming mint or cancelling doesn't.
  const { decodeFunctionData } = await import('viem')
  const fnName = (decodeFunctionData({ abi: RELAYABLE_ABI, data }) as { functionName: string }).functionName
  if (SPEND_CALLS.has(fnName)) {
    const block = spendBlock(session?.canSpend)
    if (block) return res.status(block.status).json({ error: block.error })
  }
  const cl = await callClients(chainKey)
  if (!cl) return res.status(400).json({ error: 'This chain is not supported' })
  if (!cl.wallet) return res.status(503).json({ error: 'Relayer is not configured' })
  if (data.slice(0, 10).toLowerCase() === REGISTER_TRADE_SELECTOR) {
    // Only for a real order: the trade row must exist, be this buyer's, still
    // awaiting registration, on an instant-order ad, for this exact amount.
    const why = await checkP2PRegistration(String((req.body as any)?.p2pTradeId ?? ''), data, caller)
    if (why) return res.status(400).json({ error: why })
  }
  if (data.slice(0, 10).toLowerCase() === TRANSFER_WITH_AUTH_SELECTOR) {
    const why = await checkRefundTransfer(chainKey, to, data, caller, (req.body as any)?.refundFor)
    if (why) return res.status(400).json({ error: why })
  }
  if (data.slice(0, 10).toLowerCase() === CANCEL_TRADE_SELECTOR) {
    // Only the trade's seller may ask the relayer to cancel it.
    try {
      const t = await cl.pub.readContract({ address: to, abi: P2P_TRADES_ABI, functionName: 'trades', args: [`0x${data.slice(10, 74)}`] })
      if (String(t[1]).toLowerCase() !== caller) return res.status(403).json({ error: 'Only the seller can cancel this order' })
    } catch { return res.status(400).json({ error: 'Unknown order' }) }
  }

  // Simulate first: an already-used or invalid signature/attestation never costs gas.
  try { await cl.pub.call({ account: cl.wallet.account, to, data }) }
  catch (e: any) { return res.status(400).json({ error: e?.shortMessage || 'Call would fail' }) }
  const txHash = await cl.wallet.sendTransaction({ to, data, ...(await relayFees(cl.pub, cl.pub.chain.id)) })
  try {
    const receipt = await cl.pub.waitForTransactionReceipt({ hash: txHash, timeout: 40_000 })
    if (receipt.status !== 'success') return res.status(502).json({ error: 'Transaction reverted', txHash })
    return res.status(200).json({ txHash })
  } catch {
    return res.status(200).json({ txHash, pending: true })
  }
}

/** Circle's CCTP fee for a burn of `burn` units to Arc via the forwarder, with margin. */
async function cctpMaxFee(srcDomain: number, burn: bigint): Promise<bigint> {
  const r = await fetch(`${IRIS}/v2/burn/USDC/fees/${srcDomain}/${ARC_DOMAIN}?forward=true`, { signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw new Error('Circle fee service unavailable')
  const rows = await r.json() as Array<{ finalityThreshold: number; minimumFee: number; forwardFee?: number | { low?: number; med?: number; high?: number } }>
  const fast = rows.find(x => x.finalityThreshold === 1000) ?? rows[0]
  if (!fast) throw new Error('No CCTP fee for this route')
  // minimumFee is in basis points (may be fractional); forwardFee in USDC base units.
  const protocol = (burn * BigInt(Math.ceil((fast.minimumFee ?? 0) * 100))) / 1_000_000n
  const ff = fast.forwardFee
  const forward = BigInt(Math.ceil(typeof ff === 'number' ? ff : (ff?.high ?? ff?.med ?? ff?.low ?? 0)))
  return ((protocol + forward) * 120n) / 100n + 1n
}

/** MeshPort's fee: the relayer's gas for the router call, priced in USDC -
 *  what that gas costs, nothing more (no margin, no minimum). */
async function relayFee(pub: any, chainKey: string): Promise<bigint> {
  const gasPrice: bigint = await pub.getGasPrice()
  const nativeUsd = Number(process.env[`BRIDGE_NATIVE_USD_${chainKey.toUpperCase()}`] || CHAINS[chainKey].gasUsd)
  // wei → USDC units: wei * usd / 1e18 * 1e6 = wei * usd / 1e12
  const units = (ROUTER_GAS * gasPrice * BigInt(Math.round(nativeUsd * 100))) / 100n / 1_000_000_000_000n
  // Testnet gas has no real value, but priced at mainnet rates a busy chain
  // (Ethereum Sepolia) came out over 1 USDC - above the app's 5% fee limit,
  // so every quote there was rejected. Capped so the fee stays small: the
  // cap only ever lowers the fee.
  const cap = BigInt(process.env.BRIDGE_MAX_FEE_UNITS || '100000')
  return units > cap ? cap : units
}

async function quote(chainKey: string, total: bigint) {
  const c = CHAINS[chainKey]
  const { pub } = await clients(chainKey)
  const [fee, usdcName, usdcVersion] = await Promise.all([
    relayFee(pub, chainKey),
    pub.readContract({ address: c.usdc, abi: USDC_ABI, functionName: 'name' }) as Promise<string>,
    pub.readContract({ address: c.usdc, abi: USDC_ABI, functionName: 'version' }) as Promise<string>,
  ])
  const maxFee = await cctpMaxFee(c.domain, total > fee ? total - fee : 0n)
  return { fee, maxFee, usdcName, usdcVersion, pub }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  try {
    // ── GET actions ──────────────────────────────────────────────────────
    if (req.method === 'GET') {
      // ── p2p_operator: the relayer's PUBLIC address, which sellers name as
      // their sell ad's auto-accept operator (escrow V3). Address only.
      if (req.query.p2p_operator) {
        let key = (process.env.BRIDGE_RELAYER_PRIVATE_KEY || '').trim()
        if (key && !key.startsWith('0x')) key = '0x' + key
        if (!/^0x[0-9a-fA-F]{64}$/.test(key)) return res.status(503).json({ error: 'Relayer is not configured' })
        const { privateKeyToAccount } = await import('viem/accounts')
        res.setHeader('Cache-Control', 'public, max-age=300')
        return res.status(200).json({ operator: privateKeyToAccount(key as `0x${string}`).address })
      }
      // ── ub_intent_status: replaces supabase.from('ub_claim_intents') in client ──
      // MultichainPage used to hit Supabase directly with the anon key just to
      // read intent status. This action proxies that read through the service key
      // on the server side so the client never needs Supabase for this.
      if (req.query.ub_intent_status) {
        const intentId = String(req.query.ub_intent_status)
        if (!/^[0-9a-f-]{36}$/.test(intentId)) return res.status(400).json({ error: 'invalid id' })
        const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim()
        const svcKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim()
        if (!supabaseUrl || !svcKey) return res.status(500).json({ error: 'server misconfigured' })
        const r = await fetch(
          `${supabaseUrl}/rest/v1/ub_claim_intents?id=eq.${intentId}&select=status&limit=1`,
          { headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` } }
        )
        const rows = await r.json().catch(() => [])
        return res.status(200).json({ status: (rows as any[])[0]?.status ?? null })
      }

      // ── ub_pending_recoveries: replaces supabase.from('activity') in cctpRecovery ──
      if (req.query.ub_pending_recoveries) {
        const wallet = String(req.query.ub_pending_recoveries)
        if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return res.status(400).json({ error: 'invalid wallet' })
        const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim()
        const svcKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim()
        if (!supabaseUrl || !svcKey) return res.status(500).json({ error: 'server misconfigured' })
        const r = await fetch(
          `${supabaseUrl}/rest/v1/activity?activity_type=eq.withdraw&status=eq.pending&wallet_address=ilike.${wallet}&select=id,amount,created_at,metadata&order=created_at.desc&limit=20`,
          { headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` } }
        )
        const rows = await r.json().catch(() => [])
        return res.status(200).json((rows as any[])
          .filter((r: any) => r.metadata?.ub_recovery === true)
          .map((r: any) => ({
            id: r.id,
            amount: Number(r.amount),
            createdAt: r.created_at,
            // initiateUbFundRecovery stores this as eligible_at (ready_at never existed).
            readyAt: r.metadata?.eligible_at ?? r.metadata?.ready_at ?? '',
          }))
        )
      }

      // ── tx_is_merchant_payment: replaces supabase.from('merchant_payments') in notifications ──
      if (req.query.tx_is_merchant_payment) {
        const txHash = String(req.query.tx_is_merchant_payment).toLowerCase()
        if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return res.status(200).json({ found: false })
        const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim()
        const svcKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim()
        if (!supabaseUrl || !svcKey) return res.status(200).json({ found: false })
        const r = await fetch(
          `${supabaseUrl}/rest/v1/merchant_payments?tx_hash=eq.${txHash}&select=id&limit=1`,
          { headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` } }
        )
        const rows = await r.json().catch(() => [])
        return res.status(200).json({ found: Array.isArray(rows) && rows.length > 0 })
      }

      // ── Quote ────────────────────────────────────────────────────────────
      const quoteIp = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown'
      if (!allowQuote(quoteIp)) return res.status(429).json({ error: 'Too many requests - try again shortly' })
      const chainKey = String(req.query.chain || '')
      const total = String(req.query.amount || '')
      if (!CHAINS[chainKey] || !routers()[chainKey]) return res.status(400).json({ error: 'Gasless bridging is not available for this chain' })
      if (!isUint(total) || BigInt(total) < MIN_TOTAL_UNITS) return res.status(400).json({ error: 'Minimum is 1 USDC' })
      const q = await quote(chainKey, BigInt(total))
      return res.status(200).json({ fee: q.fee.toString(), maxFee: q.maxFee.toString(), usdcName: q.usdcName, usdcVersion: q.usdcVersion })
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    // ── claim_recovery_scan: replaces supabase.functions.invoke('claim-recovery-scan') ──
    // AppLayout and SwapPage used to call the Supabase Edge Function directly
    // from the browser. Routing through bridge-relay keeps all Supabase
    // service-key usage server-side and avoids exposing the anon key to the
    // Edge Function's JWT check (which was accepting the anon key as auth,
    // making the scan triggerable by anyone who read the anon key from the
    // bundle). The actual work is still done by the Supabase Edge Function;
    // this is just a server-side proxy that adds real authentication.
    if ((req.body as any)?.action === 'claim_recovery_scan') {
      const wallet = sessionOwns ? await sessionWallet(req) : null
      if (!wallet) return res.status(401).json({ error: 'Not authenticated' })
      const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim()
      const svcKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim()
      if (!supabaseUrl || !svcKey) return res.status(500).json({ error: 'server misconfigured' })
      const r = await fetch(`${supabaseUrl}/functions/v1/claim-recovery-scan`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${svcKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: wallet }),
      })
      const out = await r.json().catch(() => ({}))
      return res.status(r.ok ? 200 : r.status).json(out)
    }

    // ── kick_claim_worker: replaces supabase.functions.invoke('claim-worker') ──
    if ((req.body as any)?.action === 'kick_claim_worker') {
      const { claimId } = (req.body ?? {}) as any
      if (typeof claimId !== 'string' || !/^[0-9a-f-]{36}$/.test(claimId)) return res.status(400).json({ error: 'invalid claimId' })
      const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim()
      const svcKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim()
      if (!supabaseUrl || !svcKey) return res.status(500).json({ error: 'server misconfigured' })
      const r = await fetch(`${supabaseUrl}/functions/v1/claim-worker`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${svcKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'single', claimId }),
      })
      const out = await r.json().catch(() => ({}))
      return res.status(r.ok ? 200 : r.status).json(out)
    }

    if ((req.body as any)?.action === 'call') return await relayCall(req, res)

    // ── Relay ────────────────────────────────────────────────────────────
    const { chain: chainKey, bridge: b, authorization: a } = (req.body ?? {}) as any
    const router = routers()[chainKey]
    if (!CHAINS[chainKey] || !router) return res.status(400).json({ error: 'Gasless bridging is not available for this chain' })
    if (!b || !a) return res.status(400).json({ error: 'Missing bridge or authorization' })
    if (!isHex(a.from, 20) || !isUint(a.value) || !isUint(a.validAfter) || !isUint(a.validBefore) || !isHex(a.signature, 65))
      return res.status(400).json({ error: 'Malformed authorization' })
    if (!isHex(b.token, 20) || !isHex(b.mintRecipient, 32) || !isUint(b.fee) || !isUint(b.maxFee) || !isHex(b.salt, 32) || !isHex(b.hookData))
      return res.status(400).json({ error: 'Malformed bridge parameters' })
    if (String(b.token).toLowerCase() !== CHAINS[chainKey].usdc.toLowerCase()) return res.status(400).json({ error: 'Only USDC can be bridged' })

    // Only self-bridges to Arc through Circle's forwarder.
    const { pad, parseSignature } = await import('viem')
    if (Number(b.destinationDomain) !== ARC_DOMAIN) return res.status(400).json({ error: 'Only bridging to Arc is supported' })
    if (String(b.hookData).toLowerCase() !== FORWARD_HOOK) return res.status(400).json({ error: 'Forwarding hook required' })
    if (![1000, 2000].includes(Number(b.minFinalityThreshold))) return res.status(400).json({ error: 'Unsupported finality' })
    if (String(b.mintRecipient).toLowerCase() !== String(pad(a.from, { size: 32 })).toLowerCase())
      return res.status(400).json({ error: 'Funds can only be bridged to your own wallet' })
    const now = Math.floor(Date.now() / 1000)
    const vb = Number(a.validBefore)
    if (vb <= now + 30 || vb > now + MAX_AUTH_WINDOW_SEC) return res.status(400).json({ error: 'Authorization window is invalid or expired' })
    const value = BigInt(a.value), fee = BigInt(b.fee), maxFee = BigInt(b.maxFee)
    if (value < MIN_TOTAL_UNITS) return res.status(400).json({ error: 'Minimum is 1 USDC' })

    const session = await sessionInfo(req)
    if (!session || session.wallet !== String(a.from).toLowerCase()) return res.status(403).json({ error: 'Not signed in to this wallet' })
    const block = spendBlock(session.canSpend)
    if (block) return res.status(block.status).json({ error: block.error })

    const c = CHAINS[chainKey]
    const { pub, wallet } = await clients(chainKey)
    if (!wallet) return res.status(503).json({ error: 'Relayer is not configured' })

    const bridgeArgs = {
      token: c.usdc,
      destinationDomain: ARC_DOMAIN, mintRecipient: b.mintRecipient as `0x${string}`, fee, maxFee,
      minFinalityThreshold: Number(b.minFinalityThreshold), hookData: FORWARD_HOOK as `0x${string}`, salt: b.salt as `0x${string}`,
    }
    const nonce = await pub.readContract({ address: router, abi: ROUTER_ABI, functionName: 'bridgeNonce', args: [bridgeArgs] }) as `0x${string}`

    // The three pre-checks are independent reads - fetched together (they used
    // to be three round trips in a row) and then checked in the same order.
    const [used, now_q, bal] = await Promise.all([
      pub.readContract({ address: c.usdc, abi: USDC_ABI, functionName: 'authorizationState', args: [a.from, nonce] }),
      quote(chainKey, value),
      pub.readContract({ address: c.usdc, abi: USDC_ABI, functionName: 'balanceOf', args: [a.from] }) as Promise<bigint>,
    ])
    // Already used → return the transaction that used it (safe retries).
    if (used) {
      const logs = await pub.getContractEvents({ address: router, abi: ROUTER_ABI, eventName: 'Bridged', args: { from: a.from, nonce }, fromBlock: 'earliest' }).catch(() => [])
      const hit = (logs as any[])[0]
      return hit ? res.status(200).json({ txHash: hit.transactionHash, alreadySubmitted: true })
        : res.status(409).json({ error: 'This authorization was already used' })
    }

    // The fee must still cover the relayer's gas (some slack for price moves since the quote).
    if (fee * 100n < now_q.fee * 80n) return res.status(400).json({ error: 'Fee too low - please try again' })
    if (maxFee * 100n < now_q.maxFee * 80n) return res.status(400).json({ error: 'Bridge fee too low - please try again' })

    if (bal < value) return res.status(400).json({ error: 'Not enough USDC on this chain' })

    const sig = parseSignature(a.signature)
    const v = sig.v !== undefined ? Number(sig.v) : 27 + (sig.yParity ?? 0)
    const authArgs = { from: a.from, value, validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), v, r: sig.r, s: sig.s }

    // Simulate first: a bad signature or changed parameter never costs gas.
    const { request } = await pub.simulateContract({
      account: wallet.account, address: router, abi: ROUTER_ABI, functionName: 'bridgeWithAuthorization', args: [bridgeArgs, authArgs],
    }).catch((e: any) => { throw Object.assign(new Error(e?.shortMessage || 'Transfer would fail'), { status: 400 }) })
    const txHash = await wallet.writeContract({ ...request, ...(await relayFees(pub, pub.chain.id)) })

    // Wait briefly for the burn; if it's slow, it's submitted (not failed) - tracking takes over.
    try {
      const receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 40_000 })
      if (receipt.status !== 'success') return res.status(502).json({ error: 'Transaction reverted', txHash })
      return res.status(200).json({ txHash })
    } catch {
      return res.status(200).json({ txHash, pending: true })
    }
  } catch (e: any) {
    console.error('[bridge-relay]', e?.message || e)
    return res.status(e?.status || 500).json({ error: e?.status ? e.message : 'Relayer error' })
  }
}
