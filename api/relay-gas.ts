import type { VercelRequest, VercelResponse } from '@vercel/node'

const CHAIN_DEFS: Record<string, { id: number; name: string; rpc: string; symbol: string }> = {
  Ethereum_Sepolia: { id: 11155111, name: 'Ethereum Sepolia', rpc: 'https://ethereum-sepolia-rpc.publicnode.com', symbol: 'ETH' },
  Base_Sepolia:     { id: 84532,    name: 'Base Sepolia',     rpc: 'https://sepolia.base.org',                   symbol: 'ETH' },
  Arbitrum_Sepolia: { id: 421614,   name: 'Arbitrum Sepolia', rpc: 'https://sepolia-rollup.arbitrum.io/rpc',     symbol: 'ETH' },
  Optimism_Sepolia: { id: 11155420, name: 'OP Sepolia',       rpc: 'https://sepolia.optimism.io',                symbol: 'ETH' },
  Polygon_Sepolia:  { id: 80002,    name: 'Polygon Amoy',     rpc: 'https://polygon-amoy-bor-rpc.publicnode.com', symbol: 'MATIC' },
  Avalanche_Fuji:   { id: 43113,    name: 'Avalanche Fuji',   rpc: 'https://api.avax-test.network/ext/bc/C/rpc', symbol: 'AVAX' },
  HyperEVM_Testnet: { id: 998,      name: 'HyperEVM Testnet', rpc: 'https://rpc.hyperliquid-testnet.xyz/evm',    symbol: 'ETH' },
  Sei_Testnet:      { id: 1328,     name: 'Sei Testnet',      rpc: 'https://evm-rpc-testnet.sei-apis.com',       symbol: 'SEI' },
  Unichain_Sepolia: { id: 1301,     name: 'Unichain Sepolia', rpc: 'https://sepolia.unichain.org',               symbol: 'ETH' },
  // Added for Plume — Plume isn't on Circle's forwarder allow-list yet (see
  // FORWARDER_SUPPORTED_SDK_CHAINS in MultichainSendPage.tsx), so the app
  // submits the destination mint itself and needs this endpoint to fund gas.
  Plume_Testnet:    { id: 98867,    name: 'Plume Testnet',    rpc: 'https://testnet-rpc.plume.org',              symbol: 'PLUME' },
  // The rest of the chains outside Circle's forwarder allow-list — same
  // reasoning as Plume above. Chain IDs verified against each network's own
  // docs (not guessed) since a wrong id here would silently sign+broadcast
  // against the wrong chain.
  Pharos_Testnet:   { id: 688689,   name: 'Pharos Atlantic',  rpc: 'https://atlantic.dplabs-internal.com',       symbol: 'PHRS' },
  XDC_Apothem:      { id: 51,       name: 'XDC Apothem',      rpc: 'https://rpc.apothem.network',                symbol: 'TXDC' },
  Codex_Testnet:    { id: 812242,   name: 'Codex Testnet',    rpc: 'https://rpc.codex-stg.xyz',                  symbol: 'ETH' },
  Injective_Testnet:{ id: 1439,     name: 'Injective Testnet',rpc: 'https://k8s.testnet.json-rpc.injective.network', symbol: 'INJ' },
  Morph_Testnet:    { id: 2910,     name: 'Morph Hoodi',      rpc: 'https://rpc-hoodi.morphl2.io',               symbol: 'ETH' },
  // Edge_Testnet intentionally omitted: couldn't confirm its numeric chain ID
  // from an authoritative source (Alchemy's Edge rollup docs don't publish it
  // alongside the testnet RPC/explorer). Signing a tx with the wrong chain ID
  // either fails outright or — worse — silently replays on the wrong chain,
  // so add this once the real ID is confirmed rather than guessing:
  // Edge_Testnet: { id: <CONFIRM ME>, name: 'Edge Testnet', rpc: 'https://edge-testnet.g.alchemy.com/public', symbol: 'EDGE' },
}

