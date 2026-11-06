// Which chains can MeshPort's Circle relayer wallet (EVM-TESTNET) sign on?
//
//   node scripts/circle-sign-check.mjs
//   (asks for the API key and the Entity Secret - typing is hidden)
//
// For each chain the relayer uses, asks Circle to SIGN a 0-value transaction
// from the relayer wallet to itself. Nothing is broadcast: no gas is spent,
// no nonce is used. Prints OK or Circle's error per chain - no secrets.

import { credentials, circle } from './circle-lib.mjs'

const WALLET_ID = process.argv.find(a => a.startsWith('--wallet-id='))?.split('=')[1] || '3077130c-ef06-5204-aa4c-b46e1a9aeb3d'
const ADDRESS = '0x7218ec7dd868444a7655599551520ac5bcca7c0d'

const CHAINS = {
  Arc_Testnet: 5042002, Ethereum_Sepolia: 11155111, Base_Sepolia: 84532, Arbitrum_Sepolia: 421614,
  Optimism_Sepolia: 11155420, Avalanche_Fuji: 43113, Polygon_Amoy: 80002, Unichain_Sepolia: 1301,
  Linea_Sepolia: 59141, World_Chain_Sepolia: 4801, Sonic_Testnet: 14601, Sei_Testnet: 1328,
  HyperEVM_Testnet: 998, Monad_Testnet: 10143, Ink_Testnet: 763373, Plume_Testnet: 98867,
  Codex_Testnet: 812242, Edge_Testnet: 33431, Injective_Testnet: 1439,
}

const { call, ciphertext } = circle(await credentials())
const ok = [], failed = []
for (const [name, chainId] of Object.entries(CHAINS)) {
  const transaction = JSON.stringify({
    nonce: 0, to: ADDRESS, value: '0', gas: '21000', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1000000', chainId,
  })
  try {
    const d = await call('POST', '/developer/sign/transaction', { walletId: WALLET_ID, transaction, entitySecretCiphertext: await ciphertext() })
    if (!d?.signedTransaction) throw new Error('no signedTransaction returned')
    ok.push(name); console.log(`  OK      ${name} (${chainId})`)
  } catch (e) {
    failed.push(name); console.log(`  FAILED  ${name} (${chainId}): ${String(e.message || e).replace(/\s+/g, ' ').slice(0, 160)}`)
  }
}
console.log(`\n${ok.length} OK, ${failed.length} failed - send this list to Claude (no secrets here).`)
