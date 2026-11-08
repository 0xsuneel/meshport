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
//        Checks the request, simulates MeshPortRouter.bridgeWithAuthorization,
//        submits it with the relayer key (paying source-chain gas) and returns
//        { txHash } - the CCTP burn. Idempotent: an authorization that was
//        already used returns the transaction that used it.
//
//   GET  ?action=token_quote / POST { action:'token_relay' }
//        The same for EURC and cirBTC over Circle CCTPx, through the same
//        MeshPortRouter - see the block above the handler.
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
// The router (contracts/MeshPortRouter.sol) makes the relayer unable to
// change anything the user signed; this endpoint additionally only relays
// self-bridges to Arc through Circle's forwarder, for signed-in users, at a
// fee that covers its gas.
//
// Env:
//   BRIDGE_RELAYER_PRIVATE_KEY  relayer key (pays gas; never holds user funds)
//   RELAYER_MODE=circle         sign with MeshPort's Circle developer-controlled
//                               wallet instead (api/_lib/relayerSigner.ts):
//                               CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET,
//                               CIRCLE_RELAYER_WALLET_ID, CIRCLE_RELAYER_ADDRESS.
//                               The key above then only covers chains Circle
//                               can't sign on and pre-switch P2P operator offers.
//   BRIDGE_ROUTERS              {"Base_Sepolia":"0x…","Ethereum_Sepolia":"0x…"}
//   BRIDGE_RPC_<CHAIN>          optional RPC override per chain
//   BRIDGE_NATIVE_USD_<CHAIN>   optional gas-token USD price per chain (defaults in CHAINS)
//   BRIDGE_MAX_FEE_UNITS        optional fee cap in USDC base units (default 100000 = 0.10)
//   SUPABASE_URL, SUPABASE_SERVICE_KEY  session → wallet ownership check

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { EXTERNAL_CHAINS } from '../src/blockchain/chains'
import { relayerAccount, relayerAddress, keyRelayerAccount, relayerMode } from './_lib/relayerSigner'
import { CROSS_CHAIN_FEE, usdRule, meshportFee, feeAcceptable, arcWeiToUsdcUnits } from '../src/lib/feePolicy'
import { waitUntil } from '@vercel/functions'
import { hedgedTransport } from './_lib/hedgedTransport'

const ARC_DOMAIN = 26
const FORWARD_HOOK = '0x636374702d666f72776172640000000000000000000000000000000000000000'
// MeshPort is testnet-only, and testnet burns/fees exist only in Circle's
// SANDBOX Iris - so sandbox is the default. IRIS_ENV=production opts in to the
// production Iris (mainnet build). With production here, a deployment that
// never set IRIS_ENV capped maxFee from MAINNET fee tables (e.g. 0.325 bps vs
// the sandbox's 1.3 bps from Base Sepolia). A cap under what the sandbox
// requires is held as insufficient_fee until standard finality (15+ min)
// instead of the fast ~10 s.
const IRIS = (process.env.IRIS_ENV || '') === 'production'
  ? 'https://iris-api.circle.com'
  : 'https://iris-api-sandbox.circle.com'
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

/** Receipt polling interval: Arc finalizes in under a second. */
function pollMsFor(chainId: number): number {
  return chainId === 5042002 ? 250 : 1000
}

// Lowest priority fee (tip) the relayer offers, per chain id. Ethereum
// Sepolia's RPCs suggest a tip of ~12 wei (its base fee is ~16 wei), but many
// proposers there only include tips of at least 0.001 gwei - so a mint sent
// with the suggested tip waited 1-2 minutes for a proposer that would take
// it, while the median tip in those blocks was ~1 gwei. 0.5 gwei (below that
// median) still left Arc → Ethereum mints waiting 40 s or more for a builder
// (transfers there took 57-162 s on 2026-10-31, the mint step most of it), so
// the floor is above the median: about 0.0006 Sepolia ETH per mint.
const MIN_PRIORITY_FEE: Record<number, bigint> = {
  11155111: 2_000_000_000n, // 2 gwei
}

/** EIP-1559 fees for a relayed transaction on a chain with a tip floor: the
 *  RPC's suggested tip raised to the floor, and room for the base fee to
 *  double. Passed explicitly - viem otherwise lets the node fill in the fees
 *  (eth_fillTransaction), which ignores the floor. {} elsewhere. */
async function relayFees(pub: any, chainId: number, boost = false): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }> {
  const floor = MIN_PRIORITY_FEE[chainId]
  if (!floor) return {}
  let suggested = 0n
  try { suggested = BigInt(await pub.request({ method: 'eth_maxPriorityFeePerGas' })) } catch { /* use the floor */ }
  let tip = suggested > floor ? suggested : floor
  // boost: a transfer's mint, where a missed block is 12 s the user waits -
  // 1.5x the tip so it's near the front of the next block.
  if (boost) tip = tip * 3n / 2n
  const block = await pub.getBlock()
  const base = BigInt(block.baseFeePerGas ?? 0n)
  return { maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip }
}

/**
 * The chain's RPCs in order - the env override (and a _2 one), this file's
 * primary, then the app's own registry (src/blockchain/chains, the same list
 * the app reads balances with). Every relay client used ONE RPC with a 15 s
 * timeout: when that node was slow or down, quotes waited and submissions
 * failed although another node for the chain worked.
 */
export function rpcListFor(chainKey: string, primary: string | undefined): string[] {
  const env = (k: string) => (process.env[k] || '').trim()
  const K = `BRIDGE_RPC_${chainKey.toUpperCase()}`
  return [...new Set([env(K), env(`${K}_2`), primary ?? '', ...(EXTERNAL_CHAINS[chainKey]?.rpcs ?? [])].filter(Boolean))]
}
/**
 * A transport that answers eth_fillTransaction with "method not found", so
 * viem fills gas, fees and nonce itself (estimateGas, estimateFeesPerGas,
 * getTransactionCount - its fallback for nodes without that method).
 * viem 2.5x asks the node to fill any field the caller didn't give; Avalanche
 * Fuji's node filled a Bring's router call with gas 11,445,952,253,021,861 and
 * a 204 wei fee cap, and every node refused it ("Missing or invalid
 * parameters", field 1 Nov 15:36 / 15:37 - Bring from Avalanche failed twice).
 */
export function withoutNodeFill<T extends (...a: any[]) => any>(base: T): T {
  return ((config: any) => {
    const t = base(config)
    return {
      ...t,
      request: async (args: any, opts?: any) => {
        if (args?.method === 'eth_fillTransaction') {
          throw Object.assign(new Error('eth_fillTransaction is not available'), { code: -32601 })
        }
        return t.request(args, opts)
      },
    }
  }) as T
}

/** One RPC: as before. Several: viem's fallback - the next one when a call fails or times out. */
async function rpcTransport(chainKey: string, primary: string) {
  const { http, fallback } = await import('viem')
  const list = rpcListFor(chainKey, primary)
  if (list.length < 2) return withoutNodeFill(http(list[0] ?? primary, { timeout: 15_000 }))
  // Reads race the next RPC after 1.2 s without an answer; sends go in order.
  return withoutNodeFill(hedgedTransport(http, fallback, list))
}

// One relayer send at a time per chain in this instance (audit 7 Nov H9):
// two requests reading the same pending nonce made one of them fail after a
// Circle signing round trip. A send that still loses its nonce (another
// instance got there first) is tried once more with a fresh one.
const sendQueues = new Map<string, Promise<unknown>>()
const NONCE_LOST = /nonce too low|replacement transaction underpriced|nonce has already been used/i // never 'already known': that one may be our own send arriving twice
export function serialSends<W extends { sendTransaction: (a: any) => Promise<any>; writeContract?: (a: any) => Promise<any> } | null>(chainKey: string, wallet: W): W {
  if (!wallet || (wallet as any).__serial) return wallet
  const wrap = (orig: (a: any) => Promise<any>) => (args: any) => {
    const run = async () => {
      try { return await orig(args) } catch (e: any) {
        if (!NONCE_LOST.test(String(e?.shortMessage || e?.message || e))) throw e
        const { nonce: _stale, ...fresh } = args ?? {}
        return await orig(fresh)
      }
    }
    const prev = sendQueues.get(chainKey) ?? Promise.resolve()
    const p = prev.then(run, run)
    sendQueues.set(chainKey, p.catch(() => {}))
    return p
  }
  const w: any = wallet
  w.sendTransaction = wrap(w.sendTransaction.bind(w))
  if (typeof w.writeContract === 'function') w.writeContract = wrap(w.writeContract.bind(w))
  w.__serial = true
  return wallet
}

