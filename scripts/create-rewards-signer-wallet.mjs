#!/usr/bin/env node
// scripts/create-rewards-signer-wallet.mjs
//
// One-time setup for C-3: creates the Circle developer-controlled wallet that
// signs reward-claim vouchers, so no signer private key lives in any env var.
//
// Prerequisites (Circle Console → Wallets → Dev Controlled):
//   - an API key                      → CIRCLE_API_KEY
//   - a registered entity secret      → CIRCLE_ENTITY_SECRET (64 hex chars)
//
// Usage:
//   CIRCLE_API_KEY=... CIRCLE_ENTITY_SECRET=... node scripts/create-rewards-signer-wallet.mjs
//
// Optional: CIRCLE_SIGNER_BLOCKCHAIN (default ARC-TESTNET). Signing is
// chain-independent for an EOA, so any EVM chain Circle offers gives an
// address that works as pointsSigner.
//
// Prints the wallet id and address. Then:
//   1. supabase secrets set REWARDS_SIGNER_WALLET_ID=<id> REWARDS_SIGNER_ADDRESS=<address> \
//        CIRCLE_ENTITY_SECRET=<secret> --project-ref <ref>   (CIRCLE_API_KEY is already set)
//   2. Register <address> as pointsSigner: contracts/set-points-signer.cjs
//   3. Once claims work, delete REWARDS_SIGNER_PRIVATE_KEY from Supabase secrets.

import { constants, publicEncrypt, randomUUID } from 'node:crypto'

const API = 'https://api.circle.com/v1/w3s'
const apiKey = (process.env.CIRCLE_API_KEY || '').trim()
const entitySecret = (process.env.CIRCLE_ENTITY_SECRET || '').trim()
const blockchain = (process.env.CIRCLE_SIGNER_BLOCKCHAIN || 'ARC-TESTNET').trim()

if (!apiKey) throw new Error('Set CIRCLE_API_KEY')
if (!/^[0-9a-fA-F]{64}$/.test(entitySecret)) throw new Error('Set CIRCLE_ENTITY_SECRET (64 hex characters)')

async function circle(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} failed: ${res.status} ${JSON.stringify(body)}`)
  return body.data
}

// Circle requires a fresh ciphertext per request.
let publicKeyPem
async function ciphertext() {
  publicKeyPem ??= (await circle('/config/entity/publicKey')).publicKey
  return publicEncrypt(
    { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(entitySecret, 'hex'),
  ).toString('base64')
}

const { walletSet } = await circle('/developer/walletSets', {
  method: 'POST',
  body: JSON.stringify({ idempotencyKey: randomUUID(), name: 'MeshPort rewards signer', entitySecretCiphertext: await ciphertext() }),
})

const { wallets } = await circle('/developer/wallets', {
  method: 'POST',
  body: JSON.stringify({
    idempotencyKey: randomUUID(),
    walletSetId: walletSet.id,
    blockchains: [blockchain],
    count: 1,
    accountType: 'EOA',
    metadata: [{ name: 'MeshPort rewards signer' }],
    entitySecretCiphertext: await ciphertext(),
  }),
})

const wallet = wallets[0]
console.log('Rewards signer wallet created.')
console.log(`  REWARDS_SIGNER_WALLET_ID=${wallet.id}`)
console.log(`  REWARDS_SIGNER_ADDRESS=${wallet.address.toLowerCase()}`)
