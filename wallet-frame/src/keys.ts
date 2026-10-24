// wallet-frame/src/keys.ts
//
// Turning a recovery phrase or a private key into an account, inside the
// wallet frame. m/44'/60'/0'/0/0 with a real BIP-39 checksum - the path the
// app has always used - so a phrase opens the same address it did before and
// in every mainstream wallet (derivation.test.ts pins this against ethers).

import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'
import { validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { bytesToHex } from 'viem'
import type { Hex } from '@/wallet/protocol'

export class KeyError extends Error {}

export function fromPhrase(phrase: string): { privateKey: Hex; address: Hex; phrase: string } {
  const clean = phrase.trim().toLowerCase().split(/\s+/).join(' ')
  if (![12, 15, 18, 21, 24].includes(clean.split(' ').length) || !validateMnemonic(clean, wordlist)) {
    throw new KeyError('That recovery phrase is not valid - check each word')
  }
  const account = mnemonicToAccount(clean)
  const hd = account.getHdKey()
  if (!hd.privateKey) throw new KeyError('Could not derive a key from that phrase')
  return { privateKey: bytesToHex(hd.privateKey), address: account.address, phrase: clean }
}

export function fromKey(secret: string): { privateKey: Hex; address: Hex } {
  const k = (secret.trim().startsWith('0x') ? secret.trim() : '0x' + secret.trim()) as Hex
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new KeyError('That private key is not valid')
  return { privateKey: k.toLowerCase() as Hex, address: privateKeyToAccount(k).address }
}
