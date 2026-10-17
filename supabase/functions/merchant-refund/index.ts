// supabase/functions/merchant-refund/index.ts
//
// Records a merchant refund that already happened on Arc.
//
//   POST { action: 'record', paymentId, txHash }   merchant only
//
// The merchant's wallet sends the refund itself, through the MeshPortRefunds
// contract (deployed with Arc Studio; one refund per payment per merchant,
// enforced on-chain). Nothing from the client is trusted except "look at
// this transaction": the receipt is read from Arc, the contract's Refunded
// event is decoded, and it must match this payment - the merchant's wallet,
// keccak256(paymentId) as the reference, the payer as the customer and an
// amount no larger than what was paid. Then it's stored in merchant_refunds
// and the customer is notified.

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

async function rpc(method: string, params: unknown[]): Promise<any> {
  const errors: string[] = []
  for (const url of ARC_RPCS) {
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

  const paymentId = String(b.paymentId ?? '')
  const txHash = String(b.txHash ?? '').toLowerCase()
  if (!/^[0-9a-f-]{36}$/i.test(paymentId) || !/^0x[0-9a-f]{64}$/.test(txHash)) return jsonFor(req, { error: 'Bad request' }, 400)
  if (/^0x0+$/.test(REFUNDS_CONTRACT)) return jsonFor(req, { error: 'Refunds are not set up yet' }, 503)

  const { data: pay } = await db.from('merchant_payments').select('*').eq('id', paymentId).maybeSingle()
  if (!pay) return jsonFor(req, { error: 'Payment not found' }, 404)
  const { data: intent } = await db.from('merchant_payment_intents').select('id, merchant_auth_uid, merchant_wallet, merchant_name, order_number').eq('id', pay.intent_id).maybeSingle()
  if (!intent || intent.merchant_auth_uid !== uid) return jsonFor(req, { error: 'Payment not found' }, 404)

  const { data: existing } = await db.from('merchant_refunds').select('*').eq('payment_id', paymentId).maybeSingle()
  if (existing) return jsonFor(req, { refund: existing })

  // Read the refund from Arc.
  let receipt: any = null
  for (let i = 0; i < 6 && !receipt; i++) {
    receipt = await rpc('eth_getTransactionReceipt', [txHash]).catch(() => null)
    if (!receipt) await new Promise(r => setTimeout(r, 1500))
  }
  if (!receipt) return jsonFor(req, { error: 'Refund transaction not found yet - try again in a moment', pending: true }, 202)
  if (receipt.status !== '0x1') return jsonFor(req, { error: 'The refund transaction failed on-chain' }, 422)

  const ref = paymentRef(paymentId).toLowerCase()
  const merchantWallet = String(intent.merchant_wallet || pay.merchant_wallet || '').toLowerCase()
  const customerWallet = String(pay.from_address || '').toLowerCase()
  let found: { amount: number; reason: string } | null = null
  for (const log of receipt.logs ?? []) {
    if (String(log.address).toLowerCase() !== REFUNDS_CONTRACT) continue
    try {
      const ev = decodeEventLog({ abi: REFUNDED_EVENT, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] })
      const a = ev.args
      if (a.paymentRef.toLowerCase() === ref && a.merchant.toLowerCase() === merchantWallet && a.customer.toLowerCase() === customerWallet) {
        found = { amount: Number(a.amount) / 1e18, reason: a.reason }
      }
    } catch { /* another event */ }
  }
  if (!found) return jsonFor(req, { error: 'This transaction is not a refund of this payment' }, 422)
  if (found.amount > Number(pay.amount) + 1e-9) return jsonFor(req, { error: 'Refund is larger than the payment' }, 422)

  const { data: row, error } = await db.from('merchant_refunds').insert({
    payment_id: paymentId, intent_id: pay.intent_id, merchant_auth_uid: uid, merchant_wallet: merchantWallet,
    customer_wallet: customerWallet, customer_user_id: pay.customer_user_id ?? null,
    amount: Number(found.amount.toFixed(6)), reason: found.reason.slice(0, 140), tx_hash: txHash,
  }).select('*').single()
  if (error) {
    const { data: again } = await db.from('merchant_refunds').select('*').eq('payment_id', paymentId).maybeSingle()
    if (again) return jsonFor(req, { refund: again })
    return jsonFor(req, { error: error.message }, 500)
  }

  if (pay.customer_user_id) {
    await db.from('notifications').insert({
      user_id: pay.customer_user_id, type: 'merchant_refund', read: false,
      title: `Refund from ${intent.merchant_name || 'a merchant'}`,
      message: `${usd(found.amount)} USDC was refunded${intent.order_number ? ` for ${intent.order_number}` : ''}${found.reason ? ` · ${found.reason}` : ''}`,
    }).then(() => {}, () => {})
  }
  return jsonFor(req, { refund: row })
})
