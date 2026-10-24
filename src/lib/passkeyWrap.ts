// src/lib/passkeyWrap.ts
//
// Lock / unlock a wallet key with a passkey's PRF secret:
//   HKDF-SHA256(PRF, salt, "meshport-wallet-passkey-v1") → AES-256-GCM
//
// Pure WebCrypto, no app imports: it runs inside the wallet frame, which
// holds the key. walletPasskey.ts does the WebAuthn ceremony and the storage
// in the app and hands this the PRF output - it never sees the key.

const HKDF_INFO = new TextEncoder().encode('meshport-wallet-passkey-v1')

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(new ArrayBuffer(h.length / 2))
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}
const toHex = (b: Uint8Array) => '0x' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('')

async function lockKey(prf: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', prf as BufferSource, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: HKDF_INFO }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export async function wrapWithPrf(privateKey: string, prf: Uint8Array, salt: Uint8Array): Promise<{ ct: Uint8Array; iv: Uint8Array }> {
  const key = await lockKey(prf, salt)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const pk = hexToBytes(privateKey)
  try {
    return { ct: new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pk)), iv }
  } finally { pk.fill(0) }
}

/** The key, or null when this PRF secret doesn't open this ciphertext. */
export async function openWithPrf(prf: Uint8Array, salt: Uint8Array, ct: Uint8Array, iv: Uint8Array): Promise<string | null> {
  const key = await lockKey(prf, salt)
  let pk: Uint8Array
  try {
    pk = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ct as BufferSource))
  } catch { return null }
  const out = toHex(pk)
  pk.fill(0)
  return out
}
