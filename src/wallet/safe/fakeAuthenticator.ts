// Test helper: a software passkey authenticator that returns exactly what a
// browser WebAuthn assertion contains, so encodings are tested against real
// P-256 math (offline here, and on Arc's precompile in the integration test).
import { p256 } from '@noble/curves/p256'
import { sha256 } from '@noble/hashes/sha256'
import { toBytes, type Hex } from 'viem'
import { base64url } from './passkeySignature'

export function fakeAuthenticator() {
  const priv = p256.utils.randomPrivateKey()
  const pub = p256.getPublicKey(priv, false)
  const spki = new Uint8Array([...new Uint8Array(26), ...pub]) // 26-byte SPKI header + point
  return {
    spki,
    sign(challenge: Hex, opts: { flags?: number; origin?: string } = {}) {
      const authenticatorData = new Uint8Array(37)
      authenticatorData.set(sha256(new TextEncoder().encode('meshport.xyz')), 0)
      authenticatorData[32] = opts.flags ?? 0x05
      const clientDataJSON = `{"type":"webauthn.get","challenge":"${base64url(toBytes(challenge))}","origin":"${opts.origin ?? 'https://wallet.meshport.xyz'}","crossOrigin":true,"topOrigin":"https://meshport.xyz"}`
      const msg = new Uint8Array([...authenticatorData, ...sha256(new TextEncoder().encode(clientDataJSON))])
      const sig = p256.sign(sha256(msg), priv, { lowS: false })
      return { authenticatorData, clientDataJSON, signature: sig.toDERRawBytes() }
    },
  }
}

