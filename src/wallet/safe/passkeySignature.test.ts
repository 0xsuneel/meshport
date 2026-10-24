import { describe, it, expect } from 'vitest'
import { p256 } from '@noble/curves/p256'
import { decodeAbiParameters, hexToBigInt, slice, size, keccak256, toBytes, type Hex } from 'viem'
import { fakeAuthenticator } from './fakeAuthenticator'
import {
  buildSafeSignatures, clientDataFields, derToRS, encodePasskeySignature, lowS, p256FromSpki,
} from './passkeySignature'

describe('passkey → Safe signature', () => {
  const challenge = keccak256(toBytes('safe op hash'))

  it('reads the P-256 key from SPKI', () => {
    const a = fakeAuthenticator()
    const { x, y } = p256FromSpki(a.spki)
    expect(p256.ProjectivePoint.fromAffine({ x, y }).assertValidity()).toBeUndefined()
  })

  it('encodes authenticatorData, the fields after the challenge, r and low-s', () => {
    const a = fakeAuthenticator()
    const assertion = a.sign(challenge)
    const [authData, fields, r, s] = decodeAbiParameters(
      [{ type: 'bytes' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint256' }],
      encodePasskeySignature(assertion, challenge),
    )
    expect(size(authData)).toBe(37)
    expect(fields).toBe('"origin":"https://wallet.meshport.xyz","crossOrigin":true,"topOrigin":"https://meshport.xyz"')
    const der = derToRS(assertion.signature)
    expect(r).toBe(der.r)
    expect(s).toBe(lowS(der.s))
    expect(s <= 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n / 2n).toBe(true)
  })

  it('rejects a response for another challenge, or without Face ID / PIN', () => {
    const a = fakeAuthenticator()
    expect(() => encodePasskeySignature(a.sign(challenge), keccak256(toBytes('other')))).toThrow(/not for this request/)
    expect(() => encodePasskeySignature(a.sign(challenge, { flags: 0x01 }), challenge)).toThrow(/Face ID/)
    expect(() => clientDataFields('{"type":"webauthn.create","challenge":"x"}', challenge)).toThrow()
  })

  it('orders owners ascending; contract data goes after the 65-byte slots', () => {
    const ecdsaOwner = '0xffffffffffffffffffffffffffffffffffffff01' as Hex
    const passkeyOwner = '0x00000000000000000000000000000000000000a1' as Hex
    const ecdsaSig = ('0x' + '11'.repeat(64) + '1b') as Hex
    const passkeySig = encodePasskeySignature(fakeAuthenticator().sign(challenge), challenge)
    const out = buildSafeSignatures([
      { signer: ecdsaOwner, kind: 'ecdsa', signature: ecdsaSig },
      { signer: passkeyOwner, kind: 'contract', signature: passkeySig },
    ])
    // slot 0 = passkey owner (lower address): r = owner, s = offset 130, v = 0
    expect(hexToBigInt(slice(out, 0, 32))).toBe(BigInt(passkeyOwner))
    expect(hexToBigInt(slice(out, 32, 64))).toBe(130n)
    expect(slice(out, 64, 65)).toBe('0x00')
    // slot 1 = ECDSA owner's 65 bytes verbatim
    expect(slice(out, 65, 130)).toBe(ecdsaSig)
    // tail = length ‖ passkey signature
    expect(hexToBigInt(slice(out, 130, 162))).toBe(BigInt(size(passkeySig)))
    expect(slice(out, 162)).toBe(passkeySig)
    expect(() => buildSafeSignatures([{ signer: ecdsaOwner, kind: 'ecdsa', signature: '0x11' }])).toThrow(/65 bytes/)
  })
})
