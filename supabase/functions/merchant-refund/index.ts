// supabase/functions/merchant-refund/index.ts
//
// Records a merchant refund that already happened (on Arc, or on the chain the customer paid on).
//
//   POST { action: 'record', paymentId | receiptId, txHash, route?, amount? }   merchant only
//
// A payment can be refunded several times, as long as all its refunds
// together stay within the payment (merchant_refunds_cap enforces it in the
// database too). Idempotent per refund transaction (tx hash + chain), not
// per payment: recording the same transaction again returns the same row.
//
// The merchant's wallet sends the refund itself, one of three ways:
//   route 'contract' (default): on Arc through the MeshPortRefunds contract
//     (deployed with Arc Studio; one refund per reference per merchant,
//     enforced on-chain). Its Refunded event must name this merchant, the
//     payer as the customer and a refund reference of this payment:
//     keccak256(id) for the 1st refund, keccak256(`${id}:${n}`) for the
//     n-th (n >= 2) - see refundRef.
//   route 'chain': from the merchant's USDC on the chain the customer paid
//     on (the money is still there) - a USDC Transfer on that chain from the
//     merchant to the payer, sent by MeshPort's relayer (EIP-3009).
//   route 'cctp': back on the chain the customer paid from - a CCTP burn on
//     Arc (TokenMessengerV2 DepositForBurn) by the merchant, minted by Circle
//     to the payer's address on that chain's domain.
// Nothing from the client is trusted except "look at this transaction": the
// receipt is read from Arc and checked against the payment (an order
// payment, or a payment on another chain without an order); all its refunds
// together never exceed the payment. The customer is notified.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { keccak256, toBytes, decodeEventLog, type Hex } from 'npm:viem@2'

// Same CORS behaviour as ../_shared/cors.ts (kept inline: one-file function).
function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || ''
  const allowed = (Deno.env.get('ALLOWED_ORIGIN') || '').trim()
  return {
    'Access-Control-Allow-Origin': allowed ? (origin.includes('localhost') ? origin : allowed) : '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}
const handleOptionsFor = (req: Request) => req.method === 'OPTIONS' ? new Response('ok', { headers: corsFor(req) }) : null
const jsonFor = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsFor(req), 'Content-Type': 'application/json' } })

// MeshPortRefunds, deployed with Arc Studio (override with MESHPORT_REFUNDS_CONTRACT).
const REFUNDS_CONTRACT = (Deno.env.get('MESHPORT_REFUNDS_CONTRACT') || '0x53e5c71290dc5147089b7b40679f3d6a164c8c2b').toLowerCase()

