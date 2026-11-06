// api/_lib/relayerSigner.ts
//
// The relayer's signing account. Two modes (RELAYER_MODE):
//
//   key (default) - BRIDGE_RELAYER_PRIVATE_KEY, as before.
//   circle        - MeshPort's Circle developer-controlled wallet
//                   (EVM-TESTNET / EVM): Circle holds the key, MeshPort asks
//                   it to sign each transaction (POST /developer/sign/transaction)
//                   and broadcasts the result itself, exactly as before. No
//                   private key in Vercel for the chains Circle signs on.
//
// The account is a normal viem account, so every wallet.sendTransaction /
// writeContract in the relayer is unchanged. Each signed transaction is
// checked before it is returned: it must recover to the Circle wallet's
// address and carry exactly the nonce, chain, recipient, value and calldata
// viem asked for - a wrong or tampered signature is never broadcast.
//
// Chains Circle can't sign on (testnet: Sonic 14601, Sei 1328, HyperEVM 998 -
// scripts/circle-sign-check.mjs, 6 Nov) keep the private key while it is set.
//
// Environment (Vercel):
//   RELAYER_MODE=circle
//   CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET          (secrets)
//   CIRCLE_RELAYER_WALLET_ID, CIRCLE_RELAYER_ADDRESS
//   CIRCLE_SIGN_UNSUPPORTED_CHAINS                optional, e.g. "998,1328,14601"
//   BRIDGE_RELAYER_PRIVATE_KEY                    optional in circle mode: the
//     unsupported chains, and P2P offers that named the old relayer address
//     as their operator.

import crypto from 'node:crypto'

type Hex = `0x${string}`

const CIRCLE_API = 'https://api.circle.com/v1/w3s'
const DEFAULT_UNSUPPORTED = [998, 1328, 14601]

const env = (k: string) => (process.env[k] || '').trim()

export function relayerMode(): 'circle' | 'key' {
  return env('RELAYER_MODE').toLowerCase() === 'circle' ? 'circle' : 'key'
}

function unsupportedChains(): Set<number> {
  const raw = env('CIRCLE_SIGN_UNSUPPORTED_CHAINS')
  const list = raw ? raw.split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0) : DEFAULT_UNSUPPORTED
  return new Set(list)
}

/** Can the Circle wallet sign on this chain? */
export function circleSignsOn(chainId: number): boolean {
  return relayerMode() === 'circle' && !unsupportedChains().has(chainId)
}

function privateKey(): Hex | null {
  let key = env('BRIDGE_RELAYER_PRIVATE_KEY')
  if (key && !key.startsWith('0x')) key = '0x' + key
  return /^0x[0-9a-fA-F]{64}$/.test(key) ? key as Hex : null
}

/** The private-key account, or null when no key is set. */
export async function keyRelayerAccount(): Promise<any | null> {
  const key = privateKey()
  if (!key) return null
  const { privateKeyToAccount } = await import('viem/accounts')
  return privateKeyToAccount(key)
}

function circleConfig() {
  const apiKey = env('CIRCLE_API_KEY'), entitySecret = env('CIRCLE_ENTITY_SECRET')
  const walletId = env('CIRCLE_RELAYER_WALLET_ID'), address = env('CIRCLE_RELAYER_ADDRESS').toLowerCase()
  if (!apiKey || !/^[0-9a-fA-F]{64}$/.test(entitySecret) || !walletId || !/^0x[0-9a-f]{40}$/.test(address)) return null
  return { apiKey, entitySecret, walletId, address: address as Hex }
}