async function clients(chainKey: string) {
  const { createPublicClient, createWalletClient, defineChain } = await import('viem')
  const c = CHAINS[chainKey]
  const rpc = process.env[`BRIDGE_RPC_${chainKey.toUpperCase()}`] || c.rpc
  // Arc's native currency is USDC, not Ether (18 native decimals on both).
  const nativeCurrency = c.id === 5042002 ? { name: 'USDC', symbol: 'USDC', decimals: 18 } : { name: 'Ether', symbol: 'ETH', decimals: 18 }
  const chain = defineChain({ id: c.id, name: c.name, nativeCurrency, rpcUrls: { default: { http: [rpc] } } })
  // Receipt waits check every 250ms on Arc (sub-second blocks) and every 1s
  // elsewhere - viem's 4s default added seconds to every relayed step.
  // A resend of the same signed bytes to the next node is harmless ("already
  // known"); the relay's replay checks (used nonce / TokenBridged) answer a
  // repeated request with the transaction already sent.
  const transport = await rpcTransport(chainKey, rpc)
  const pub: any = createPublicClient({ chain, transport, pollingInterval: pollMsFor(c.id) })
  // The relayer account: Circle's wallet (RELAYER_MODE=circle) or the private key.
  const account = await relayerAccount(c.id)
  const wallet: any = serialSends(chainKey, account ? createWalletClient({ chain, transport, account }) : null)
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
// ── Transfer FROM Arc through MeshPortRouter (one signature) ───────────────
// The app's Transfer USDC: the wallet signs ONE EIP-3009 authorization for
// the exact amount + fee to the Arc router (ARC_ROUTER, contracts/
// MeshPortRouter.sol); this relayer submits bridgeWithAuthorization, which in
// one transaction pulls exactly that, pays MeshPort's fee, approves exactly
// the amount to Circle's TokenMessengerV2 and burns it to the recipient. No
// approval is left behind, and the user's wallet signs no transaction.
//   - the router binds every parameter into the authorization's nonce, so
//     nothing here can change the recipient, chain or fees;
//   - only the signed-in wallet's own authorization, USDC, a known CCTP
//     destination, no hook or Circle's forwarding hook;
//   - the fee must cover this relayer's gas (simulated first - a bad
//     signature or a changed parameter never costs gas).
export function arcTransferDomains(): Set<number> {
  return new Set(Object.values(CHAINS).map(c => c.domain).filter(d => d !== ARC_DOMAIN))
}
function arcRouter(): `0x${string}` | null {
  const r = (process.env.ARC_ROUTER || '').trim()
  return /^0x[0-9a-fA-F]{40}$/.test(r) ? r as `0x${string}` : null
}
const ARC_USDC_ERC20 = '0x3600000000000000000000000000000000000000' as const

// ── Which mints the relayer pays for (audit 7 Nov H2) ───────────────────────
// A CCTP V2 message: 148-byte header (version, sourceDomain, destinationDomain,
// nonce, sender, recipient, destinationCaller, two thresholds), then the burn
// body (version, burnToken, mintRecipient, amount, messageSender, ...).
export function cctpMessageParts(message: string): { destinationDomain: number; mintRecipient: string; messageSender: string } | null {
  if (!isHex(message) || message.length < 2 + 280 * 2) return null
  const b = message.slice(2)
  const word = (byteOffset: number) => b.slice(byteOffset * 2, byteOffset * 2 + 64)
  return {
    destinationDomain: parseInt(b.slice(16, 24), 16),
    mintRecipient: '0x' + word(184).slice(24),
    messageSender: '0x' + word(248).slice(24),
  }
}
/**
 * Null when the relayer may pay the gas to mint `message` for `caller`, else
 * why not. On Arc any attested message (a Bring; Arc gas is ~$0.005). Elsewhere
 * only burns MeshPort is paid for or that are the caller's own: from a
 * MeshPort router or the caller's wallet - not any
 * attested message (the relayer's destination gas, ~$0.0006+ on Ethereum).
 */
export async function mintRefusal(chainKey: string, message: string, caller: string): Promise<string | null> {
  if (chainKey === 'Arc_Testnet') return null
  const m = cctpMessageParts(message)
  if (!m) return 'Not a CCTP message'
  const sender = m.messageSender.toLowerCase()
  const known = new Set([...Object.values(routers()), arcRouter() ?? ''].map(a => a.toLowerCase()).filter(Boolean))
  if (known.has(sender) || sender === caller.toLowerCase()) return null
  return 'This transfer was not sent through MeshPort'
}

async function arcTransfer(req: VercelRequest, res: VercelResponse) {
  const router = arcRouter()
  if (!router) return res.status(400).json({ error: 'One-signature transfers are not set up on Arc' })
  const { bridge: b, authorization: a } = (req.body ?? {}) as any
  if (!b || !a) return res.status(400).json({ error: 'Missing bridge or authorization' })
  if (!isHex(a.from, 20) || !isUint(a.value) || !isUint(a.validAfter) || !isUint(a.validBefore) || !isHex(a.signature, 65))
    return res.status(400).json({ error: 'Malformed authorization' })
  if (!isHex(b.token, 20) || !isHex(b.mintRecipient, 32) || !isUint(b.fee) || !isUint(b.maxFee) || !isHex(b.salt, 32) || !isHex(b.hookData))
    return res.status(400).json({ error: 'Malformed bridge parameters' })
  if (String(b.token).toLowerCase() !== ARC_USDC_ERC20) return res.status(400).json({ error: 'Only USDC can be sent this way' })
  if (!arcTransferDomains().has(Number(b.destinationDomain))) return res.status(400).json({ error: 'Unsupported destination' })
  const hook = String(b.hookData).toLowerCase()
  if (hook !== '0x' && hook !== FORWARD_HOOK) return res.status(400).json({ error: 'Unsupported hook' })
  if (![1000, 2000].includes(Number(b.minFinalityThreshold))) return res.status(400).json({ error: 'Unsupported finality' })
  if (/^0x0{64}$/i.test(String(b.mintRecipient))) return res.status(400).json({ error: 'Missing recipient' })
  const now = Math.floor(Date.now() / 1000)
  const vb = Number(a.validBefore)
  if (vb <= now + 30 || vb > now + MAX_AUTH_WINDOW_SEC) return res.status(400).json({ error: 'Authorization window is invalid or expired' })
  const value = BigInt(a.value), fee = BigInt(b.fee), maxFee = BigInt(b.maxFee)
  if (value < MIN_TOTAL_UNITS) return res.status(400).json({ error: 'Minimum is 1 USDC' })

  const session = await sessionInfo(req)
  if (!session || session.wallet !== String(a.from).toLowerCase()) return res.status(403).json({ error: 'Not signed in to this wallet' })
  const block = spendBlock(session.canSpend)
  if (block) return res.status(block.status).json({ error: block.error })
  if (!allowRelay(session.wallet)) return res.status(429).json({ error: 'Too many requests - try again in a few minutes' })

  const cl = await callClients('Arc_Testnet')
  if (!cl) return res.status(400).json({ error: 'Arc is not configured' })
  if (!cl.wallet) return res.status(503).json({ error: 'Relayer is not configured' })
  const { pub, wallet } = cl
  const bridgeArgs = {
    token: ARC_USDC_ERC20 as `0x${string}`, destinationDomain: Number(b.destinationDomain), mintRecipient: b.mintRecipient as `0x${string}`,
    fee, maxFee, minFinalityThreshold: Number(b.minFinalityThreshold), hookData: (hook === '0x' ? '0x' : FORWARD_HOOK) as `0x${string}`, salt: b.salt as `0x${string}`,
  }
  const nonce = await pub.readContract({ address: router, abi: ROUTER_ABI, functionName: 'bridgeNonce', args: [bridgeArgs] }) as `0x${string}`
  const used = await pub.readContract({ address: ARC_USDC_ERC20, abi: USDC_ABI, functionName: 'authorizationState', args: [a.from, nonce] })
  // Already used → the transaction that used it (safe retries).
  if (used) {
    const hit = await findBridged(pub, router, a.from, nonce)
    return hit ? res.status(200).json({ txHash: hit, alreadySubmitted: true })
      : res.status(409).json({ error: 'This transfer was already sent', alreadySubmitted: true })
  }

  const { parseSignature } = await import('viem')
  const sig = parseSignature(a.signature)
  const v = sig.v !== undefined ? Number(sig.v) : 27 + (sig.yParity ?? 0)
  const authArgs = { from: a.from, value, validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), v, r: sig.r, s: sig.s }

  // Simulate first: a bad signature, too little USDC or a changed parameter never costs gas.
  const { request } = await pub.simulateContract({
    account: wallet.account, address: router, abi: ROUTER_ABI, functionName: 'bridgeWithAuthorization', args: [bridgeArgs, authArgs],
  }).catch((e: any) => { throw Object.assign(new Error(e?.shortMessage || 'Transfer would fail'), { status: 400 }) })
  // The fee pays this transaction's gas (Arc gas is USDC: wei / 1e12 = 6-decimal units).
  const [gas, gasPrice] = await Promise.all([
    pub.estimateContractGas({ account: wallet.account, address: router, abi: ROUTER_ABI, functionName: 'bridgeWithAuthorization', args: [bridgeArgs, authArgs] }) as Promise<bigint>,
    pub.getGasPrice() as Promise<bigint>,
  ])
  // No hook = MeshPort's relayer mints on the destination: its gas there is
  // part of the fee too (transfer_mint quotes the same number to the app).
  const destKey = hook === '0x' ? chainKeyForDomain(Number(b.destinationDomain)) : null
  const destGas = destKey ? await destMintGasCost(destKey).catch(() => 0n) : 0n
  const gasUnits = arcWeiToUsdcUnits(gas * gasPrice) + destGas
  const required = meshportFee(value - fee, gasUnits, usdRule(CROSS_CHAIN_FEE, 6))
  if (!feeAcceptable(fee, required, gasUnits)) return res.status(400).json({ error: 'Fee too low - please try again' })

  const txHash = await wallet.writeContract({ ...request, ...(await relayFees(pub, pub.chain.id)) })
  try {
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 40_000 })
    if (receipt.status !== 'success') return res.status(502).json({ error: 'Transaction reverted', txHash })
    return res.status(200).json({ txHash })
  } catch {
    return res.status(200).json({ txHash, pending: true })
  }
}

/**
 * The router transaction that used an authorization (a retry after a lost
 * answer). Public nodes often refuse a log search from block 0, and the
 * authorization can only have been used inside its window, so the recent
 * blocks are searched when the full search is refused (audit 7 Nov H7).
 */
async function findBridged(pub: any, router: `0x${string}`, from: `0x${string}`, nonce: `0x${string}`): Promise<string | null> {
  const find = (fromBlock: bigint | 'earliest') => pub.getContractEvents({ address: router, abi: ROUTER_ABI, eventName: 'Bridged', args: { from, nonce }, fromBlock }) as Promise<any[]>
  let logs: any[] = await find('earliest').catch(() => [])
  if (!logs.length) {
    const head = await pub.getBlockNumber().catch(() => null) as bigint | null
    if (head !== null) logs = await find(head > 9_000n ? head - 9_000n : 0n).catch(() => [])
  }
  return logs[0]?.transactionHash ?? null
}

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
  const transport = await rpcTransport(chainKey, rpc)
  const pub: any = createPublicClient({ chain, transport, pollingInterval: pollMsFor(id) })
  const account = await relayerAccount(id)
  if (!account) return { pub, wallet: null as any, keyWallet: null as any }
  const wallet: any = serialSends(chainKey, createWalletClient({ chain, transport, account }))
  // Circle mode: the private-key wallet too, when set and different - P2P
  // offers made before the switch name the OLD relayer address as operator.
  const key = relayerMode() === 'circle' ? await keyRelayerAccount() : null
  const keyWallet: any = key && key.address.toLowerCase() !== account.address.toLowerCase()
    ? serialSends(`${chainKey}:key`, createWalletClient({ chain, transport, account: key })) : null
  return { pub, wallet, keyWallet }
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
const RECEIVE_MESSAGE_SELECTOR = '0x57ecfd28' // receiveMessage(bytes,bytes)
// Separate budgets per kind of request (7 Nov: the background claim scans
// and the mints shared the 20 sends' budget, so after a burst of moves a
// transfer's mint was refused and the transfer sat waiting). allowRelay:
// requests that make the relayer SEND something it pays for.
const _bucketHits = new Map<string, number[]>()
function allowAction(bucket: 'mint' | 'scan', wallet: string): boolean {
  const max = bucket === 'mint' ? 60 : 30
  const key = `${bucket}:${wallet}`, now = Date.now(), win = 10 * 60_000
  const hits = (_bucketHits.get(key) || []).filter(t => now - t < win)
  if (hits.length >= max) return false
  hits.push(now)
  _bucketHits.set(key, hits)
  if (_bucketHits.size > RELAY_HITS_MAX) { const k = _bucketHits.keys().next().value; if (k !== undefined) _bucketHits.delete(k) }
  return true
}
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

