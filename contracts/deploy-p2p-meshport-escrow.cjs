/**
 * P2PMeshportEscrow — Hardhat Deploy Script
 *
 * Deploys the NEW role-based escrow contract (contracts/P2PMeshportEscrow.sol),
 * which replaces the single-admin P2PEscrow.sol. See the contract's own
 * header comment for the full reasoning — short version: pause/freeze
 * power is now separate from fund-moving admin power, so your everyday
 * admin-panel wallet can pause directly without ever holding fund-moving
 * authority.
 *
 * ── 1. Set your deployer key ──────────────────────────────────────────────
 * Add to .env (this wallet becomes the contract's `admin` — pick your
 * SAFEST wallet for this, not your everyday admin-panel one):
 *
 *      ADMIN_PRIVATE_KEY=0xyour_private_key_here
 *
 * ── 2. Optionally set who gets PAUSER access immediately ─────────────────
 * If set, the deploy script also grants pauser rights in the same run —
 * this should be your everyday admin-panel wallet, the one you actually
 * click "Emergency Pause" from:
 *
 *      INITIAL_PAUSER_ADDRESS=0x05d00ab75bcbe15450143f810cd5e5164ee126e0
 *
 * (You can always add/remove pausers later via addPauser()/removePauser()
 * from the admin wallet — this just saves a second transaction now.)
 *
 * ── 3. Compile ─────────────────────────────────────────────────────────────
 *      npm run contract:compile
 *
 * ── 4. Deploy ──────────────────────────────────────────────────────────────
 *      npx hardhat run contracts/deploy-p2p-meshport-escrow.cjs --network arcTestnet
 *
 * ── 5. Wire it up ──────────────────────────────────────────────────────────
 * Copy the printed address into your env (both locally AND in Vercel's
 * project settings, since that's where the live app actually reads it
 * from) as:
 *
 *      VITE_P2P_ESCROW_CONTRACT=<printed address>
 *
 * ── 6. Migrate ─────────────────────────────────────────────────────────────
 * This is a FRESH contract with no funds and no history. Any USDC still
 * sitting in the OLD P2PEscrow contract needs to be withdrawn there first
 * (sellers use withdrawRemaining(), or admin does it on their behalf) —
 * this script does not touch or migrate the old contract's balances.
 * Once switched over, new offers/deposits go to this new contract only.
 */

const { ethers } = require('hardhat')

async function main() {
  const [deployer] = await ethers.getSigners()
  const initialPauser = process.env.INITIAL_PAUSER_ADDRESS || ''

  console.log('═══════════════════════════════════════════')
  console.log('  P2PMeshportEscrow Contract Deployment')
  console.log('═══════════════════════════════════════════')
  console.log('Deployer (becomes admin):', deployer.address)

  const balance = await ethers.provider.getBalance(deployer.address)
  console.log('Balance  :', ethers.formatUnits(balance, 18), 'USDC (gas — native on Arc)')

  const P2PMeshportEscrow = await ethers.getContractFactory('P2PMeshportEscrow')
  const escrow = await P2PMeshportEscrow.deploy()
  await escrow.waitForDeployment()

  const address = await escrow.getAddress()
  console.log('───────────────────────────────────────────')
  console.log('Deployed at:', address)
  console.log('Admin      :', deployer.address, '(fund-moving power)')

  if (initialPauser) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(initialPauser)) {
      console.log('WARNING: INITIAL_PAUSER_ADDRESS is not a valid address, skipping addPauser().')
    } else {
      console.log('Granting PAUSER role to:', initialPauser, '...')
      const tx = await escrow.addPauser(initialPauser)
      await tx.wait()
      console.log('Pauser granted. tx:', tx.hash)
    }
  } else {
    console.log('No INITIAL_PAUSER_ADDRESS set — remember to call addPauser(yourAdminWallet)')
    console.log('from the admin wallet before relying on pause from the admin panel.')
  }

  console.log('───────────────────────────────────────────')
  console.log('Next step: add this to .env AND Vercel project env vars —')
  console.log(`VITE_P2P_ESCROW_CONTRACT=${address}`)
  console.log('═══════════════════════════════════════════')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
