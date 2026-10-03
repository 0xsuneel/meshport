// api/bridge-relay.ts — MeshPort's gasless bridge relayer (Vercel).
//
// Stateless: it holds no user funds, keeps no job state, and can only submit
// what a user signed (or what Circle attested). Three actions:
//
//   GET  ?action=quote&chain=Base_Sepolia&amount=<USDC base units>
//        → { fee, maxFee, usdcName, usdcVersion }
//        fee    = MeshPort fee (relayer's source-chain gas, in USDC, + margin)
//        maxFee = CCTP V2 maxFee (protocol fee + Circle forwarding fee, + margin)
//
//   POST { action:'relay', chain, bridge, authorization }
//        Checks the request, simulates MeshPortBridgeRouter.bridgeWithAuthorization,
//        submits it with the relayer key (paying source-chain gas) and returns
//        { txHash } — the CCTP burn. Idempotent: an authorization that was
//        already used returns the transaction that used it.
//
//   POST { action:'call', chain, to, data }
//        Submits, from the relayer wallet, one of a few calls whose outcome
//        doesn't depend on who sends them — so the user needs no gas:
//          · Circle Gateway Wallet deposits signed by the user
//            (depositWithAuthorization / depositWithPermit; the depositor
//            must be the signed-in user's wallet)
//          · Gateway Minter gatewayMint(attestation, signature)
//          · CCTP V2 MessageTransmitter receiveMessage(message, attestation)
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
//   BRIDGE_MIN_FEE_UNITS        optional fee floor in USDC base units (default 50000 = 0.05)
//   SUPABASE_URL, SUPABASE_SERVICE_KEY  session → wallet ownership check

import type { VercelRequest, VercelResponse } from '@vercel/node'

const ARC_DOMAIN = 26
const FORWARD_HOOK = '0x636374702d666f72776172640000000000000000000000000000000000000000'
const IRIS = 'https://iris-api-sandbox.circle.com'
const ROUTER_GAS = 260_000n           // receiveWithAuthorization + transfer + approve + depositForBurnWithHook
const MAX_AUTH_WINDOW_SEC = 2 * 60 * 60
const MIN_TOTAL_UNITS = 1_000_000n    // 1 USDC

// Chain id, USDC and CCTP domain per chain — from src/blockchain/chains.ts
// (EXTERNAL_CHAINS, verified ids only) and Circle's domain table;
// src/lib/gaslessBridge.test.ts checks this stays in sync. `gasUsd` is a rough
// USD price of the chain's gas token, only used to turn gas into a USDC fee
// (override per chain with BRIDGE_NATIVE_USD_<CHAIN>; the fee floor applies anyway).
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

const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://cvvpzfvzweszuuxvaayb.supabase.co').trim()
const SERVICE_KEY  = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()

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

/** The wallet of the caller's Supabase session, or null when not signed in. */
async function sessionWallet(req: VercelRequest): Promise<string | null> {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token || !SERVICE_KEY) return null
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } })
  if (!r.ok) return null
  const u = await r.json().catch(() => null) as { id?: string } | null
  if (!u?.id) return null
  const ur = await fetch(`${SUPABASE_URL}/rest/v1/users?auth_uid=eq.${u.id}&select=wallet_address`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  })
  const rows = ur.ok ? await ur.json().catch(() => []) as Array<{ wallet_address?: string }> : []
  return rows[0]?.wallet_address ? rows[0].wallet_address.toLowerCase() : null
}

/** The caller's Supabase session must own `address`. */
async function sessionOwns(req: VercelRequest, address: string): Promise<boolean> {
  return (await sessionWallet(req)) === address.toLowerCase()
}