// ── Relay timing ─────────────────────────────────────────────────────────────
// One line per relayed call (mints: receiveMessage, gatewayMint; deposits;
// refunds), in Vercel's log and in the response (`timing`, which the app
// stores with its own wait times - lib/relayTiming): where a destination mint
// spends its time. Field 2 Nov: Arc → Ethereum mints by this relayer took
// 6-26 s and nothing recorded whether that was our checks, the RPC, or
// blocks. `blocks` = blocks from the head we saw before sending to the one it
// landed in (1 = the next block). Durations and block numbers only - no
// addresses or amounts.
const instanceStartedAt = Date.now()
let relayCallsServed = 0
interface RelayTiming {
  fn: string; chain: string; cold: boolean
  checksMs: number; simulateMs?: number; sendMs?: number; receiptMs?: number; totalMs: number
  headBlock?: number; minedBlock?: number; blocks?: number; tipGwei?: number; outcome: string
}
function logRelayTiming(t: RelayTiming): RelayTiming {
  console.log(`[relay timing] ${t.fn} ${t.chain} ${t.outcome} cold=${t.cold} checks=${t.checksMs}ms simulate=${t.simulateMs ?? '-'}ms send=${t.sendMs ?? '-'}ms receipt=${t.receiptMs ?? '-'}ms total=${t.totalMs}ms head=${t.headBlock ?? '-'} mined=${t.minedBlock ?? '-'} blocks=${t.blocks ?? '-'} tip=${t.tipGwei ?? '-'}gwei`)
  return t
}