const DRPC_KEY = Deno.env.get('DRPC_KEY') ?? ''
// The customer's push ("Refund from …"), sent through the app's /api/push.
const APP_BASE_URL = (() => {
  const raw = (Deno.env.get('APP_BASE_URL') || '').trim()
  const m = /https?:\/\/[^\s/'"]+/i.exec(raw)
  return m ? m[0] : 'https://meshport.xyz'
})()
const PUSH_INTERNAL_SECRET = (Deno.env.get('PUSH_INTERNAL_SECRET') || '').trim()
const ARC_RPCS = [
  ...((Deno.env.get('ARC_RPC_URL') ?? '').trim() ? [(Deno.env.get('ARC_RPC_URL') ?? '').trim()] : []),
  ...(DRPC_KEY ? [`https://lb.drpc.live/arc-testnet/${DRPC_KEY}`] : []),
  'https://rpc.testnet.arc.io',
  'https://rpc.blockdaemon.testnet.arc.io',
  'https://rpc.drpc.testnet.arc.io',
]

// Public RPCs to look at the payer on the chain they paid from (same set as merchant-pay).
const CHAIN_RPCS: Record<string, string[]> = {
  Ethereum_Sepolia: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.drpc.org'],
  Base_Sepolia: ['https://base-sepolia-rpc.publicnode.com', 'https://sepolia.base.org'],
  Arbitrum_Sepolia: ['https://arbitrum-sepolia-rpc.publicnode.com', 'https://sepolia-rollup.arbitrum.io/rpc'],
  Optimism_Sepolia: ['https://optimism-sepolia-rpc.publicnode.com', 'https://sepolia.optimism.io'],
  Polygon_Sepolia: ['https://polygon-amoy-bor-rpc.publicnode.com'],
  Avalanche_Fuji: ['https://api.avax-test.network/ext/bc/C/rpc', 'https://avalanche-fuji-c-chain-rpc.publicnode.com'],
  HyperEVM_Testnet: ['https://rpcs.chain.link/hyperevm/testnet', 'https://rpc.hyperliquid-testnet.xyz/evm'],
  Sei_Testnet: ['https://evm-rpc-testnet.sei-apis.com'],
  Unichain_Sepolia: ['https://sepolia.unichain.org'],
  Sonic_Testnet: ['https://rpc.testnet.soniclabs.com'],
  World_Chain_Sepolia: ['https://worldchain-sepolia.g.alchemy.com/public'],
  Linea_Sepolia: ['https://rpc.sepolia.linea.build'],
  Ink_Testnet: ['https://rpc-gel-sepolia.inkonchain.com'],
  Monad_Testnet: ['https://testnet-rpc.monad.xyz'],
  Plume_Testnet: ['https://testnet-rpc.plume.org'],
  Codex_Testnet: ['https://rpc.codex-stg.xyz'],
  XDC_Apothem: ['https://rpc.apothem.network'],
}

// USDC per chain (same values as merchant-pay / src/blockchain/chains.ts).
const CHAIN_USDC: Record<string, string> = {
  Ethereum_Sepolia: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238', Base_Sepolia: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  Arbitrum_Sepolia: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d', Optimism_Sepolia: '0x5fd84259d66cd46123540766be93dfe6d43130d7',
  Polygon_Sepolia: '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582', Avalanche_Fuji: '0x5425890298aed601595a70ab815c96711a31bc65',
  HyperEVM_Testnet: '0x2b3370ee501b4a559b57d449569354196457d8ab', Sei_Testnet: '0x4fcf1784b31630811181f670aea7a7bef803eaed',
  Unichain_Sepolia: '0x31d0220469e10c4e71834a79b1f276d740d3768f', Sonic_Testnet: '0x0ba304580ee7c9a980cf72e55f5ed2e9fd30bc51',
  World_Chain_Sepolia: '0x66145f38cbac35ca6f1dfb4914df98f1614aea88', Linea_Sepolia: '0xfece4462d57bd51a6a552365a011b95f0e16d9b7',
  Ink_Testnet: '0xfabab97dce620294d2b0b0e46c68964e326300ac', Monad_Testnet: '0x534b2f3a21130d7a60830c2df862319e593943a3',
  Plume_Testnet: '0xcb5f30e335672893c7eb944b374c196392c19d18', Codex_Testnet: '0x6d7f141b6819c2c9cc2f818e6ad549e7ca090f8f',
  XDC_Apothem: '0xb5ab69f7bbada22b28e79c8ffaece55ef1c771d4',
}
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

// CCTP V2 (testnet) on Arc.
const TOKEN_MESSENGER = '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa'
const CCTP_DOMAINS: Record<string, number> = {
  Ethereum_Sepolia: 0, Avalanche_Fuji: 1, Optimism_Sepolia: 2, Arbitrum_Sepolia: 3, Base_Sepolia: 6, Polygon_Sepolia: 7,
  Polygon_Amoy_Testnet: 7, Unichain_Sepolia: 10, Linea_Sepolia: 11, Codex_Testnet: 12, Sonic_Testnet: 13, World_Chain_Sepolia: 14,
  Monad_Testnet: 15, Sei_Testnet: 16, XDC_Apothem: 18, HyperEVM_Testnet: 19, Ink_Testnet: 21, Plume_Testnet: 22,
  Edge_Testnet: 28, Injective_Testnet: 29, Morph_Testnet: 30, Pharos_Testnet: 31,
}
const DEPOSIT_FOR_BURN = [{
  type: 'event', name: 'DepositForBurn', anonymous: false,
  inputs: [
    { name: 'burnToken', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
    { name: 'depositor', type: 'address', indexed: true },
    { name: 'mintRecipient', type: 'bytes32', indexed: false },
    { name: 'destinationDomain', type: 'uint32', indexed: false },
    { name: 'destinationTokenMessenger', type: 'bytes32', indexed: false },
    { name: 'destinationCaller', type: 'bytes32', indexed: false },
    { name: 'maxFee', type: 'uint256', indexed: false },
    { name: 'minFinalityThreshold', type: 'uint32', indexed: true },
    { name: 'hookData', type: 'bytes', indexed: false },
  ],
}] as const

const REFUNDED_EVENT = [{
  type: 'event', name: 'Refunded', anonymous: false,
  inputs: [
    { name: 'paymentRef', type: 'bytes32', indexed: true },
    { name: 'merchant', type: 'address', indexed: true },
    { name: 'customer', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
    { name: 'reason', type: 'string', indexed: false },
  ],
}] as const

function serviceKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (legacy) return legacy
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (raw) {
    try {
      const p = JSON.parse(raw)
      const c = p?.service_role ?? p?.SUPABASE_SERVICE_ROLE_KEY ?? Object.values(p ?? {})[0]
      if (typeof c === 'string' && c) return c
    } catch { /* fall through */ }
  }
  throw new Error('No Supabase service role key found')
}
const db = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey())

async function rpc(method: string, params: unknown[], urls: string[] = ARC_RPCS): Promise<any> {
  const errors: string[] = []
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(8000),
      })
      const j = await r.json()
      if (j.error) { errors.push(String(j.error?.message ?? j.error)); continue }
      return j.result
    } catch (e) { errors.push(e instanceof Error ? e.message : String(e)) }
  }
  throw new Error(errors.join(' | ') || `${method} failed`)
}

