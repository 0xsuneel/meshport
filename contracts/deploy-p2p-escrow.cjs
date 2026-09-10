/**
 * P2PEscrow — Hardhat Deploy Script
 *
 * 1. Add your private key to .env (same one used for ArcPayRewards is fine):
 *      ADMIN_PRIVATE_KEY=0xyour_private_key_here
 *
 * 2. Compile:
 *      npm run contract:compile
 *
 * 3. Deploy:
 *      npx hardhat run contracts/deploy-p2p-escrow.cjs --network arcTestnet
 *
 * 4. Copy the printed address into .env as VITE_P2P_ESCROW_CONTRACT —
 *    this is what lib/p2pProviders.ts's escrow provider actually calls.
 *    Without this set, EscrowProvider falls back to the honor-system
 *    behavior it already had (documented clearly in-app, not silently) —
 *    see the fallback comment in p2pProviders.ts.
 */

const { ethers } = require('hardhat')

async function main() {
  const [deployer] = await ethers.getSigners()

  console.log('═══════════════════════════════════════════')
  console.log('  P2PEscrow Contract Deployment')
  console.log('═══════════════════════════════════════════')
  console.log('Deployer :', deployer.address)

  const balance = await ethers.provider.getBalance(deployer.address)
  console.log('Balance  :', ethers.formatUnits(balance, 18), 'USDC (gas — native on Arc)')

  const P2PEscrow = await ethers.getContractFactory('P2PEscrow')
  const escrow = await P2PEscrow.deploy()
  await escrow.waitForDeployment()

  const address = await escrow.getAddress()
  console.log('───────────────────────────────────────────')
  console.log('Deployed at:', address)
  console.log('Admin      :', deployer.address)
  console.log('───────────────────────────────────────────')
  console.log('Next step: add this to .env —')
  console.log(`VITE_P2P_ESCROW_CONTRACT=${address}`)
  console.log('═══════════════════════════════════════════')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