async function relayCall(req: VercelRequest, res: VercelResponse) {
  const startedAt = Date.now()
  const cold = relayCallsServed++ === 0
  const { chain, to, data } = (req.body ?? {}) as any
  const chainKey = CHAIN_ALIASES[chain] ?? String(chain || '')
  if (!isHex(to, 20) || !isHex(data) || data.length < 10) return res.status(400).json({ error: 'Malformed call' })
  const session = await sessionInfo(req)
  const caller = session?.wallet ?? null
  if (!caller) return res.status(403).json({ error: 'Not signed in' })
  // Finishing a transfer's mint has its own (larger) budget: it must never be
  // crowded out by other requests - the user's money is waiting on it.
  const isMint = String(data).slice(0, 10).toLowerCase() === RECEIVE_MESSAGE_SELECTOR
  if (!(isMint ? allowAction('mint', caller) : allowRelay(caller))) return res.status(429).json({ error: 'Too many requests - try again in a few minutes' })
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
  if (fnName === 'receiveMessage') {
    const args = (decodeFunctionData({ abi: RELAYABLE_ABI, data }) as { args: readonly unknown[] }).args
    const why = await mintRefusal(chainKey, String(args[0]), caller)
    if (why) return res.status(403).json({ error: why })
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

  const checksDoneAt = Date.now()
  const timing = (outcome: string, extra: Partial<RelayTiming> = {}) => logRelayTiming({
    fn: fnName, chain: chainKey, cold: cold && startedAt - instanceStartedAt < 10_000,
    checksMs: checksDoneAt - startedAt, totalMs: Date.now() - startedAt, outcome, ...extra,
  })

  // Simulate first: an already-used or invalid signature/attestation never costs gas.
  // The chain head is read alongside (no added wait) so `blocks` can be counted.
  let headBlock: number | undefined
  // P2P operator calls must come from the offer's named operator: an offer
  // made before the switch to Circle names the old (private-key) relayer, so
  // if the Circle wallet can't make the call, the key wallet tries.
  let sender: any = cl.wallet
  const operatorCall = fnName === 'registerTrade' || fnName === 'cancelTrade'
  try {
    const [, head] = await Promise.all([
      cl.pub.call({ account: cl.wallet.account, to, data }).catch(async (e: any) => {
        if (!operatorCall || !cl.keyWallet) throw e
        await cl.pub.call({ account: cl.keyWallet.account, to, data })
        sender = cl.keyWallet
      }),
      cl.pub.getBlockNumber().then((b: bigint) => Number(b)).catch(() => undefined),
    ])
    headBlock = head
  } catch (e: any) {
    if (isOutOfGasError(String(e?.shortMessage || e?.message || e))) {
      timing('no-gas', { simulateMs: Date.now() - checksDoneAt })
      return outOfGas(res, chainKey, sender.account.address)
    }
    timing('refused', { simulateMs: Date.now() - checksDoneAt })
    return res.status(400).json({ error: e?.shortMessage || 'Call would fail' })
  }
  const simulatedAt = Date.now()
  const fees = await relayFees(cl.pub, cl.pub.chain.id)
  const tipGwei = fees.maxPriorityFeePerGas != null ? Number(fees.maxPriorityFeePerGas) / 1e9 : undefined
  let txHash: `0x${string}`
  try {
    txHash = await sender.sendTransaction({ to, data, ...fees })
  } catch (e: any) {
    if (isOutOfGasError(String(e?.shortMessage || e?.message || e))) {
      timing('no-gas', { simulateMs: simulatedAt - checksDoneAt })
      return outOfGas(res, chainKey, sender.account.address)
    }
    throw e
  }
  const sentAt = Date.now()
  const base = { simulateMs: simulatedAt - checksDoneAt, sendMs: sentAt - simulatedAt, headBlock, tipGwei }
  try {
    const receipt = await cl.pub.waitForTransactionReceipt({ hash: txHash, timeout: 40_000 })
    const minedBlock = Number(receipt.blockNumber)
    const t = timing(receipt.status === 'success' ? 'mined' : 'reverted', {
      ...base, receiptMs: Date.now() - sentAt, minedBlock, blocks: headBlock != null ? minedBlock - headBlock : undefined,
    })
    if (receipt.status !== 'success') return res.status(502).json({ error: 'Transaction reverted', txHash, timing: t })
    return res.status(200).json({ txHash, timing: t })
  } catch {
    const t = timing('pending', { ...base, receiptMs: Date.now() - sentAt })
    return res.status(200).json({ txHash, pending: true, timing: t })
  }
}

type IrisFeeRow = { finalityThreshold: number; minimumFee: number; forwardFee?: number | { low?: number; med?: number; high?: number } }

// Quote inputs that change slowly, kept per warm instance so a quote is one
// round of parallel reads (or none) instead of four sequential ones:
// Circle's fee table (20 s), the chain's gas price (10 s), and USDC's
// EIP-712 name/version (fixed per contract).
const FEE_ROWS_TTL_MS = 20_000
const GAS_PRICE_TTL_MS = 10_000
const feeRowsCache = new Map<number, { at: number; rows: Promise<IrisFeeRow[]> }>()
const gasPriceCache = new Map<string, { at: number; price: Promise<bigint> }>()
const usdcMetaCache = new Map<string, Promise<[string, string]>>()

function cached<K, V>(map: Map<K, { at: number } & Record<string, any>>, key: K, field: string, ttl: number, load: () => Promise<V>): Promise<V> {
  const hit = map.get(key)
  if (hit && Date.now() - hit.at < ttl) return hit[field] as Promise<V>
  const p = load()
  const entry = { at: Date.now(), [field]: p }
  map.set(key, entry as any)
  p.catch(() => { if (map.get(key) === entry) map.delete(key) }) // a failure is never cached
  return p
}

function irisFeeRows(srcDomain: number): Promise<IrisFeeRow[]> {
  return cached(feeRowsCache, srcDomain, 'rows', FEE_ROWS_TTL_MS, async () => {
    const r = await fetch(`${IRIS}/v2/burn/USDC/fees/${srcDomain}/${ARC_DOMAIN}?forward=true`, { signal: AbortSignal.timeout(8_000) })
    if (!r.ok) throw new Error('Circle fee service unavailable')
    return await r.json() as IrisFeeRow[]
  })
}

/**
 * Circle's CCTP fee for a burn of `burn` units to Arc, with margin: the fast
 * protocol fee, plus Circle's forwarding fee when Circle's forwarder mints
 * (`forward`), not when MeshPort's relayer mints.
 */
async function cctpMaxFee(srcDomain: number, burn: bigint, rowsIn?: IrisFeeRow[], forward = true): Promise<bigint> {
  const rows = rowsIn ?? await irisFeeRows(srcDomain)
  const fast = rows.find(x => x.finalityThreshold === 1000) ?? rows[0]
  if (!fast) throw new Error('No CCTP fee for this route')
  // minimumFee is in basis points (may be fractional); forwardFee in USDC base units.
  const protocol = (burn * BigInt(Math.ceil((fast.minimumFee ?? 0) * 100))) / 1_000_000n
  const ff = fast.forwardFee
  const fwd = forward ? BigInt(Math.ceil(typeof ff === 'number' ? ff : (ff?.high ?? ff?.med ?? ff?.low ?? 0))) : 0n
  return ((protocol + fwd) * 120n) / 100n + 1n
}

/** The chain's gas price, cached 10 s (a quote and the relay right after it share one read). */
function chainGasPrice(pub: any, chainKey: string): Promise<bigint> {
  return cached(gasPriceCache, chainKey, 'price', GAS_PRICE_TTL_MS, () => pub.getGasPrice() as Promise<bigint>)
}

// ── MeshPort's fee (src/lib/feePolicy.ts) ──────────────────────────────────
// 0.2% of the amount, min $0.05, cap $5 - never below the relayer's live gas
// cost × 1.15. The gas cost uses the chain's CURRENT gas price (read at quote
// and again before sending) and, on mainnet, the gas coin's LIVE price.
// Testnet gas has no real value: there it is priced at the table's rough
// gasUsd and capped (BRIDGE_TESTNET_GAS_CAP_UNITS, default 0.10 USDC) so test
// moves stay cheap; the percentage / minimum / cap still apply.
const IS_MAINNET = (process.env.BRIDGE_NETWORK || process.env.VITE_NETWORK_ENV || '').toLowerCase() === 'mainnet'
const GAS_COIN: Record<string, string> = {
  Avalanche_Fuji: 'AVAX', Polygon_Sepolia: 'POL', Sei_Testnet: 'SEI', Sonic_Testnet: 'S', HyperEVM_Testnet: 'HYPE',
  Monad_Testnet: 'MON', XDC_Apothem: 'XDC', Plume_Testnet: 'PLUME', Injective_Testnet: 'INJ',
}
const nativePriceCache = new Map<string, { at: number; usd: Promise<number> }>()
/** The chain's gas coin in USD: live on mainnet (Coinbase spot, cached 60 s), the table's rough price on testnet or if the live read fails. */
export async function nativeUsd(chainKey: string): Promise<number> {
  const fixed = Number(process.env[`BRIDGE_NATIVE_USD_${chainKey.toUpperCase()}`] || CHAINS[chainKey]?.gasUsd || 3000)
  if (!IS_MAINNET) return fixed
  const coin = GAS_COIN[chainKey] ?? 'ETH'
  const hit = nativePriceCache.get(coin)
  if (hit && Date.now() - hit.at < 60_000) return hit.usd
  const usd = fetch(`https://api.coinbase.com/v2/prices/${coin}-USD/spot`, { signal: AbortSignal.timeout(4_000) })
    .then(r => r.json()).then(j => { const v = Number(j?.data?.amount); if (!(v > 0)) throw new Error('no price'); return v })
    .catch(() => fixed)
  nativePriceCache.set(coin, { at: Date.now(), usd })
  return usd
}

/** Native-coin wei → USDC units (6 dp) at `usd` dollars per coin, rounded up. */
function weiToUsdUnits(wei: bigint, usd: number): bigint {
  return (wei * BigInt(Math.round(usd * 100)) + 100n * 1_000_000_000_000n - 1n) / 100n / 1_000_000_000_000n
}
/** Testnet only: gas has no real value - keep the gas part small. */
function testnetGasCap(units: bigint): bigint {
  if (IS_MAINNET) return units
  const cap = BigInt(process.env.BRIDGE_TESTNET_GAS_CAP_UNITS || process.env.BRIDGE_MAX_FEE_UNITS || '100000')
  return units > cap ? cap : units
}

/** The relayer's gas for the router call on this chain, in USDC units, right now. */
async function relayGasCost(pub: any, chainKey: string): Promise<bigint> {
  const [gasPrice, usd] = await Promise.all([chainGasPrice(pub, chainKey), nativeUsd(chainKey)])
  return testnetGasCap(weiToUsdUnits(ROUTER_GAS * gasPrice, usd))
}

/** MeshPort's fee on a USDC Bring of `total` units (fee included). */
async function relayFee(pub: any, chainKey: string, total: bigint): Promise<{ fee: bigint; gasCost: bigint }> {
  const gasCost = await relayGasCost(pub, chainKey)
  return { fee: meshportFee(total, gasCost, usdRule(CROSS_CHAIN_FEE, 6)), gasCost }
}

async function quote(chainKey: string, total: bigint) {
  const c = CHAINS[chainKey]
  const { pub } = await clients(chainKey)
  let meta = usdcMetaCache.get(chainKey)
  if (!meta) {
    meta = Promise.all([
      pub.readContract({ address: c.usdc, abi: USDC_ABI, functionName: 'name' }) as Promise<string>,
      pub.readContract({ address: c.usdc, abi: USDC_ABI, functionName: 'version' }) as Promise<string>,
    ])
    usdcMetaCache.set(chainKey, meta)
    meta.catch(() => usdcMetaCache.delete(chainKey))
  }
  // All at once: gas price, USDC's signing domain and Circle's fee table.
  const [{ fee, gasCost }, [usdcName, usdcVersion], rows, relayerMint] = await Promise.all([
    relayFee(pub, chainKey, total), meta, irisFeeRows(c.domain), relayerMintQuote(total, chainKey),
  ])
  const maxFee = await cctpMaxFee(c.domain, total > fee ? total - fee : 0n, rows)
  // MeshPort's relayer mints on Arc instead of Circle's forwarder: no
  // forwarding fee (~$0.02 a Bring); the Arc mint gas (~$0.005) is in
  // MeshPort's fee instead. Null when the relayer can't mint right now.
  const direct = relayerMint
    ? { fee: relayerMint.fee, gasCost: relayerMint.gasCost, maxFee: await cctpMaxFee(c.domain, total > relayerMint.fee ? total - relayerMint.fee : 0n, rows, false) }
    : null
  return { fee, gasCost, maxFee, direct, usdcName, usdcVersion, pub }
}

// ── Bring: MeshPort's relayer mints on Arc (no Circle forwarding fee) ──────
// The burn carries no hook; once Circle attests it, the relayer submits
// receiveMessage on Arc (api/bridge-relay waitUntil, below - the user can
// close the app). The attested message fixes recipient and amount, and a
// message mints only once. If the relayer can't mint (BRING_ARC_MINT=circle,
// or its Arc gas is low), quotes fall back to Circle's forwarder.
const ARC_MINT_GAS = 220_000n // seen: 181k
const ARC_MINT_MIN_BALANCE = 500_000_000_000_000_000n // 0.5 USDC (18 decimals) of Arc gas
let _arcMintHealth: { at: number; ok: Promise<boolean> } | null = null
async function relayerCanMintOnArc(): Promise<boolean> {
  if ((process.env.BRING_ARC_MINT || '').toLowerCase() === 'circle') return false
  if (_arcMintHealth && Date.now() - _arcMintHealth.at < 60_000) return _arcMintHealth.ok
  const ok = (async () => {
    const cl = await callClients('Arc_Testnet')
    if (!cl?.wallet) return false
    const bal = await cl.pub.getBalance({ address: cl.wallet.account.address }) as bigint
    return bal >= ARC_MINT_MIN_BALANCE
  })().catch(() => false)
  _arcMintHealth = { at: Date.now(), ok }
  return ok
}
/** MeshPort's fee for a Bring when the relayer mints on Arc: its gas covers both legs. Null when it can't. */
async function relayerMintQuote(total: bigint, chainKey: string): Promise<{ fee: bigint; gasCost: bigint } | null> {
  if (!(await relayerCanMintOnArc())) return null
  const cl = await callClients('Arc_Testnet')
  if (!cl) return null
  const { pub } = await clients(chainKey)
  const [src, arcGasPrice] = await Promise.all([relayGasCost(pub, chainKey), cl.pub.getGasPrice() as Promise<bigint>])
  const gasCost = src + arcWeiToUsdcUnits(ARC_MINT_GAS * arcGasPrice)
  return { fee: meshportFee(total, gasCost, usdRule(CROSS_CHAIN_FEE, 6)), gasCost }
}

const RECEIVE_MESSAGE_ABI = [{
  type: 'function', name: 'receiveMessage', stateMutability: 'nonpayable', outputs: [{ type: 'bool' }],
  inputs: [{ name: 'message', type: 'bytes' }, { name: 'attestation', type: 'bytes' }],
}] as const

/**
 * After a hookless Bring burn: wait for Circle's attestation, then mint on
 * Arc from the relayer. Runs after the response (waitUntil), within the
 * function's time limit; if it runs out, the app's own follow-up
 * (finishCctpMintViaRelayer) or Recover finishes it - the mint is open to anyone.
 */
export async function mintOnArcAfterBurn(chainKey: string, burnTx: string, deadlineMs: number): Promise<string | null> {
  const started = Date.now()
  const domain = CHAINS[chainKey]?.domain
  if (domain === undefined) return null
  let msg: any = null
  while (Date.now() < deadlineMs) {
    try {
      const r = await fetch(`${IRIS}/v2/messages/${domain}?transactionHash=${burnTx}`, { signal: AbortSignal.timeout(5_000) })
      msg = r.ok ? (await r.json())?.messages?.[0] : null
    } catch { msg = null }
    if (msg?.status === 'complete' && msg.message && msg.attestation && msg.attestation !== 'PENDING') break
    await new Promise(res => setTimeout(res, 1_500))
  }
  if (!(msg?.status === 'complete' && msg.message && msg.attestation && msg.attestation !== 'PENDING')) {
    console.warn('[bridge-relay] arc mint: no attestation in time', chainKey, burnTx, `${Date.now() - started}ms`)
    return null
  }
  const attestedAt = Date.now()
  const cl = await callClients('Arc_Testnet')
  if (!cl?.wallet) return null
  const { encodeFunctionData } = await import('viem')
  const data = encodeFunctionData({ abi: RECEIVE_MESSAGE_ABI, functionName: 'receiveMessage', args: [msg.message, msg.attestation] })
  try {
    // Simulated first: already minted (the app's follow-up, Recover) costs nothing.
    await cl.pub.call({ account: cl.wallet.account, to: MESSAGE_TRANSMITTER_V2 as `0x${string}`, data })
  } catch (e: any) {
    console.log('[bridge-relay] arc mint: not needed', chainKey, burnTx, e?.shortMessage || e?.message || e)
    return null
  }
  const txHash = await cl.wallet.sendTransaction({ to: MESSAGE_TRANSMITTER_V2 as `0x${string}`, data, ...(await relayFees(cl.pub, cl.pub.chain.id)) })
  console.log('[bridge-relay] arc mint', JSON.stringify({ chain: chainKey, burnTx, mintTx: txHash, attestMs: attestedAt - started, sendMs: Date.now() - attestedAt }))
  return txHash
}

// ── Transfer: the relayer mints on the destination as soon as Circle attests ─
// POST { action:'transfer_mint_start', chain, burnTx }, sent by the app right
// after a hookless Arc burn (lib/fastCctp settle). The server waits for the
// attestation itself (Iris every 0.5 s), submits receiveMessage with a raised
// tip, and answers once it's mined - no round trip from the phone between
// "attested" and "mint sent". Same exposure as action:'call' with
// receiveMessage: an attested message fixes recipient and amount, and mints once.
const TRANSFER_MINT_POLL_MS = 500
async function transferMintStart(req: VercelRequest, res: VercelResponse) {
  const startedAt = Date.now()
  const session = await sessionInfo(req)
  const caller = session?.wallet ?? null
  if (!caller) return res.status(403).json({ error: 'Not signed in' })
  if (!allowAction('mint', caller)) return res.status(429).json({ error: 'Too many requests - try again in a few minutes' })
  const chainKey = String((req.body as any)?.chain || '')
  const burnTx = String((req.body as any)?.burnTx || '')
  const dest = CHAINS[chainKey]
  if (!dest || chainKey === 'Arc_Testnet' || !isHex(burnTx, 32)) return res.status(400).json({ error: 'Bad request' })

  // Warmed while Circle attests: the chain's clients and fees, so the send
  // right after the attestation is only estimate + nonce + sign.
  const clP = callClients(chainKey).catch(() => null)
  const feesP = clP.then(cl => cl ? relayFees(cl.pub, cl.pub.chain.id, true) : {}).catch(() => ({}))
  const deadline = startedAt + 40_000
  let msg: any = null
  const done = (m: any) => m?.status === 'complete' && m.message && m.attestation && m.attestation !== 'PENDING'
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${IRIS}/v2/messages/${ARC_DOMAIN}?transactionHash=${burnTx}`, { signal: AbortSignal.timeout(4_000) })
      msg = r.ok ? (await r.json())?.messages?.[0] : null
    } catch { msg = null }
    if (done(msg)) break
    await new Promise(r => setTimeout(r, TRANSFER_MINT_POLL_MS))
  }
  if (!done(msg)) return res.status(200).json({ pending: true })
  const attestedAt = Date.now()
  const d = msg.decodedMessage
  const parts = cctpMessageParts(String(msg.message))
  if (!parts || parts.destinationDomain !== dest.domain) return res.status(400).json({ error: 'Not a transfer to this chain' })
  const hook = d?.decodedMessageBody?.hookData
  if (hook && hook !== '0x') return res.status(200).json({ pending: true, forwarder: true }) // Circle's forwarder mints it
  // Only a burn sent through MeshPort, or the caller's own (audit 7 Nov H2).
  const refused = await mintRefusal(chainKey, String(msg.message), caller)
  if (refused) return res.status(403).json({ error: refused })

  const cl = await clP
  if (!cl?.wallet) return res.status(400).json({ error: 'Relayer not available on this chain' })
  const { encodeFunctionData } = await import('viem')
  const data = encodeFunctionData({ abi: RECEIVE_MESSAGE_ABI, functionName: 'receiveMessage', args: [msg.message, msg.attestation] })
  const to = MESSAGE_TRANSMITTER_V2 as `0x${string}`
  const from = cl.wallet.account.address
  // The gas estimate doubles as the simulation: already minted = it fails, nothing is sent.
  let gas: bigint, nonce: number
  try {
    [gas, nonce] = await Promise.all([
      cl.pub.estimateGas({ account: from, to, data }) as Promise<bigint>,
      cl.pub.getTransactionCount({ address: from, blockTag: 'pending' }) as Promise<number>,
    ])
  } catch (e: any) {
    // A revert means the message was already received (CCTP mints once); a
    // network error doesn't (audit 7 Nov M10) - the app then mints its own way.
    const text = String(e?.shortMessage || e?.message || e)
    // Checked first: "Execution reverted ... gas required exceeds allowance (0)"
    // is the relayer having no gas, not an already-minted message (8 Nov).
    if (isOutOfGasError(text)) return outOfGas(res, chainKey, from)
    if (/revert|already|nonce/i.test(text)) return res.status(200).json({ alreadyMinted: true, error: text.slice(0, 120) })
    return res.status(502).json({ error: 'Could not check the mint - try again' })
  }
  let txHash: `0x${string}`
  try {
    txHash = await cl.wallet.sendTransaction({ to, data, gas: gas * 6n / 5n, nonce, ...(await feesP) })
  } catch (e: any) {
    if (isOutOfGasError(String(e?.shortMessage || e?.message || e))) return outOfGas(res, chainKey, from)
    throw e
  }
  const sentAt = Date.now()
  const log = (outcome: string) => console.log('[bridge-relay] transfer mint', JSON.stringify({
    chain: chainKey, burnTx, mintTx: txHash, outcome, attestMs: attestedAt - startedAt, sendMs: sentAt - attestedAt, receiptMs: Date.now() - sentAt,
  }))
  try {
    const receipt = await cl.pub.waitForTransactionReceipt({ hash: txHash, timeout: Math.max(5_000, startedAt + 55_000 - Date.now()) })
    log(receipt.status)
    if (receipt.status !== 'success') return res.status(502).json({ error: 'Transaction reverted', txHash })
    return res.status(200).json({ txHash })
  } catch {
    log('pending')
    return res.status(200).json({ txHash, pending: true })
  }
}

// ── EURC / cirBTC (Circle CCTPx) through MeshPortRouter ────────────────────
// The same relayer, the CCTPx counterpart of the USDC flow above:
//
//   GET  ?action=token_quote&chain=Base_Sepolia&token=EURC&amount=<token units>[&recipient=0x…]
//        → { fee, nativeFee, finality, token, tokenId, decimals, auth, domainName, domainVersion }
//        fee       = MeshPort fee, in the token (the relayer's gas + Circle's
//                    CCTPx fee, which the relayer pays in the chain's native coin)
//        auth      = '3009' (ReceiveWithAuthorization) or 'permit' (EIP-2612)
//
//   POST { action:'token_relay', chain, symbol, bridge, authorization | permit }
//        Checks it, gets a fresh signed quote from Circle, simulates and submits
//        MeshPortRouter.tokenBridgeWith{Authorization,Permit} paying Circle's fee
//        as msg.value → { txHash }. Idempotent like 'relay'.
//
// The same router as USDC (BRIDGE_ROUTERS). Env: optional CCTPX_IRIS (default
// sandbox - CCTPx testnet chains), BRIDGE_EURC_USD / BRIDGE_CIRBTC_USD (rough
// token prices, to turn the native cost into the token), BRIDGE_TOKEN_MAX_FEE_USD
// (cap, default 0.50).

const CCTPX_IRIS = (process.env.CCTPX_IRIS || 'https://iris-api-sandbox.circle.com').replace(/\/+$/, '')
/** How long token_relay waits for the source chain's receipt before answering 'pending'. */
const TOKEN_RECEIPT_WAIT_MS = 4_000
const TOKEN_ROUTER_GAS = 420_000n     // receive/permit + fee transfer + approves + crossChainTransfer
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** CCTPx token ids on testnet (@circle-fin/provider-cctpx KNOWN_TOKEN_IDS_BY_NETWORK). */
export const CCTPX_TOKENS: Record<string, { id: `0x${string}`; decimals: number; usdEnv: string; usd: number; min: bigint }> = {
  EURC:   { id: '0x2587821a0ee7daa174b95436b5dab1731cfa1844775b010217d3c0dd02a4eecd', decimals: 6, usdEnv: 'BRIDGE_EURC_USD',   usd: 1.1,     min: 1_000_000n }, // 1 EURC
  cirBTC: { id: '0x7c27b7b6485f3ea49b7d1a439e288d3c3116f533302afabb7e372dfc0770cc7d', decimals: 8, usdEnv: 'BRIDGE_CIRBTC_USD', usd: 100_000, min: 1_000n },     // 0.00001 cirBTC
}

const TOKEN_BRIDGE_COMPONENTS = [
  { name: 'token', type: 'address' }, { name: 'tokenId', type: 'bytes32' }, { name: 'destinationDomain', type: 'uint32' },
  { name: 'recipient', type: 'address' }, { name: 'fee', type: 'uint256' }, { name: 'minFinalityThreshold', type: 'uint32' },
  { name: 'salt', type: 'bytes32' },
] as const
const TOKEN_ROUTER_ABI = [
  {
    type: 'function', name: 'tokenBridgeWithAuthorization', stateMutability: 'payable',
    inputs: [
      { name: 'b', type: 'tuple', components: TOKEN_BRIDGE_COMPONENTS },
      { name: 'a', type: 'tuple', components: [
        { name: 'from', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' },
        { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' },
      ] },
      { name: 'signedQuote', type: 'bytes' },
    ],
    outputs: [{ name: 'nonce', type: 'bytes32' }],
  },
  {
    type: 'function', name: 'tokenBridgeWithPermit', stateMutability: 'payable',
    inputs: [
      { name: 'b', type: 'tuple', components: TOKEN_BRIDGE_COMPONENTS },
      { name: 'p', type: 'tuple', components: [
        { name: 'from', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
        { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' },
        { name: 'bv', type: 'uint8' }, { name: 'br', type: 'bytes32' }, { name: 'bs', type: 'bytes32' },
      ] },
      { name: 'signedQuote', type: 'bytes' },
    ],
    outputs: [{ name: 'nonce', type: 'bytes32' }],
  },
  { type: 'function', name: 'tokenBridgeNonce', stateMutability: 'view', inputs: [{ name: 'b', type: 'tuple', components: TOKEN_BRIDGE_COMPONENTS }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'usedNonce', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'bytes32' }], outputs: [{ type: 'bool' }] },
  {
    type: 'event', name: 'TokenBridged', inputs: [
      { name: 'from', type: 'address', indexed: true }, { name: 'nonce', type: 'bytes32', indexed: true },
      { name: 'token', type: 'address', indexed: true }, { name: 'destinationDomain', type: 'uint32', indexed: false },
      { name: 'recipient', type: 'address', indexed: false }, { name: 'amount', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false },
    ],
  },
] as const
const TOKEN_ABI = [
  ...USDC_ABI,
  { type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'eip712Domain', stateMutability: 'view', inputs: [], outputs: [
    { type: 'bytes1' }, { type: 'string' }, { type: 'string' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256[]' },
  ] },
] as const


// Circle's CCTPx token registry: where each token is deployed (by CCTP domain).
//
// The registry lists ~1,000 tokens in pages of 50, and a page can only be
// asked for after the one before it - walking it all took 2.5 s warm and
// 10-20 s on a cold serverless start, which is exactly the delay every EURC /
// cirBTC quote and Bring paid. Circle's endpoint filters by token id
// (?tokenId=), so one ~130 ms request returns just the token needed; the full
// walk stays as the fallback if the filter ever stops working.
type CctpxDeployment = { domainId: number; tokenAddress: string; enabled?: boolean }
type CctpxToken = { tokenId: string; deployments: CctpxDeployment[] }

const REGISTRY_TTL_MS = 5 * 60_000
let _registry: { at: number; tokens: CctpxToken[] } | null = null
async function cctpxRegistry(): Promise<CctpxToken[]> {
  if (_registry && Date.now() - _registry.at < REGISTRY_TTL_MS) return _registry.tokens
  const tokens: any[] = []
  let after = ''
  for (let page = 0; page < 20; page++) {
    const r = await fetch(`${CCTPX_IRIS}/v2/cctpx/tokens?pageSize=200${after ? `&pageAfter=${encodeURIComponent(after)}` : ''}`, { signal: AbortSignal.timeout(10_000) })
    if (!r.ok) throw new Error('Circle token registry unavailable')
    const j = await r.json() as { data?: any[]; nextPageAfter?: string | null }
    tokens.push(...(j.data ?? []))
    if (!j.nextPageAfter) break
    after = j.nextPageAfter
  }
  _registry = { at: Date.now(), tokens }
  return tokens
}

const deploymentsCache = new Map<string, { at: number; deployments: Promise<CctpxDeployment[]> }>()
const lastGoodDeployments = new Map<string, CctpxDeployment[]>()

async function loadCctpxDeployments(symbol: string): Promise<CctpxDeployment[]> {
  const id = CCTPX_TOKENS[symbol].id
  try {
    const r = await fetch(`${CCTPX_IRIS}/v2/cctpx/tokens?tokenId=${id}`, { signal: AbortSignal.timeout(5_000) })
    if (r.ok) {
      const j = await r.json() as { data?: CctpxToken[] }
      const t = (j.data ?? []).find(x => String(x.tokenId).toLowerCase() === id)
      if (t) return t.deployments
    }
  } catch { /* fall back to the full registry */ }
  const t = (await cctpxRegistry()).find(x => String(x.tokenId).toLowerCase() === id)
  return t?.deployments ?? []
}

/** The token's deployments (cached 5 min; a failed refresh keeps serving the last good answer). */
async function cctpxDeployments(symbol: string): Promise<CctpxDeployment[]> {
  try {
    const rows = await cached(deploymentsCache, symbol, 'deployments', REGISTRY_TTL_MS, () => loadCctpxDeployments(symbol))
    lastGoodDeployments.set(symbol, rows)
    return rows
  } catch (e) {
    const stale = lastGoodDeployments.get(symbol)
    if (stale) return stale
    throw e
  }
}

/** The token's contract on `domain` when Circle has it on there AND on Arc; null otherwise. */
export async function cctpxTokenAddress(symbol: string, domain: number): Promise<`0x${string}` | null> {
  const deployments = await cctpxDeployments(symbol)
  const on = (d: number) => deployments.find(x => x.domainId === d && x.enabled !== false && isHex(x.tokenAddress, 20))
  return on(ARC_DOMAIN) && on(domain) ? on(domain)!.tokenAddress as `0x${string}` : null
}

/** Circle's signed CCTPx fee quote (native fee) for `amount` to `recipient` on Arc. */
async function cctpxQuote(symbol: string, srcDomain: number, amount: bigint, recipient: string, fast: boolean) {
  const r = await fetch(`${CCTPX_IRIS}/v2/quote/cctpx/${CCTPX_TOKENS[symbol].id}/${srcDomain}/${ARC_DOMAIN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: amount.toString(), feeToken: ZERO_ADDRESS,
      requests: [{ type: 'FORWARD', params: { msgType: 'TransferMessage', destinationAddress: recipient } }, ...(fast ? [{ type: 'PRE_FINALITY' }] : [])],
    }),
    signal: AbortSignal.timeout(10_000),
  })
  const j = await r.json().catch(() => null) as { signedQuote?: string; feeToken?: string; feeTotalAmount?: string } | null
  if (!r.ok || !j?.signedQuote || !isHex(j.signedQuote) || !isUint(j.feeTotalAmount)) throw new Error('Circle fee quote unavailable')
  if (String(j.feeToken || ZERO_ADDRESS).toLowerCase() !== ZERO_ADDRESS) throw new Error('Unexpected Circle fee token')
  return { signedQuote: j.signedQuote as `0x${string}`, nativeFee: BigInt(j.feeTotalAmount) }
}