/** The on-chain reference for refund number `n` of a payment (same as src/lib/merchantRefunds.ts). */
const refundRef = (paymentId: string, n = 1) => keccak256(toBytes(n <= 1 ? paymentId : `${paymentId}:${n}`))
/** Highest refund number accepted for the contract route. */
const MAX_REFUNDS = 200

const usd = (n: number) => '$' + n.toFixed(2)
/** ORD-100014 → #14, as the app shows order numbers (src/lib/orderLabels.ts). */
const orderDisplay = (n: string) => { const m = /^ORD-(\d+)$/i.exec(n); const k = m ? Number(m[1]) - 100000 : 0; return k > 0 ? `#${k}` : n }

// Stored chain names that mean the same chain.
const chainKey = (c: string) => c === 'Polygon_Amoy_Testnet' ? 'Polygon_Sepolia' : c
const ARC_USDC = '0x3600000000000000000000000000000000000000'
const MIN_REFUND = 0.01

/** USDC's own blocklist (FiatToken isBlacklisted) for `who` on `chain`; null when unreadable. */
async function usdcBlocked(chain: string, who: string): Promise<boolean | null> {
  const token = chain === 'Arc_Testnet' ? ARC_USDC : CHAIN_USDC[chainKey(chain)]
  const urls = chain === 'Arc_Testnet' ? ARC_RPCS : (CHAIN_RPCS[chainKey(chain)] ?? [])
  if (!token || !urls.length) return null
  const data = '0xfe575a87' + who.replace(/^0x/, '').toLowerCase().padStart(64, '0')
  const out = await rpc('eth_call', [{ to: token, data }, 'latest'], urls).catch(() => null)
  if (typeof out !== 'string' || !/^0x[0-9a-f]*$/i.test(out) || out.length < 3) return null
  return BigInt(out) !== 0n
}

/** Block number, index and time (ms) of a transaction on a chain; null when unreadable. */
async function txPosition(urls: string[], hash: string, receipt?: any): Promise<{ block: number; index: number; time: number } | null> {
  const r = receipt ?? await rpc('eth_getTransactionReceipt', [hash], urls).catch(() => null)
  if (!r?.blockNumber) return null
  const blk = await rpc('eth_getBlockByNumber', [r.blockNumber, false], urls).catch(() => null)
  if (!blk?.timestamp) return null
  return { block: parseInt(r.blockNumber, 16), index: parseInt(r.transactionIndex ?? '0x0', 16), time: parseInt(blk.timestamp, 16) * 1000 }
}