// Circle's entity public key, kept for the instance (a fresh ciphertext is
// still made for every request - Circle refuses a reused one).
let _publicKey: Promise<string> | null = null
async function circleCall(apiKey: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(CIRCLE_API + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`Circle ${path}: ${r.status} ${j?.message || 'request failed'}`)
  return j.data
}
async function ciphertext(apiKey: string, entitySecret: string): Promise<string> {
  _publicKey ??= circleCall(apiKey, '/config/entity/publicKey').then(d => d.publicKey as string)
  let key: string
  try { key = await _publicKey } catch (e) { _publicKey = null; throw e }
  return crypto.publicEncrypt(
    { key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(entitySecret, 'hex'),
  ).toString('base64')
}

/**
 * The JSON transaction Circle signs (Ethereum JSON-RPC shape, EIP-1559 fees -
 * Circle requires maxFeePerGas / maxPriorityFeePerGas; a legacy gasPrice is
 * sent as both).
 */
export function circleTxObject(tx: any): Record<string, unknown> {
  const maxFee = tx.maxFeePerGas ?? tx.gasPrice
  const tip = tx.maxPriorityFeePerGas ?? tx.gasPrice ?? maxFee
  if (tx.chainId == null || tx.nonce == null || tx.gas == null || maxFee == null) throw new Error('Relayer transaction is missing chainId, nonce, gas or fee')
  return {
    nonce: Number(tx.nonce),
    ...(tx.to ? { to: tx.to } : {}),
    value: BigInt(tx.value ?? 0n).toString(),
    data: tx.data ?? '0x',
    gas: BigInt(tx.gas).toString(),
    maxFeePerGas: BigInt(maxFee).toString(),
    maxPriorityFeePerGas: BigInt(tip).toString(),
    chainId: Number(tx.chainId),
  }
}

/** The signed transaction is exactly what was asked for, signed by `address` - or throws. */
export async function checkSigned(signed: Hex, asked: Record<string, any>, address: string): Promise<void> {
  const { parseTransaction, recoverTransactionAddress } = await import('viem')
  const p: any = parseTransaction(signed)
  const from = (await recoverTransactionAddress({ serializedTransaction: signed as any })).toLowerCase()
  const same = (a: unknown, b: unknown) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()
  const ok = from === address.toLowerCase()
    && Number(p.chainId) === Number(asked.chainId)
    && Number(p.nonce) === Number(asked.nonce)
    && same(p.to, asked.to)
    && BigInt(p.value ?? 0n) === BigInt(asked.value)
    && same(p.data ?? '0x', asked.data ?? '0x')
    && BigInt(p.gas) === BigInt(asked.gas)
    && BigInt(p.maxFeePerGas ?? p.gasPrice) === BigInt(asked.maxFeePerGas)
  if (!ok) throw new Error('Circle returned a transaction that does not match the request - not sent')
}

/** The Circle-backed viem account, or null when Circle isn't configured. */
export async function circleRelayerAccount(): Promise<any | null> {
  const cfg = circleConfig()
  if (!cfg) return null
  const { toAccount } = await import('viem/accounts')
  const unsupported = (what: string) => async () => { throw new Error(`The Circle relayer account does not ${what}`) }
  return toAccount({
    address: cfg.address,
    async signTransaction(tx: any) {
      const asked = circleTxObject(tx)
      const d = await circleCall(cfg.apiKey, '/developer/sign/transaction', {
        walletId: cfg.walletId,
        transaction: JSON.stringify(asked),
        entitySecretCiphertext: await ciphertext(cfg.apiKey, cfg.entitySecret),
      })
      const signed = String(d?.signedTransaction ?? '') as Hex
      if (!/^0x[0-9a-fA-F]+$/.test(signed)) throw new Error('Circle returned no signed transaction')
      await checkSigned(signed, asked, cfg.address)
      return signed
    },
    signMessage: unsupported('sign messages') as any,
    signTypedData: unsupported('sign typed data') as any,
  })
}

/**
 * The account the relayer sends from on `chainId`: Circle where it signs
 * (circle mode), otherwise the private key. Null when neither is configured.
 */
export async function relayerAccount(chainId: number): Promise<any | null> {
  if (circleSignsOn(chainId)) {
    const a = await circleRelayerAccount()
    if (a) return a
  }
  return keyRelayerAccount()
}

/** The relayer's public address on Arc (what P2P sellers name as operator). */
export async function relayerAddress(): Promise<string | null> {
  if (relayerMode() === 'circle') {
    const cfg = circleConfig()
    if (cfg) return cfg.address
  }
  return (await keyRelayerAccount())?.address ?? null
}
