// src/lib/chatIdentity.ts
//
// The chat identity seed, derived from the wallet key. Pure and dependency-
// light on purpose: it runs inside the wallet frame (wallet-frame/), which is
// the only place the wallet key exists, and the app only ever receives the
// derived seed - never the key it came from.

import { sha256 } from '@noble/hashes/sha256'

// Domain separation - this seed is only ever a chat identity.
const CHAT_IDENTITY_INFO = new TextEncoder().encode('meshport-chat-identity-v2')

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16)
  return bytes
}

/** sha256(walletKey ‖ "meshport-chat-identity-v2") - same wallet, same seed, every device. */
export function deriveChatSeed(walletPrivateKeyHex: string): Uint8Array {
  const walletKeyBytes = hexToBytes(walletPrivateKeyHex)
  const combined = new Uint8Array(walletKeyBytes.length + CHAT_IDENTITY_INFO.length)
  combined.set(walletKeyBytes, 0)
  combined.set(CHAT_IDENTITY_INFO, walletKeyBytes.length)
  const seed = sha256(combined)
  walletKeyBytes.fill(0)
  combined.fill(0)
  return seed
}
