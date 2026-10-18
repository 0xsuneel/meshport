// Merchant refunds - Business → payment → Refund.
//
// The merchant's own wallet sends the refund (the key signs here and never
// leaves the device), one of three ways:
//   'chain'  from the merchant's USDC on the chain the customer paid on (the
//            money is still there): an EIP-3009 transferWithAuthorization to
//            the payer, signed here and submitted by MeshPort's relayer
//            (/api/bridge-relay), so no gas token is needed. The relayer only
//            sends it for a real, unrefunded payment from that wallet.
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

export type RefundRoute = 'chain' | 'arc' | 'origin'
export type MerchantRefund = { id: string; paymentId: string; amount: number; reason: string; txHash: string; createdAt: string; chain: string; route: 'contract' | 'cctp' | 'chain' }
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

async function record(target: { paymentId?: string; receiptId?: string }, txHash: string, route: 'contract' | 'cctp' | 'chain', reason: string, amount?: number): Promise<MerchantRefund> {
  for (let i = 0; i < 6; i++) {
    // `amount` is what the customer gets; the server checks the transaction sends exactly that.
    const { data, error } = await supabase.functions.invoke('merchant-refund', { body: { action: 'record', ...target, txHash, route, reason, amount } })
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

/** Shown when a refund was broadcast but isn't confirmed yet (it's recorded once it lands). */
export const REFUND_STILL_CONFIRMING = 'Refund sent - still confirming on-chain. Check again in a minute.'

// Arc's fee floor: a tx under 20 gwei max fee is dropped by the mempool.
const ARC_MIN_FEE = parseGwei('20')

type FeeReader = {
  getBlock: (args: { blockTag: 'latest' }) => Promise<{ [k: string]: unknown }>
  getGasPrice: () => Promise<bigint>
}
/** maxFeePerGas for Arc: twice the latest base fee (or the node's gas price), never under 20 gwei. */
async function arcFees(publicClient: FeeReader): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const [block, gasPrice] = await Promise.all([
    publicClient.getBlock({ blockTag: 'latest' }).catch(() => null),
    publicClient.getGasPrice().catch(() => null),
  ])
  const base = typeof block?.baseFeePerGas === 'bigint' ? block.baseFeePerGas : null
  let maxFee = ARC_MIN_FEE
  if (base != null && base * 2n > maxFee) maxFee = base * 2n
  if (gasPrice != null && gasPrice > maxFee) maxFee = gasPrice
  const tip = parseGwei('1')
  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: tip < maxFee ? tip : maxFee }
}

/**
 * Sends one Arc transaction and waits for it (up to 2 minutes). If it hasn't
 * landed by then it may still: `onLate` runs if it confirms later (so the
 * refund is still recorded) and this throws REFUND_STILL_CONFIRMING - never
 * "failed" for a transaction that may yet succeed.
 */