/** Fast (1000) when Circle quotes it, otherwise standard (2000). */
async function cctpxQuoteAnySpeed(symbol: string, srcDomain: number, amount: bigint, recipient: string) {
  try { return { ...(await cctpxQuote(symbol, srcDomain, amount, recipient, true)), finality: 1000 } }
  catch { return { ...(await cctpxQuote(symbol, srcDomain, amount, recipient, false)), finality: 2000 } }
}

/**
 * MeshPort's fee in the token: the relayer's gas for the router call plus
 * Circle's native fee, priced at the chain's gas-token and the token's rough
 * USD prices, capped (testnet gas has no real value) - the cap only lowers it.
 */
export function tokenFeeUnits(totalWei: bigint, gasUsd: number, symbol: string, env: Record<string, string | undefined> = process.env): bigint {
  const t = CCTPX_TOKENS[symbol]
  const tokenUsd = Number(env[t.usdEnv] || t.usd)
  const capUsd = Number(env.BRIDGE_TOKEN_MAX_FEE_USD || 0.5)
  const usd = Math.min(Number(totalWei) / 1e18 * gasUsd, capUsd)
  return BigInt(Math.ceil(usd / tokenUsd * 10 ** t.decimals))
}

/**
 * MeshPort's fee on a token Bring of `amount` (token units): 0.2%, min $0.05,
 * cap $5 in the token - never below the relayer's live cost (its gas + Circle's
 * native CCTPx fee, which it pays) × 1.15.
 */
