// src/wallet/signatureChatSeed.ts
//
// The end-to-end chat key for a wallet whose key isn't in the wallet frame
// (a Circle wallet - the provider keeps the key). Created / imported wallets
// derive the chat seed from the wallet key inside the frame
// (lib/chatIdentity.ts); here it comes from a signature over a fixed
// statement instead:
//   seed = sha256(signature ‖ "meshport-chat-identity-v2")
// Only usable when the wallet signs deterministically (RFC 6979) - otherwise
// the chat key would change and older messages couldn't be read. Checked by
// signing twice: different signatures → no seed (chat stays as before) and
// it's reported. Once per session per wallet.

import type { WalletAccount } from './account'

export const CHAT_SEED_STATEMENT = (address: string) =>
  `MeshPort chat key\n\nThis signature creates the key for your encrypted chats. It moves no funds and costs nothing.\n\nWallet: ${address.toLowerCase()}\nVersion: 2`

const seeds = new Map<string, Promise<Uint8Array>>()

/** Pure: the seed from a signature (hex, 0x-prefixed). */
export async function seedFromSignature(signature: string): Promise<Uint8Array> {
  const { sha256 } = await import('@noble/hashes/sha256')
  const sig = signature.slice(2)
  const info = new TextEncoder().encode('meshport-chat-identity-v2')
  const bytes = new Uint8Array(sig.length / 2 + info.length)
  for (let i = 0; i < sig.length / 2; i++) bytes[i] = parseInt(sig.slice(i * 2, i * 2 + 2), 16)
  bytes.set(info, sig.length / 2)
  return sha256(bytes)
}

export function signatureChatSeed(account: WalletAccount): Promise<Uint8Array> {
  const key = account.address.toLowerCase()
  let p = seeds.get(key)
  if (!p) {
    p = (async () => {
      const message = CHAT_SEED_STATEMENT(account.address)
      const first = await account.signMessage({ message })
      const second = await account.signMessage({ message })
      if (first.toLowerCase() !== second.toLowerCase()) {
        void import('@/lib/errorReport').then(r => r.reportClientError('rejection', new Error('[chat seed] signatures differ - chat key not derived'))).catch(() => {})
        throw new Error('This wallet cannot make a stable chat key')
      }
      return seedFromSignature(first)
    })()
    seeds.set(key, p)
    p.catch(() => seeds.delete(key))
  }
  return p.then(s => new Uint8Array(s)) // a copy: callers may zero it
}
