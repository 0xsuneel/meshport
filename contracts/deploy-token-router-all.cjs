// Deploy MeshPortTokenRouter (EURC / cirBTC Bring through MeshPort's
// relayer) to every CCTPx testnet chain, at the SAME address on all of them
// (CREATE2, see token-router-create2.cjs).
//
//   node contracts/deploy-token-router-all.cjs            check + deploy
//   node contracts/deploy-token-router-all.cjs --dry-run  checks only
//   node contracts/deploy-token-router-all.cjs --chains=Base_Sepolia
//
// Reads ADMIN_PRIVATE_KEY (pays deploy gas), FEE_RECIPIENT (MeshPort's fee
// wallet - part of the address, keep it fixed; the same as for the USDC
// router) and optional BRIDGE_RPC_<CHAIN> overrides. Before spending gas it
// checks the RPC is that chain, Circle's CCTPx service and the CREATE2
// deployer exist there, and the deploy wallet has gas. Already-deployed
// chains are left alone. Prints the value for VITE_TOKEN_ROUTERS and
// TOKEN_ROUTERS (Vercel).

require('dotenv').config()
const { createPublicClient, createWalletClient, http, defineChain, concat, getAddress, formatEther } = require('viem')
const { privateKeyToAccount } = require('viem/accounts')
const { CREATE2_DEPLOYER, SALT, CCTPX_SERVICE_TESTNET, initCode, predictTokenRouterAddress } = require('./token-router-create2.cjs')
const { CHAINS: ALL } = require('./deploy-bridge-router-all.cjs')

// The CCTPx-eligible testnets MeshPort lists (src/lib/tokenBridge.ts).
const KEYS = ['Ethereum_Sepolia', 'Base_Sepolia', 'Arbitrum_Sepolia', 'Optimism_Sepolia', 'Polygon_Sepolia', 'Avalanche_Fuji']

const ROUTER_ABI = [
  { type: 'function', name: 'feeRecipient', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'service', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
]
const hasCode = (code) => !!code && code !== '0x'

async function deployOn(key, cfg, account, feeRecipient, router, dryRun) {
  const rpc = process.env[`BRIDGE_RPC_${key.toUpperCase()}`] || cfg.rpc
  const chain = defineChain({ id: cfg.chainId, name: key, nativeCurrency: { name: 'Native', symbol: 'NATIVE', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } })
  const pub = createPublicClient({ chain, transport: http(rpc, { timeout: 20_000 }) })

  const id = await pub.getChainId()
  if (id !== cfg.chainId) return { ok: false, reason: `RPC is chain ${id}, expected ${cfg.chainId}` }
  if (hasCode(await pub.getCode({ address: router }))) return { ok: true, status: 'already deployed' }
  if (!hasCode(await pub.getCode({ address: CCTPX_SERVICE_TESTNET }))) return { ok: false, reason: "no Circle CCTPx service on this chain" }
  if (!hasCode(await pub.getCode({ address: CREATE2_DEPLOYER }))) return { ok: false, reason: 'CREATE2 deployer not present on this chain' }
  const balance = await pub.getBalance({ address: account.address })
  if (balance === 0n) return { ok: false, reason: `deploy wallet has no gas on this chain (${account.address})` }
  if (dryRun) return { ok: true, status: `ready (balance ${formatEther(balance)})`, dry: true }

  const wallet = createWalletClient({ chain, transport: http(rpc, { timeout: 20_000 }), account })
  const hash = await wallet.sendTransaction({ to: CREATE2_DEPLOYER, data: concat([SALT, initCode(CCTPX_SERVICE_TESTNET, feeRecipient)]) })
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
  if (receipt.status !== 'success') return { ok: false, reason: `deploy transaction reverted (${hash})` }
  if (!hasCode(await pub.getCode({ address: router }))) return { ok: false, reason: `no code at ${router} after deploy (${hash})` }

  const [fee, service] = await Promise.all([
    pub.readContract({ address: router, abi: ROUTER_ABI, functionName: 'feeRecipient' }),
    pub.readContract({ address: router, abi: ROUTER_ABI, functionName: 'service' }),
  ])
  if (getAddress(fee) !== getAddress(feeRecipient) || getAddress(service) !== getAddress(CCTPX_SERVICE_TESTNET)) {
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
  const router = predictTokenRouterAddress(feeRecipient)

  console.log(`Token router address on every chain: ${router}`)
  console.log(`Fee recipient: ${feeRecipient}   Deploy wallet: ${account.address}${dryRun ? '   (dry run)' : ''}\n`)

  const enabled = {}
  for (const key of KEYS) {
    if (only.length && !only.includes(key)) continue
    let r
    try { r = await deployOn(key, ALL[key], account, feeRecipient, router, dryRun) }
    catch (e) { r = { ok: false, reason: (e && (e.shortMessage || e.message)) || String(e) } }
    console.log(`${r.ok ? '✔' : '✗'} ${key.padEnd(18)} ${r.ok ? r.status : `skipped — ${r.reason}`}`)
    if (r.ok && !r.dry) enabled[key] = router
  }

  if (dryRun) return console.log('\nDry run only — nothing was deployed.')
  const json = JSON.stringify(enabled)
  console.log(`\n${Object.keys(enabled).length} chain(s) ready. Set BOTH in Vercel (Production + Preview), then redeploy:`)
  console.log(`  VITE_TOKEN_ROUTERS=${json}`)
  console.log(`  TOKEN_ROUTERS=${json}`)
  console.log('The relayer wallet (BRIDGE_RELAYER_PRIVATE_KEY) pays gas and Circle\'s fee on these chains - keep it funded.')
}

if (require.main === module) main().catch(e => { console.error(e.message || e); process.exit(1) })
