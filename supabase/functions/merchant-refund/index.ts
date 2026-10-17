// supabase/functions/merchant-refund/index.ts
//
// Records a merchant refund that already happened (on Arc, or on the chain the customer paid on).
//
//   POST { action: 'record', paymentId | receiptId, txHash, route? }   merchant only
//
// The merchant's wallet sends the refund itself, one of three ways:
//   route 'contract' (default): on Arc through the MeshPortRefunds contract
//     (deployed with Arc Studio; one refund per payment per merchant,
//     enforced on-chain). Its Refunded event must name this merchant,
//     keccak256(id) as the reference and the payer as the customer.
//   route 'chain': from the merchant's USDC on the chain the customer paid
//     on (the money is still there) - a USDC Transfer on that chain from the
//     merchant to the payer, sent by MeshPort's relayer (EIP-3009).
//   route 'cctp': back on the chain the customer paid from - a CCTP burn on
//     Arc (TokenMessengerV2 DepositForBurn) by the merchant, minted by Circle
//     to the payer's address on that chain's domain.
// Nothing from the client is trusted except "look at this transaction": the
// receipt is read from Arc and checked against the payment (an order
// payment, or a payment on another chain without an order); one refund per
// payment is kept by merchant_refunds' unique keys. The customer is notified.

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
const ARC_RPCS = [
  ...((Deno.env.get('ARC_RPC_URL') ?? '').trim() ? [(Deno.env.get('ARC_RPC_URL') ?? '').trim()] : []),
  ...(DRPC_KEY ? [`https://lb.drpc.live/arc-testnet/${DRPC_KEY}`] : []),
  'https://rpc.testnet.arc.io',
  'https://rpc.blockdaemon.testnet.arc.io',
  'https://rpc.drpc.testnet.arc.io',
]