async function clients(chainKey: string) {
  const { createPublicClient, createWalletClient, http, defineChain } = await import('viem')
  const c = CHAINS[chainKey]
  const rpc = process.env[`BRIDGE_RPC_${chainKey.toUpperCase()}`] || c.rpc
  const chain = defineChain({ id: c.id, name: c.name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } })
  const pub: any = createPublicClient({ chain, transport: http(rpc, { timeout: 15_000 }) })
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
const EXTRA_RPCS: Record<string, string> = {
  Arc_Testnet:         'https://rpc.testnet.arc.network',
  Sonic_Testnet:       'https://rpc.testnet.soniclabs.com',
  World_Chain_Sepolia: 'https://worldchain-sepolia.g.alchemy.com/public',
  Linea_Sepolia:       'https://rpc.sepolia.linea.build',
  Ink_Testnet:         'https://rpc-gel-sepolia.inkonchain.com',
  Monad_Testnet:       'https://testnet-rpc.monad.xyz',
  Edge_Testnet:        'https://edge-testnet.g.alchemy.com/public',
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
  { type: 'function', name: 'gatewayMint', stateMutability: 'nonpayable', outputs: [], inputs: [
    { name: 'attestationPayload', type: 'bytes' }, { name: 'signature', type: 'bytes' }] },
  { type: 'function', name: 'receiveMessage', stateMutability: 'nonpayable', outputs: [{ type: 'bool' }], inputs: [
    { name: 'message', type: 'bytes' }, { name: 'attestation', type: 'bytes' }] },
] as const

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
    return null
  }
  if (call.functionName === 'gatewayMint') return target === GATEWAY_MINTER ? null : 'This call cannot be relayed'
  if (call.functionName === 'receiveMessage') return target === MESSAGE_TRANSMITTER_V2 ? null : 'This call cannot be relayed'
  return 'This call cannot be relayed'
}

/** Public + relayer wallet client for any chain a relayed call can run on (chain id read from the RPC). */
async function callClients(chainKey: string) {
  const { createPublicClient, createWalletClient, http, defineChain } = await import('viem')
  const rpc = process.env[`BRIDGE_RPC_${chainKey.toUpperCase()}`] || CHAINS[chainKey]?.rpc || EXTRA_RPCS[chainKey]
  if (!rpc) return null
  const probe: any = createPublicClient({ transport: http(rpc, { timeout: 15_000 }) })
  const id = await probe.getChainId()
  const chain = defineChain({ id, name: chainKey, nativeCurrency: { name: 'Native', symbol: 'NATIVE', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } })
  const pub: any = createPublicClient({ chain, transport: http(rpc, { timeout: 15_000 }) })
  let key = (process.env.BRIDGE_RELAYER_PRIVATE_KEY || '').trim()
  if (key && !key.startsWith('0x')) key = '0x' + key
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) return { pub, wallet: null as any }
  const { privateKeyToAccount } = await import('viem/accounts')
  const wallet: any = createWalletClient({ chain, transport: http(rpc, { timeout: 15_000 }), account: privateKeyToAccount(key as `0x${string}`) })
  return { pub, wallet }
}

