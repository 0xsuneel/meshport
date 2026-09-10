/**
 * P2PMeshportEscrowV2 — Hardhat Deploy Script (2-of-3 role manager multisig)
 *
 * Deploys the security-hardened V2 escrow contract
 * (contracts/P2PMeshportEscrowV2.sol). See the contract's own header
 * comment for the full list of what changed — short version: the
 * offer-key front-run hijack is fixed, release() no longer trusts
 * caller-supplied buyer/amount, disputes go through a real three-tier
 * Pauser -> Investigator -> Admin flow with per-dispute independence
 * enforced on-chain, and — new in this version — NO role
 * (Pauser/Investigator/Admin) can be granted, removed, or transferred by
 * Admin unilaterally anymore. Every role change requires 2-of-3
 * confirmations from three fixed, independent ROLE MANAGER signers set
 * ONCE at deployment, right here.
 *
 * ── This is a NEW contract at a NEW address ───────────────────────────────
 * Not an upgrade of any previously-deployed contract — plain Solidity
 * contracts aren't upgradeable in place. Any USDC already escrowed
 * elsewhere stays there; deploying this does not move it.
 *
 * ── REQUIRED: three genuinely separate role manager signer addresses ────
 * Add to .env:
 *
 *      ADMIN_PRIVATE_KEY=0xyour_deployer_key_here
 *      ROLE_MANAGER_1=0x...
 *      ROLE_MANAGER_2=0x...
 *      ROLE_MANAGER_3=0x...
 *
 * These three addresses become the contract's PERMANENT role manager
 * signers (see roleManagerSigners()/isRoleManagerSigner() on the deployed
 * contract — there is no function to change them in this version; treat
 * them as fixed for this deployment's lifetime). They must be:
 *   - Three DISTINCT, non-zero addresses (the contract enforces this at
 *     construction and this script also checks it before spending gas).
 *   - Held by three genuinely different, independent people/systems —
 *     nothing on-chain can verify this, but it's the entire point. Using
 *     the deployer's own address, or three keys actually controlled by
 *     the same person, defeats the whole mechanism this script exists to
 *     set up correctly.
 *   - NOT the same as whoever ends up holding Pauser/Investigator/Admin —
 *     the role manager signers' only power is voting on role changes; they
 *     are a genuinely separate authority from the roles they manage.
 *
 * This script REFUSES to deploy if any two of the three are identical or
 * any is the zero address — this is a hard stop, not a warning, because a
 * misconfigured multisig here is exactly the "admin can unilaterally
 * destroy separation of duties" problem this whole redesign exists to fix.
 *
 * ── After deployment: bootstrapping the first roles ───────────────────────
 * The contract starts with ZERO pausers/investigators — not even the
 * deployer. If ROLE_MANAGER_1 and ROLE_MANAGER_2's private keys are ALSO
 * available in this environment (ROLE_MANAGER_1_KEY / ROLE_MANAGER_2_KEY,
 * separate from the addresses above), this script will optionally submit
 * and confirm the first AddPauser/AddInvestigator proposals for you. This
 * is entirely optional and skipped by default — in most real deployments,
 * the three role manager keys should NOT all be sitting in the same
 * deploy environment, and the first role grants should happen afterward,
 * signer-by-signer, from the Role Managers admin panel instead.
 *
 * ── Compile / Deploy ───────────────────────────────────────────────────────
 *      npm run contract:compile
 *      npx hardhat run contracts/deploy-p2p-meshport-escrow-v2.cjs --network arcTestnet
 *
 * ── Wire it up ─────────────────────────────────────────────────────────────
 * Copy the printed address into env (locally AND in Vercel's project
 * settings):
 *
 *      VITE_P2P_ESCROW_CONTRACT=<printed address>
 */

const { ethers } = require('hardhat')

