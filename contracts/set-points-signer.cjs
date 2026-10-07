/**
 * MeshPortRewards — set the points signer (owner only)
 *
 * Registers the address the rewards-claim-sign edge function signs claims
 * with: the Circle developer-controlled wallet (REWARDS_SIGNER_WALLET_ID,
 * see scripts/create-rewards-signer-wallet.mjs) or, legacy, the account of
 * REWARDS_SIGNER_PRIVATE_KEY. Until this is set, every claimRewards() call
 * reverts with InvalidSignature.
 *
 * .env:
 *   ADMIN_PRIVATE_KEY=0x...        (the wallet that owns the contract)
 *   VITE_REWARDS_CONTRACT=0x...    (the deployed MeshPortRewards address)
 *   REWARDS_SIGNER_ADDRESS=0x...   (the signer wallet ADDRESS, not a key)
 *
 * Usage:
 *   npx hardhat run contracts/set-points-signer.cjs --network arcTestnet
 *
 * Timelocked contracts (with TIMELOCK_DELAY): the first post-deploy set is
 * instant; a rotation needs two runs — the first schedules it, the second
 * (after the 2-day delay) applies it. Re-running early just reports when it
 * will be ready.
 */

const { ethers } = require('hardhat')

const ABI = [
  'function owner() view returns (address)',
  'function pointsSigner() view returns (address)',
  'function setPointsSigner(address newSigner)',
  'function TIMELOCK_DELAY() view returns (uint256)',
  'function scheduleSetPointsSigner(address newSigner)',
  'function operationId(bytes4 action, uint256 value) view returns (bytes32)',
  'function scheduledAt(bytes32 id) view returns (uint256)',
]

async function main() {
  const contractAddress = (process.env.VITE_REWARDS_CONTRACT || '').trim()
  const signerAddress = (process.env.REWARDS_SIGNER_ADDRESS || '').trim()
  if (!ethers.isAddress(contractAddress)) throw new Error('Set VITE_REWARDS_CONTRACT in .env')
  if (!ethers.isAddress(signerAddress)) throw new Error('Set REWARDS_SIGNER_ADDRESS in .env (the signer wallet ADDRESS)')

  const [owner] = await ethers.getSigners()
  const rewards = new ethers.Contract(contractAddress, ABI, owner)

  const currentOwner = await rewards.owner()
  if (currentOwner.toLowerCase() !== owner.address.toLowerCase()) {
    throw new Error(`ADMIN_PRIVATE_KEY is ${owner.address}, but the contract owner is ${currentOwner}`)
  }

  const current = await rewards.pointsSigner()
  if (current.toLowerCase() === signerAddress.toLowerCase()) {
    console.log('Points signer is already', current)
    return
  }

  let timelocked = true
  try { await rewards.TIMELOCK_DELAY() } catch { timelocked = false }

  if (timelocked && current !== ethers.ZeroAddress) {
    const selector = rewards.interface.getFunction('setPointsSigner').selector
    const id = await rewards.operationId(selector, BigInt(signerAddress))
    const readyAt = Number(await rewards.scheduledAt(id))
    const now = Math.floor(Date.now() / 1000)
    if (readyAt === 0) {
      const tx = await rewards.scheduleSetPointsSigner(signerAddress)
      console.log('Scheduled signer rotation. Tx hash:', tx.hash)
      await tx.wait()
      const ready = Number(await rewards.scheduledAt(id))
      console.log(`Run this script again after ${new Date(ready * 1000).toISOString()} to apply it.`)
      return
    }
    if (now < readyAt) {
      console.log(`Rotation is scheduled; it can be applied after ${new Date(readyAt * 1000).toISOString()}.`)
      return
    }
  }

  const tx = await rewards.setPointsSigner(signerAddress)
  console.log('Tx hash:', tx.hash)
  await tx.wait()
  console.log('Points signer set to', await rewards.pointsSigner())
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
