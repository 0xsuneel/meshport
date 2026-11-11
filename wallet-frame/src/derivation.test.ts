import { describe, it, expect } from 'vitest'
import { HDNodeWallet, Mnemonic, Wallet } from 'ethers'
import { generateMnemonic, english } from 'viem/accounts'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { bytesToHex } from 'viem'
import { fromPhrase, fromKey, KeyError } from './keys'

// The app used ethers' HDNodeWallet at m/44'/60'/0'/0/0 for every phrase it
// made or imported (lib/arc.ts before the wallet frame). The frame derives
// with viem / @scure instead - these must give the very same key, or a
// returning user's phrase would open a different, empty wallet.
function ethersDerive(phrase: string) {
  const w = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(phrase.trim().toLowerCase()), "m/44'/60'/0'/0/0")
  return { privateKey: w.privateKey.toLowerCase(), address: w.address }
}

describe('wallet frame key derivation', () => {
  it('matches the app\'s previous (ethers) derivation for known phrases', () => {
    for (const phrase of [
      'test test test test test test test test test test test junk',
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      'legal winner thank year wave sausage worth useful legal winner thank yellow',
    ]) {
      const ours = fromPhrase(phrase)
      const theirs = ethersDerive(phrase)
      expect(ours.address).toBe(theirs.address)
      expect(ours.privateKey).toBe(theirs.privateKey)
    }
  })

  it('matches for freshly generated 12- and 24-word phrases', () => {
    for (const strength of [128, 256]) {
      for (let i = 0; i < 5; i++) {
        const phrase = generateMnemonic(english, strength)
        expect(fromPhrase(phrase).address).toBe(ethersDerive(phrase).address)
      }
    }
  })

  // OKX's own vector (okx/js-wallet-sdk coin-ethereum/tests/eth.test.ts,
  // getDerivedPrivateKey at m/44'/60'/0'/0/0). Their test phrase has no valid
  // BIP-39 checksum - their SDK derives without checking; the frame refuses
  // such a phrase at import, like MetaMask - so the same seed -> key maths
  // the frame uses (@scure, as viem's mnemonicToAccount) is compared here:
  // a valid phrase opens the same first account in MeshPort and OKX Wallet.
  it("derives the same key as OKX Wallet SDK's vector", () => {
    const phrase = 'swift choose erupt agree fragile spider glare spawn suit they solid bus'
    const key = HDKey.fromMasterSeed(mnemonicToSeedSync(phrase)).derive("m/44'/60'/0'/0/0").privateKey!
    expect(bytesToHex(key)).toBe('0xf5c8f8b725a47cffc33de30a0bb9dd48d47601b615a650d5a41636277f52bbd7')
    expect(() => fromPhrase(phrase)).toThrow(KeyError)
  })

  it('takes a private key the ways OKX does: 0x / 0X / no prefix, any case - never an off-curve one', () => {
    const w = Wallet.createRandom()
    const bare = w.privateKey.slice(2)
    for (const form of [bare, '0x' + bare, '0X' + bare, '0X' + bare.toUpperCase(), bare.toUpperCase()]) {
      expect(fromKey(form)).toEqual({ privateKey: w.privateKey.toLowerCase(), address: w.address })
    }
    expect(() => fromKey('0x' + '00'.repeat(32))).toThrow(KeyError)
    expect(() => fromKey('0x' + 'ff'.repeat(32))).toThrow(KeyError)
  })

  it('normalises spacing and case the way the old import did', () => {
    const phrase = 'test test test test test test test test test test test junk'
    expect(fromPhrase(`  TEST test\ttest  test test test test test test test test JUNK `).address).toBe(fromPhrase(phrase).address)
  })

  it('rejects a phrase with a bad checksum or a wrong word count', () => {
    expect(() => fromPhrase('test test test test test test test test test test test test')).toThrow(KeyError)
    expect(() => fromPhrase('test test test')).toThrow(KeyError)
    expect(() => fromPhrase('notaword test test test test test test test test test test junk')).toThrow(KeyError)
  })

  it('imports a raw private key with or without 0x, same address as ethers', () => {
    const w = Wallet.createRandom()
    expect(fromKey(w.privateKey).address).toBe(w.address)
    expect(fromKey(w.privateKey.slice(2)).address).toBe(w.address)
    expect(() => fromKey('0x1234')).toThrow(KeyError)
    expect(() => fromKey('zz'.repeat(32))).toThrow(KeyError)
  })
})