async function sendArcTx(account: ReturnType<typeof privateKeyToAccount>, to: Hex, data: Hex, value = 0n, onLate?: (hash: Hash) => void) {
  const publicClient = createPublicClient({ transport: arcTransport({ retryCount: 3, timeout: 30000 }), pollingInterval: 1000 })
  const walletClient = createWalletClient({ account, transport: arcTransport() })
  const [nonce, gas, fees] = await Promise.all([
    publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    publicClient.estimateGas({ account: account.address, to, data, value }),
    arcFees(publicClient),
  ])
  const hash: Hash = await walletClient.sendTransaction({
    to, data, value, nonce, gas: (gas * 130n) / 100n,
    ...fees, chain: ARC_CHAIN_INLINE,
  } as unknown as Parameters<typeof walletClient.sendTransaction>[0])
  let receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>> | null = null
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
  } catch {
    // Not seen yet: keep watching in the background, and record it if it lands.
    if (onLate) {
      void publicClient.waitForTransactionReceipt({ hash, timeout: 15 * 60_000 })
        .then(r => { if (r.status === 'success') onLate(hash) }).catch(() => {})
    }
    throw new Error(REFUND_STILL_CONFIRMING)
  }
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
  // A transfer to a blocklisted address reverts and still costs gas.
  const { isUsdcBlocked, BLOCKED_TEXT } = await import('@/lib/usdcBlocklist')
  const toChain = (p.route === 'chain' || p.route === 'origin') && p.chain ? p.chain : 'Arc_Testnet'
  if (await isUsdcBlocked(p.customer, toChain)) throw new Error(BLOCKED_TEXT)

  if (p.route === 'chain' && p.chain && p.chain !== 'Arc_Testnet') {
    const hash = await transferOnChain({ chain: p.chain, account, to: p.customer as Hex, amount: p.amount, target })
    void import('@/blockchain/BlockchainManager').then(m => m.notifyExternalBalanceChanged(p.chain!, account.address, { spent: p.amount })).catch(() => {})
    return record(target, hash, 'chain', reason, p.amount)
  }

  if (p.route === 'origin' && p.chain && canRefundOnChain(p.chain)) {
    const amount = BigInt(Math.round(p.amount * 1e6))
    const forward = forwarderChain(p.chain)
    const fee = await cctpFee(p.chain, amount, forward)
    const burn = amount + fee
    if (balance < burn * 10n ** 12n + 50_000_000_000_000_000n) throw new Error(`Not enough USDC on Arc: this refund needs about $${(Number(burn) / 1e6 + 0.05).toFixed(2)} including fees`)
    await sendArcTx(account, ARC_USDC, encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [TOKEN_MESSENGER, burn] })).catch((e: Error) => {
      // Only the approval was sent - no money moved yet.
      throw new Error(e.message === REFUND_STILL_CONFIRMING ? 'The approval is still confirming on-chain - try the refund again in a minute.' : e.message)
    })
    const base = [burn, CCTP_DOMAINS[p.chain], pad(p.customer as Hex, { size: 32 }), ARC_USDC, pad('0x0', { size: 32 }), fee, FAST_FINALITY] as const
    const data = forward
      ? encodeFunctionData({ abi: MESSENGER, functionName: 'depositForBurnWithHook', args: [...base, FORWARD_HOOK] })
      : encodeFunctionData({ abi: MESSENGER, functionName: 'depositForBurn', args: base })
    const hash = await sendArcTx(account, TOKEN_MESSENGER, data, 0n, h => { void record(target, h, 'cctp', reason, p.amount).catch(() => {}) })
    // No forwarder on that chain: MeshPort's relayer submits the mint.
    if (!forward) void import('@/lib/cctpRecovery').then(m => m.finishCctpMintViaRelayer({ sourceChain: 'Arc_Testnet', destinationChain: p.chain!, burnTxHash: hash, timeoutMs: 15 * 60_000 })).catch(() => {})
    return record(target, hash, 'cctp', reason, p.amount)
  }

  const value = BigInt(Math.round(p.amount * 1e6)) * 10n ** 12n // Arc native USDC has 18 decimals
  if (balance < value) throw new Error('Not enough USDC on Arc for this refund')
  const data = encodeFunctionData({ abi: ABI, functionName: 'refund', args: [paymentRef(refId), p.customer as Hex, reason] })
  const hash = await sendArcTx(account, REFUNDS_CONTRACT, data, value, h => { void record(target, h, 'contract', reason, p.amount).catch(() => {}) }).catch((e: Error) => {
    throw new Error(/AlreadyRefunded/i.test(e.message) ? 'This payment was already refunded' : /insufficient/i.test(e.message) ? 'Not enough USDC on Arc for this refund' : e.message)
  })
  return record(target, hash, 'contract', reason, p.amount)
}

// ── Who can be refunded ───────────────────────────────────────────────────
// Only a payment sent straight from a person's own wallet can go back to
// that address: an exchange, a bridge, a Safe or any other contract may not
// belong to the customer on the refund chain (or can't receive at all).
// Checked on the chain it was paid on: a wallet has no contract code (or only
// an EIP-7702 delegation, 0xef0100…); bridge mints come from the zero address.
export type SenderCheck = { refundable: boolean; reason?: string }
const senderCache = new Map<string, SenderCheck>()

async function codeAt(chain: string, address: string): Promise<string | null> {
  const body = { jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }
  if (chain === 'Arc_Testnet') {
    const { arcRpcJson } = await import('@/lib/arc')
    const j = await arcRpcJson(body).catch(() => null)
    return typeof j?.result === 'string' ? j.result : null
  }
  const { EXTERNAL_CHAINS } = await import('@/blockchain/chains')
  for (const url of EXTERNAL_CHAINS[chain]?.rpcs ?? []) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(6000) })
      const j = await r.json()
      if (typeof j?.result === 'string') return j.result
    } catch { /* next RPC */ }
  }
  return null
}

