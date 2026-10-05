/**
 * MeshPortRewards — set the points signer (owner only)
 *
 * Registers the address whose key the rewards-claim-sign edge function
 * signs claims with (its REWARDS_SIGNER_PRIVATE_KEY secret). Until this is
 * set, every claimRewards() call reverts with InvalidSignature.
 *
 * .env:
 *   ADMIN_PRIVATE_KEY=0x...        (the wallet that deployed the contract)
 *   VITE_REWARDS_CONTRACT=0x...    (the deployed MeshPortRewards address)
 *
 * Usage:
 *   npx hardhat run contracts/set-points-signer.cjs --network arcTestnet
 * with REWARDS_SIGNER_ADDRESS (an address, not a key) set in .env.
 */

const { ethers } = require('hardhat')

const ABI = [
  'function owner() view returns (address)',
  'function pointsSigner() view returns (address)',
  'function setPointsSigner(address newSigner)',
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

  const tx = await rewards.setPointsSigner(signerAddress)
  console.log('Tx hash:', tx.hash)
  await tx.wait()
  console.log('Points signer set to', await rewards.pointsSigner())
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
