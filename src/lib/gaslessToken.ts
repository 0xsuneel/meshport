// src/lib/gaslessToken.ts
//
// Gasless Bring for EURC and cirBTC (any CCTPx chain → Arc), through
// MeshPortTokenRouter (contracts/MeshPortTokenRouter.sol) and the same
// relayer as USDC (/api/bridge-relay, token_quote / token_relay):
//
//   1. the relayer quotes MeshPort's fee, in the token - it covers the
//      relayer's gas and Circle's CCTPx fee, which the relayer pays in the
//      chain's native coin
//   2. the user signs ONE authorization locally (EIP-3009, or EIP-2612 permit
//      plus a bridge signature, whichever the token supports)
//   3. the relayer submits it; in one transaction the router pulls the token,
//      pays MeshPort's fee and sends the rest with Circle's CCTPx to the
//      user's own wallet on Arc. The user needs no gas on that chain.
//
// SECURITY: what gets signed is built HERE. The router comes from the app's
// own config, the token address is checked against Circle's registry
// (lib/tokenBridge), the token id is compiled in, and the recipient is the
// user's own address. Only the fee comes from the server, and it's capped.

import { encodeAbiParameters, keccak256, toHex, getAddress, type Hex } from 'viem'
import type { WalletAccount } from '@/wallet'
import { EXTERNAL_CHAINS } from '@/blockchain/chains'
import { assertAccountUnlocked } from '@/lib/accountLockRule'
import type { CctpxToken } from './tokenBridge'

const ARC_DOMAIN = 26
const AUTH_WINDOW_SEC = 60 * 60

/** CCTPx token ids on testnet (the same as @circle-fin/provider-cctpx's). */
export const CCTPX_TOKEN_IDS: Record<CctpxToken, Hex> = {
  EURC:   '0x2587821a0ee7daa174b95436b5dab1731cfa1844775b010217d3c0dd02a4eecd',
  cirBTC: '0x7c27b7b6485f3ea49b7d1a439e288d3c3116f533302afabb7e372dfc0770cc7d',
}
const DECIMALS: Record<CctpxToken, number> = { EURC: 6, cirBTC: 8 }
// MeshPort's fee may be up to 5% of the amount, or this small fixed amount
// (about half a dollar), whichever is more - whatever the server quotes.
const FEE_SHARE = 0.05
const FEE_SMALL: Record<CctpxToken, bigint> = { EURC: 600_000n, cirBTC: 1_000n }

export const TOKEN_BRIDGE_TYPEHASH = keccak256(toHex(
  'MeshPortTokenBridge(uint256 chainId,address router,address token,bytes32 tokenId,uint32 destinationDomain,address recipient,uint256 fee,uint32 minFinalityThreshold,bytes32 salt)',
))

/** VITE_TOKEN_ROUTERS: { "Base_Sepolia": "0x…" } - chains MeshPortTokenRouter is deployed on. */
export function tokenRouter(chainId: string): Hex | null {
  try {
    const raw = import.meta.env.VITE_TOKEN_ROUTERS as string | undefined
    if (!raw) return null
    const v = (JSON.parse(raw) as Record<string, string>)[chainId]
    return typeof EXTERNAL_CHAINS[chainId]?.chainId === 'number' && v && /^0x[0-9a-fA-F]{40}$/.test(v) ? getAddress(v) : null
  } catch { return null }
}
export const hasTokenRouter = (chainId: string) => !!tokenRouter(chainId)

export interface TokenBridgeParams {
  token: Hex
  tokenId: Hex
  destinationDomain: number
  recipient: Hex
  fee: bigint
  minFinalityThreshold: number
  salt: Hex
}

/** Same hash as MeshPortTokenRouter.bridgeNonce(). */
export function tokenBridgeNonce(p: TokenBridgeParams, chainId: number, router: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint32' },
      { type: 'address' }, { type: 'uint256' }, { type: 'uint32' }, { type: 'bytes32' },
    ],
    [TOKEN_BRIDGE_TYPEHASH, BigInt(chainId), router, p.token, p.tokenId, p.destinationDomain, p.recipient, p.fee, p.minFinalityThreshold, p.salt],
  ))
}

export interface TokenQuote {
  fee: string
  nativeFee: string
  finality: number
  token: Hex
  tokenId: Hex
  decimals: number
  auth: '3009' | 'permit'
  domainName: string
  domainVersion: string
}

/** Checks the server's quote against the app's own limits. Throws with a readable reason. */
export function checkTokenQuote(q: TokenQuote, token: CctpxToken, total: bigint, expectedAddress: string | undefined): bigint {
  const fee = BigInt(q.fee)
  if (fee < 0n) throw new Error('Invalid quote')
  if (q.tokenId.toLowerCase() !== CCTPX_TOKEN_IDS[token]) throw new Error('Invalid quote')
  if (!expectedAddress || q.token.toLowerCase() !== expectedAddress.toLowerCase()) throw new Error(`${token} isn't available on this chain right now`)
  if (q.auth !== '3009' && q.auth !== 'permit') throw new Error('Invalid quote')
  if (q.finality !== 1000 && q.finality !== 2000) throw new Error('Invalid quote')
  if (fee > FEE_SMALL[token] && Number(fee) > Number(total) * FEE_SHARE) throw new Error('Network fee is unusually high right now - try again later')
  if (fee >= total) throw new Error('Amount too small to cover the network fee')
  return fee
}

export const toTokenUnits = (token: CctpxToken, n: number) => BigInt(Math.round(n * 10 ** DECIMALS[token]))
export const fromTokenUnits = (token: CctpxToken, u: bigint) => Number(u) / 10 ** DECIMALS[token]

