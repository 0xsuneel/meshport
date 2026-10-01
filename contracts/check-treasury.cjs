/**
 * Check ArcPayRewards Treasury Balance
 *
 * Read-only — does not send any transaction.
 * Prints the treasury's USDC balance and (if ADMIN_PRIVATE_KEY is set)
 * the admin wallet's USDC balance too, so you know how much you can
 * top up with.
 *
 * Usage (PowerShell):
 *   node contracts\check-treasury.cjs
 *
 * Usage (bash):
 *   node contracts/check-treasury.cjs
 *
 * Requirements:
 *   - VITE_REWARDS_CONTRACT set in .env
 *   - ADMIN_PRIVATE_KEY is optional — if present, also shows admin balance
 */

require('dotenv').config()
const { createPublicClient, http, formatUnits } = require('viem')
const { privateKeyToAccount } = require('viem/accounts')

const RPC_URL          = 'https://rpc.testnet.arc.network'
const USDC_CONTRACT    = '0x3600000000000000000000000000000000000000'
const REWARDS_CONTRACT = process.env.VITE_REWARDS_CONTRACT
const PRIVATE_KEY      = process.env.ADMIN_PRIVATE_KEY

const ARC_CHAIN = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
  rpcUrls: { default: { http: [RPC_URL] }, public: { http: [RPC_URL] } },
}

const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
]

async function main() {
  if (!REWARDS_CONTRACT) {
    console.error('❌  Set VITE_REWARDS_CONTRACT in .env')
    process.exit(1)
  }

  const publicClient = createPublicClient({ chain: ARC_CHAIN, transport: http(RPC_URL) })

  console.log('═══════════════════════════════════════════')
  console.log('  ArcPayRewards Treasury Balance')
  console.log('═══════════════════════════════════════════')
  console.log('Rewards contract :', REWARDS_CONTRACT)

  const treasuryBal = await publicClient.readContract({
    address: USDC_CONTRACT, abi: ERC20_ABI, functionName: 'balanceOf', args: [REWARDS_CONTRACT],
  })
  console.log('Treasury balance :', formatUnits(treasuryBal, 6), 'USDC')

  if (PRIVATE_KEY && PRIVATE_KEY !== '0xyour_admin_wallet_private_key') {
    const account = privateKeyToAccount(PRIVATE_KEY)
    const adminBal = await publicClient.readContract({
      address: USDC_CONTRACT, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address],
    })
    console.log('───────────────────────────────────────────')
    console.log('Admin wallet     :', account.address)
    console.log('Admin balance    :', formatUnits(adminBal, 6), 'USDC')
  } else {
    console.log('───────────────────────────────────────────')
    console.log('(Set ADMIN_PRIVATE_KEY in .env to also see your admin wallet balance)')
  }

  console.log('\nExplorer: https://testnet.arcscan.app/address/' + REWARDS_CONTRACT)
}

main().catch(err => {
  console.error('\n❌  Failed:', err.shortMessage || err.message)
  process.exit(1)
})
