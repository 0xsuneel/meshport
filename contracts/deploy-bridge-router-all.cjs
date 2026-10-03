// Deploy MeshPortBridgeRouter to every supported chain in one run — at the
// SAME address on all of them (CREATE2, see bridge-router-create2.cjs).
//
//   node contracts/deploy-bridge-router-all.cjs            check + deploy
//   node contracts/deploy-bridge-router-all.cjs --dry-run  checks only, no transactions
//   node contracts/deploy-bridge-router-all.cjs --chains=Base_Sepolia,Ethereum_Sepolia
//
// Reads from .env (or the environment):
//   ADMIN_PRIVATE_KEY   wallet that pays the deploy gas on each chain
//   FEE_RECIPIENT       MeshPort's fee wallet (part of the address — keep it fixed)
//   BRIDGE_RPC_<CHAIN>  optional RPC override, e.g. BRIDGE_RPC_BASE_SEPOLIA
//
// Before spending gas on a chain it checks that: the RPC really is that chain,
// Circle's TokenMessengerV2 exists there, its USDC supports EIP-3009, the
// CREATE2 deployer exists, and the deploy wallet has gas. A chain that fails a
// check is skipped with the reason; the rest still deploy. Already-deployed
// chains are detected and left alone, so it is safe to run again (e.g. after
// funding a skipped chain). At the end it prints the value for
// VITE_BRIDGE_ROUTERS and BRIDGE_ROUTERS (Vercel).

require('dotenv').config()
const { createPublicClient, createWalletClient, http, defineChain, concat, getAddress, formatEther } = require('viem')
const { privateKeyToAccount } = require('viem/accounts')
const { CREATE2_DEPLOYER, SALT, TOKEN_MESSENGER_V2_TESTNET, initCode, predictRouterAddress } = require('./bridge-router-create2.cjs')

