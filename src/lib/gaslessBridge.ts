// src/lib/gaslessBridge.ts
//
// Gasless "Bring Funds" (CCTP, any supported chain → Arc) through
// MeshPortBridgeRouter (contracts/MeshPortBridgeRouter.sol):
//
//   1. ask /api/bridge-relay for a quote (MeshPort fee + CCTP maxFee)
//   2. sign ONE USDC ReceiveWithAuthorization locally - the wallet key never
//      leaves the device, and the user needs no gas on the source chain
//   3. /api/bridge-relay submits it; in one transaction the router pulls the
//      USDC, pays MeshPort's fee, and burns the rest with Circle's
//      forwarding hook so Circle mints on Arc
//   4. the returned burn hash goes to the normal tracking (lib/cctpTracker)
//
// SECURITY: what gets signed is built HERE from values compiled into the app
// - the router and USDC addresses, the chain id, Arc's domain, the user's
// own address as recipient and Circle's forwarding hook. Only the fee and
// maxFee come from the server, and both are capped below. A wrong or
// malicious server can therefore at most make the signature useless, never
// redirect the funds.
//
// Off until a router address is configured for a chain (VITE_BRIDGE_ROUTERS,
// JSON like {"Base_Sepolia":"0x…"}); Bring Funds then keeps its current flow.

import { encodeAbiParameters, keccak256, toHex, pad, getAddress, type Hex } from 'viem'
import { EXTERNAL_CHAINS } from '@/blockchain/chains'

export const ARC_DOMAIN = 26
/** Circle Forwarding Service hook: "cctp-forward", version 0, no extra data. */
export const FORWARD_HOOK: Hex = '0x636374702d666f72776172640000000000000000000000000000000000000000'
export const FAST_FINALITY = 1000
export const BRIDGE_TYPEHASH = keccak256(toHex(
  'MeshPortBridge(uint256 chainId,address router,address token,uint32 destinationDomain,bytes32 mintRecipient,uint256 fee,uint256 maxFee,uint32 minFinalityThreshold,bytes32 hookDataHash,bytes32 salt)',
))

/**
 * Chains gasless bridging can run on: every external chain whose numeric chain
 * id is verified in EXTERNAL_CHAINS (the id is part of what the user signs, so
 * an unverified one is never used). Which of these are actually ON is decided
 * by VITE_BRIDGE_ROUTERS (only chains the router was deployed to).
 */
export const GASLESS_CHAINS: Record<string, { chainId: number; usdc: Hex }> = Object.fromEntries(
  Object.entries(EXTERNAL_CHAINS)
    .filter(([, c]) => typeof c.chainId === 'number')
    .map(([k, c]) => [k, { chainId: c.chainId as number, usdc: getAddress(c.usdc) }]),
)

// Hard limits the app enforces whatever the server quotes.
const MAX_FEE_SHARE = 0.05        // MeshPort fee ≤ 5% of the amount…
const MAX_FEE_ABS = 2_000_000n    // …and ≤ 2 USDC
const MAX_CCTP_SHARE = 0.02       // CCTP maxFee ≤ 2% of the amount
const AUTH_WINDOW_SEC = 60 * 60   // signature valid for 1 hour

function configuredRouters(): Record<string, Hex> {
  try {
    // Plain import.meta.env.VITE_… so Vite substitutes it at build time.
    const raw = import.meta.env.VITE_BRIDGE_ROUTERS as string | undefined
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, string>
    const out: Record<string, Hex> = {}
    for (const [k, v] of Object.entries(parsed)) if (GASLESS_CHAINS[k] && /^0x[0-9a-fA-F]{40}$/.test(v)) out[k] = getAddress(v)
    return out
  } catch { return {} }
}

/** The router for a chain, or null when gasless bridging isn't set up there. */
export function gaslessRouter(chainId: string): Hex | null {
  return configuredRouters()[chainId] ?? null
}
export function isGaslessBridgeAvailable(chainId: string): boolean {
  return !!gaslessRouter(chainId)
}

export interface BridgeParams {
  token: Hex
  destinationDomain: number
  mintRecipient: Hex
  fee: bigint
  maxFee: bigint
  minFinalityThreshold: number
  hookData: Hex
  salt: Hex
}

/** Same hash as MeshPortBridgeRouter.bridgeNonce() - the EIP-3009 nonce the user signs. */
export function bridgeNonce(p: BridgeParams, chainId: number, router: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint32' }, { type: 'bytes32' },
      { type: 'uint256' }, { type: 'uint256' }, { type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes32' },
    ],
    [BRIDGE_TYPEHASH, BigInt(chainId), router, p.token, p.destinationDomain, p.mintRecipient, p.fee, p.maxFee, p.minFinalityThreshold, keccak256(p.hookData), p.salt],
  ))
}

export interface BridgeQuote {
  fee: string            // MeshPort fee, USDC base units
  maxFee: string         // CCTP maxFee (protocol + forwarding), base units
  usdcName: string       // USDC's EIP-712 domain name on that chain
  usdcVersion: string
}

/** Checks a quote against the app's own limits. Throws with a readable reason. */
export function checkQuote(q: BridgeQuote, amount: bigint): { fee: bigint; maxFee: bigint } {
  const fee = BigInt(q.fee), maxFee = BigInt(q.maxFee)
  if (fee < 0n || maxFee < 0n) throw new Error('Invalid quote')
  if (fee > MAX_FEE_ABS || Number(fee) > Number(amount) * MAX_FEE_SHARE) throw new Error('Network fee is unusually high right now - try again later')
  if (Number(maxFee) > Number(amount) * MAX_CCTP_SHARE) throw new Error('Bridge fee is unusually high right now - try again later')
  if (maxFee >= amount) throw new Error('Amount too small to cover the bridge fee')
  return { fee, maxFee }
}