export async function checkRefundableSender(chain: string, from: string): Promise<SenderCheck> {
  const key = `${chain}:${from.toLowerCase()}`
  const hit = senderCache.get(key)
  if (hit) return hit
  let out: SenderCheck
  if (!/^0x[0-9a-fA-F]{40}$/.test(from) || /^0x0{40}$/i.test(from)) {
    out = { refundable: false, reason: 'Paid through a bridge, so there is no wallet to send a refund back to.' }
  } else {
    const { KNOWN_INTERNAL_CONTRACTS } = await import('@/lib/onchainReceivedActivity')
    const code = KNOWN_INTERNAL_CONTRACTS.has(from.toLowerCase()) ? 'contract' : await codeAt(chain, from)
    const { isUsdcBlocked, BLOCKED_TEXT } = await import('@/lib/usdcBlocklist')
    out = code === null ? { refundable: false, reason: "Couldn't check who sent this payment. Try again in a moment." }
      : !(code === '0x' || code.toLowerCase().startsWith('0xef0100'))
        ? { refundable: false, reason: 'Paid from a contract (an exchange, bridge or smart account), so it can’t be refunded automatically. Contact the customer.' }
      : await isUsdcBlocked(from, chain) ? { refundable: false, reason: `Paid from a blocked address. ${BLOCKED_TEXT}` }
      : { refundable: true }
  }
  if (out.refundable || out.reason?.startsWith('Paid')) senderCache.set(key, out)
  return out
}

// ── Refund from the payment's own chain ──────────────────────────────────
const USDC_ABI = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'transferWithAuthorization', stateMutability: 'nonpayable', outputs: [], inputs: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }] },
] as const

/** USDC the merchant still holds on that chain (6 dp), or null when unreadable. */
export async function chainUsdcBalance(chain: string, wallet: string): Promise<number | null> {
  try {
    const { readExternalChainBalance } = await import('@/blockchain/BlockchainManager')
    return await readExternalChainBalance(chain as never, wallet)
  } catch { return null }
}

async function transferOnChain(p: { chain: string; account: ReturnType<typeof privateKeyToAccount>; to: Hex; amount: number; target: { paymentId?: string; receiptId?: string } }): Promise<Hash> {
  const { EXTERNAL_CHAINS } = await import('@/blockchain/chains')
  const cfg = EXTERNAL_CHAINS[p.chain]
  if (!cfg || typeof cfg.chainId !== 'number') throw new Error('Refunds on this chain are not available')
  const { http, parseSignature, toHex } = await import('viem')
  const usdc = cfg.usdc as Hex
  const value = BigInt(Math.round(p.amount * 1e6))
  // Name/version for the EIP-712 domain and the balance, from the chain itself.
  let read: any = null
  for (const url of cfg.rpcs) {
    try {
      const c: any = createPublicClient({ transport: http(url, { timeout: 8000 }) })
      const [name, version, bal] = await Promise.all([
        c.readContract({ address: usdc, abi: USDC_ABI, functionName: 'name' }),
        c.readContract({ address: usdc, abi: USDC_ABI, functionName: 'version' }),
        c.readContract({ address: usdc, abi: USDC_ABI, functionName: 'balanceOf', args: [p.account.address] }),
      ])
      read = { name, version, bal }; break
    } catch { /* next RPC */ }
  }
  if (!read) throw new Error('Could not reach this chain - try again')
  if ((read.bal as bigint) < value) throw new Error('Not enough USDC left on this chain (it may already be settled to Arc)')

  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)))
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 60 * 60)
  const signature = await p.account.signTypedData({
    domain: { name: read.name, version: read.version, chainId: cfg.chainId, verifyingContract: usdc },
    types: { TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ] },
    primaryType: 'TransferWithAuthorization',
    message: { from: p.account.address, to: p.to, value, validAfter: 0n, validBefore, nonce },
  })
  const sig = parseSignature(signature)
  const data = encodeFunctionData({ abi: USDC_ABI, functionName: 'transferWithAuthorization',
    args: [p.account.address, p.to, value, 0n, validBefore, nonce, Number(sig.v ?? BigInt(27 + (sig.yParity ?? 0))), sig.r, sig.s] })

  const { authApiHeaders } = await import('@/lib/supabase')
  const r = await fetch('/api/bridge-relay', { method: 'POST', headers: await authApiHeaders(),
    body: JSON.stringify({ action: 'call', chain: p.chain, to: usdc, data, refundFor: p.target }) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.txHash) throw new Error(j.error || 'Could not send the refund')
  return j.txHash as Hash
}
