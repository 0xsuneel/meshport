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

const API = 'https://api.circle.com/v1/w3s'

// Hidden prompt (nothing echoed, nothing saved in shell history). Text typed
// or pasted past the first line is kept for the next prompt.
let pending = ''
// Windows Terminal wraps a paste in hidden codes (ESC[200~ ... ESC[201~);
// drop them, any other control characters, spaces and surrounding quotes.
const clean = (v) => String(v)
  .replace(/\u001b\[20[01]~/g, '')
  .replace(/[\u0000-\u001f\u007f]/g, '')
  .trim()
  .replace(/^['"]+|['"]+$/g, '')
  .trim()
function ask(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin
    process.stdout.write(question)
    const finish = (line) => {
      stdin.setRawMode?.(false); stdin.pause(); stdin.off('data', onData)
      process.stdout.write('\n'); resolve(clean(line))
    }
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(1) } // Ctrl+C
        if (ch === '\u0008' || ch === '\u007f') pending = pending.slice(0, -1)
        else pending += ch
      }
      const nl = pending.search(/[\r\n]/)
      if (nl >= 0) {
        const line = pending.slice(0, nl)
        pending = pending.slice(nl + 1).replace(/^\n/, '')
        finish(line)
      }
    }
    const nl = pending.search(/[\r\n]/)
    if (nl >= 0) { const line = pending.slice(0, nl); pending = pending.slice(nl + 1).replace(/^\n/, ''); return finish(line) }
    stdin.setRawMode?.(true)
    stdin.setEncoding('utf8')
    stdin.on('data', onData)
    stdin.resume()
  })
}
const apiKey = clean(process.env.CIRCLE_API_KEY || '') || await ask('Circle API key (hidden): ')
const entitySecret = clean(process.env.CIRCLE_ENTITY_SECRET || '') || await ask('Entity Secret (hidden): ')
const arg = (n) => process.argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1]
const mainnet = process.argv.includes('--mainnet')

if (!apiKey) throw new Error('Set CIRCLE_API_KEY')
if (!/^[0-9a-fA-F]{64}$/.test(entitySecret)) {
  // Say what is wrong without showing the secret.
  const bad = [...new Set(entitySecret.replace(/[0-9a-fA-F]/g, ''))].length
  throw new Error(`The Entity Secret must be 64 hex characters (0-9, a-f). Got ${entitySecret.length} characters` +
    (bad ? `, with ${bad} kind(s) of non-hex character` : '') +
    '. Use the Entity Secret itself - not the ciphertext and not the recovery file.')
}
if (mainnet !== apiKey.startsWith('LIVE_')) throw new Error(mainnet ? '--mainnet needs a LIVE_ API key' : 'This is a LIVE_ key - add --mainnet, or use your TEST_ key')

async function call(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${j.message || JSON.stringify(j)}`)
  return j.data
}

// A fresh ciphertext for every request (Circle refuses a reused one).
let publicKey
async function ciphertext() {
  publicKey ??= (await call('GET', '/config/entity/publicKey')).publicKey
  return crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(entitySecret, 'hex'),
  ).toString('base64')
}

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