function assertValidAddress(name, value) {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} is missing or not a valid address: "${value}"`)
  }
}

async function main() {
  const [deployer] = await ethers.getSigners()

  const rm1 = process.env.ROLE_MANAGER_1 || ''
  const rm2 = process.env.ROLE_MANAGER_2 || ''
  const rm3 = process.env.ROLE_MANAGER_3 || ''

  console.log('═══════════════════════════════════════════')
  console.log('  P2PMeshportEscrowV2 Contract Deployment')
  console.log('  (2-of-3 role manager multisig)')
  console.log('═══════════════════════════════════════════')
  console.log('Deployer (becomes admin):', deployer.address)

  // ── Hard validation — refuse to deploy a misconfigured multisig ────────
  assertValidAddress('ROLE_MANAGER_1', rm1)
  assertValidAddress('ROLE_MANAGER_2', rm2)
  assertValidAddress('ROLE_MANAGER_3', rm3)
  const signers = [rm1.toLowerCase(), rm2.toLowerCase(), rm3.toLowerCase()]
  if (new Set(signers).size !== 3) {
    throw new Error('ROLE_MANAGER_1/2/3 must be three DISTINCT addresses — refusing to deploy a multisig where the same key can confirm its own proposal twice under a different label.')
  }
  if (signers.includes(deployer.address.toLowerCase())) {
    console.log('WARNING: the deployer address is also one of the three role manager')
    console.log('         signers. This is allowed (the contract does not forbid it),')
    console.log('         but it means this deployment does NOT yet have three fully')
    console.log('         independent role manager signers — replace this signer with')
    console.log('         a genuinely separate address before relying on this for')
    console.log('         real separation-of-duties guarantees.')
  }

  const balance = await ethers.provider.getBalance(deployer.address)
  console.log('Balance  :', ethers.formatUnits(balance, 18), 'USDC (gas — native on Arc)')
  console.log('Role manager signers:')
  console.log('  1:', rm1)
  console.log('  2:', rm2)
  console.log('  3:', rm3)
  console.log('  (2 of these 3 must confirm any future role change)')

  const P2PMeshportEscrowV2 = await ethers.getContractFactory('P2PMeshportEscrowV2')
  const escrow = await P2PMeshportEscrowV2.deploy([rm1, rm2, rm3])
  await escrow.waitForDeployment()

  const address = await escrow.getAddress()
  console.log('───────────────────────────────────────────')
  console.log('Deployed at:', address)
  console.log('Admin      :', deployer.address, '(dispute-resolution power only — no role-granting power)')
  console.log('Pausers    : none yet')
  console.log('Investigators: none yet')
  console.log('  -> Every role must be granted via a 2-of-3 role manager proposal.')
  console.log('     Use the Role Managers admin panel, or set ROLE_MANAGER_1_KEY/')
  console.log('     ROLE_MANAGER_2_KEY below to bootstrap the first roles now.')

  // ── Optional: bootstrap the first roles right now, if 2 of the 3 role
  // manager PRIVATE KEYS (not just addresses) are available in this env.
  // Skipped by default -- see this file's own header on why.
  const rm1Key = process.env.ROLE_MANAGER_1_KEY || ''
  const rm2Key = process.env.ROLE_MANAGER_2_KEY || ''
  const initialPauser = process.env.INITIAL_PAUSER_ADDRESS || ''
  const initialInvestigator = process.env.INITIAL_INVESTIGATOR_ADDRESS || ''

  if (rm1Key && rm2Key && (initialPauser || initialInvestigator)) {
    const signer1 = new ethers.Wallet(rm1Key, ethers.provider)
    const signer2 = new ethers.Wallet(rm2Key, ethers.provider)
    if (signer1.address.toLowerCase() !== rm1.toLowerCase() || signer2.address.toLowerCase() !== rm2.toLowerCase()) {
      console.log('WARNING: ROLE_MANAGER_1_KEY/ROLE_MANAGER_2_KEY do not match ROLE_MANAGER_1/2 addresses — skipping bootstrap.')
    } else {
      async function grantRole(actionIndex, target, label) {
        console.log(`Proposing ${label} for ${target} (signer 1)...`)
        const tx1 = await escrow.connect(signer1).proposeRoleChange(actionIndex, target)
        await tx1.wait()
        const proposalId = (await escrow.roleProposalCount()) - 1n
        console.log(`Confirming proposal #${proposalId} (signer 2)...`)
        const tx2 = await escrow.connect(signer2).confirmRoleChange(proposalId)
        await tx2.wait()
        console.log(`${label} executed. tx: ${tx2.hash}`)
      }
      if (initialPauser) await grantRole(0, initialPauser, 'AddPauser')
      if (initialInvestigator) {
        if (initialInvestigator.toLowerCase() !== initialPauser.toLowerCase()) {
          await grantRole(0, initialInvestigator, 'AddPauser (investigator prerequisite)')
        }
        await grantRole(2, initialInvestigator, 'AddInvestigator')
      }
    }
  } else {
    console.log('No role-manager private keys provided — skipping automatic bootstrap.')
    console.log('Grant the first Pauser/Investigator from the Role Managers admin panel.')
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
