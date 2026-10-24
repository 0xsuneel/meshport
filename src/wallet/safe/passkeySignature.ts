// src/wallet/safe/passkeySignature.ts
//
// Turning a browser WebAuthn assertion into the signature Safe's passkey
// signer verifies, and combining owner signatures into the bytes a Safe's
// checkSignatures() expects. Pure - no DOM, no network - so it runs in the
// wallet frame and in tests alike.
//
// Safe passkey signature = abi.encode(
//   bytes  authenticatorData,
//   string clientDataFields,   // clientDataJSON after `"challenge":"…",` minus the closing `}`
//   uint256 r, uint256 s)
//
// The contract rebuilds clientDataJSON as
//   {"type":"webauthn.get","challenge":"<base64url(challenge)>",<clientDataFields>}
// so the browser's JSON must start exactly that way (it does, per the
// WebAuthn spec's serialization); this module checks it before encoding.

import { encodeAbiParameters, concat, pad, size, toHex, hexToBytes, bytesToHex, type Hex as ViemHex } from 'viem'
import type { Hex } from '../protocol'

const P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n

export function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export class PasskeySignatureError extends Error {}

/** The fields after the challenge, exactly as Safe's WebAuthn library re-assembles them. */
export function clientDataFields(clientDataJSON: string, challenge: Hex): string {
  const prefix = `{"type":"webauthn.get","challenge":"${base64url(hexToBytes(challenge))}",`
  if (!clientDataJSON.startsWith(prefix)) {
    throw new PasskeySignatureError('Passkey response is not for this request (type or challenge differ)')
  }
  if (!clientDataJSON.endsWith('}')) throw new PasskeySignatureError('Malformed passkey client data')
  return clientDataJSON.slice(prefix.length, -1)
}

/** r, s from a DER-encoded ECDSA signature (what WebAuthn returns). */
export function derToRS(der: Uint8Array): { r: bigint; s: bigint } {
  // SEQUENCE { INTEGER r, INTEGER s }
  let i = 0
  const expect = (b: number) => { if (der[i++] !== b) throw new PasskeySignatureError('Bad DER signature') }
  const readLen = () => { const l = der[i++]; if (l & 0x80) throw new PasskeySignatureError('Bad DER length'); return l }
  expect(0x30); readLen()
  expect(0x02); const rl = readLen(); const r = der.slice(i, i + rl); i += rl
  expect(0x02); const sl = readLen(); const s = der.slice(i, i + sl); i += sl
  const toBig = (b: Uint8Array) => BigInt(bytesToHex(b))
  return { r: toBig(r), s: toBig(s) }
}

/**
 * Safe's passkey signer allows either s (verifySignatureAllowMalleability), but
 * low-s is the canonical form - normalise so the same signature never has two
 * encodings in logs or replay checks.
 */
export function lowS(s: bigint): bigint {
  return s > P256_N / 2n ? P256_N - s : s
}

export interface WebAuthnAssertion {
  authenticatorData: Uint8Array
  clientDataJSON: string
  /** DER signature from AuthenticatorAssertionResponse.signature */
  signature: Uint8Array
}

/** The signature Safe's WebAuthn signer verifies for `challenge`. Checks user verification was done. */
export function encodePasskeySignature(a: WebAuthnAssertion, challenge: Hex): Hex {
  if (a.authenticatorData.length < 37) throw new PasskeySignatureError('Malformed authenticator data')
  const flags = a.authenticatorData[32]
  // UP (0x01) and UV (0x04): the signer contract requires UV - fail early with a clear reason.
  if ((flags & 0x05) !== 0x05) throw new PasskeySignatureError('Face ID / PIN was not used for this passkey signature')
  const fields = clientDataFields(a.clientDataJSON, challenge)
  const { r, s } = derToRS(a.signature)
  return encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint256' }],
    [bytesToHex(a.authenticatorData), fields, r, lowS(s)],
  )
}

/** x, y of a P-256 public key from SubjectPublicKeyInfo (AuthenticatorAttestationResponse.getPublicKey()). */
export function p256FromSpki(spki: Uint8Array): { x: bigint; y: bigint } {
  // The uncompressed point is the last 65 bytes: 0x04 ‖ x ‖ y
  const pt = spki.slice(spki.length - 65)
  if (pt[0] !== 0x04) throw new PasskeySignatureError('Passkey is not an uncompressed P-256 key')
  return { x: BigInt(bytesToHex(pt.slice(1, 33))), y: BigInt(bytesToHex(pt.slice(33, 65))) }
}

// ── Safe signature bytes ─────────────────────────────────────────────────────
// checkSignatures reads one 65-byte slot per owner, owners in ascending order:
//   ECDSA owner:    r ‖ s ‖ v (27/28)
//   contract owner: bytes32(owner) ‖ bytes32(offset of its data) ‖ 0x00
// and contract owners' data is appended after all slots as length ‖ bytes.

export type OwnerSignature =
  | { signer: Hex; kind: 'ecdsa'; signature: Hex }        // 65 bytes r‖s‖v
  | { signer: Hex; kind: 'contract'; signature: Hex }     // e.g. encodePasskeySignature(...)

export function buildSafeSignatures(sigs: readonly OwnerSignature[]): Hex {
  if (sigs.length === 0) throw new Error('No signatures')
  const sorted = [...sigs].sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1))
  const seen = new Set<string>()
  for (const s of sorted) {
    const k = s.signer.toLowerCase()
    if (seen.has(k)) throw new Error('One signature per owner')
    seen.add(k)
  }
  let tailOffset = sorted.length * 65
  const slots: ViemHex[] = []
  const tail: ViemHex[] = []
  for (const s of sorted) {
    if (s.kind === 'ecdsa') {
      if (size(s.signature) !== 65) throw new Error('ECDSA owner signature must be 65 bytes')
      slots.push(s.signature)
    } else {
      slots.push(concat([pad(s.signer, { size: 32 }), toHex(BigInt(tailOffset), { size: 32 }), '0x00']))
      const piece = concat([toHex(BigInt(size(s.signature)), { size: 32 }), s.signature])
      tail.push(piece)
      tailOffset += size(piece)
    }
  }
  return concat([...slots, ...tail])
}