// Chain ids and USDC addresses as verified in src/blockchain/chains.ts
// (EXTERNAL_CHAINS); only chains with a verified chain id are listed.
// src/lib/gaslessBridge.test.ts checks this table stays in sync.
const CHAINS = {
  Ethereum_Sepolia:  { chainId: 11155111, usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', rpc: 'https://ethereum-sepolia-rpc.publicnode.com' },
  Base_Sepolia:      { chainId: 84532,    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', rpc: 'https://sepolia.base.org' },
  Arbitrum_Sepolia:  { chainId: 421614,   usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', rpc: 'https://sepolia-rollup.arbitrum.io/rpc' },
  Optimism_Sepolia:  { chainId: 11155420, usdc: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7', rpc: 'https://sepolia.optimism.io' },
  Polygon_Sepolia:   { chainId: 80002,    usdc: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582', rpc: 'https://polygon-amoy-bor-rpc.publicnode.com' },
  Avalanche_Fuji:    { chainId: 43113,    usdc: '0x5425890298aed601595a70AB815c96711a31Bc65', rpc: 'https://api.avax-test.network/ext/bc/C/rpc' },
  HyperEVM_Testnet:  { chainId: 998,      usdc: '0x2B3370eE501B4a559b57D449569354196457D8Ab', rpc: 'https://rpcs.chain.link/hyperevm/testnet' },
  Sei_Testnet:       { chainId: 1328,     usdc: '0x4fCF1784B31630811181f670Aea7A7bEF803eaED', rpc: 'https://evm-rpc-testnet.sei-apis.com' },
  Unichain_Sepolia:  { chainId: 1301,     usdc: '0x31d0220469e10c4E71834a79b1f276d740d3768F', rpc: 'https://sepolia.unichain.org' },
  Morph_Testnet:     { chainId: 2910,     usdc: '0x7433b41C6c5e1d58D4Da99483609520255ab661B', rpc: 'https://rpc-hoodi.morphl2.io' },
  Pharos_Testnet:    { chainId: 688689,   usdc: '0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B', rpc: 'https://atlantic.dplabs-internal.com' },
  Plume_Testnet:     { chainId: 98867,    usdc: '0xcB5f30e335672893c7eb944B374c196392C19D18', rpc: 'https://testnet-rpc.plume.org' },
  XDC_Apothem:       { chainId: 51,       usdc: '0xb5AB69F7bBada22B28e79C8FFAECe55eF1c771D4', rpc: 'https://rpc.apothem.network' },
  Codex_Testnet:     { chainId: 812242,   usdc: '0x6d7f141b6819C2c9CC2f818e6ad549E7Ca090F8f', rpc: 'https://rpc.codex-stg.xyz' },
  Monad_Testnet:     { chainId: 10143,    usdc: '0x534b2f3A21130d7a60830c2Df862319e593943A3', rpc: 'https://testnet-rpc.monad.xyz' },
  Sonic_Testnet:     { chainId: 14601,    usdc: '0x0BA304580ee7c9a980CF72e55f5Ed2E9fd30Bc51', rpc: 'https://rpc.testnet.soniclabs.com' },
  World_Chain_Sepolia: { chainId: 4801,   usdc: '0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88', rpc: 'https://worldchain-sepolia.g.alchemy.com/public' },
  Linea_Sepolia:     { chainId: 59141,    usdc: '0xFEce4462D57bD51A6A552365A011b95f0E16d9B7', rpc: 'https://rpc.sepolia.linea.build' },
  Ink_Testnet:       { chainId: 763373,   usdc: '0xFabab97dCE620294D2B0b0e46C68964e326300Ac', rpc: 'https://rpc-gel-sepolia.inkonchain.com' },
  Injective_Testnet: { chainId: 1439,     usdc: '0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d', rpc: 'https://k8s.testnet.json-rpc.injective.network' },
}

const ROUTER_ABI = [
  { type: 'function', name: 'feeRecipient', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'tokenMessenger', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
]
const USDC_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'authorizationState', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'bytes32' }], outputs: [{ type: 'bool' }] },
]

const hasCode = (code) => !!code && code !== '0x'

async function deployOn(key, cfg, account, feeRecipient, router, dryRun) {
  const rpc = process.env[`BRIDGE_RPC_${key.toUpperCase()}`] || cfg.rpc
  const chain = defineChain({ id: cfg.chainId, name: key, nativeCurrency: { name: 'Native', symbol: 'NATIVE', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } })
  const pub = createPublicClient({ chain, transport: http(rpc, { timeout: 20_000 }) })

  const id = await pub.getChainId()
  if (id !== cfg.chainId) return { ok: false, reason: `RPC is chain ${id}, expected ${cfg.chainId}` }
  if (hasCode(await pub.getCode({ address: router }))) return { ok: true, status: 'already deployed' }
  if (!hasCode(await pub.getCode({ address: TOKEN_MESSENGER_V2_TESTNET }))) return { ok: false, reason: 'no CCTP V2 TokenMessenger on this chain' }
  try {
    await pub.readContract({ address: cfg.usdc, abi: USDC_ABI, functionName: 'authorizationState', args: [account.address, SALT] })
  } catch { return { ok: false, reason: 'USDC does not support EIP-3009 (not Circle FiatToken)' } }
  if (!hasCode(await pub.getCode({ address: CREATE2_DEPLOYER }))) return { ok: false, reason: 'CREATE2 deployer not present on this chain' }
  const balance = await pub.getBalance({ address: account.address })
  if (balance === 0n) return { ok: false, reason: `deploy wallet has no gas on this chain (${account.address})` }
  if (dryRun) return { ok: true, status: `ready (balance ${formatEther(balance)})`, dry: true }

  const wallet = createWalletClient({ chain, transport: http(rpc, { timeout: 20_000 }), account })
  const hash = await wallet.sendTransaction({ to: CREATE2_DEPLOYER, data: concat([SALT, initCode(TOKEN_MESSENGER_V2_TESTNET, feeRecipient)]) })
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
  if (receipt.status !== 'success') return { ok: false, reason: `deploy transaction reverted (${hash})` }
  if (!hasCode(await pub.getCode({ address: router }))) return { ok: false, reason: `no code at ${router} after deploy (${hash})` }

  // Verify before anyone relies on it.
  const [fee, messenger] = await Promise.all([
    pub.readContract({ address: router, abi: ROUTER_ABI, functionName: 'feeRecipient' }),
    pub.readContract({ address: router, abi: ROUTER_ABI, functionName: 'tokenMessenger' }),
  ])
  if (getAddress(fee) !== getAddress(feeRecipient) || getAddress(messenger) !== getAddress(TOKEN_MESSENGER_V2_TESTNET)) {
    return { ok: false, reason: 'deployed contract has unexpected settings' }
  }
  return { ok: true, status: `deployed (${hash})` }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const only = (process.argv.find(a => a.startsWith('--chains=')) || '').slice('--chains='.length).split(',').filter(Boolean)
  let pk = (process.env.ADMIN_PRIVATE_KEY || '').trim()
  if (!pk) throw new Error('Set ADMIN_PRIVATE_KEY (the wallet that pays deploy gas)')
  if (!pk.startsWith('0x')) pk = `0x${pk}`
  const account = privateKeyToAccount(pk)
  const feeRecipient = getAddress((process.env.FEE_RECIPIENT || account.address).trim())
  const router = predictRouterAddress(feeRecipient)

  console.log(`Router address on every chain: ${router}`)
  console.log(`Fee recipient: ${feeRecipient}   Deploy wallet: ${account.address}${dryRun ? '   (dry run)' : ''}\n`)

  const enabled = {}
  for (const [key, cfg] of Object.entries(CHAINS)) {
    if (only.length && !only.includes(key)) continue
    let r
    try { r = await deployOn(key, cfg, account, feeRecipient, router, dryRun) }
    catch (e) { r = { ok: false, reason: (e && (e.shortMessage || e.message)) || String(e) } }
    console.log(`${r.ok ? '✔' : '✗'} ${key.padEnd(18)} ${r.ok ? r.status : `skipped — ${r.reason}`}`)
    if (r.ok && !r.dry) enabled[key] = router
  }

  if (dryRun) return console.log('\nDry run only — nothing was deployed.')
  const json = JSON.stringify(enabled)
  console.log(`\n${Object.keys(enabled).length} chain(s) ready. Set BOTH in Vercel (Production + Preview), then redeploy:`)
  console.log(`  VITE_BRIDGE_ROUTERS=${json}`)
  console.log(`  BRIDGE_ROUTERS=${json}`)
  console.log('The relayer wallet also needs gas on each of these chains.')
}

if (require.main === module) main().catch(e => { console.error(e.message || e); process.exit(1) })
module.exports = { CHAINS }