// Fund user to 0.020 ETH — covers approve + depositFor (two txs) on any chain.
// OP Sepolia approve ~0.0001 ETH + depositFor ~0.0003 ETH per claim.
// 0.020 ETH gives ~50 claim operations before needing a top-up.
const TARGET_BALANCE = BigInt('20000000000000000')  // 0.020 ETH
const MIN_SEND       = BigInt('500000000000000')    // 0.0005 ETH — top-up even small deficits

function isValidAddress(a: string) { return /^0x[0-9a-fA-F]{40}$/.test(a) }

async function rpcCall(rpc: string, method: string, params: any[]): Promise<any> {
  const r = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10000),
  })
  const j = await r.json()
  if (j.error) throw new Error(j.error.message ?? JSON.stringify(j.error))
  return j.result
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Content-Type', 'application/json')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const { chainId, userAddress } = req.body ?? {}

    if (!chainId || !CHAIN_DEFS[chainId])
      return res.status(400).json({ error: `Unsupported chain: ${chainId}` })
    if (!userAddress || !isValidAddress(userAddress))
      return res.status(400).json({ error: 'Invalid address' })

    let relayKey = (process.env.RELAY_PRIVATE_KEY ?? '').trim()
    if (!relayKey)
      return res.status(200).json({ funded: false, reason: 'relay_not_configured' })
    if (!relayKey.startsWith('0x')) relayKey = '0x' + relayKey

    const chain = CHAIN_DEFS[chainId]
    console.log('[relay-gas] chain:', chainId, '| user:', userAddress)

    // Check user balance
    const userBalHex = await rpcCall(chain.rpc, 'eth_getBalance', [userAddress, 'latest'])
    const userBal    = BigInt(userBalHex)
    console.log('[relay-gas] user balance:', userBal.toString(), chain.symbol)

    // Already has enough gas — skip funding entirely
    const sendAmount = userBal < TARGET_BALANCE ? TARGET_BALANCE - userBal : BigInt(0)
    if (sendAmount < MIN_SEND) {
      console.log('[relay-gas] user already funded — skipping')
      return res.status(200).json({ funded: false, reason: 'sufficient', userBalance: userBal.toString() })
    }

    const { privateKeyToAccount } = await import('viem/accounts')
    const account = privateKeyToAccount(relayKey as `0x${string}`)
    console.log('[relay-gas] relay wallet:', account.address, '| sending:', sendAmount.toString(), 'wei')

    // Check relay balance
    const relayBalHex = await rpcCall(chain.rpc, 'eth_getBalance', [account.address, 'latest'])
    const relayBal    = BigInt(relayBalHex)
    if (relayBal < sendAmount + BigInt('21000000000000')) { // sendAmount + min gas
      console.warn('[relay-gas] relay underfunded — has:', relayBal.toString(), 'needs:', sendAmount.toString())
      return res.status(200).json({ funded: false, reason: 'relay_underfunded', chain: chain.name })
    }

    // Send ETH
    const { createWalletClient, http } = await import('viem')
    const viemChain = {
      id: chain.id,
      name: chain.name,
      nativeCurrency: { name: chain.symbol, symbol: chain.symbol, decimals: 18 },
      rpcUrls: { default: { http: [chain.rpc] } },
    } as const

    const walletClient = createWalletClient({ account, chain: viemChain, transport: http(chain.rpc) })
    const txHash = await walletClient.sendTransaction({
      to:    userAddress as `0x${string}`,
      value: sendAmount,
      kzg:   undefined,
    } as any)

    console.log('[relay-gas] ✓ ETH sent, txHash:', txHash)
    console.log('[relay-gas] returning immediately — deposit() will retry internally until ETH lands')

    // ── FIRE AND FORGET ──────────────────────────────────────────────────────
    // Do NOT wait for receipt. The Circle SDK deposit() has internal retry
    // logic and will wait for ETH to land (typically 5–15s on L2s).
    // Waiting here added 15–60s of unnecessary blocking per chain.
    return res.status(200).json({
      funded:  true,
      txHash,
      amount:  sendAmount.toString(),
      chain:   chain.name,
    })

  } catch (err: any) {
    console.error('[relay-gas] ERROR:', err?.message)
    console.error('[relay-gas] STACK:', err?.stack?.slice(0, 300))
    return res.status(500).json({ error: err?.message ?? 'Relay failed' })
  }
}
