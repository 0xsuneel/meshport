/**
 * /api/relay-deposit  —  Fully gasless deposit relayer
 *
 * Relay wallet (server-side RELAY_PRIVATE_KEY) calls depositFor() so the
 * USER pays zero ETH gas. USDC is debited from userAddress on-chain and
 * credited to their Circle Unified Balance.
 *
 * Must be .js (CommonJS) — the Circle SDK pulls in rpc-websockets which has
 * a uuid ESM incompatibility that crashes .ts compiled-to-CJS files.
 * swap-proxy.js uses the same Module._load stub pattern to work around it.
 */

// ── Stub out problematic ESM-only transitive deps before any require() ────────
const Module = require('module')
const _origLoad = Module._load
Module._load = function (id, ...args) {
  if (id === 'rpc-websockets' || id.startsWith('rpc-websockets/'))
    return {
      Client: class {
        constructor() {}
        on() {}
        removeListener() {}
        send() {}
        close() {}
      },
    }
  if (id === '@solana/web3.js')
    return {
      Connection: class {},
      PublicKey: class { constructor(k) { this.toString = () => k } },
      Transaction: class {},
      clusterApiUrl: () => '',
      LAMPORTS_PER_SOL: 1e9,
    }
  return _origLoad.apply(this, [id, ...args])
}

// drpc.live API key — set DRPC_KEY in Vercel environment variables (never
// VITE_-prefixed — must stay server-side only).
const DRPC_KEY = process.env.DRPC_KEY ?? ''

// Optional explicit authenticated RPC URL override — set ARC_RPC_URL (NOT
// VITE_ARC_RPC_URL) in Vercel. VITE_-prefixed vars are bundled into the
// client and are never read here.
const CONFIGURED_ARC_RPC_URL = (process.env.ARC_RPC_URL || '').trim()

// Arc RPC list — authenticated endpoint (when configured) tried first for
// its higher rate limits, then Circle's own official public Arc Testnet RPC
// endpoints as fallback (free, keyless, Circle-operated — see
// https://docs.arc.io/arc/references/connect-to-arc). Kept in sync manually
// with api/arc-rpc.js and api/swap-proxy.js since this is an isolated
// CommonJS Vercel function.
const ARC_RPCS = [
  ...(CONFIGURED_ARC_RPC_URL ? [CONFIGURED_ARC_RPC_URL] : []),
  ...(DRPC_KEY ? [`https://lb.drpc.live/arc-testnet/${DRPC_KEY}`] : []), // dRPC authenticated (higher limits)
  'https://rpc.testnet.arc.network',
  'https://rpc.blockdaemon.testnet.arc.network',
  'https://rpc.drpc.testnet.arc.network',
  'https://rpc.quicknode.testnet.arc.network',
]

// ── RPC endpoints keyed by Circle SDK chain.name ──────────────────────────────
const RPC_BY_CHAIN_NAME = {
  // Ethereum Sepolia
  'Ethereum Sepolia':     'https://ethereum-sepolia-rpc.publicnode.com',
  'Ethereum_Sepolia':     'https://ethereum-sepolia-rpc.publicnode.com',
  // Base Sepolia
  'Base Sepolia':         'https://sepolia.base.org',
  'Base_Sepolia':         'https://sepolia.base.org',
  // Arbitrum Sepolia
  'Arbitrum Sepolia':     'https://sepolia-rollup.arbitrum.io/rpc',
  'Arbitrum_Sepolia':     'https://sepolia-rollup.arbitrum.io/rpc',
  // Optimism Sepolia — SDK may send either name
  'OP Sepolia':           'https://sepolia.optimism.io',
  'Optimism Sepolia':     'https://sepolia.optimism.io',
  'Optimism_Sepolia':     'https://sepolia.optimism.io',
  // Polygon Amoy
  'Polygon PoS Amoy':     'https://polygon-amoy-bor-rpc.publicnode.com',
  'Polygon Amoy':         'https://polygon-amoy-bor-rpc.publicnode.com',
  'Polygon_Amoy_Testnet': 'https://polygon-amoy-bor-rpc.publicnode.com',
  // Avalanche Fuji
  'Avalanche Fuji':       'https://api.avax-test.network/ext/bc/C/rpc',
  'Avalanche_Fuji':       'https://api.avax-test.network/ext/bc/C/rpc',
  // HyperEVM Testnet
  'HyperEVM Testnet':     'https://rpc.hyperliquid-testnet.xyz/evm',
  'HyperEVM_Testnet':     'https://rpc.hyperliquid-testnet.xyz/evm',
  // Sei Testnet
  'Sei Testnet':          'https://evm-rpc-testnet.sei-apis.com',
  'Sei_Testnet':          'https://evm-rpc-testnet.sei-apis.com',
  // Sonic Testnet
  'Sonic Testnet':        'https://rpc.testnet.soniclabs.com',
  'Sonic_Testnet':        'https://rpc.testnet.soniclabs.com',
  // Unichain Sepolia
  'Unichain Sepolia':     'https://sepolia.unichain.org',
  'Unichain_Sepolia':     'https://sepolia.unichain.org',
  // World Chain Sepolia
  'World Chain Sepolia':  'https://worldchain-sepolia.g.alchemy.com/public',
  'World_Chain_Sepolia':  'https://worldchain-sepolia.g.alchemy.com/public',
  // Arc Testnet — intentionally not listed here; getProvider() routes Arc
  // through ARC_RPCS (fallback across multiple endpoints) before falling
  // back to this single-URL map.
}