async function fetchQuote(chainId: string, token: CctpxToken, total: bigint, recipient: string): Promise<TokenQuote> {
  const { authApiHeaders } = await import('@/lib/supabase')
  const qs = new URLSearchParams({ action: 'token_quote', chain: chainId, token, amount: total.toString(), recipient })
  const r = await fetch(`/api/bridge-relay?${qs}`, { headers: await authApiHeaders() })
  const q = await r.json().catch(() => null) as (TokenQuote & { error?: string }) | null
  if (!r.ok || !q) throw new Error(q?.error || 'Could not get a fee quote')
  return q
}

/** MeshPort's fee (in the token) for bringing `amount` of `token` from `chainId`. Signs nothing. */
export async function quoteGaslessToken(p: { chainId: string; token: CctpxToken; amount: number; recipient: string; tokenAddress: string | undefined }): Promise<{ fee: number; receive: number }> {
  if (!tokenRouter(p.chainId)) throw new Error('Gasless bringing is not available for this chain')
  const total = toTokenUnits(p.token, p.amount)
  const fee = checkTokenQuote(await fetchQuote(p.chainId, p.token, total, p.recipient), p.token, total, p.tokenAddress)
  return { fee: fromTokenUnits(p.token, fee), receive: fromTokenUnits(p.token, total - fee) }
}

/**
 * Bring `amount` of `token` (what leaves the wallet; MeshPort's fee comes out
 * of it) from `chainId` to the user's wallet on Arc. Returns the source-chain
 * transaction hash and what Arc receives.
 */
export async function bringTokenGasless(p: {
  chainId: string
  token: CctpxToken
  amount: number
  /** The token's address on that chain, from Circle's registry. */
  tokenAddress: string | undefined
  signer: WalletAccount
  walletAddress: string
  onStatus?: (msg: string) => void
}): Promise<{ txHash: Hex; fee: number; receive: number }> {
  assertAccountUnlocked()
  const chainNum = EXTERNAL_CHAINS[p.chainId]?.chainId
  const router = tokenRouter(p.chainId)
  if (typeof chainNum !== 'number' || !router) throw new Error('Gasless bringing is not available for this chain')
  const account = p.signer
  if (account.address.toLowerCase() !== p.walletAddress.toLowerCase()) throw new Error('Wallet key does not match this account')
  const total = toTokenUnits(p.token, p.amount)

  p.onStatus?.('Getting fee…')
  const q = await fetchQuote(p.chainId, p.token, total, account.address)
  const fee = checkTokenQuote(q, p.token, total, p.tokenAddress)
  const token = getAddress(q.token)

  const params: TokenBridgeParams = {
    token, tokenId: CCTPX_TOKEN_IDS[p.token], destinationDomain: ARC_DOMAIN, recipient: account.address,
    fee, minFinalityThreshold: q.finality, salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
  }
  const nonce = tokenBridgeNonce(params, chainNum, router)
  const until = BigInt(Math.floor(Date.now() / 1000) + AUTH_WINDOW_SEC)
  const tokenDomain = { name: q.domainName, version: q.domainVersion, chainId: chainNum, verifyingContract: token }

  p.onStatus?.('Signing…')
  let body: Record<string, unknown>
  if (q.auth === '3009') {
    const signature = await account.signTypedData({
      domain: tokenDomain,
      types: { ReceiveWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ] },
      primaryType: 'ReceiveWithAuthorization',
      message: { from: account.address, to: router, value: total, validAfter: 0n, validBefore: until, nonce },
    })
    body = { authorization: { from: account.address, value: total.toString(), validAfter: '0', validBefore: until.toString(), signature } }
  } else {
    // The permit's own nonce, read from the token on that chain.
    const { getClient } = await import('@/blockchain/ProviderManager')
    const permitNonce = await (getClient(p.chainId as any) as any).readContract({
      address: token, functionName: 'nonces', args: [account.address],
      abi: [{ type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
    }) as bigint
    const signature = await account.signTypedData({
      domain: tokenDomain,
      types: { Permit: [
        { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
      ] },
      primaryType: 'Permit',
      message: { owner: account.address, spender: router, value: total, nonce: permitNonce, deadline: until },
    })
    const bridgeSignature = await account.signTypedData({
      domain: { name: 'MeshPortTokenRouter', version: '1', chainId: chainNum, verifyingContract: router },
      types: { BridgePermit: [
        { name: 'from', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ] },
      primaryType: 'BridgePermit',
      message: { from: account.address, value: total, deadline: until, nonce },
    })
    body = { permit: { from: account.address, value: total.toString(), deadline: until.toString(), signature, bridgeSignature } }
  }

  p.onStatus?.('Submitting…')
  const { authApiHeaders } = await import('@/lib/supabase')
  const rr = await fetch('/api/bridge-relay', {
    method: 'POST',
    headers: await authApiHeaders(),
    body: JSON.stringify({
      action: 'token_relay', chain: p.chainId, symbol: p.token,
      bridge: { ...params, fee: params.fee.toString() },
      ...body,
    }),
  })
  const out = await rr.json().catch(() => null) as { txHash?: Hex; error?: string; pending?: boolean } | null
  if (!rr.ok || !out?.txHash) throw new Error(out?.error || 'Relayer did not accept the transfer')
  if (out.pending) {
    p.onStatus?.('Confirming…')
    let receipt: any = null
    try {
      const { getClient } = await import('@/blockchain/ProviderManager')
      receipt = await getClient(p.chainId as any).waitForTransactionReceipt({ hash: out.txHash, timeout: 180_000 })
    } catch { /* RPC trouble - Circle still delivers once it's confirmed */ }
    if (receipt?.status === 'reverted') throw new Error('The transfer failed on-chain - nothing was moved')
  }
  return { txHash: out.txHash, fee: fromTokenUnits(p.token, fee), receive: fromTokenUnits(p.token, total - fee) }
}