const toUnits = (usdc: number) => BigInt(Math.round(usdc * 1e6))

/** Fetches the relayer's quote for moving `total` units and checks it against the app's limits. */
async function fetchCheckedQuote(chainId: string, total: bigint): Promise<{ quote: BridgeQuote; fee: bigint; maxFee: bigint }> {
  const { authApiHeaders } = await import('@/lib/supabase')
  const qr = await fetch(`/api/bridge-relay?action=quote&chain=${encodeURIComponent(chainId)}&amount=${total}`, { headers: await authApiHeaders() })
  const quote = await qr.json().catch(() => null) as (BridgeQuote & { error?: string }) | null
  if (!qr.ok || !quote) throw new Error(quote?.error || 'Could not get a fee quote')
  const { fee, maxFee } = checkQuote(quote, total)
  if (fee >= total) throw new Error('Amount too small to cover the network fee')
  if (maxFee >= total - fee) throw new Error('Amount too small to cover the bridge fee')
  return { quote, fee, maxFee }
}

/**
 * The fees a gasless bridge of `amountUsdc` will charge, in USDC: `networkFee`
 * is MeshPort's (the relayer's source-chain gas), `bridgeFee` is the most
 * Circle can take on mint (usually a little less). Read-only - signs nothing.
 */
export async function quoteGaslessBridge(chainId: string, amountUsdc: number): Promise<{ networkFee: number; bridgeFee: number }> {
  if (!gaslessRouter(chainId)) throw new Error('Gasless bridging is not available for this chain')
  const { fee, maxFee } = await fetchCheckedQuote(chainId, toUnits(amountUsdc))
  return { networkFee: Number(fee) / 1e6, bridgeFee: Number(maxFee) / 1e6 }
}

/**
 * Bring `amountUsdc` from `chainId` to the user's Arc wallet. `amountUsdc` is
 * what leaves the user's wallet (so "Max" = the whole balance): MeshPort's
 * fee comes out of it, the rest is burned, and Circle's own fee comes out of
 * the burn on Arc. Returns the burn transaction hash.
 */
export async function bringFundsGasless(p: {
  chainId: string
  amountUsdc: number
  privateKey: string
  walletAddress: string
  onStatus?: (msg: string) => void
}): Promise<{ txHash: Hex; fee: number; maxFee: number }> {
  const chain = GASLESS_CHAINS[p.chainId]
  const router = gaslessRouter(p.chainId)
  if (!chain || !router) throw new Error('Gasless bridging is not available for this chain')
  const total = toUnits(p.amountUsdc)

  p.onStatus?.('Getting fee…')
  const { quote, fee, maxFee } = await fetchCheckedQuote(p.chainId, total)

  const { privateKeyToAccount } = await import('viem/accounts')
  const account = privateKeyToAccount((p.privateKey.startsWith('0x') ? p.privateKey : `0x${p.privateKey}`) as Hex)
  if (account.address.toLowerCase() !== p.walletAddress.toLowerCase()) throw new Error('Wallet key does not match this account')

  const params: BridgeParams = {
    token: chain.usdc,
    destinationDomain: ARC_DOMAIN,
    mintRecipient: pad(account.address, { size: 32 }),
    fee, maxFee,
    minFinalityThreshold: FAST_FINALITY,
    hookData: FORWARD_HOOK,
    salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
  }
  const nonce = bridgeNonce(params, chain.chainId, router)
  const value = total // amount + fee; the router burns value - fee
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + AUTH_WINDOW_SEC)

  p.onStatus?.('Signing…')
  const signature = await account.signTypedData({
    domain: { name: quote.usdcName, version: quote.usdcVersion, chainId: chain.chainId, verifyingContract: chain.usdc },
    types: { ReceiveWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ] },
    primaryType: 'ReceiveWithAuthorization',
    message: { from: account.address, to: router, value, validAfter: 0n, validBefore, nonce },
  })

  p.onStatus?.('Submitting…')
  const { authApiHeaders } = await import('@/lib/supabase')
  const rr = await fetch('/api/bridge-relay', {
    method: 'POST',
    headers: await authApiHeaders(),
    body: JSON.stringify({
      action: 'relay', chain: p.chainId,
      bridge: { ...params, fee: params.fee.toString(), maxFee: params.maxFee.toString() },
      authorization: { from: account.address, value: value.toString(), validAfter: '0', validBefore: validBefore.toString(), signature },
    }),
  })
  const out = await rr.json().catch(() => null) as { txHash?: Hex; error?: string; pending?: boolean } | null
  if (!rr.ok || !out?.txHash) throw new Error(out?.error || 'Relayer did not accept the transfer')
  // The relayer gave up waiting for the receipt (slow chain) - wait for it
  // here, so "Burned" is only shown once the burn has really confirmed.
  if (out.pending) {
    p.onStatus?.('Confirming…')
    let receipt: any = null
    try {
      const { getClient } = await import('@/blockchain/ProviderManager')
      receipt = await getClient(p.chainId as any).waitForTransactionReceipt({ hash: out.txHash, timeout: 180_000 })
    } catch { /* RPC trouble - the claim worker still tracks this burn */ }
    if (receipt?.status === 'reverted') throw new Error('The transfer failed on-chain - nothing was moved')
  }
  return { txHash: out.txHash, fee: Number(fee) / 1e6, maxFee: Number(maxFee) / 1e6 }
}