// Public RPCs to look at the payer on the chain they paid from (same set as merchant-pay).
const CHAIN_RPCS: Record<string, string[]> = {
  Ethereum_Sepolia: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://rpc.sepolia.org'],
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

/** The on-chain reference for a payment: keccak256 of its id. */
const paymentRef = (paymentId: string) => keccak256(toBytes(paymentId))

const usd = (n: number) => '$' + n.toFixed(2)

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
  const txHash = String(b.txHash ?? '').toLowerCase()
  const uuid = /^[0-9a-f-]{36}$/i
  if (!!paymentId === !!receiptId || !uuid.test(paymentId ?? receiptId ?? '') || !/^0x[0-9a-f]{64}$/.test(txHash)) return jsonFor(req, { error: 'Bad request' }, 400)
  if (route === 'contract' && /^0x0+$/.test(REFUNDS_CONTRACT)) return jsonFor(req, { error: 'Refunds are not set up yet' }, 503)

  // What is being refunded: an order payment, or a payment on another chain.
  let target: { id: string; intentId: string | null; merchantWallet: string; customer: string; customerUserId: string | null; amount: number; chain: string; merchantName: string | null; orderNumber: string | null }
  if (paymentId) {
    const { data: pay } = await db.from('merchant_payments').select('*').eq('id', paymentId).maybeSingle()
    if (!pay) return jsonFor(req, { error: 'Payment not found' }, 404)
    const { data: intent } = await db.from('merchant_payment_intents').select('id, merchant_auth_uid, merchant_wallet, merchant_name, order_number').eq('id', pay.intent_id).maybeSingle()
    if (!intent || intent.merchant_auth_uid !== uid) return jsonFor(req, { error: 'Payment not found' }, 404)
    target = { id: paymentId, intentId: pay.intent_id, merchantWallet: String(intent.merchant_wallet || pay.merchant_wallet || '').toLowerCase(),
      customer: String(pay.from_address || '').toLowerCase(), customerUserId: pay.customer_user_id ?? null, amount: Number(pay.amount),
      chain: pay.source_chain, merchantName: intent.merchant_name, orderNumber: intent.order_number }
  } else {
    const { data: rc } = await db.from('merchant_chain_receipts').select('*').eq('id', receiptId).maybeSingle()
    if (!rc) return jsonFor(req, { error: 'Payment not found' }, 404)
    const { data: u } = await db.from('users').select('id, wallet_address, store_name, username').eq('auth_uid', uid).maybeSingle()
    const { data: apps } = await db.from('merchant_applications').select('wallet_address, business_name').eq('auth_uid', uid).eq('status', 'approved')
    const mine = new Set([u?.wallet_address, ...(apps ?? []).map((a: any) => a.wallet_address)].filter(Boolean).map((w: string) => w.toLowerCase()))
    if (!mine.has(String(rc.merchant_wallet).toLowerCase())) return jsonFor(req, { error: 'Payment not found' }, 404)
    const { data: payer } = await db.from('users').select('id').ilike('wallet_address', String(rc.from_address || '')).maybeSingle()
    target = { id: receiptId!, intentId: null, merchantWallet: String(rc.merchant_wallet).toLowerCase(), customer: String(rc.from_address || '').toLowerCase(),
      customerUserId: payer?.id ? String(payer.id) : null, amount: Number(rc.amount), chain: rc.source_chain,
      merchantName: (apps ?? [])[0]?.business_name || u?.store_name || u?.username || null, orderNumber: rc.order_number ?? null }
  }
  if (!/^0x[0-9a-f]{40}$/.test(target.customer) || /^0x0+$/.test(target.customer)) return jsonFor(req, { error: 'This payment has no wallet to refund to' }, 422)

  // Only a person's own wallet: a contract (exchange, bridge, smart account)
  // may not be the customer's on the refund chain. EIP-7702 wallets are fine.
  const code = await rpc('eth_getCode', [target.customer, 'latest'], target.chain === 'Arc_Testnet' ? ARC_RPCS : (CHAIN_RPCS[target.chain] ?? [])).catch(() => null)
  if (typeof code !== 'string') return jsonFor(req, { error: "Couldn't check who sent this payment - try again" }, 503)
  if (code !== '0x' && !code.toLowerCase().startsWith('0xef0100')) return jsonFor(req, { error: 'Paid from a contract (exchange, bridge or smart account) - it can’t be refunded automatically' }, 422)

  const key = paymentId ? 'payment_id' : 'receipt_id'
  const { data: existing } = await db.from('merchant_refunds').select('*').eq(key, target.id).maybeSingle()
  if (existing) return jsonFor(req, { refund: existing })

  // Read the refund (on Arc, or on the payment's chain for route 'chain').
  const txRpcs = route === 'chain' ? (CHAIN_RPCS[target.chain] ?? []) : ARC_RPCS
  let receipt: any = null
  for (let i = 0; i < 6 && !receipt; i++) {
    receipt = await rpc('eth_getTransactionReceipt', [txHash], txRpcs).catch(() => null)
    if (!receipt) await new Promise(r => setTimeout(r, 1500))
  }
  if (!receipt) return jsonFor(req, { error: 'Refund transaction not found yet - try again in a moment', pending: true }, 202)
  if (receipt.status !== '0x1') return jsonFor(req, { error: 'The refund transaction failed on-chain' }, 422)

  const ref = paymentRef(target.id).toLowerCase()
  const merchantWallet = target.merchantWallet
  const customerWallet = target.customer
  let found: { amount: number; reason: string } | null = null
  for (const log of receipt.logs ?? []) {
    const addr = String(log.address).toLowerCase()
    try {
      if (route === 'contract' && addr === REFUNDS_CONTRACT) {
        const a = decodeEventLog({ abi: REFUNDED_EVENT, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] }).args
        if (a.paymentRef.toLowerCase() === ref && a.merchant.toLowerCase() === merchantWallet && a.customer.toLowerCase() === customerWallet) {
          found = { amount: Number(a.amount) / 1e18, reason: a.reason }
        }
      }
      if (route === 'chain' && addr === CHAIN_USDC[target.chain] && log.topics?.[0] === TRANSFER_TOPIC) {
        const from = ('0x' + String(log.topics[1]).slice(-40)).toLowerCase()
        const to = ('0x' + String(log.topics[2]).slice(-40)).toLowerCase()
        if (from === merchantWallet && to === customerWallet) found = { amount: Number(BigInt(log.data)) / 1e6, reason: String(b.reason ?? '').slice(0, 140) }
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

  const { data: row, error } = await db.from('merchant_refunds').insert({
    payment_id: paymentId, receipt_id: receiptId, intent_id: target.intentId, merchant_auth_uid: uid, merchant_wallet: merchantWallet,
    customer_wallet: customerWallet, customer_user_id: target.customerUserId, route,
    refund_chain: route === 'contract' ? 'Arc_Testnet' : target.chain,
    amount: Number(Math.max(found.amount, 0.000001).toFixed(6)), reason: found.reason.slice(0, 140), tx_hash: txHash,
  }).select('*').single()
  if (error) {
    const { data: again } = await db.from('merchant_refunds').select('*').eq(key, target.id).maybeSingle()
    if (again) return jsonFor(req, { refund: again })
    return jsonFor(req, { error: error.message }, 500)
  }

  if (target.customerUserId) {
    await db.from('notifications').insert({
      user_id: target.customerUserId, type: 'merchant_refund', read: false,
      title: `Refund from ${target.merchantName || 'a merchant'}`,
      message: `${usd(found.amount)} USDC was refunded${target.orderNumber ? ` for ${target.orderNumber}` : ''}${route !== 'contract' ? ` on ${target.chain.replace(/_(Sepolia|Testnet|Fuji)$/, '').replace(/_/g, ' ')}` : ''}${found.reason ? ` · ${found.reason}` : ''}`,
    }).then(() => {}, () => {})
  }
  return jsonFor(req, { refund: row })
})