Deno.serve(async (req: Request) => {
  const preflight = handleOptionsFor(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return jsonFor(req, { error: 'Method not allowed' }, 405)

  let b: Record<string, unknown> = {}
  try { b = await req.json() } catch { /* validated below */ }
  if (b.action !== 'record') return jsonFor(req, { error: 'Unknown action' }, 400)

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const { data: auth } = await db.auth.getUser(jwt).catch(() => ({ data: null as any }))
  const uid = auth?.user?.id
  if (!uid) return jsonFor(req, { error: 'Sign in again' }, 401)

  const paymentId = b.paymentId ? String(b.paymentId) : null
  const receiptId = b.receiptId ? String(b.receiptId) : null
  const route = b.route === 'cctp' ? 'cctp' : b.route === 'chain' ? 'chain' : 'contract'
  const claimed = b.amount == null ? null : Number(b.amount)
  if (claimed != null && !(Number.isFinite(claimed) && claimed > 0)) return jsonFor(req, { error: 'Bad request' }, 400)
  const txHash = String(b.txHash ?? '').toLowerCase()
  const uuid = /^[0-9a-f-]{36}$/i
  if (!!paymentId === !!receiptId || !uuid.test(paymentId ?? receiptId ?? '') || !/^0x[0-9a-f]{64}$/.test(txHash)) return jsonFor(req, { error: 'Bad request' }, 400)
  if (route === 'contract' && /^0x0+$/.test(REFUNDS_CONTRACT)) return jsonFor(req, { error: 'Refunds are not set up yet' }, 503)

  // What is being refunded: an order payment, or a payment on another chain.
  let target: { id: string; intentId: string | null; merchantWallet: string; customer: string; customerUserId: string | null; amount: number; chain: string; txHash: string; merchantName: string | null; orderNumber: string | null }
  if (paymentId) {
    const { data: pay } = await db.from('merchant_payments').select('*').eq('id', paymentId).maybeSingle()
    if (!pay) return jsonFor(req, { error: 'Payment not found' }, 404)
    const { data: intent } = await db.from('merchant_payment_intents').select('id, merchant_auth_uid, merchant_wallet, merchant_name, order_number').eq('id', pay.intent_id).maybeSingle()
    if (!intent || intent.merchant_auth_uid !== uid) return jsonFor(req, { error: 'Payment not found' }, 404)
    target = { id: paymentId, intentId: pay.intent_id, merchantWallet: String(intent.merchant_wallet || pay.merchant_wallet || '').toLowerCase(),
      customer: String(pay.from_address || '').toLowerCase(), customerUserId: pay.customer_user_id ?? null, amount: Number(pay.amount),
      chain: chainKey(pay.source_chain), txHash: String(pay.tx_hash).toLowerCase(), merchantName: intent.merchant_name, orderNumber: intent.order_number }
  } else {
    const { data: rc } = await db.from('merchant_chain_receipts').select('*').eq('id', receiptId).maybeSingle()
    if (!rc) return jsonFor(req, { error: 'Payment not found' }, 404)
    const { data: u } = await db.from('users').select('id, wallet_address, store_name, username').eq('auth_uid', uid).maybeSingle()
    const { data: apps } = await db.from('merchant_applications').select('wallet_address, business_name').eq('auth_uid', uid).eq('status', 'approved')
    const mine = new Set([u?.wallet_address, ...(apps ?? []).map((a: any) => a.wallet_address)].filter(Boolean).map((w: string) => w.toLowerCase()))
    if (!mine.has(String(rc.merchant_wallet).toLowerCase())) return jsonFor(req, { error: 'Payment not found' }, 404)
    const { data: payer } = await db.from('users').select('id').ilike('wallet_address', String(rc.from_address || '')).maybeSingle()
    target = { id: receiptId!, intentId: null, merchantWallet: String(rc.merchant_wallet).toLowerCase(), customer: String(rc.from_address || '').toLowerCase(),
      customerUserId: payer?.id ? String(payer.id) : null, amount: Number(rc.amount), chain: chainKey(rc.source_chain), txHash: String(rc.tx_hash).toLowerCase(),
      merchantName: (apps ?? [])[0]?.business_name || u?.store_name || u?.username || null, orderNumber: rc.order_number ?? null }
  }
  if (!/^0x[0-9a-f]{40}$/.test(target.customer) || /^0x0+$/.test(target.customer)) return jsonFor(req, { error: 'This payment has no wallet to refund to' }, 422)

  // A refund goes back the way the money came: on Arc (refunds contract) for
  // an Arc payment; for a payment on another chain, on that chain (USDC
  // transfer) or to that chain from Arc (CCTP).
  const fromArc = target.chain === 'Arc_Testnet'
  if (route === 'contract' && !fromArc) return jsonFor(req, { error: 'This payment came in on another chain - refund it on that chain' }, 422)
  if (route !== 'contract' && fromArc) return jsonFor(req, { error: 'This payment came in on Arc - refund it on Arc' }, 422)
  if (route === 'chain' && !CHAIN_RPCS[target.chain]) return jsonFor(req, { error: 'Refunds on this chain are not available' }, 422)
  if (route === 'cctp' && CCTP_DOMAINS[target.chain] === undefined) return jsonFor(req, { error: 'Refunds to this chain are not available' }, 422)

  // Only a person's own wallet: a contract (exchange, bridge, smart account)
  // may not be the customer's on the refund chain. EIP-7702 wallets are fine.
  const code = await rpc('eth_getCode', [target.customer, 'latest'], target.chain === 'Arc_Testnet' ? ARC_RPCS : (CHAIN_RPCS[target.chain] ?? [])).catch(() => null)
  if (typeof code !== 'string') return jsonFor(req, { error: "Couldn't check who sent this payment - try again" }, 503)
  if (code !== '0x' && !code.toLowerCase().startsWith('0xef0100')) return jsonFor(req, { error: 'Paid from a contract (exchange, bridge or smart account) - it can’t be refunded automatically' }, 422)

  const key = paymentId ? 'payment_id' : 'receipt_id'
  const refundChain = route === 'contract' ? 'Arc_Testnet' : target.chain
  // Idempotent per refund transaction: the same tx recorded again is the same refund.
  const byTx = async () => (await db.from('merchant_refunds').select('*').eq('tx_hash', txHash).eq('refund_chain', refundChain).maybeSingle()).data
  const sameRefund = (row: any) => row[key] === target.id ? jsonFor(req, { refund: row })
    : jsonFor(req, { error: 'This transaction is already recorded as another refund' }, 409)
  const existing = await byTx()
  if (existing) return sameRefund(existing)

  // What can still go back on this payment (all its refunds so far, on any route).
  const { data: leftRaw, error: leftErr } = await db.rpc('merchant_refund_remaining', paymentId ? { p_payment: paymentId } : { p_receipt: receiptId })
  if (leftErr || leftRaw == null) return jsonFor(req, { error: "Couldn't check this payment's refunds - try again", pending: true }, 202)
  const remaining = Number(leftRaw)
  if (remaining + 1e-9 < MIN_REFUND) return jsonFor(req, { error: 'This payment is already fully refunded' }, 422)

  // Read the refund (on Arc, or on the payment's chain for route 'chain').
  const txRpcs = route === 'chain' ? (CHAIN_RPCS[target.chain] ?? []) : ARC_RPCS
  let receipt: any = null
  for (let i = 0; i < 6 && !receipt; i++) {
    receipt = await rpc('eth_getTransactionReceipt', [txHash], txRpcs).catch(() => null)
    if (!receipt) await new Promise(r => setTimeout(r, 1500))
  }
  if (!receipt) return jsonFor(req, { error: 'Refund transaction not found yet - try again in a moment', pending: true }, 202)
  if (receipt.status !== '0x1') return jsonFor(req, { error: 'The refund transaction failed on-chain' }, 422)

  // The refund must come after the payment (not some older transfer).
  const payRpcs = fromArc ? ARC_RPCS : (CHAIN_RPCS[target.chain] ?? [])
  const [paidAt, refundAt] = await Promise.all([txPosition(payRpcs, target.txHash), txPosition(txRpcs, txHash, receipt)])
  if (!paidAt || !refundAt) return jsonFor(req, { error: "Couldn't check the refund's timing - try again in a moment", pending: true }, 202)
  const sameChain = route === 'chain' || route === 'contract'
  const after = sameChain
    ? (refundAt.block > paidAt.block || (refundAt.block === paidAt.block && refundAt.index > paidAt.index))
    : refundAt.time >= paidAt.time
  if (!after) return jsonFor(req, { error: 'This transaction was sent before the payment - it is not a refund of it' }, 422)

  // Any refund reference of this payment (the contract takes each one once).
  const refs = new Set(Array.from({ length: MAX_REFUNDS }, (_, i) => refundRef(target.id, i + 1).toLowerCase()))
  const merchantWallet = target.merchantWallet
  const customerWallet = target.customer
  let found: { amount: number; reason: string } | null = null
  for (const log of receipt.logs ?? []) {
    const addr = String(log.address).toLowerCase()
    try {
      if (route === 'contract' && addr === REFUNDS_CONTRACT) {
        const a = decodeEventLog({ abi: REFUNDED_EVENT, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] }).args
        if (refs.has(a.paymentRef.toLowerCase()) && a.merchant.toLowerCase() === merchantWallet && a.customer.toLowerCase() === customerWallet) {
          found = { amount: Number(a.amount) / 1e18, reason: a.reason }
        }
      }
      if (route === 'chain' && addr === CHAIN_USDC[target.chain] && log.topics?.[0] === TRANSFER_TOPIC) {
        const from = ('0x' + String(log.topics[1]).slice(-40)).toLowerCase()
        const to = ('0x' + String(log.topics[2]).slice(-40)).toLowerCase()
        if (from === merchantWallet && to === customerWallet) {
          if (found) return jsonFor(req, { error: 'This transaction holds more than one transfer to the customer - record a single refund transfer' }, 422)
          found = { amount: Number(BigInt(log.data)) / 1e6, reason: String(b.reason ?? '').slice(0, 140) }
        }
      }
      if (route === 'cctp' && addr === TOKEN_MESSENGER) {
        const a = decodeEventLog({ abi: DEPOSIT_FOR_BURN, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] }).args
        const recipient = ('0x' + a.mintRecipient.slice(-40)).toLowerCase()
        if (String(receipt.from).toLowerCase() === merchantWallet && a.depositor.toLowerCase() === merchantWallet
            && recipient === customerWallet && a.destinationDomain === CCTP_DOMAINS[target.chain]) {
          // The customer receives the burn minus Circle's fee (paid on top by the merchant).
          found = { amount: (Number(a.amount) - Number(a.maxFee)) / 1e6, reason: String(b.reason ?? '').slice(0, 140) }
        }
      }
    } catch { /* another event */ }
  }
  if (!found) return jsonFor(req, { error: 'This transaction is not a refund of this payment' }, 422)
  if (found.amount > target.amount + 1e-6) return jsonFor(req, { error: 'Refund is larger than the payment' }, 422)
  if (found.amount > remaining + 1e-6) return jsonFor(req, { error: `Refund is more than what's left on this payment (${usd(remaining)})` }, 422)
  if (found.amount + 1e-9 < MIN_REFUND) return jsonFor(req, { error: `A refund must be at least ${usd(MIN_REFUND)}` }, 422)
  if (claimed != null && Math.abs(found.amount - claimed) > 0.000001) {
    return jsonFor(req, { error: `This transaction refunds ${usd(found.amount)}, not ${usd(claimed)}` }, 422)
  }

  // USDC's blocklist, on the chain the refund lands on.
  const blocked = await usdcBlocked(route === 'contract' ? 'Arc_Testnet' : target.chain, customerWallet)
  if (blocked === null) return jsonFor(req, { error: "Couldn't check this address - try again in a moment", pending: true }, 202)
  if (blocked) return jsonFor(req, { error: "This customer's address is blocked by USDC - the refund can't be recorded" }, 422)

  const { data: row, error } = await db.from('merchant_refunds').insert({
    payment_id: paymentId, receipt_id: receiptId, intent_id: target.intentId, merchant_auth_uid: uid, merchant_wallet: merchantWallet,
    customer_wallet: customerWallet, customer_user_id: target.customerUserId, route,
    refund_chain: refundChain,
    amount: Number(Math.max(found.amount, 0.000001).toFixed(6)), reason: found.reason.slice(0, 140), tx_hash: txHash,
  }).select('*').single()
  if (error) {
    const again = await byTx()
    if (again) return sameRefund(again)
    // merchant_refunds_cap: over the payment, or a blocked sender.
    if (/more than this payment|blocked address/i.test(error.message)) return jsonFor(req, { error: error.message }, 422)
    return jsonFor(req, { error: error.message }, 500)
  }

  // The customer's side, for a refund that lands on Arc: their Activity row
  // for this transfer says it's a refund from this business (the Arc watcher
  // records it as a plain receive from the refunds contract - or hasn't yet,
  // then it's written here and the watcher leaves it alone), and one push
  // names the business instead of "Received from 0x53e5…".
  if (refundChain === 'Arc_Testnet') {
    const refundMeta = {
      receiveKind: 'merchant_refund', note: 'Refund', merchantName: target.merchantName ?? null,
      merchantOrder: target.orderNumber ?? null, refundReason: found.reason ? found.reason.slice(0, 140) : null, refundId: row.id, pushed: true,
    }
    const recvHash = `recv_${txHash.toLowerCase()}`
    const wallet = customerWallet.toLowerCase()
    try {
      const { data: existing } = await db.from('activity').select('id, metadata').eq('tx_hash', recvHash).eq('wallet_address', wallet).maybeSingle()
      if (existing) {
        await db.from('activity').update({ metadata: { ...(existing.metadata ?? {}), ...refundMeta, note: 'Refund' } }).eq('id', existing.id)
      } else {
        await db.from('activity').upsert({
          wallet_address: wallet, user_id: target.customerUserId ?? undefined, tx_hash: recvHash, activity_type: 'receive', status: 'completed',
          amount: found.amount, usd_value: found.amount, token_symbol: 'USDC', counterparty_address: REFUNDS_CONTRACT,
          explorer_url: `https://testnet.arcscan.app/tx/${txHash}`, metadata: { ...refundMeta, source: 'merchant-refund' },
        }, { onConflict: 'tx_hash,wallet_address', ignoreDuplicates: true })
      }
    } catch (e) { console.warn('[merchant-refund] customer activity not updated:', e instanceof Error ? e.message : e) }
    if (target.customerUserId && PUSH_INTERNAL_SECRET) {
      try {
        await fetch(`${APP_BASE_URL}/api/push?action=send-internal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PUSH_INTERNAL_SECRET}` },
          body: JSON.stringify({
            userId: target.customerUserId,
            title: `Refund from ${target.merchantName || 'a business'}`,
            body: `+${usd(found.amount)} USDC${target.orderNumber ? ` for ${orderDisplay(target.orderNumber)}` : ''}${found.reason ? ` · ${found.reason}` : ''}`,
            url: '/activity',
            // Same tag as the receive push: replaces it if that went first.
            tag: `payment-${txHash.toLowerCase()}`,
          }),
          signal: AbortSignal.timeout(8000),
        })
      } catch (e) { console.warn('[merchant-refund] push failed (non-fatal):', e instanceof Error ? e.message : e) }
    }
  }

  if (target.customerUserId) {
    await db.from('notifications').insert({
      user_id: target.customerUserId, type: 'merchant_refund', read: false,
      title: `Refund from ${target.merchantName || 'a business'}`,
      message: `${usd(found.amount)} USDC was refunded${target.orderNumber ? ` for ${orderDisplay(target.orderNumber)}` : ''}${route !== 'contract' ? ` on ${target.chain.replace(/_(Sepolia|Testnet|Fuji)$/, '').replace(/_/g, ' ')}` : ''}${found.reason ? ` · ${found.reason}` : ''}`,
    }).then(() => {}, () => {})
  }
  return jsonFor(req, { refund: row })
})