// ── Client chainId → Circle SDK UnifiedBalanceChain enum value ────────────────
const CHAIN_ID_TO_SDK = {
  Ethereum_Sepolia:    'Ethereum_Sepolia',
  Base_Sepolia:        'Base_Sepolia',
  Arbitrum_Sepolia:    'Arbitrum_Sepolia',
  Optimism_Sepolia:    'Optimism_Sepolia',
  Polygon_Sepolia:     'Polygon_Amoy_Testnet',
  Avalanche_Fuji:      'Avalanche_Fuji',
  HyperEVM_Testnet:    'HyperEVM_Testnet',
  Sei_Testnet:         'Sei_Testnet',
  Sonic_Testnet:       'Sonic_Testnet',
  Unichain_Sepolia:    'Unichain_Sepolia',
  World_Chain_Sepolia: 'World_Chain_Sepolia',
}

const SUPPORTED_CHAINS = new Set(Object.keys(CHAIN_ID_TO_SDK))
const MAX_AMOUNT = parseFloat(process.env.RELAY_MAX_AMOUNT_USDC || '1000')

function isValidAddress(addr) {
  return /^0x[0-9a-fA-F]{40}$/.test(addr)
}

async function buildRelayAdapter(privateKey) {
  const { createEthersAdapterFromPrivateKey } = require('@circle-fin/adapter-ethers-v6')
  const { JsonRpcProvider, FallbackProvider } = require('ethers')

  return createEthersAdapterFromPrivateKey({
    privateKey,
    getProvider: ({ chain }) => {
      if (chain.name === 'Arc Testnet' || chain.name === 'Arc_Testnet') {
        console.log(`[relay-deposit] getProvider chain="${chain.name}" → ARC_RPCS (${ARC_RPCS.length} endpoints, fallback)`)
        // Static network — Arc's chain ID is fixed, so skip ethers' eth_chainId
        // auto-detect call. Left undetected, a single failed detection makes
        // ethers v6 retry it every ~1s forever, which on its own is enough
        // extra traffic to keep a rate-limited RPC key rate-limited.
        const ARC_NETWORK = { chainId: 5042002, name: 'arc-testnet' }
        // quorum: 1 — treat this purely as failover, not multi-node consensus
        return new FallbackProvider(ARC_RPCS.map(url => new JsonRpcProvider(url, ARC_NETWORK, { staticNetwork: true })), undefined, { quorum: 1 })
      }
      const rpcUrl = RPC_BY_CHAIN_NAME[chain.name]
                  || (chain.rpcEndpoints && chain.rpcEndpoints[0])
                  || ARC_RPCS[0]
      console.log(`[relay-deposit] getProvider chain="${chain.name}" → ${rpcUrl}`)
      return new JsonRpcProvider(rpcUrl)
    },
  })
}

module.exports = async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*'
  const requestOrigin = req.headers.origin || ''
  const isDev         = requestOrigin.includes('localhost')
  res.setHeader('Access-Control-Allow-Origin',  isDev ? requestOrigin : allowedOrigin)
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' })

  const { chainId, amount, userAddress } = req.body || {}

  if (!chainId || !SUPPORTED_CHAINS.has(chainId))
    return res.status(400).json({
      error: `Unsupported chainId: ${chainId}. Supported: ${[...SUPPORTED_CHAINS].join(', ')}`,
    })

  const amtNum = parseFloat(amount)
  if (!amount || isNaN(amtNum) || amtNum <= 0)
    return res.status(400).json({ error: 'Invalid amount' })
  if (amtNum > MAX_AMOUNT)
    return res.status(400).json({ error: `Amount ${amtNum} exceeds relay limit of ${MAX_AMOUNT} USDC` })
  if (!userAddress || !isValidAddress(userAddress))
    return res.status(400).json({ error: 'Invalid userAddress' })

  let relayKey = (process.env.RELAY_PRIVATE_KEY || '').trim()
  if (!relayKey) {
    console.error('[relay-deposit] RELAY_PRIVATE_KEY not set')
    return res.status(500).json({ error: 'Relay not configured — RELAY_PRIVATE_KEY missing' })
  }
  if (!relayKey.startsWith('0x')) relayKey = '0x' + relayKey

  const sdkChain  = CHAIN_ID_TO_SDK[chainId]
  const amountStr = amtNum.toFixed(2)

  console.log(`[relay-deposit] chain=${sdkChain} amount=${amountStr} user=${userAddress}`)

  try {
    const { AppKit } = require('@circle-fin/app-kit')
    const kit        = new AppKit({ clientKey: process.env.KIT_KEY, disableErrorReporting: true })
    const adapter    = await buildRelayAdapter(relayKey)

    const result = await kit.unifiedBalance.depositFor({
      from:           { adapter, chain: sdkChain },
      amount:         amountStr,
      token:          'USDC',
      depositAccount: userAddress,
    })

    console.log('[relay-deposit] depositFor succeeded:', JSON.stringify(result))

    return res.status(200).json({
      success:     true,
      txHash:      result && result.txHash      ? result.txHash      : '',
      explorerUrl: result && result.explorerUrl ? result.explorerUrl : '',
      amount:      result && result.amount      ? result.amount      : amountStr,
      chain:       sdkChain,
      depositedTo: userAddress,
    })
  } catch (e) {
    const msg = (e && (e.shortMessage || e.message || e.reason)) || String(e)
    console.error('[relay-deposit] depositFor error:', msg)
    console.error('[relay-deposit] stack:', e && e.stack ? e.stack.slice(0, 500) : '')
    return res.status(500).json({ error: msg, chain: sdkChain })
  }
}
