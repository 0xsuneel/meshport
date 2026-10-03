// Deploy MeshPortBridgeRouter on a CCTP source chain.
//
//   FEE_RECIPIENT=0x… npx hardhat run contracts/deploy-bridge-router.cjs --network baseSepolia
//   FEE_RECIPIENT=0x… npx hardhat run contracts/deploy-bridge-router.cjs --network ethereumSepolia
//
// ADMIN_PRIVATE_KEY (in .env) pays for the deployment. FEE_RECIPIENT is the
// wallet that receives MeshPort's fee on this chain — fixed in the contract,
// so choose it deliberately (defaults to the deployer).
//
// Afterwards add the printed address to BOTH settings in Vercel:
//   VITE_BRIDGE_ROUTERS   (app)    {"Base_Sepolia":"0x…","Ethereum_Sepolia":"0x…"}
//   BRIDGE_ROUTERS        (relayer) same JSON
// and set BRIDGE_RELAYER_PRIVATE_KEY (a wallet holding a little ETH on each
// chain for gas; it never holds user funds).

const { ethers, network } = require('hardhat')

const TOKEN_MESSENGER_V2_TESTNET = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'
const CHAINS = {
  11155111: { key: 'Ethereum_Sepolia', usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' },
  84532:    { key: 'Base_Sepolia',     usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId)
  const chain = CHAINS[chainId]
  if (!chain) throw new Error(`No USDC/CCTP config for chain ${chainId} (${network.name})`)
  const [deployer] = await ethers.getSigners()
  const feeRecipient = process.env.FEE_RECIPIENT || deployer.address
  if (!ethers.isAddress(feeRecipient)) throw new Error('FEE_RECIPIENT is not a valid address')

  // Sanity: the USDC must support EIP-3009 (Circle's FiatToken).
  const usdc = new ethers.Contract(chain.usdc, ['function name() view returns (string)', 'function version() view returns (string)'], deployer)
  console.log(`USDC on ${chain.key}: ${await usdc.name()} v${await usdc.version()}`)

  const router = await (await ethers.getContractFactory('MeshPortBridgeRouter'))
    .deploy(chain.usdc, TOKEN_MESSENGER_V2_TESTNET, feeRecipient)
  await router.waitForDeployment()
  const address = await router.getAddress()

  // Verify the immutables match what was intended before anyone relies on it.
  const [u, m, f] = await Promise.all([router.usdc(), router.tokenMessenger(), router.feeRecipient()])
  if (u !== chain.usdc || m !== TOKEN_MESSENGER_V2_TESTNET || f.toLowerCase() !== feeRecipient.toLowerCase()) throw new Error('Deployed values do not match')

  console.log(`MeshPortBridgeRouter on ${chain.key}: ${address}`)
  console.log(`  usdc ${u}\n  tokenMessenger ${m}\n  feeRecipient ${f}`)
  console.log(`Add to VITE_BRIDGE_ROUTERS and BRIDGE_ROUTERS: "${chain.key}":"${address}"`)
}

main().catch((e) => { console.error(e); process.exit(1) })