async function tokenFee(pub: any, chainKey: string, symbol: string, nativeFee: bigint, amount: bigint): Promise<{ fee: bigint; gasCost: bigint }> {
  const [gasPrice, gasUsd] = await Promise.all([chainGasPrice(pub, chainKey), nativeUsd(chainKey)])
  const t = CCTPX_TOKENS[symbol]
  const gasCost = tokenFeeUnits(TOKEN_ROUTER_GAS * gasPrice + nativeFee, gasUsd, symbol, IS_MAINNET ? { ...process.env, BRIDGE_TOKEN_MAX_FEE_USD: '1e12' } : process.env)
  const tokenUsd = Number(process.env[t.usdEnv] || t.usd)
  return { fee: meshportFee(amount, gasCost, usdRule(CROSS_CHAIN_FEE, t.decimals, tokenUsd)), gasCost }
}

// How a token is pulled and its EIP-712 domain never change for a deployed
// token: read once (it was 3-5 sequential RPC calls on every quote).
const tokenAuthCache = new Map<string, Promise<{ auth: '3009' | 'permit' | null; name: string; version: string }>>()
function tokenAuth(pub: any, token: `0x${string}`) {
  const key = `${pub.chain?.id}|${token.toLowerCase()}`
  let hit = tokenAuthCache.get(key)
  if (!hit) {
    hit = readTokenAuth(pub, token)
    tokenAuthCache.set(key, hit)
    // Only a definite EIP-3009 answer is kept: a failure, or a fallback to
    // permit / nothing that a flaky RPC read could have caused, is re-read next time.
    hit.then(v => { if (v.auth !== '3009') tokenAuthCache.delete(key) }, () => tokenAuthCache.delete(key))
  }
  return hit
}

/** How the token lets the router pull it, and its EIP-712 domain. */
async function readTokenAuth(pub: any, token: `0x${string}`) {
  let auth: '3009' | 'permit' | null = null
  try { await pub.readContract({ address: token, abi: TOKEN_ABI, functionName: 'authorizationState', args: [ZERO_ADDRESS, '0x' + '00'.repeat(32)] }); auth = '3009' } catch { /* not EIP-3009 */ }
  if (!auth) { try { await pub.readContract({ address: token, abi: TOKEN_ABI, functionName: 'nonces', args: [ZERO_ADDRESS] }); auth = 'permit' } catch { /* no permit */ } }
  let name = '', version = '1'
  try {
    const d = await pub.readContract({ address: token, abi: TOKEN_ABI, functionName: 'eip712Domain' }) as any[]
    name = d[1]; version = d[2] || '1'
  } catch {
    name = await pub.readContract({ address: token, abi: TOKEN_ABI, functionName: 'name' }) as string
    try { version = await pub.readContract({ address: token, abi: TOKEN_ABI, functionName: 'version' }) as string } catch { /* EIP-2612 default */ }
  }
  return { auth, name, version }
}

async function tokenQuote(req: VercelRequest, res: VercelResponse) {
  const chainKey = String(req.query.chain || '')
  const symbol = String(req.query.token || '')
  const amount = String(req.query.amount || '')
  const recipient = isHex(req.query.recipient, 20) ? String(req.query.recipient) : '0x0000000000000000000000000000000000000001'
  if (!CHAINS[chainKey] || !routers()[chainKey]) return res.status(400).json({ error: 'Gasless bringing is not available for this chain' })
  if (!CCTPX_TOKENS[symbol]) return res.status(400).json({ error: 'Unsupported token' })
  if (!isUint(amount) || BigInt(amount) < CCTPX_TOKENS[symbol].min) return res.status(400).json({ error: 'Amount too small' })
  const c = CHAINS[chainKey]
  const token = await cctpxTokenAddress(symbol, c.domain)
  if (!token) return res.status(400).json({ error: `${symbol} can't be brought from this chain right now` })
  const { pub } = await clients(chainKey)
  // Circle's quote, the token's signing domain and the gas price: all at once.
  const [q, info] = await Promise.all([
    cctpxQuoteAnySpeed(symbol, c.domain, BigInt(amount), recipient), tokenAuth(pub, token),
    chainGasPrice(pub, chainKey).catch(() => undefined),
  ])
  if (!info.auth) return res.status(400).json({ error: `${symbol} on this chain can't be moved with a signature` })
  const { fee } = await tokenFee(pub, chainKey, symbol, q.nativeFee, BigInt(amount))
  return res.status(200).json({
    fee: fee.toString(), nativeFee: q.nativeFee.toString(), finality: q.finality, token, tokenId: CCTPX_TOKENS[symbol].id,
    decimals: CCTPX_TOKENS[symbol].decimals, auth: info.auth, domainName: info.name, domainVersion: info.version,
  })
}

