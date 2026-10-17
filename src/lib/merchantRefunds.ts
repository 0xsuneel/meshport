// Merchant refunds - Business → payment → Refund.
//
// The merchant's own wallet sends the refund on Arc through the
// MeshPortRefunds contract (written, tested and deployed with Arc Studio):
// refund(paymentRef, customer, reason) with the USDC as the transaction
// value. The contract forwards it to the customer and allows one refund per
// payment per merchant. The key signs here and never leaves the device;
// merchant-refund then reads the Refunded event from Arc and records it.
import { createPublicClient, createWalletClient, encodeFunctionData, keccak256, toBytes, parseGwei, type Hash } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { supabase } from '@/lib/supabase'
import { arcTransport } from '@/lib/arc'
import { ARC_CHAIN_INLINE } from '@/blockchain/chains'
import { describeFunctionsError } from '@/lib/describeFunctionsError'

export const REFUNDS_CONTRACT = '0x53e5c71290dc5147089b7b40679f3d6a164c8c2b' as `0x${string}`
export const REFUND_REASONS = ['Order cancelled', 'Wrong amount', 'Item unavailable', 'Paid twice', 'Other']

const ABI = [{
  type: 'function', name: 'refund', stateMutability: 'payable',
  inputs: [{ name: 'paymentRef', type: 'bytes32' }, { name: 'customer', type: 'address' }, { name: 'reason', type: 'string' }], outputs: [],
}] as const

export type MerchantRefund = { id: string; paymentId: string; amount: number; reason: string; txHash: string; createdAt: string }
const mapRefund = (r: any): MerchantRefund => ({ id: r.id, paymentId: r.payment_id, amount: Number(r.amount), reason: r.reason ?? '', txHash: r.tx_hash, createdAt: r.created_at })

/** The on-chain reference for a payment (same as merchant-refund). */
export const paymentRef = (paymentId: string) => keccak256(toBytes(paymentId))

export async function listMyRefunds(): Promise<MerchantRefund[]> {
  const { data } = await supabase.from('merchant_refunds').select('*').order('created_at', { ascending: false }).limit(500)
  return (data ?? []).map(mapRefund)
}

export function subscribeMyRefunds(onChange: () => void): () => void {
  const ch = supabase.channel(`merchant-refunds-${Math.random().toString(36).slice(2)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'merchant_refunds' }, onChange).subscribe()
  return () => { supabase.removeChannel(ch) }
}

async function record(paymentId: string, txHash: string): Promise<MerchantRefund> {
  for (let i = 0; i < 6; i++) {
    const { data, error } = await supabase.functions.invoke('merchant-refund', { body: { action: 'record', paymentId, txHash } })
    if (error) throw new Error(await describeFunctionsError(error, 'Could not record the refund'))
    if (data?.refund) return mapRefund(data.refund)
    if (!data?.pending) throw new Error(data?.error || 'Could not record the refund')
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error('Refund sent - it will show here in a moment')
}

/** Sends the refund from the merchant's wallet and records it. */
export async function refundPayment(p: { paymentId: string; customer: string; amount: number; reason: string; privateKey: string }): Promise<MerchantRefund> {
  if (/^0x0+$/.test(REFUNDS_CONTRACT)) throw new Error('Refunds are not available yet')
  if (!(p.amount > 0)) throw new Error('Nothing to refund')
  const account = privateKeyToAccount(p.privateKey as `0x${string}`)
  const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 30000 }), pollingInterval: 250 })
  const walletClient = createWalletClient({ account, transport: arcTransport() })
  const value = BigInt(Math.round(p.amount * 1e6)) * 10n ** 12n // Arc native USDC has 18 decimals
  const data = encodeFunctionData({ abi: ABI, functionName: 'refund', args: [paymentRef(p.paymentId), p.customer as `0x${string}`, p.reason.slice(0, 140)] })

  const [nonce, gas, balance] = await Promise.all([
    publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    publicClient.estimateGas({ account: account.address, to: REFUNDS_CONTRACT, data, value }).catch((e: Error) => {
      throw new Error(/AlreadyRefunded/i.test(e.message) ? 'This payment was already refunded' : /insufficient/i.test(e.message) ? 'Not enough USDC on Arc for this refund' : 'Refund would fail - check your Arc balance')
    }),
    publicClient.getBalance({ address: account.address }),
  ])
  if (balance < value) throw new Error('Not enough USDC on Arc for this refund')

  const hash: Hash = await walletClient.sendTransaction({
    to: REFUNDS_CONTRACT, data, value, nonce, gas: (gas * 130n) / 100n,
    maxFeePerGas: parseGwei('25'), maxPriorityFeePerGas: parseGwei('1'), chain: ARC_CHAIN_INLINE,
  } as unknown as Parameters<typeof walletClient.sendTransaction>[0])
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30000 })
  if (receipt.status !== 'success') throw new Error('The refund transaction failed on-chain')
  return record(p.paymentId, hash)
}
