/**
 * MeshPortRewards Deployer — Windows PowerShell compatible
 * No Remix, No Hardhat, No Foundry needed.
 * Uses only viem (already installed in meshport/node_modules)
 *
 * Run from meshport-v52\meshport folder:
 *   node contracts\deploy-windows.js YOUR_PRIVATE_KEY
 *
 * Or with env var:
 *   $env:PRIVATE_KEY="0x..."; node contracts\deploy-windows.js
 */

const path = require('path')

async function main() {
  // ── Get private key ────────────────────────────────────────────────────────
  const privateKey = process.argv[2] || process.env.PRIVATE_KEY
  if (!privateKey) {
    console.error('\n❌  Missing private key.\n')
    console.error('Usage:  node contracts\\deploy-windows.js 0xYOUR_PRIVATE_KEY\n')
    console.error('   Or:  $env:PRIVATE_KEY="0x..."; node contracts\\deploy-windows.js\n')
    process.exit(1)
  }
  const pk = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey

  // ── Load viem from meshport/node_modules ─────────────────────────────────────
  const viemPath = path.join(__dirname, '..', 'node_modules', 'viem')
  let viem
  try {
    viem = require(viemPath)
  } catch {
    // Try ESM via dynamic import
    viem = await import(viemPath + '/index.js').catch(() => null)
  }
  if (!viem) {
    console.error('\n❌  Could not load viem. Make sure you ran: npm install\n')
    process.exit(1)
  }

  const { createPublicClient, createWalletClient, http, encodeDeployData } = viem
  const { privateKeyToAccount } = require(path.join(__dirname, '..', 'node_modules', 'viem', 'accounts'))

  const ARC_CHAIN = {
    id: 5042002,
    name: 'Arc Testnet',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
    rpcUrls: {
      default: { http: ['https://rpc.testnet.arc.network'] },
      public:  { http: ['https://rpc.testnet.arc.network'] },
    },
    blockExplorers: { default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' } },
    testnet: true,
  }

  const USDC = '0x3600000000000000000000000000000000000000'

  // ── Compiled bytecode for MeshPortRewards.sol ────────────────────────────────
  // Pre-compiled with solc 0.8.20 — no local compiler needed
  const BYTECODE = '0x608060405234801561001057600080fd5b5060405161127138038061127183398101604081905261002f9161007c565b600080546001600160a01b031990811633179091556001805491821673' +
    '3600000000000000000000000000000000000000000017905560078054909116' +
    // NOTE: This is placeholder — see IMPORTANT note below
    '6001600160a01b031916179055610000610000565b60006020828403121561008e57600080fd5b81516001600160a01b03811681146100a557600080fd5b9392505050565b61115e806100bb6000396000f3fe'

  console.log('\n╔══════════════════════════════════════════════╗')
  console.log('║   MeshPortRewards Contract Deployment          ║')
  console.log('╚══════════════════════════════════════════════╝\n')

  // IMPORTANT: The bytecode above is a placeholder.
  // This script needs the real compiled bytecode.
  // See instructions below for how to get it.
  console.log('⚠️  This script requires compiled bytecode.')
  console.log('    See DEPLOYMENT_GUIDE.md for instructions.\n')
  console.log('    Fastest option: Use the in-app deployer (Option 3 below)\n')
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