async function relayCall(req: VercelRequest, res: VercelResponse) {
  const { chain, to, data } = (req.body ?? {}) as any
  const chainKey = CHAIN_ALIASES[chain] ?? String(chain || '')
  if (!isHex(to, 20) || !isHex(data) || data.length < 10) return res.status(400).json({ error: 'Malformed call' })
  const caller = await sessionWallet(req)
  if (!caller) return res.status(403).json({ error: 'Not signed in' })
  const reason = await checkRelayable(to, data, caller)
  if (reason) return res.status(400).json({ error: reason })
  const cl = await callClients(chainKey)
  if (!cl) return res.status(400).json({ error: 'This chain is not supported' })
  if (!cl.wallet) return res.status(503).json({ error: 'Relayer is not configured' })

  // Simulate first: an already-used or invalid signature/attestation never costs gas.
  try { await cl.pub.call({ account: cl.wallet.account, to, data }) }
  catch (e: any) { return res.status(400).json({ error: e?.shortMessage || 'Call would fail' }) }
  const txHash = await cl.wallet.sendTransaction({ to, data })
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

/** MeshPort's fee: the relayer's gas for the router call, priced in USDC, with margin and a floor. */
async function relayFee(pub: any, chainKey: string): Promise<bigint> {
  const gasPrice: bigint = await pub.getGasPrice()
  const nativeUsd = Number(process.env[`BRIDGE_NATIVE_USD_${chainKey.toUpperCase()}`] || CHAINS[chainKey].gasUsd)
  // wei → USDC units: wei * usd / 1e18 * 1e6 = wei * usd / 1e12
  const units = (ROUTER_GAS * gasPrice * BigInt(Math.round(nativeUsd * 100))) / 100n / 1_000_000_000_000n
  const withMargin = (units * 130n) / 100n
  const floor = BigInt(process.env.BRIDGE_MIN_FEE_UNITS || '50000')
  // Testnet gas has no real value, but priced at mainnet rates a busy chain
  // (Ethereum Sepolia) came out over 1 USDC — above the app's 5% fee limit,
  // so every quote there was rejected. Capped so the fee stays small.
  const cap = BigInt(process.env.BRIDGE_MAX_FEE_UNITS || '100000')
  const fee = withMargin > floor ? withMargin : floor
  return fee > cap ? cap : fee
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
    // ── Quote ────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const chainKey = String(req.query.chain || '')
      const total = String(req.query.amount || '')
      if (!CHAINS[chainKey] || !routers()[chainKey]) return res.status(400).json({ error: 'Gasless bridging is not available for this chain' })
      if (!isUint(total) || BigInt(total) < MIN_TOTAL_UNITS) return res.status(400).json({ error: 'Minimum is 1 USDC' })
      const q = await quote(chainKey, BigInt(total))
      return res.status(200).json({ fee: q.fee.toString(), maxFee: q.maxFee.toString(), usdcName: q.usdcName, usdcVersion: q.usdcVersion })
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
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

    if (!(await sessionOwns(req, a.from))) return res.status(403).json({ error: 'Not signed in to this wallet' })

    const c = CHAINS[chainKey]
    const { pub, wallet } = await clients(chainKey)
    if (!wallet) return res.status(503).json({ error: 'Relayer is not configured' })

    const bridgeArgs = {
      token: c.usdc,
      destinationDomain: ARC_DOMAIN, mintRecipient: b.mintRecipient as `0x${string}`, fee, maxFee,
      minFinalityThreshold: Number(b.minFinalityThreshold), hookData: FORWARD_HOOK as `0x${string}`, salt: b.salt as `0x${string}`,
    }
    const nonce = await pub.readContract({ address: router, abi: ROUTER_ABI, functionName: 'bridgeNonce', args: [bridgeArgs] }) as `0x${string}`

    // Already used → return the transaction that used it (safe retries).
    const used = await pub.readContract({ address: c.usdc, abi: USDC_ABI, functionName: 'authorizationState', args: [a.from, nonce] })
    if (used) {
      const logs = await pub.getContractEvents({ address: router, abi: ROUTER_ABI, eventName: 'Bridged', args: { from: a.from, nonce }, fromBlock: 'earliest' }).catch(() => [])
      const hit = (logs as any[])[0]
      return hit ? res.status(200).json({ txHash: hit.transactionHash, alreadySubmitted: true })
        : res.status(409).json({ error: 'This authorization was already used' })
    }

    // The fee must still cover the relayer's gas (some slack for price moves since the quote).
    const now_q = await quote(chainKey, value)
    if (fee * 100n < now_q.fee * 80n) return res.status(400).json({ error: 'Fee too low — please try again' })
    if (maxFee * 100n < now_q.maxFee * 80n) return res.status(400).json({ error: 'Bridge fee too low — please try again' })

    const bal = await pub.readContract({ address: c.usdc, abi: USDC_ABI, functionName: 'balanceOf', args: [a.from] }) as bigint
    if (bal < value) return res.status(400).json({ error: 'Not enough USDC on this chain' })

    const sig = parseSignature(a.signature)
    const v = sig.v !== undefined ? Number(sig.v) : 27 + (sig.yParity ?? 0)
    const authArgs = { from: a.from, value, validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), v, r: sig.r, s: sig.s }

    // Simulate first: a bad signature or changed parameter never costs gas.
    const { request } = await pub.simulateContract({
      account: wallet.account, address: router, abi: ROUTER_ABI, functionName: 'bridgeWithAuthorization', args: [bridgeArgs, authArgs],
    }).catch((e: any) => { throw Object.assign(new Error(e?.shortMessage || 'Transfer would fail'), { status: 400 }) })
    const txHash = await wallet.writeContract(request)

    // Wait briefly for the burn; if it's slow, it's submitted (not failed) — tracking takes over.
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
