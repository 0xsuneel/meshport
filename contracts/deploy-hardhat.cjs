/**
 * MeshPortRewards — Hardhat Deploy Script
 *
 * BUG FIX: this script used to call getContractFactory('ArcPayRewards') —
 * a stale name from before the contract was renamed to MeshPortRewards
 * (contracts/MeshPortRewards.sol). No such contract has existed for a
 * while, so `npm run contract:deploy` was guaranteed to fail immediately.
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
 * 4. Copy the printed address into .env (and Vercel) as VITE_REWARDS_CONTRACT
 *
 * 5. REQUIRED post-deploy step (new — signature-gated claims): call
 *    setPointsSigner(<address>) as the owner, where <address> is the
 *    account whose private key is set as REWARDS_SIGNER_PRIVATE_KEY on the
 *    supabase/functions/rewards-claim-sign edge function. Until this is
 *    set, pointsSigner is address(0) and every claimRewards() call will
 *    revert with InvalidSignature.
 */

const { ethers } = require('hardhat')

const USDC_ADDRESS = '0x3600000000000000000000000000000000000000'

async function main() {
  const [deployer] = await ethers.getSigners()

  console.log('═══════════════════════════════════════════')
  console.log('  MeshPortRewards Contract Deployment')
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
  const Factory = await ethers.getContractFactory('MeshPortRewards')
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
  console.log('🔑  REQUIRED: call setPointsSigner(<signer address>) as owner — claimRewards()')
  console.log('    reverts with InvalidSignature until this is set. <signer address> must')
  console.log('    match REWARDS_SIGNER_PRIVATE_KEY on the rewards-claim-sign edge function.')
}

main().catch((err) => {
  console.error('\n❌ Deploy failed:', err.message)
  process.exit(1)
})