async function tokenRelay(req: VercelRequest, res: VercelResponse) {
  const { chain: chainKey, symbol, bridge: b, authorization: a, permit: p } = (req.body ?? {}) as any
  const router = routers()[chainKey]
  if (!CHAINS[chainKey] || !router) return res.status(400).json({ error: 'Gasless bringing is not available for this chain' })
  if (!CCTPX_TOKENS[symbol]) return res.status(400).json({ error: 'Unsupported token' })
  if (!b || (!a === !p)) return res.status(400).json({ error: 'Missing bridge or authorization' })
  if (!isHex(b.token, 20) || !isHex(b.tokenId, 32) || !isHex(b.recipient, 20) || !isUint(b.fee) || !isHex(b.salt, 32))
    return res.status(400).json({ error: 'Malformed bridge parameters' })
  const auth = a ?? p
  if (!isHex(auth.from, 20) || !isUint(auth.value) || !isHex(auth.signature, 65)) return res.status(400).json({ error: 'Malformed authorization' })
  if (a && (!isUint(a.validAfter) || !isUint(a.validBefore))) return res.status(400).json({ error: 'Malformed authorization' })
  if (p && (!isUint(p.deadline) || !isHex(p.bridgeSignature, 65))) return res.status(400).json({ error: 'Malformed permit' })

  // Only the user's own EURC / cirBTC, to their own wallet on Arc.
  const t = CCTPX_TOKENS[symbol]
  if (String(b.tokenId).toLowerCase() !== t.id) return res.status(400).json({ error: 'Wrong token id' })
  if (Number(b.destinationDomain) !== ARC_DOMAIN) return res.status(400).json({ error: 'Only bringing to Arc is supported' })
  if (String(b.recipient).toLowerCase() !== String(auth.from).toLowerCase()) return res.status(400).json({ error: 'Funds can only be brought to your own wallet' })
  if (![1000, 2000].includes(Number(b.minFinalityThreshold))) return res.status(400).json({ error: 'Unsupported finality' })
  const now = Math.floor(Date.now() / 1000)
  const until = Number(a ? a.validBefore : p.deadline)
  if (until <= now + 30 || until > now + MAX_AUTH_WINDOW_SEC) return res.status(400).json({ error: 'Authorization window is invalid or expired' })
  const value = BigInt(auth.value), fee = BigInt(b.fee)
  if (value < t.min || fee >= value) return res.status(400).json({ error: 'Amount too small' })

  const session = await sessionInfo(req)
  if (!session || session.wallet !== String(auth.from).toLowerCase()) return res.status(403).json({ error: 'Not signed in to this wallet' })
  const block = spendBlock(session.canSpend)
  if (block) return res.status(block.status).json({ error: block.error })
  if (!allowRelay(session.wallet)) return res.status(429).json({ error: 'Too many requests - try again shortly' })

  const c = CHAINS[chainKey]
  const token = await cctpxTokenAddress(symbol, c.domain)
  if (!token || token.toLowerCase() !== String(b.token).toLowerCase()) return res.status(400).json({ error: `${symbol} can't be brought from this chain right now` })
  const { pub, wallet } = await clients(chainKey)
  if (!wallet) return res.status(503).json({ error: 'Relayer is not configured' })

  const bridgeArgs = {
    token: token as `0x${string}`, tokenId: t.id, destinationDomain: ARC_DOMAIN, recipient: b.recipient as `0x${string}`,
    fee, minFinalityThreshold: Number(b.minFinalityThreshold), salt: b.salt as `0x${string}`,
  }
  // Everything the checks need, at once: the replay check (nonce, then whether
  // it was used), Circle's fee quote for exactly this transfer, the sender's
  // balance and the gas price. These used to be four rounds in a row.
  const amount = value - fee
  const replay = (async () => {
    const nonce = await pub.readContract({ address: router, abi: TOKEN_ROUTER_ABI, functionName: 'tokenBridgeNonce', args: [bridgeArgs] }) as `0x${string}`
    const used = a
      ? await pub.readContract({ address: token, abi: TOKEN_ABI, functionName: 'authorizationState', args: [auth.from, nonce] })
      : await pub.readContract({ address: router, abi: TOKEN_ROUTER_ABI, functionName: 'usedNonce', args: [auth.from, nonce] })
    return { nonce, used }
  })()
  const [{ nonce, used }, quoted, bal] = await Promise.all([
    replay,
    // Circle's fee for exactly this transfer, paid by the relayer; the user's fee must still cover it.
    // A failed quote is held back, not thrown: a retry of an already-sent transfer must still answer "already submitted".
    cctpxQuote(symbol, c.domain, amount, String(b.recipient), Number(b.minFinalityThreshold) === 1000)
      .then(v => ({ v }), (e: unknown) => ({ e })),
    pub.readContract({ address: token, abi: TOKEN_ABI, functionName: 'balanceOf', args: [auth.from] }) as Promise<bigint>,
    chainGasPrice(pub, chainKey).catch(() => undefined),
  ])
  if (used) {
    // Public nodes often refuse a log search from block 0; the authorization
    // can only have been used inside its window (MAX_AUTH_WINDOW_SEC), so the
    // recent blocks are searched when the full search is refused.
    const find = (fromBlock: bigint | 'earliest') => pub.getContractEvents({ address: router, abi: TOKEN_ROUTER_ABI, eventName: 'TokenBridged', args: { from: auth.from, nonce }, fromBlock }) as Promise<any[]>
    let logs: any[] = await find('earliest').catch(() => [])
    if (!logs.length) {
      const head = await pub.getBlockNumber().catch(() => null)
      if (head !== null) logs = await find(head > 9_000n ? head - 9_000n : 0n).catch(() => [])
    }
    const hit = logs[0]
    return hit ? res.status(200).json({ txHash: hit.transactionHash, alreadySubmitted: true })
      : res.status(409).json({ error: 'This authorization was already used' })
  }

  if ('e' in quoted) throw quoted.e
  const q = quoted.v
  const needed = await tokenFee(pub, chainKey, symbol, q.nativeFee, value)
  if (!feeAcceptable(fee, needed.fee, needed.gasCost)) return res.status(400).json({ error: 'Fee too low - please try again' })
  if (bal < value) return res.status(400).json({ error: `Not enough ${symbol} on this chain` })

  const { parseSignature } = await import('viem')
  const vrs = (sig: `0x${string}`) => { const s = parseSignature(sig); return { v: s.v !== undefined ? Number(s.v) : 27 + (s.yParity ?? 0), r: s.r, s: s.s } }
  const call = a
    ? (() => { const s = vrs(a.signature); return { functionName: 'tokenBridgeWithAuthorization' as const,
        args: [bridgeArgs, { from: a.from, value, validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), ...s }, q.signedQuote] } })()
    : (() => { const s = vrs(p.signature), bs = vrs(p.bridgeSignature); return { functionName: 'tokenBridgeWithPermit' as const,
        args: [bridgeArgs, { from: p.from, value, deadline: BigInt(p.deadline), ...s, bv: bs.v, br: bs.r, bs: bs.s }, q.signedQuote] } })()

  // Simulate first: a bad signature or changed parameter never costs gas.
  const { request } = await pub.simulateContract({
    account: wallet.account, address: router, abi: TOKEN_ROUTER_ABI, ...call, value: q.nativeFee,
  } as any).catch((e: any) => { throw Object.assign(new Error(e?.shortMessage || 'Transfer would fail'), { status: 400 }) })
  const txHash = await wallet.writeContract({ ...request, ...(await relayFees(pub, pub.chain.id)) })
  // Answer as soon as it is sent. Waiting here for the source chain's receipt
  // (up to 40 s on Ethereum) held the phone's request open that long, and a
  // phone that dropped it saw "Failed to fetch" for a transfer that was sent
  // (field 1 Nov 04:46, EURC from Ethereum). The app waits for the receipt
  // itself ('pending'); a fast chain still answers with the receipt here.
  try {
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: TOKEN_RECEIPT_WAIT_MS })
    if (receipt.status !== 'success') return res.status(502).json({ error: 'Transaction reverted', txHash })
    return res.status(200).json({ txHash })
  } catch {
    return res.status(200).json({ txHash, pending: true })
  }
}

// ── Transfer: who mints on the destination ──────────────────────────────────
// Circle's forwarder (the user pays Circle's forwarding fee out of the amount)
// or MeshPort's relayer (it pays the destination gas, charged in MeshPort's
// fee). The relayer mints when that gas costs less than Circle's forwarding
// fee - and always where Circle's forwarder keeps failing.
const DEST_MINT_GAS = 300_000n // receiveMessage, seen ~290k on Ethereum Sepolia
const FORWARDER_FAILING = new Set((process.env.FORWARDER_FAILING_CHAINS || 'Ethereum_Sepolia').split(',').map(s => s.trim()).filter(Boolean))
function chainKeyForDomain(domain: number): string | null {
  for (const [k, c] of Object.entries(CHAINS)) if (c.domain === domain && k !== 'Arc_Testnet') return k
  return null
}
/** MeshPort's relayer's gas for a mint on `chainKey`, in USDC units (live gas price; testnet capped). */
async function destMintGasCost(chainKey: string): Promise<bigint> {
  const { pub } = await clients(chainKey)
  const [gasPrice, usd] = await Promise.all([chainGasPrice(pub, chainKey), nativeUsd(chainKey)])
  return testnetGasCap(weiToUsdUnits(DEST_MINT_GAS * gasPrice, usd))
}
/** Native wei the relayer must hold on a chain to mint once: the mint's gas at
 *  3x the current price (a transfer's mint raises the tip and leaves room for
 *  the base fee to double). */
export function destMintNeedsWei(gasPrice: bigint): bigint {
  return DEST_MINT_GAS * gasPrice * 3n
}
/** A node or viem saying the sender can't pay the gas, as opposed to the call
 *  itself reverting (an already-minted message reverts; that's not this). */
export function isOutOfGasError(text: string): boolean {
  return /insufficient funds|exceeds the balance of the account|gas required exceeds allowance \(0\)/i.test(text)
}
export const relayerOutOfGas = (chainName: string) => `MeshPort's relayer is out of gas on ${chainName}`
function outOfGas(res: VercelResponse, chainKey: string, address: string) {
  console.error('[bridge-relay] RELAYER OUT OF GAS', JSON.stringify({ chain: chainKey, address }))
  destGasHealth.delete(chainKey) // the next plan re-reads the balance and picks Circle's forwarder
  return res.status(503).json({ error: relayerOutOfGas(CHAINS[chainKey]?.name ?? chainKey.replace(/_/g, ' ')), noGas: true })
}
/** Whether MeshPort's relayer can pay a mint on `chainKey` right now (cached 60 s).
 *  8 Nov: it had 0 ETH on Base Sepolia, the plan still said "relayer", and a
 *  burned transfer sat unminted. With this false the app burns through
 *  Circle's forwarder instead. */
