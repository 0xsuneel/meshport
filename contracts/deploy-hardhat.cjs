/**
 * ArcPayRewards — Hardhat Deploy Script
 *
 * 1. Add your private key to .env:
 *      ADMIN_PRIVATE_KEY=0xyour_private_key_here
 *
 * 2. Compile the contract:
 *      npm run contract:compile
 *
 * 3. Deploy:
 *      npm run contract:deploy
 *
 * 4. Copy the printed address into .env as VITE_REWARDS_CONTRACT
 */

const { ethers } = require('hardhat')

const USDC_ADDRESS = '0x3600000000000000000000000000000000000000'

async function main() {
  const [deployer] = await ethers.getSigners()

  console.log('═══════════════════════════════════════════')
  console.log('  ArcPayRewards Contract Deployment')
  console.log('═══════════════════════════════════════════')
  console.log('Deployer :', deployer.address)

  const balance = await ethers.provider.getBalance(deployer.address)
  console.log('Balance  :', ethers.formatUnits(balance, 6), 'USDC (gas)')
  console.log('USDC     :', USDC_ADDRESS)
  console.log('───────────────────────────────────────────')

  if (balance === 0n) {
    console.error('\n❌  No balance for gas. Fund your wallet first.')
    process.exit(1)
  }

  console.log('\n📦  Deploying...')
  const Factory = await ethers.getContractFactory('ArcPayRewards')
  const contract = await Factory.deploy(USDC_ADDRESS)

  console.log('📡  Tx hash :', contract.deploymentTransaction()?.hash)
  console.log('⏳  Waiting for confirmation...')

  await contract.waitForDeployment()
  const address = await contract.getAddress()

  console.log('\n✅  Deployed successfully!')
  console.log('───────────────────────────────────────────')
  console.log('Contract address :', address)
  console.log('Explorer         :', `https://testnet.arcscan.app/address/${address}`)
  console.log('\n📋  Add this line to your .env file:')
  console.log('───────────────────────────────────────────')
  console.log(`VITE_REWARDS_CONTRACT=${address}`)
  console.log('───────────────────────────────────────────')
  console.log('\n💰  Next: send USDC to the contract address so users can claim rewards.')
}

main().catch((err) => {
  console.error('\n❌ Deploy failed:', err.message)
  process.exit(1)
})
