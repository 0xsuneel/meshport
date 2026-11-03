// Deploy MeshPortCheckout on Arc (merchant payments with MeshPort's fee taken
// in the same transaction - contracts/MeshPortCheckout.sol).
//
//   node contracts/deploy-checkout.cjs --dry-run   checks only
//   node contracts/deploy-checkout.cjs             deploy + verify
//
// Reads from .env (or the environment):
//   ADMIN_PRIVATE_KEY   wallet that pays the deploy gas (USDC on Arc)
//   FEE_RECIPIENT       where the fee goes - MeshPort's RELAYER wallet (it pays gas)
//   CHECKOUT_FEE_BPS    optional, default 60 (0.6%) - at most 500 (the contract refuses more)
//   CHECKOUT_FEE_CAP    optional, in USD, default 3
//   BRIDGE_RPC_ARC_TESTNET optional RPC override
// Compiled with the local solcjs (contracts/compile-solcjs.cjs) - no download.
// At the end it prints VITE_MESHPORT_CHECKOUT and MESHPORT_CHECKOUT for Vercel
// and Supabase.

require('dotenv').config()
const { createPublicClient, createWalletClient, http, defineChain, getAddress, parseEther, formatEther, encodeDeployData } = require('viem')
const { privateKeyToAccount } = require('viem/accounts')
const path = require('path')
const { execFileSync } = require('child_process')
const fs = require('fs')

const ARC = defineChain({
  id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.BRIDGE_RPC_ARC_TESTNET || 'https://rpc.testnet.arc.io'] } },
})

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  let pk = (process.env.ADMIN_PRIVATE_KEY || '').trim()
  if (!pk) throw new Error('Set ADMIN_PRIVATE_KEY (the wallet that pays deploy gas)')
  if (!pk.startsWith('0x')) pk = `0x${pk}`
  const account = privateKeyToAccount(pk)
  if (!process.env.FEE_RECIPIENT) throw new Error('Set FEE_RECIPIENT to the relayer wallet address (the fee pays its gas)')
  const feeRecipient = getAddress(process.env.FEE_RECIPIENT.trim())
  const bps = BigInt(process.env.CHECKOUT_FEE_BPS || 60)
  const cap = parseEther(String(process.env.CHECKOUT_FEE_CAP || 3))
  if (bps > 500n) throw new Error('CHECKOUT_FEE_BPS above 500 (5%) - the contract refuses it')

  execFileSync('node', [path.join(__dirname, 'compile-solcjs.cjs'), 'MeshPortCheckout.sol'], { stdio: 'inherit' })
  const art = JSON.parse(fs.readFileSync(path.join(__dirname, 'artifacts/contracts/MeshPortCheckout.sol/MeshPortCheckout.json'), 'utf8'))

  const pub = createPublicClient({ chain: ARC, transport: http(undefined, { timeout: 20_000 }) })
  if (await pub.getChainId() !== ARC.id) throw new Error('RPC is not Arc testnet')
  const balance = await pub.getBalance({ address: account.address })
  console.log(`Deploy wallet ${account.address}: ${formatEther(balance)} USDC on Arc`)
  console.log(`Fee: ${Number(bps) / 100}% (cap $${formatEther(cap)}) → ${feeRecipient}`)
  if (balance === 0n) throw new Error('The deploy wallet has no USDC on Arc for gas')
  if (dryRun) return console.log('\nDry run only - nothing was deployed.')

  const wallet = createWalletClient({ chain: ARC, transport: http(undefined, { timeout: 20_000 }), account })
  const hash = await wallet.sendTransaction({ data: encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args: [feeRecipient, bps, cap] }) })
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`Deploy failed (${hash})`)
  const address = receipt.contractAddress
  const read = (functionName) => pub.readContract({ address, abi: art.abi, functionName })
  const [fr, fb, fc] = await Promise.all([read('feeRecipient'), read('feeBps'), read('feeCap')])
  if (getAddress(fr) !== feeRecipient || fb !== bps || fc !== cap) throw new Error('Deployed contract has unexpected settings')
  console.log(`\n✔ MeshPortCheckout deployed at ${address} (${hash})`)
  console.log('Set in Vercel (Production + Preview) and in Supabase Edge Function secrets, then redeploy:')
  console.log(`  VITE_MESHPORT_CHECKOUT=${address}`)
  console.log(`  MESHPORT_CHECKOUT=${address}`)
}

main().catch(e => { console.error(e.shortMessage || e.message || e); process.exit(1) })
