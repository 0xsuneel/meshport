// Create MeshPort's Circle developer-controlled wallets (relayer + fee wallet,
// Solana fee payer). No packages needed - Circle's REST API + Node's crypto.
//
//   node scripts/circle-create-wallets.mjs
//   (asks for the API key and the Entity Secret - typing is hidden; or set
//    CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET in the environment)
//   (add --wallet-set-id=<id> to reuse a wallet set you already have)
//   (add --mainnet to create EVM / SOL instead of EVM-TESTNET / SOL-DEVNET;
//    use a mainnet API key for that)
//
// Wallets created:
//   EVM-TESTNET (EOA) - the relayer AND fee wallet. A signing wallet: one
//     address on every EVM chain (Arc, Ethereum, Base, ...); MeshPort signs
//     through Circle (POST /developer/sign/transaction) and broadcasts itself,
//     exactly like the relayer does today. Circle: don't also create native
//     chain wallets (ARC-TESTNET, BASE-SEPOLIA...) in this wallet set and sign
//     with this one on those chains - keep this set for EVM-TESTNET only.
//   SOL-DEVNET (EOA)  - the Solana fee payer.
//
// Prints only IDs and addresses (safe to share). The API key and the Entity
// Secret are never printed or written anywhere.

import crypto from 'node:crypto'
import { credentials, circle } from './circle-lib.mjs'

const { apiKey, entitySecret } = await credentials()
const { call, ciphertext } = circle({ apiKey, entitySecret })
const arg = (n) => process.argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1]
const mainnet = process.argv.includes('--mainnet')

if (mainnet !== apiKey.startsWith('LIVE_')) throw new Error(mainnet ? '--mainnet needs a LIVE_ API key' : 'This is a LIVE_ key - add --mainnet, or use your TEST_ key')

async function main() {
  let walletSetId = arg('wallet-set-id')
  if (!walletSetId) {
    const d = await call('POST', '/developer/walletSets', {
      idempotencyKey: crypto.randomUUID(), entitySecretCiphertext: await ciphertext(), name: 'MeshPort relayer',
    })
    walletSetId = d.walletSet.id
  }
  const create = async (blockchain) => (await call('POST', '/developer/wallets', {
    idempotencyKey: crypto.randomUUID(), entitySecretCiphertext: await ciphertext(),
    walletSetId, blockchains: [blockchain], count: 1, accountType: 'EOA',
  })).wallets[0]

  const evm = await create(mainnet ? 'EVM' : 'EVM-TESTNET')
  const sol = await create(mainnet ? 'SOL' : 'SOL-DEVNET')

  console.log('\nCreated - send these to Claude (no secrets here):')
  console.log(`  CIRCLE_WALLET_SET_ID=${walletSetId}`)
  console.log(`  CIRCLE_RELAYER_WALLET_ID=${evm.id}      # ${evm.blockchain}`)
  console.log(`  RELAYER_ADDRESS=${evm.address}      # relayer + fee wallet, every EVM chain`)
  console.log(`  CIRCLE_SOLANA_WALLET_ID=${sol.id}      # ${sol.blockchain}`)
  console.log(`  SOLANA_FEE_PAYER=${sol.address}`)
  console.log('\nFund them: test USDC on Arc (faucet.circle.com - Arc gas is USDC), a little')
  console.log('gas coin on each chain the relayer mints on, and SOL on Devnet for the Solana one.')
}

main().catch(e => { console.error(e.message || e); process.exit(1) })
