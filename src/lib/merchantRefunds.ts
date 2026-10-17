// Merchant refunds - Business → payment → Refund.
//
// The merchant's own wallet sends the refund from its Arc balance, one of
// two ways (the key signs here and never leaves the device):
//   'arc'    on Arc through the MeshPortRefunds contract (written, tested and
//            deployed with Arc Studio): refund(paymentRef, customer, reason)
//            with the USDC as the transaction value; one refund per payment
//            per merchant, on-chain.
//   'origin' back on the chain the customer paid from: a CCTP burn on Arc
//            (TokenMessengerV2) to the payer's address on that chain. Circle's
//            Forwarding Service mints it there (or MeshPort's relayer, on
//            chains where the forwarder doesn't mint). The merchant pays
//            Circle's fee on top, so the customer gets the full amount.
// merchant-refund then reads the transaction from Arc, checks it against
// the payment and records it (one refund per payment).
import { createPublicClient, createWalletClient, encodeFunctionData, keccak256, toBytes, parseGwei, pad, type Hash, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { supabase } from '@/lib/supabase'
import { arcTransport } from '@/lib/arc'
import { ARC_CHAIN_INLINE, circleForwarderMintsTo } from '@/blockchain/chains'
import { describeFunctionsError } from '@/lib/describeFunctionsError'
import { CCTP_DOMAINS } from '@/lib/cctpTracker'
import { FORWARD_HOOK, FAST_FINALITY, ARC_DOMAIN } from '@/lib/gaslessBridge'

export const REFUNDS_CONTRACT = '0x53e5c71290dc5147089b7b40679f3d6a164c8c2b' as `0x${string}`
export const REFUND_REASONS = ['Order cancelled', 'Wrong amount', 'Item unavailable', 'Paid twice', 'Other']

const TOKEN_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as Hex // CCTP V2 (testnet)
const ARC_USDC = '0x3600000000000000000000000000000000000000' as Hex          // Arc USDC, ERC-20 view (6 decimals)

const ABI = [{
  type: 'function', name: 'refund', stateMutability: 'payable',
  inputs: [{ name: 'paymentRef', type: 'bytes32' }, { name: 'customer', type: 'address' }, { name: 'reason', type: 'string' }], outputs: [],
}] as const
const ERC20 = [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const
const BURN_ARGS = [
  { name: 'amount', type: 'uint256' }, { name: 'destinationDomain', type: 'uint32' }, { name: 'mintRecipient', type: 'bytes32' },
  { name: 'burnToken', type: 'address' }, { name: 'destinationCaller', type: 'bytes32' }, { name: 'maxFee', type: 'uint256' },
  { name: 'minFinalityThreshold', type: 'uint32' },
] as const
const MESSENGER = [
  { type: 'function', name: 'depositForBurn', stateMutability: 'nonpayable', inputs: BURN_ARGS, outputs: [] },
  { type: 'function', name: 'depositForBurnWithHook', stateMutability: 'nonpayable', inputs: [...BURN_ARGS, { name: 'hookData', type: 'bytes' }], outputs: [] },
] as const

export type RefundRoute = 'arc' | 'origin'
export type MerchantRefund = { id: string; paymentId: string; amount: number; reason: string; txHash: string; createdAt: string; chain: string; route: 'contract' | 'cctp' }
const mapRefund = (r: any): MerchantRefund => ({ id: r.id, paymentId: r.payment_id ?? `rcpt_${r.receipt_id}`, amount: Number(r.amount), reason: r.reason ?? '',
  txHash: r.tx_hash, createdAt: r.created_at, chain: r.refund_chain ?? 'Arc_Testnet', route: r.route ?? 'contract' })

/** The on-chain reference for a payment (same as merchant-refund). */
export const paymentRef = (id: string) => keccak256(toBytes(id))

/** Can this chain take a refund back (a CCTP domain MeshPort knows)? */
export const canRefundOnChain = (chain: string) => chain !== 'Arc_Testnet' && CCTP_DOMAINS[chain] !== undefined

export async function listMyRefunds(): Promise<MerchantRefund[]> {
  const { data } = await supabase.from('merchant_refunds').select('*').order('created_at', { ascending: false }).limit(500)
  return (data ?? []).map(mapRefund)
}

export function subscribeMyRefunds(onChange: () => void): () => void {
  const ch = supabase.channel(`merchant-refunds-${Math.random().toString(36).slice(2)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'merchant_refunds' }, onChange).subscribe()
  return () => { supabase.removeChannel(ch) }
}

async function record(target: { paymentId?: string; receiptId?: string }, txHash: string, route: 'contract' | 'cctp', reason: string): Promise<MerchantRefund> {
  for (let i = 0; i < 6; i++) {
    const { data, error } = await supabase.functions.invoke('merchant-refund', { body: { action: 'record', ...target, txHash, route, reason } })
    if (error) throw new Error(await describeFunctionsError(error, 'Could not record the refund'))
    if (data?.refund) return mapRefund(data.refund)
    if (!data?.pending) throw new Error(data?.error || 'Could not record the refund')
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error('Refund sent - it will show here in a moment')
}

const forwarderChain = (chain: string) => circleForwarderMintsTo(chain === 'Polygon_Sepolia' ? 'Polygon_Amoy_Testnet' : chain)

/** Circle's fee to bring `amount` from Arc to `chain` (USDC units, 6 dp), paid on top. */
async function cctpFee(chain: string, amount: bigint, forward: boolean): Promise<bigint> {
  const dst = CCTP_DOMAINS[chain]
  for (const host of ['https://iris-api-sandbox.circle.com', 'https://iris-api.circle.com']) {
    try {
      const r = await fetch(`${host}/v2/burn/USDC/fees/${ARC_DOMAIN}/${dst}${forward ? '?forward=true' : ''}`, { signal: AbortSignal.timeout(8000) })
      if (!r.ok) continue
      const rows = await r.json() as Array<{ finalityThreshold: number; minimumFee: number; forwardFee?: { high?: number; med?: number } }>
      const fast = rows.find(x => x.finalityThreshold <= FAST_FINALITY) ?? rows[0]
      if (!fast) continue
      const bps = BigInt(Math.ceil((fast.minimumFee ?? 0) * 100)) // minimumFee is in basis points (may be fractional)
      const protocol = (amount * bps + 999_999n) / 1_000_000n
      const fwd = forward ? BigInt(Math.ceil(fast.forwardFee?.high ?? fast.forwardFee?.med ?? 0)) : 0n
      return ((protocol + fwd) * 12n) / 10n + 1_000n // 20% headroom; maxFee is a cap, not a charge
    } catch { /* try the other host */ }
  }
  // No quote: a safe cap (Ethereum's mint is the costly one).
  return chain === 'Ethereum_Sepolia' ? 1_500_000n : 250_000n + amount / 1000n
}

async function sendArcTx(account: ReturnType<typeof privateKeyToAccount>, to: Hex, data: Hex, value = 0n) {
  const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 30000 }), pollingInterval: 250 })
  const walletClient = createWalletClient({ account, transport: arcTransport() })
  const [nonce, gas] = await Promise.all([
    publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    publicClient.estimateGas({ account: account.address, to, data, value }),
  ])
  const hash: Hash = await walletClient.sendTransaction({
    to, data, value, nonce, gas: (gas * 130n) / 100n,
    maxFeePerGas: parseGwei('25'), maxPriorityFeePerGas: parseGwei('1'), chain: ARC_CHAIN_INLINE,
  } as unknown as Parameters<typeof walletClient.sendTransaction>[0])
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30000 })
  if (receipt.status !== 'success') throw new Error('The refund transaction failed on-chain')
  return hash
}

/** Sends the refund from the merchant's wallet and records it. */
export async function refundPayment(p: {
  /** An order payment's id, or "rcpt_<id>" for a payment on another chain without an order. */
  paymentId: string; customer: string; amount: number; reason: string; privateKey: string
  route?: RefundRoute; chain?: string
}): Promise<MerchantRefund> {
  if (!(p.amount > 0)) throw new Error('Nothing to refund')
  const target = p.paymentId.startsWith('rcpt_') ? { receiptId: p.paymentId.slice(5) } : { paymentId: p.paymentId }
  const refId = target.receiptId ?? target.paymentId!
  const account = privateKeyToAccount(p.privateKey as Hex)
  const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 30000 }), pollingInterval: 250 })
  const balance = await publicClient.getBalance({ address: account.address }) // 18 decimals
  const reason = p.reason.slice(0, 140)

  if (p.route === 'origin' && p.chain && canRefundOnChain(p.chain)) {
    const amount = BigInt(Math.round(p.amount * 1e6))
    const forward = forwarderChain(p.chain)
    const fee = await cctpFee(p.chain, amount, forward)
    const burn = amount + fee
    if (balance < burn * 10n ** 12n + 50_000_000_000_000_000n) throw new Error(`Not enough USDC on Arc: this refund needs about $${(Number(burn) / 1e6 + 0.05).toFixed(2)} including fees`)
    await sendArcTx(account, ARC_USDC, encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [TOKEN_MESSENGER, burn] }))
    const base = [burn, CCTP_DOMAINS[p.chain], pad(p.customer as Hex, { size: 32 }), ARC_USDC, pad('0x0', { size: 32 }), fee, FAST_FINALITY] as const
    const data = forward
      ? encodeFunctionData({ abi: MESSENGER, functionName: 'depositForBurnWithHook', args: [...base, FORWARD_HOOK] })
      : encodeFunctionData({ abi: MESSENGER, functionName: 'depositForBurn', args: base })
    const hash = await sendArcTx(account, TOKEN_MESSENGER, data)
    // No forwarder on that chain: MeshPort's relayer submits the mint.
    if (!forward) void import('@/lib/cctpRecovery').then(m => m.finishCctpMintViaRelayer({ sourceChain: 'Arc_Testnet', destinationChain: p.chain!, burnTxHash: hash, timeoutMs: 15 * 60_000 })).catch(() => {})
    return record(target, hash, 'cctp', reason)
  }

  const value = BigInt(Math.round(p.amount * 1e6)) * 10n ** 12n // Arc native USDC has 18 decimals
  if (balance < value) throw new Error('Not enough USDC on Arc for this refund')
  const data = encodeFunctionData({ abi: ABI, functionName: 'refund', args: [paymentRef(refId), p.customer as Hex, reason] })
  const hash = await sendArcTx(account, REFUNDS_CONTRACT, data, value).catch((e: Error) => {
    throw new Error(/AlreadyRefunded/i.test(e.message) ? 'This payment was already refunded' : /insufficient/i.test(e.message) ? 'Not enough USDC on Arc for this refund' : e.message)
  })
  return record(target, hash, 'contract', reason)
}
