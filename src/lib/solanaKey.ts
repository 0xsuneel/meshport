// src/lib/solanaKey.ts
//
// The Solana key of a created / imported wallet (docs/SOLANA.md), derived
// from the wallet key the same way the chat seed is (lib/chatIdentity.ts):
// sha256(walletKey ‖ "meshport-solana-key-v1") is the ed25519 seed. Same
// wallet, same Solana address, on every device - restored by the wallet's
// existing recovery phrase or private key, nothing new to back up.
//
// Runs inside the wallet frame (wallet-frame/), the only place the wallet key
// exists; the app only gets the public key and signatures.

import { sha256 } from '@noble/hashes/sha256'
import { ed25519 } from '@noble/curves/ed25519'

const SOLANA_KEY_INFO = new TextEncoder().encode('meshport-solana-key-v1')

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2) throw new Error('Not hex')
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16)
  return bytes
}

/** The 32-byte ed25519 seed. Callers zero it when done. */
export function deriveSolanaSeed(walletPrivateKeyHex: string): Uint8Array {
  const key = hexToBytes(walletPrivateKeyHex)
  const combined = new Uint8Array(key.length + SOLANA_KEY_INFO.length)
  combined.set(key, 0)
  combined.set(SOLANA_KEY_INFO, key.length)
  const seed = sha256(combined)
  key.fill(0)
  combined.fill(0)
  return seed
}

export function solanaPublicKey(walletPrivateKeyHex: string): Uint8Array {
  const seed = deriveSolanaSeed(walletPrivateKeyHex)
  try { return ed25519.getPublicKey(seed) } finally { seed.fill(0) }
}

/** ed25519 signature over a Solana transaction's message bytes. */
export function solanaSign(walletPrivateKeyHex: string, message: Uint8Array): Uint8Array {
  const seed = deriveSolanaSeed(walletPrivateKeyHex)
  try { return ed25519.sign(message, seed) } finally { seed.fill(0) }
}

export { hexToBytes as solanaHexToBytes }