const destGasHealth = new Map<string, { at: number; ok: Promise<boolean> }>()
function relayerHasDestGas(chainKey: string): Promise<boolean> {
  return cached(destGasHealth, chainKey, 'ok', 60_000, async () => {
    const cl = await clients(chainKey)
    if (!cl.wallet) return false
    const address = cl.wallet.account.address
    const [balance, gasPrice] = await Promise.all([
      cl.pub.getBalance({ address }) as Promise<bigint>, chainGasPrice(cl.pub, chainKey),
    ])
    const ok = balance >= destMintNeedsWei(gasPrice)
    if (!ok) console.error('[bridge-relay] RELAYER LOW GAS', JSON.stringify({ chain: chainKey, address, balance: balance.toString(), needs: destMintNeedsWei(gasPrice).toString() }))
    return ok
  }).catch(() => false)
}
/** Circle's forwarding fee (base units) for Arc → `chainKey`, or null. */
const forwardFeeCache = new Map<string, { at: number; fee: Promise<bigint | null> }>()
function arcForwardFee(chainKey: string): Promise<bigint | null> {
  return cached(forwardFeeCache, chainKey, 'fee', FEE_ROWS_TTL_MS, async () => {
    const r = await fetch(`${IRIS}/v2/burn/USDC/fees/${ARC_DOMAIN}/${CHAINS[chainKey].domain}?forward=true`, { signal: AbortSignal.timeout(8_000) })
    if (!r.ok) return null
    const rows = await r.json() as IrisFeeRow[]
    const fast = rows.find(x => x.finalityThreshold === 1000) ?? rows[0]
    const ff = fast?.forwardFee
    if (ff == null) return null
    return BigInt(Math.ceil(typeof ff === 'number' ? ff : (ff?.high ?? ff?.med ?? ff?.low ?? 0)))
  })
}
/** GET ?action=transfer_mint&chain= → { relayer, destGas, forwardFee } (units). */
async function transferMint(req: VercelRequest, res: VercelResponse) {
  const chainKey = String(req.query.chain || '')
  if (!CHAINS[chainKey] || chainKey === 'Arc_Testnet') return res.status(200).json({ relayer: false })
  const [destGas, forwardFee, hasGas] = await Promise.all([
    destMintGasCost(chainKey).catch(() => null), arcForwardFee(chainKey).catch(() => null), relayerHasDestGas(chainKey),
  ])
  const canMint = hasGas && destGas != null
  const relayer = canMint && (FORWARDER_FAILING.has(chainKey) || (forwardFee != null && destGas! * 115n / 100n <= forwardFee))
  res.setHeader('Cache-Control', 'private, max-age=30')
  // relayerUnavailable: the relayer can't mint here now - use Circle's
  // forwarder even where it is usually skipped (FORWARDER_FAILING).
  return res.status(200).json({ relayer, relayerUnavailable: !canMint, destGas: (destGas ?? 0n).toString(), forwardFee: forwardFee?.toString() ?? null })
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  try {
    // ── GET actions ──────────────────────────────────────────────────────
    if (req.method === 'GET') {
      // ── warm: a move is about to need this function (Transfer's Review /
      // passcode step): start the instance and set up the destination chain's
      // clients and the relayer signer now, so the mint request that follows
      // doesn't pay a cold start (7 Nov: 24 s of a Unified Balance transfer's
      // 33 s Gateway mint request was spent before the handler ran).
      if (req.query.action === 'warm') {
        const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown'
        if (!allowQuote(ip)) return res.status(429).end()
        const chainKey = CHAIN_ALIASES[String(req.query.chain || '')] ?? String(req.query.chain || '')
        if (CHAINS[chainKey] || EXTRA_RPCS[chainKey]) await callClients(chainKey).then(cl => cl?.pub.getBlockNumber()).catch(() => {})
        res.setHeader('Cache-Control', 'no-store')
        return res.status(204).end()
      }
      // ── p2p_operator: the relayer's PUBLIC address, which sellers name as
      // their sell ad's auto-accept operator (escrow V3). Address only.
      if (req.query.p2p_operator) {
        const operator = await relayerAddress()
        if (!operator) return res.status(503).json({ error: 'Relayer is not configured' })
        res.setHeader('Cache-Control', 'public, max-age=300')
        return res.status(200).json({ operator })
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
        // Only the signed-in account's own withdrawals (anyone could read any
        // wallet's pending recoveries with just its address before).
        const asked = String(req.query.ub_pending_recoveries)
        if (!/^0x[0-9a-fA-F]{40}$/.test(asked)) return res.status(400).json({ error: 'invalid wallet' })
        const wallet = await sessionWallet(req)
        if (!wallet) return res.status(401).json({ error: 'Not signed in' })
        if (wallet !== asked.toLowerCase()) return res.status(403).json({ error: 'Not your wallet' })
        res.setHeader('Cache-Control', 'no-store')
        const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim()
        const svcKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim()
        if (!supabaseUrl || !svcKey) return res.status(500).json({ error: 'server misconfigured' })
        const r = await fetch(
          `${supabaseUrl}/rest/v1/activity?activity_type=eq.withdraw&status=eq.pending&wallet_address=ilike.${encodeURIComponent(wallet)}&select=id,amount,created_at,metadata&order=created_at.desc&limit=20`,
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
      if (req.query.action === 'token_quote') return await tokenQuote(req, res)
      if (req.query.action === 'transfer_mint') return await transferMint(req, res)
      const chainKey = String(req.query.chain || '')
      const total = String(req.query.amount || '')
      if (!CHAINS[chainKey] || !routers()[chainKey]) return res.status(400).json({ error: 'Gasless bridging is not available for this chain' })
      if (!isUint(total) || BigInt(total) < MIN_TOTAL_UNITS) return res.status(400).json({ error: 'Minimum is 1 USDC' })
      const q = await quote(chainKey, BigInt(total))
      // fee / maxFee: Circle's forwarder mints (what older app builds sign).
      // relayerMint: MeshPort's relayer mints on Arc - no forwarding fee.
      return res.status(200).json({
        fee: q.fee.toString(), maxFee: q.maxFee.toString(), usdcName: q.usdcName, usdcVersion: q.usdcVersion,
        ...(q.direct ? { relayerMint: { fee: q.direct.fee.toString(), maxFee: q.direct.maxFee.toString() } } : {}),
      })
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
      const wallet = await sessionWallet(req)
      if (!wallet) return res.status(401).json({ error: 'Not authenticated' })
      if (!allowAction('scan', wallet)) return res.status(429).json({ error: 'Too many requests - try again in a few minutes' })
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
      // Only the claim's own wallet may kick it (audit 7 Nov H11: anyone with a
      // claim id could run the worker with the service key), within the relay limit.
      const caller = await sessionWallet(req)
      if (!caller) return res.status(403).json({ error: 'Not signed in' })
      if (!allowAction('scan', caller)) return res.status(429).json({ error: 'Too many requests - try again in a few minutes' })
      const own = await fetch(`${supabaseUrl}/rest/v1/claims?id=eq.${claimId}&select=wallet_address`, {
        headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` }, signal: AbortSignal.timeout(6_000),
      }).then(r => r.ok ? r.json() : []).catch(() => []) as Array<{ wallet_address?: string }>
      if (String(own[0]?.wallet_address ?? '').toLowerCase() !== caller) return res.status(403).json({ error: 'Not your claim' })
      const r = await fetch(`${supabaseUrl}/functions/v1/claim-worker`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${svcKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'single', claimId }),
      })
      const out = await r.json().catch(() => ({}))
      return res.status(r.ok ? 200 : r.status).json(out)
    }

    if ((req.body as any)?.action === 'call') return await relayCall(req, res)
    if ((req.body as any)?.action === 'token_relay') return await tokenRelay(req, res)
    if ((req.body as any)?.action === 'arc_transfer') return await arcTransfer(req, res)
    if ((req.body as any)?.action === 'transfer_mint_start') return await transferMintStart(req, res)

    // ── Relay ────────────────────────────────────────────────────────────
    const RELAY_STARTED_AT = Date.now()
    const { chain: chainKey, bridge: b, authorization: a } = (req.body ?? {}) as any
    const router = routers()[chainKey]
    if (!CHAINS[chainKey] || !router) return res.status(400).json({ error: 'Gasless bridging is not available for this chain' })
    if (!b || !a) return res.status(400).json({ error: 'Missing bridge or authorization' })
    if (!isHex(a.from, 20) || !isUint(a.value) || !isUint(a.validAfter) || !isUint(a.validBefore) || !isHex(a.signature, 65))
      return res.status(400).json({ error: 'Malformed authorization' })
    if (!isHex(b.token, 20) || !isHex(b.mintRecipient, 32) || !isUint(b.fee) || !isUint(b.maxFee) || !isHex(b.salt, 32) || !isHex(b.hookData))
      return res.status(400).json({ error: 'Malformed bridge parameters' })
    if (String(b.token).toLowerCase() !== CHAINS[chainKey].usdc.toLowerCase()) return res.status(400).json({ error: 'Only USDC can be bridged' })

    // Only self-bridges to Arc: through Circle's forwarder (forwarding hook),
    // or minted on Arc by this relayer (no hook - see mintOnArcAfterBurn).
    const { pad, parseSignature } = await import('viem')
    if (Number(b.destinationDomain) !== ARC_DOMAIN) return res.status(400).json({ error: 'Only bridging to Arc is supported' })
    const hook = String(b.hookData).toLowerCase()
    if (hook !== FORWARD_HOOK && hook !== '0x') return res.status(400).json({ error: 'Unsupported hook' })
    const relayerMints = hook === '0x'
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
    if (!allowRelay(session.wallet)) return res.status(429).json({ error: 'Too many requests - try again in a few minutes' })
    const block = spendBlock(session.canSpend)
    if (block) return res.status(block.status).json({ error: block.error })

    const c = CHAINS[chainKey]
    const { pub, wallet } = await clients(chainKey)
    if (!wallet) return res.status(503).json({ error: 'Relayer is not configured' })

    const bridgeArgs = {
      token: c.usdc,
      destinationDomain: ARC_DOMAIN, mintRecipient: b.mintRecipient as `0x${string}`, fee, maxFee,
      minFinalityThreshold: Number(b.minFinalityThreshold), hookData: (relayerMints ? '0x' : FORWARD_HOOK) as `0x${string}`, salt: b.salt as `0x${string}`,
    }
    // The quote and the balance don't depend on the nonce: started now, they
    // run while the nonce and its "already used" check are read (two rounds).
    const quoteP = quote(chainKey, value)
    const balP = pub.readContract({ address: c.usdc, abi: USDC_ABI, functionName: 'balanceOf', args: [a.from] }) as Promise<bigint>
    quoteP.catch(() => {}); balP.catch(() => {}) // surfaced where they are awaited below
    const nonce = await pub.readContract({ address: router, abi: ROUTER_ABI, functionName: 'bridgeNonce', args: [bridgeArgs] }) as `0x${string}`
    const used = await pub.readContract({ address: c.usdc, abi: USDC_ABI, functionName: 'authorizationState', args: [a.from, nonce] })
    // Already used → return the transaction that used it (safe retries).
    if (used) {
      const hit = await findBridged(pub, router, a.from, nonce)
      return hit ? res.status(200).json({ txHash: hit, alreadySubmitted: true })
        : res.status(409).json({ error: 'This transfer was already sent', alreadySubmitted: true })
    }

    const [now_q, bal] = await Promise.all([quoteP, balP])
    // The relayer must be able to mint on Arc for a hookless burn (else its quote said Circle's forwarder).
    if (relayerMints && !now_q.direct) return res.status(409).json({ error: 'Please try again', retryQuote: true })
    const want = relayerMints && now_q.direct ? now_q.direct : now_q
    // The fee must match today's quote (a little slack for moves since it) and never be below the live gas.
    if (!feeAcceptable(fee, want.fee, want.gasCost)) return res.status(400).json({ error: 'Fee too low - please try again' })
    if (maxFee * 100n < want.maxFee * 80n) return res.status(400).json({ error: 'Bridge fee too low - please try again' })

    if (bal < value) return res.status(400).json({ error: 'Not enough USDC on this chain' })

    const sig = parseSignature(a.signature)
    const v = sig.v !== undefined ? Number(sig.v) : 27 + (sig.yParity ?? 0)
    const authArgs = { from: a.from, value, validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), v, r: sig.r, s: sig.s }

    // Simulate first: a bad signature or changed parameter never costs gas.
    const { request } = await pub.simulateContract({
      account: wallet.account, address: router, abi: ROUTER_ABI, functionName: 'bridgeWithAuthorization', args: [bridgeArgs, authArgs],
    }).catch((e: any) => { throw Object.assign(new Error(e?.shortMessage || 'Transfer would fail'), { status: 400 }) })
    const txHash = await wallet.writeContract({ ...request, ...(await relayFees(pub, pub.chain.id)) })
    // Hookless: mint on Arc once Circle attests, after this response (the
    // function's 60 s limit; the app follows up if it runs out).
    const startMint = () => { if (relayerMints) waitUntil(mintOnArcAfterBurn(chainKey, txHash, RELAY_STARTED_AT + 55_000).catch(e => console.error('[bridge-relay] arc mint failed', e?.shortMessage || e?.message || e))) }

    // Wait briefly for the burn; if it's slow, it's submitted (not failed) - tracking takes over.
    try {
      const receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 40_000 })
      if (receipt.status !== 'success') return res.status(502).json({ error: 'Transaction reverted', txHash })
      startMint()
      return res.status(200).json({ txHash, mint: relayerMints ? 'relayer' : 'circle' })
    } catch {
      startMint()
      return res.status(200).json({ txHash, pending: true, mint: relayerMints ? 'relayer' : 'circle' })
    }
  } catch (e: any) {
    console.error('[bridge-relay]', e?.message || e)
    return res.status(e?.status || 500).json({ error: e?.status ? e.message : 'Relayer error' })
  }
}
