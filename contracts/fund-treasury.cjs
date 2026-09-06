/**
 * Fund ArcPayRewards Treasury
 *
 * Sends USDC to the rewards contract via ERC-20 transfer().
 * On Arc, you MUST use ERC-20 transfer — not a native send.
 *
 * Usage:
 *   node contracts/fund-treasury.cjs <amount>
 *
 * Example — fund with 50 USDC:
 *   node contracts/fund-treasury.cjs 50
 *
 * Requirements:
 *   - ADMIN_PRIVATE_KEY set in .env
 *   - VITE_REWARDS_CONTRACT set in .env
 *   - Admin wallet must have enough USDC
 */

require('dotenv').config()
const { createWalletClient, createPublicClient, http, parseUnits, formatUnits } = require('viem')
const { privateKeyToAccount } = require('viem/accounts')

const RPC_URL          = 'https://rpc.testnet.arc.network'
const USDC_CONTRACT    = '0x3600000000000000000000000000000000000000'
const REWARDS_CONTRACT = process.env.VITE_REWARDS_CONTRACT
const PRIVATE_KEY      = process.env.ADMIN_PRIVATE_KEY
const AMOUNT_USDC      = process.argv[2] || '10' // default 10 USDC

const ARC_CHAIN = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
  rpcUrls: { default: { http: [RPC_URL] }, public: { http: [RPC_URL] } },
}

const ERC20_ABI = [
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
]

async function main() {
  if (!PRIVATE_KEY) { console.error('❌  Set ADMIN_PRIVATE_KEY in .env'); process.exit(1) }
  if (!REWARDS_CONTRACT) { console.error('❌  Set VITE_REWARDS_CONTRACT in .env'); process.exit(1) }

  const account = privateKeyToAccount(PRIVATE_KEY)
  const amount  = parseUnits(AMOUNT_USDC, 6)

  const publicClient = createPublicClient({ chain: ARC_CHAIN, transport: http(RPC_URL) })
  const walletClient = createWalletClient({ account, chain: ARC_CHAIN, transport: http(RPC_URL) })

  console.log('═══════════════════════════════════════════')
  console.log('  Fund ArcPayRewards Treasury')
  console.log('═══════════════════════════════════════════')
  console.log('Admin wallet     :', account.address)
  console.log('Rewards contract :', REWARDS_CONTRACT)
  console.log('Amount           :', AMOUNT_USDC, 'USDC')

  // Check admin balance
  const adminBal = await publicClient.readContract({
    address: USDC_CONTRACT, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address],
  })
  console.log('Admin balance    :', formatUnits(adminBal, 6), 'USDC')

  if (adminBal < amount) {
    console.error(`❌  Not enough USDC. Have ${formatUnits(adminBal, 6)}, need ${AMOUNT_USDC}`)
    console.error('   Get testnet USDC from: https://faucet.circle.com')
    process.exit(1)
  }

  // Check current treasury balance
  const beforeBal = await publicClient.readContract({
    address: USDC_CONTRACT, abi: ERC20_ABI, functionName: 'balanceOf', args: [REWARDS_CONTRACT],
  })
  console.log('Treasury before  :', formatUnits(beforeBal, 6), 'USDC')
  console.log('───────────────────────────────────────────')

  console.log('\n📦  Sending USDC via ERC-20 transfer()...')

  // Must use ERC-20 transfer() — NOT native send (Arc requirement)
  const hash = await walletClient.writeContract({
    address: USDC_CONTRACT,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [REWARDS_CONTRACT, amount],
  })

  console.log('📡  Tx hash :', hash)
  console.log('⏳  Waiting for confirmation...')

  await publicClient.waitForTransactionReceipt({ hash })

  // Check new treasury balance
  const afterBal = await publicClient.readContract({
    address: USDC_CONTRACT, abi: ERC20_ABI, functionName: 'balanceOf', args: [REWARDS_CONTRACT],
  })

  console.log('\n✅  Treasury funded successfully!')
  console.log('───────────────────────────────────────────')
  console.log('Treasury after   :', formatUnits(afterBal, 6), 'USDC')
  console.log('Explorer         :', `https://testnet.arcscan.app/tx/${hash}`)
  console.log('\nUsers can now claim rewards! 🎉')
}

main().catch(err => {
  console.error('\n❌  Failed:', err.shortMessage || err.message)
  process.exit(1)
})
