/**
 * MeshPortRewards Contract Deployment Script
 * 
 * Run ONCE to deploy the rewards contract to Arc Testnet.
 * 
 * Prerequisites:
 * 1. Compile the contract first:
 *    - Option A: Remix IDE (remix.ethereum.org) → paste MeshPortRewards.sol → compile → copy bytecode
 *    - Option B: npx hardhat compile (if hardhat is installed)
 * 
 * 2. Set ADMIN_PRIVATE_KEY in environment (this is the treasury admin wallet)
 * 
 * Usage:
 *   ADMIN_PRIVATE_KEY=0x... npx tsx contracts/deploy-rewards.ts
 */

import { createWalletClient, createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const ARC_CHAIN = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] }, public: { http: ['https://rpc.testnet.arc.network'] } },
  blockExplorers: { default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' } },
  testnet: true,
} as const

const USDC_CONTRACT = '0x3600000000000000000000000000000000000000'

// PASTE COMPILED BYTECODE HERE (from Remix or hardhat compile output)
// Example: const BYTECODE = '0x608060405234801561001057600080fd5b50...'
const BYTECODE = process.env.CONTRACT_BYTECODE || ''

async function deploy() {
  const adminPrivateKey = process.env.ADMIN_PRIVATE_KEY
  if (!adminPrivateKey) throw new Error('Set ADMIN_PRIVATE_KEY env var')
  if (!BYTECODE) throw new Error('Set CONTRACT_BYTECODE env var or paste bytecode above')

  const account = privateKeyToAccount(adminPrivateKey as `0x${string}`)
  console.log('Deploying from:', account.address)

  const publicClient = createPublicClient({ chain: ARC_CHAIN, transport: http() })
  const walletClient = createWalletClient({ account, chain: ARC_CHAIN, transport: http() })

  // Encode constructor args: address _usdcToken
  const { encodeDeployData } = await import('viem')
  const ABI = [{ type: 'constructor', inputs: [{ name: '_usdcToken', type: 'address' }] }]
  const data = encodeDeployData({ abi: ABI, bytecode: BYTECODE as `0x${string}`, args: [USDC_CONTRACT] })

  const hash = await walletClient.deployContract({ abi: ABI, bytecode: BYTECODE as `0x${string}`, args: [USDC_CONTRACT] })
  console.log('Deploy txHash:', hash)
  
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60000 })
  console.log('Contract deployed at:', receipt.contractAddress)
  console.log('\nSave this address as VITE_REWARDS_CONTRACT in .env')
  console.log(`VITE_REWARDS_CONTRACT=${receipt.contractAddress}`)
}

deploy().catch(console.error)
