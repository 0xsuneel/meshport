// supabase/functions/merchant-pay/index.ts
//
// Merchant payment requests — the only place a request's status changes.
//
//   POST { action: 'get',    code }                 public: what the pay page shows
//   POST { action: 'submit', code, chain, txHash, orderNumber?, amount? }
//                                                   a customer's payment tx → verified on-chain,
//                                                   confirmed against the order number + amount
//   POST { action: 'verify', code, chain, txHash }  same, called by the merchant (paste a tx)
//   POST { action: 'cancel', code }                 merchant only, while nothing is paid
//   POST { action: 'watch' }                        cron (service role): direct deposits → orders
//   POST { action: 'assign', depositId, code }      merchant picks the order for a deposit
//   POST { action: 'dismiss', depositId }           merchant: not an order payment
//   POST { action: 'complete', code, note? }        merchant marks an order completed (settled another way)
//
// Nothing is trusted from the client except "look at this transaction":
// the receipt is fetched from the chain, the USDC Transfer to the merchant's
// wallet is read from its logs, and one chain tx can only ever count once
// (merchant_payments unique source_chain + tx_hash).
//
// Routes:
//   Arc_Testnet                → paid immediately (direct Arc transfer, no UB)
//   a Unified Balance chain    → "processing": the USDC sits at the merchant's
//                                address on that chain until the merchant's
//                                auto-collect moves it to Arc with the existing
//                                UB claim; the ub_claim_intents trigger then
//                                marks it paid (see the migration).

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { handleOptionsFor, jsonFor } from '../_shared/cors.ts'

const DRPC_KEY = Deno.env.get('DRPC_KEY') ?? ''
const ARC_RPCS = [
  ...((Deno.env.get('ARC_RPC_URL') ?? '').trim() ? [(Deno.env.get('ARC_RPC_URL') ?? '').trim()] : []),
  ...(DRPC_KEY ? [`https://lb.drpc.live/arc-testnet/${DRPC_KEY}`] : []),
  'https://rpc.testnet.arc.network',
]
const d = (net: string) => (DRPC_KEY ? [`https://lb.drpc.live/${net}/${DRPC_KEY}`] : [])

// Chains a customer can pay on. Arc = direct; the rest are Unified Balance
// chains with a known chain id + USDC contract (same values the app uses in
// src/blockchain/chains.ts). Nothing here is guessed.
type ChainDef = { label: string; chainId: number; usdc: string; rpcs: string[]; route: 'direct' | 'ub' }
export const PAY_CHAINS: Record<string, ChainDef> = {
  Arc_Testnet:      { label: 'Arc',       chainId: 5042002,  usdc: '0x3600000000000000000000000000000000000000', rpcs: ARC_RPCS, route: 'direct' },
  Ethereum_Sepolia: { label: 'Ethereum',  chainId: 11155111, usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', rpcs: [...d('sepolia'), 'https://ethereum-sepolia-rpc.publicnode.com', 'https://rpc.sepolia.org'], route: 'ub' },
  Base_Sepolia:     { label: 'Base',      chainId: 84532,    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', rpcs: [...d('base-sepolia'), 'https://base-sepolia-rpc.publicnode.com', 'https://sepolia.base.org'], route: 'ub' },
  Arbitrum_Sepolia: { label: 'Arbitrum',  chainId: 421614,   usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', rpcs: [...d('arbitrum-sepolia'), 'https://arbitrum-sepolia-rpc.publicnode.com', 'https://sepolia-rollup.arbitrum.io/rpc'], route: 'ub' },
  Optimism_Sepolia: { label: 'Optimism',  chainId: 11155420, usdc: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7', rpcs: [...d('optimism-sepolia'), 'https://optimism-sepolia-rpc.publicnode.com', 'https://sepolia.optimism.io'], route: 'ub' },
  Polygon_Sepolia:  { label: 'Polygon',   chainId: 80002,    usdc: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582', rpcs: [...d('polygon-amoy'), 'https://polygon-amoy-bor-rpc.publicnode.com'], route: 'ub' },
  Avalanche_Fuji:   { label: 'Avalanche', chainId: 43113,    usdc: '0x5425890298aed601595a70AB815c96711a31Bc65', rpcs: [...d('avalanche-fuji'), 'https://api.avax-test.network/ext/bc/C/rpc', 'https://avalanche-fuji-c-chain-rpc.publicnode.com'], route: 'ub' },
  HyperEVM_Testnet: { label: 'HyperEVM',  chainId: 998,      usdc: '0x2B3370eE501B4a559b57D449569354196457D8Ab', rpcs: ['https://rpcs.chain.link/hyperevm/testnet', 'https://rpc.hyperliquid-testnet.xyz/evm'], route: 'ub' },
  Sei_Testnet:      { label: 'Sei',       chainId: 1328,     usdc: '0x4fCF1784B31630811181f670Aea7A7bEF803eaED', rpcs: [...d('sei-testnet'), 'https://evm-rpc-testnet.sei-apis.com'], route: 'ub' },
  Unichain_Sepolia: { label: 'Unichain',  chainId: 1301,     usdc: '0x31d0220469e10c4E71834a79b1f276d740d3768F', rpcs: [...d('unichain-sepolia'), 'https://sepolia.unichain.org'], route: 'ub' },
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

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

async function rpc(urls: string[], method: string, params: unknown[]): Promise<any> {
  let last: unknown = null
  for (const url of urls) {
    if (!url || url.endsWith('/')) continue
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(8000),
      })
      const j = await r.json()
      if (j.error) { last = j.error; continue }
      return j.result
    } catch (e) { last = e }
  }
  throw last ?? new Error(`${method} failed`)
}

async function caller(req: Request): Promise<{ authUid: string; userId: string | null; wallet: string | null; username: string | null } | null> {
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!jwt) return null
  const { data } = await db.auth.getUser(jwt).catch(() => ({ data: null as any }))
  const uid = data?.user?.id
  if (!uid) return null
  const { data: u } = await db.from('users').select('id, wallet_address, username').eq('auth_uid', uid).maybeSingle()
  return { authUid: uid, userId: u?.id ? String(u.id) : null, wallet: u?.wallet_address?.toLowerCase() ?? null, username: u?.username ?? null }
}

function effectiveStatus(i: any): string {
  if ((i.status === 'pending') && i.expires_at && new Date(i.expires_at).getTime() < Date.now()) return 'expired'
  return i.status
}

function publicView(i: any, payments: any[]) {
  return {
    code: i.code, orderNumber: i.order_number ?? null, merchantName: i.merchant_name, merchantWallet: i.merchant_wallet,
    merchantUsername: i._merchant_username ?? null, merchantAvatar: i._merchant_avatar ?? null,
    amount: Number(i.requested_amount), received: Number(i.received_amount), currency: i.currency,
    note: i.note, customerUsername: i.customer_username, status: effectiveStatus(i),
    kind: i.kind ?? 'request', items: Array.isArray(i.items) ? i.items : null,
    createdAt: i.created_at, expiresAt: i.expires_at, paidAt: i.paid_at,
    completedByMerchant: !!i.completed_by_merchant, completedNote: i.completed_note ?? null,
    chains: Object.entries(PAY_CHAINS).map(([id, c]) => ({ id, label: c.label, chainId: c.chainId, usdc: c.usdc, route: c.route })),
    payments: payments.map(p => ({ chain: p.source_chain, amount: Number(p.amount), status: p.status, txHash: p.tx_hash, method: p.method, createdAt: p.created_at })),
  }
}

async function loadIntent(code: string) {
  const { data } = await db.from('merchant_payment_intents').select('*').eq('code', code).maybeSingle()
  if (data?.merchant_user_id) {
    const { data: u } = await db.from('users').select('username, avatar_url').eq('id', data.merchant_user_id).maybeSingle()
    ;(data as any)._merchant_username = u?.username ?? null
    ;(data as any)._merchant_avatar = u?.avatar_url ?? null
  }
  return data
}

async function loadPayments(intentId: string) {
  const { data } = await db.from('merchant_payments').select('*').eq('intent_id', intentId).order('created_at', { ascending: true })
  return data ?? []
}

// Arc: USDC is the native coin. Every native movement — a plain native send
// (what MeshPort Pay/Chat Pay does) and the native leg of an ERC-20
// transfer() — emits a standard Transfer log from the EIP-7708 system
// emitter, in 18 decimals. A plain native send emits NOTHING on the ERC-20
// contract (0x3600…), so reading only that contract misses it. Arc docs:
// https://docs.arc.io/arc/references/usdc-system-events
const ARC_NATIVE_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe'
// Testnet blocks before the Zero5 hard fork used a custom event instead.
const ARC_LEGACY_AUTHORITY = '0x1800000000000000000000000000000000000000'
const ARC_LEGACY_TOPIC = '0x62f084c00a442dcf51cdbb51beed2839bf42a268da8474b0e98f38edb7db5a22'

/** Sum of USDC sent to `to` in this tx (as a 6-decimal amount), plus the sender. */
function usdcToMerchant(receipt: any, usdc: string, to: string, chainId: string): { amount: number; from: string | null } {
  const want = '0x' + to.replace(/^0x/, '').toLowerCase().padStart(64, '0')
  const sum = (emitter: string, topic0: string, decimals: 6 | 18) => {
    let atomic = 0n
    let from: string | null = null
    for (const log of receipt?.logs ?? []) {
      if (String(log.address).toLowerCase() !== emitter) continue
      if (String(log.topics?.[0]).toLowerCase() !== topic0) continue
      if (String(log.topics?.[2]).toLowerCase() !== want) continue
      try { atomic += BigInt(log.data) } catch { continue }
      from = from ?? ('0x' + String(log.topics?.[1]).slice(-40)).toLowerCase()
    }
    // 18 → 6 decimals without float error, then to a number.
    const six = decimals === 18 ? atomic / 1_000_000_000_000n : atomic
    return { amount: Number(six) / 1e6, from }
  }
  if (chainId === 'Arc_Testnet') {
    // Native emitter only — an ERC-20 transfer() also logs on 0x3600…, and
    // counting both would double the amount.
    const native = sum(ARC_NATIVE_EMITTER, TRANSFER_TOPIC, 18)
    if (native.amount > 0) return native
    const legacy = sum(ARC_LEGACY_AUTHORITY, ARC_LEGACY_TOPIC, 18)
    if (legacy.amount > 0) return legacy
  }
  return sum(usdc.toLowerCase(), TRANSFER_TOPIC, 6)
}

type OrderCheck = { orderNumber: string | null; amount: number | null }
type MatchedBy = 'customer' | 'merchant' | 'watcher'

async function recordPayment(req: Request | null, i: any, chainId: string, txHash: string, who: Awaited<ReturnType<typeof caller>>, order: OrderCheck, matchedBy: MatchedBy = 'customer') {
  const chain = PAY_CHAINS[chainId]
  if (!chain) return { error: "This network isn't supported for this payment.", status: 400 }
  // Personal requests (non-merchant users) are paid on Arc only — there's no
  // merchant auto-collect to move funds from other chains.
  if (i.personal && chainId !== 'Arc_Testnet') return { error: 'This request can only be paid on Arc.', status: 400 }
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { error: 'Invalid transaction', status: 400 }
  const tx = txHash.toLowerCase()

  // Already counted (idempotent: same answer, never a second credit).
  const { data: dup } = await db.from('merchant_payments').select('intent_id').eq('source_chain', chainId).eq('tx_hash', tx).maybeSingle()
  if (dup) {
    if (dup.intent_id !== i.id) return { error: 'This transaction was already used for another payment.', status: 409 }
    return { ok: true, duplicate: true }
  }

  // Confirm against the order: the order number must be this request's,
  // the amount must be exactly what's due, and a paid order takes no more.
  const due = Math.max(0, Number(i.requested_amount) - Number(i.received_amount))
  if (effectiveStatus(i) === 'paid' || (Number(i.received_amount) > 0 && due <= 0.000001)) {
    return { error: `Order #${i.order_number} is already paid.`, status: 409 }
  }
  if (order.orderNumber && order.orderNumber.toUpperCase() !== String(i.order_number).toUpperCase()) {
    return { error: `Order number doesn't match this payment request (#${i.order_number}).`, status: 409 }
  }
  if (order.amount != null && Math.abs(order.amount - due) > 0.000001) {
    return { error: `Amount doesn't match order #${i.order_number} — $${due.toFixed(2)} USDC is due.`, status: 409 }
  }
  const receipt = await rpc(chain.rpcs, 'eth_getTransactionReceipt', [tx]).catch(() => null)
  if (!receipt) return { pending: true }
  if (receipt.status !== '0x1') return { error: 'The transaction failed on-chain.', status: 409 }
  const { amount, from } = usdcToMerchant(receipt, chain.usdc, i.merchant_wallet, chainId)
  if (!(amount > 0) || !from) return { error: `This transaction didn't send USDC to ${i.merchant_name ?? 'the merchant'} on ${chain.label}.`, status: 409 }
  if (order.amount != null && amount + 0.000001 < order.amount) {
    return { error: `This transaction sent $${amount} USDC, but order #${i.order_number} is for $${order.amount} USDC.`, status: 409 }
  }

  // Who paid: the signed-in MeshPort user if it was their own wallet; else a
  // MeshPort account that owns the sending address; else just the address.
  let customerUserId: string | null = null
  let customerUsername: string | null = null
  if (who?.wallet && who.wallet === from) { customerUserId = who.userId; customerUsername = who.username }
  else {
    const { data: u } = await db.from('users').select('id, username').ilike('wallet_address', from).maybeSingle()
    if (u) { customerUserId = String(u.id); customerUsername = u.username ?? null }
  }
  const method = chain.route === 'ub' ? 'external_ub' : (customerUserId && who?.wallet === from ? 'arc_direct' : 'external_arc')

  const { error: insErr } = await db.from('merchant_payments').insert({
    intent_id: i.id, merchant_wallet: i.merchant_wallet, source_chain: chainId, tx_hash: tx, from_address: from,
    amount, method, status: 'confirmed', customer_user_id: customerUserId, customer_username: customerUsername,
    order_number: i.order_number, matched_by: matchedBy,
    ...(chain.route === 'direct' ? { arc_tx_hash: tx } : {}),
  })
  if (insErr) {
    if (/duplicate|unique/i.test(insErr.message)) return { ok: true, duplicate: true }
    throw insErr
  }
  // A deposit the watcher parked as "needs review" is settled now.
  await db.from('merchant_unmatched_deposits').update({ status: 'assigned', assigned_code: i.code, updated_at: new Date().toISOString() })
    .eq('source_chain', chainId).eq('tx_hash', tx).eq('status', 'needs_review')

  const payments = await loadPayments(i.id)
  const received = payments.reduce((s, p) => s + Number(p.amount), 0)
  // Paid on arrival, whichever chain — the money is the merchant's; only its
  // conversion to Arc waits for auto-convert.
  const full = received >= Number(i.requested_amount) * 0.999
  const status = !full ? 'partially_paid' : 'paid'
  await db.from('merchant_payment_intents').update({
    received_amount: Number(received.toFixed(6)), status,
    ...(status === 'paid' ? { paid_at: new Date().toISOString(), destination_tx_hash: chain.route === 'direct' ? tx : undefined } : {}),
    payment_method: method, source_chain: chainId, source_tx_hash: tx,
    customer_wallet: i.customer_wallet ?? from,
    ...(customerUsername && !i.customer_username ? { customer_username: customerUsername } : {}),
    ...(customerUserId && !i.customer_user_id ? { customer_user_id: customerUserId } : {}),
  }).eq('id', i.id)
  return { ok: true }
}

// ── Direct-deposit watcher ─────────────────────────────────────────────────
// Customers who send USDC straight to the merchant's address leave no order
// number on-chain. Every minute (cron) this reads USDC Transfer logs to the
// addresses of merchants with open orders and links a deposit to an order
// only when exactly ONE open order is due that exact amount (and, if the
// order names a customer, the sender is that customer's wallet). Several
// matches → "needs review" for the merchant; none → an ordinary transfer.
// Arc: native USDC Transfer logs come from the EIP-7708 system emitter
// (18 decimals) — https://docs.arc.io/integrate/exchanges/deposits
const SCAN_RANGE: Record<string, number> = { Arc_Testnet: 3000 }
const DEFAULT_RANGE = 1000
const START_LOOKBACK = 300
const ZERO = '0x0000000000000000000000000000000000000000'
// Circle Gateway wallet + minter (same on every EVM testnet).
const GATEWAY_CONTRACTS = new Set(['0x0077777d7eba4688bdef3e311b846f25870a19b9', '0x0022222abe238cc2c7bb1f21003f0a260052475b'])

function isServiceCaller(req: Request): boolean {
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const part = jwt.split('.')[1]
  if (!part) return false
  try {
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')))
    return json?.role === 'service_role'
  } catch { return false }
}

const pad = (a: string) => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0')
const hex = (n: number) => '0x' + n.toString(16)

async function watchDeposits() {
  const { data: open } = await db.from('merchant_payment_intents').select('*')
    .in('status', ['pending', 'partially_paid'])
    .gt('created_at', new Date(Date.now() - 30 * 86400_000).toISOString())
  const intents = (open ?? []).filter((i: any) => !i.expires_at || new Date(i.expires_at).getTime() > Date.now() - 86400_000)
  // Every approved merchant's address is watched on the other chains, so any
  // payment there (order or not) is recorded and notified ("Payment received
  // on Base"). It stays on that chain until the merchant's auto-convert.
  const { data: apps } = await db.from('merchant_applications').select('wallet_address').eq('status', 'approved')
  const merchantWallets = new Set((apps ?? []).map((a: any) => String(a.wallet_address ?? '').toLowerCase()).filter(Boolean))
  if (intents.length === 0 && merchantWallets.size === 0) return { scanned: 0, matched: 0, review: 0 }

  // Customer wallets for orders that name a customer.
  const custIds = [...new Set(intents.map((i: any) => i.customer_user_id).filter(Boolean))]
  const custWallet = new Map<string, string>()
  if (custIds.length) {
    const { data: us } = await db.from('users').select('id, wallet_address').in('id', custIds)
    for (const u of us ?? []) if (u.wallet_address) custWallet.set(String(u.id), String(u.wallet_address).toLowerCase())
  }
  const orderWallets = [...new Set(intents.map((i: any) => String(i.merchant_wallet).toLowerCase()))]
  const { data: cursors } = await db.from('merchant_deposit_cursors').select('chain, last_block')
  const cursorOf = new Map((cursors ?? []).map((c: any) => [c.chain, Number(c.last_block)]))

  let scanned = 0, matched = 0, review = 0
  // Read every chain at the same time (the slow part is the RPC round
  // trips), then handle the payments one chain after another.
  type Fetched = { fromBlock: number; toBlock: number; logs: any[] | null } | { error: unknown } | null
  const fetched = new Map<string, Fetched>(await Promise.all(Object.entries(PAY_CHAINS).map(async ([chainId, chain]): Promise<[string, Fetched]> => {
    try {
      const latest = parseInt(await rpc(chain.rpcs, 'eth_blockNumber', []), 16)
      if (!Number.isFinite(latest)) return [chainId, null]
      const fromBlock = (cursorOf.get(chainId) ?? (latest - START_LOOKBACK)) + 1
      const toBlock = Math.min(latest, fromBlock + (SCAN_RANGE[chainId] ?? DEFAULT_RANGE) - 1)
      if (fromBlock > toBlock) return [chainId, null]
      const isArc = chainId === 'Arc_Testnet'
      // Arc: open orders only (plain Arc receives are handled by the app).
      const wallets = isArc ? orderWallets : [...new Set([...orderWallets, ...merchantWallets])]
      if (wallets.length === 0) return [chainId, { fromBlock, toBlock, logs: null }]
      const logs: any[] = await rpc(chain.rpcs, 'eth_getLogs', [{
        address: isArc ? ARC_NATIVE_EMITTER : chain.usdc,
        topics: [TRANSFER_TOPIC, null, wallets.map(pad)],
        fromBlock: hex(fromBlock), toBlock: hex(toBlock),
      }])
      return [chainId, { fromBlock, toBlock, logs: logs ?? [] }]
    } catch (e) {
      return [chainId, { error: e }]
    }
  })))

  for (const [chainId, chain] of Object.entries(PAY_CHAINS)) {
    try {
      const f = fetched.get(chainId)
      if (!f) continue
      if ('error' in f) throw f.error
      const { toBlock } = f
      const isArc = chainId === 'Arc_Testnet'
      if (f.logs === null) {
        await db.from('merchant_deposit_cursors').upsert({ chain: chainId, last_block: toBlock, updated_at: new Date().toISOString() })
        continue
      }
      const logs = f.logs
      scanned += 1
      const blockTime = new Map<string, number>()
      for (const log of logs ?? []) {
        const to = ('0x' + String(log.topics?.[2]).slice(-40)).toLowerCase()
        const from = ('0x' + String(log.topics?.[1]).slice(-40)).toLowerCase()
        if (from === ZERO || from === to) continue // mints (UB / CCTP arrivals) and self-sends
        if (GATEWAY_CONTRACTS.has(from)) continue // the merchant's own Ledger withdrawals
        let atomic = 0n
        try { atomic = BigInt(log.data) } catch { continue }
        const amount = Number(isArc ? atomic / 1_000_000_000_000n : atomic) / 1e6
        if (!(amount > 0)) continue
        const tx = String(log.transactionHash).toLowerCase()

        const { data: known } = await db.from('merchant_payments').select('id').eq('source_chain', chainId).eq('tx_hash', tx).maybeSingle()
        const { data: queued } = await db.from('merchant_unmatched_deposits').select('id').eq('source_chain', chainId).eq('tx_hash', tx).maybeSingle()
        const matchOrder = async () => {

        if (!blockTime.has(log.blockNumber)) {
          const b = await rpc(chain.rpcs, 'eth_getBlockByNumber', [log.blockNumber, false]).catch(() => null)
          blockTime.set(log.blockNumber, b?.timestamp ? parseInt(b.timestamp, 16) * 1000 : Date.now())
        }
        const at = blockTime.get(log.blockNumber)!

        // Open orders of this merchant that were open when the deposit landed.
        const live = intents.filter((i: any) => {
          if (String(i.merchant_wallet).toLowerCase() !== to) return false
          if (i.personal && !isArc) return false
          if (new Date(i.created_at).getTime() > at + 60_000) return false
          if (i.expires_at && new Date(i.expires_at).getTime() < at) return false
          return true
        })
        const dueOf = (i: any) => Number(i.requested_amount) - Number(i.received_amount)
        const custOf = (i: any) => (i.customer_user_id ? custWallet.get(String(i.customer_user_id)) : null) ?? null
        // An order naming a customer only ever takes deposits from that customer.
        const allowed = live.filter((i: any) => { const cw = custOf(i); return !cw || cw === from })

        const record = async (i: any) => {
          const out: any = await recordPayment(null, i, chainId, tx, null, { orderNumber: null, amount: null }, 'watcher')
          if (out?.ok && !out.duplicate) {
            matched += 1
            // Refresh what's still due for the next deposit in this run.
            const { data: fresh } = await db.from('merchant_payment_intents').select('*').eq('id', i.id).maybeSingle()
            const k = intents.indexOf(i)
            if (k >= 0) { if (fresh && ['pending', 'partially_paid'].includes(fresh.status)) intents[k] = fresh; else intents.splice(k, 1) }
          }
        }
        const park = async (list: any[], reason: 'multiple_orders' | 'amount_mismatch') => {
          await db.from('merchant_unmatched_deposits').insert({
            merchant_wallet: to, source_chain: chainId, tx_hash: tx, from_address: from, amount, reason,
            candidate_codes: list.map((c: any) => c.code),
          })
          review += 1
        }

        // 1) Exact amount.
        const exact = allowed.filter((i: any) => Math.abs(dueOf(i) - amount) <= 0.000001)
        if (exact.length === 1) { await record(exact[0]); return }
        if (exact.length > 1) { await park(exact, 'multiple_orders'); return }

        // 2) From the customer an order was made for: partial / split payment
        //    (less than due) or overpayment (more) — linked to that order.
        const theirs = live.filter((i: any) => custOf(i) === from)
        if (theirs.length === 1) { await record(theirs[0]); return }
        if (theirs.length > 1) { await park(theirs, 'amount_mismatch'); return }

        // 3) Anyone else, within ±10% of what an order is due → merchant decides.
        const close = allowed
          .filter((i: any) => !custOf(i) && Math.abs(dueOf(i) - amount) <= Math.max(0.1 * dueOf(i), 0.01))
          .sort((a: any, b: any) => Math.abs(dueOf(a) - amount) - Math.abs(dueOf(b) - amount))
        if (close.length > 0) { await park(close, 'amount_mismatch'); return }
        // 4) Nothing close — an ordinary transfer, not an order payment.
        }
        if (!known && !queued) await matchOrder()

        // Other chains: record the payment for the merchant (notified as
        // "Payment received on Base"; orders are named, so they aren't
        // notified twice). Converted to Arc by auto-convert.
        if (!isArc && merchantWallets.has(to)) {
          const { data: paid } = await db.from('merchant_payments').select('order_number').eq('source_chain', chainId).eq('tx_hash', tx).maybeSingle()
          await db.from('merchant_chain_receipts').upsert({
            merchant_wallet: to, source_chain: chainId, tx_hash: tx, from_address: from, amount,
            order_number: paid?.order_number ?? null,
          }, { onConflict: 'source_chain,tx_hash,merchant_wallet', ignoreDuplicates: true })
        }
      }
      await db.from('merchant_deposit_cursors').upsert({ chain: chainId, last_block: toBlock, updated_at: new Date().toISOString() })
    } catch (e) {
      console.error('[merchant-pay/watch]', chainId, e instanceof Error ? e.message : e)
    }
  }
  return { scanned, matched, review }
}

Deno.serve(async (req: Request) => {
  const preflight = handleOptionsFor(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return jsonFor(req, { error: 'Method not allowed' }, 405)

  let b: Record<string, unknown> = {}
  try { b = await req.json() } catch { /* validated below */ }
  const action = String(b.action ?? '')

  if (action === 'watch') {
    if (!isServiceCaller(req)) return jsonFor(req, { error: 'Forbidden' }, 403)
    const { data: gotLock } = await db.rpc('merchant_watch_lock_acquire', { p_seconds: 60 })
    if (gotLock !== true) return jsonFor(req, { skipped: 'busy' })
    try { return jsonFor(req, await watchDeposits()) }
    catch (e) { console.error('[merchant-pay/watch]', e instanceof Error ? e.message : e); return jsonFor(req, { error: 'watch failed' }, 500) }
    finally { await db.rpc('merchant_watch_lock_release').then(() => {}, () => {}) }
  }

  if (action === 'dismiss') {
    const who = await caller(req)
    const { data: dep } = await db.from('merchant_unmatched_deposits').select('*').eq('id', String(b.depositId ?? '')).maybeSingle()
    if (!who?.wallet || !dep || dep.merchant_wallet !== who.wallet) return jsonFor(req, { error: 'Not found' }, 404)
    await db.from('merchant_unmatched_deposits').update({ status: 'dismissed', updated_at: new Date().toISOString() }).eq('id', dep.id)
    return jsonFor(req, { ok: true })
  }

  // MeshPort scanned a wallet payment QR (address + amount, no link): the
  // newest open order for that wallet with exactly that amount due, if any.
  if (action === 'find') {
    const wallet = String(b.wallet ?? '').toLowerCase()
    const amt = Number(b.amount)
    if (!/^0x[0-9a-f]{40}$/.test(wallet) || !(Number.isFinite(amt) && amt > 0)) return jsonFor(req, { order: null })
    try {
      const { data } = await db.from('merchant_payment_intents').select('code, order_number, requested_amount, received_amount, expires_at')
        .eq('merchant_wallet', wallet).in('status', ['pending', 'partially_paid'])
        .gt('created_at', new Date(Date.now() - 30 * 86400_000).toISOString())
        .order('created_at', { ascending: false }).limit(50)
      const hit = (data ?? []).find((i: any) =>
        (!i.expires_at || new Date(i.expires_at).getTime() > Date.now())
        && Math.abs(Number(i.requested_amount) - Number(i.received_amount) - amt) <= 1e-6)
      return jsonFor(req, { order: hit ? { code: hit.code, orderNumber: hit.order_number ?? null } : null })
    } catch { return jsonFor(req, { order: null }) }
  }

  const code = String(b.code ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32)
  if (!code) return jsonFor(req, { error: 'Missing payment code' }, 400)

  try {
    const i = await loadIntent(code)
    if (!i) return jsonFor(req, { error: 'Payment request not found' }, 404)

    if (action === 'get') return jsonFor(req, publicView(i, await loadPayments(i.id)))

    if (action === 'assign') {
      // The merchant picks which order a "needs review" deposit paid.
      const who = await caller(req)
      if (who?.authUid !== i.merchant_auth_uid) return jsonFor(req, { error: 'Not found' }, 404)
      const { data: dep } = await db.from('merchant_unmatched_deposits').select('*').eq('id', String(b.depositId ?? '')).maybeSingle()
      if (!dep || dep.status !== 'needs_review' || dep.merchant_wallet !== String(i.merchant_wallet).toLowerCase()) return jsonFor(req, { error: 'Deposit not found' }, 404)
      const out: any = await recordPayment(req, i, dep.source_chain, dep.tx_hash, who, { orderNumber: null, amount: null }, 'merchant')
      if (out.error) return jsonFor(req, { error: out.error }, out.status ?? 400)
      if (out.pending) return jsonFor(req, { error: 'Not confirmed on-chain yet — try again shortly' }, 409)
      await db.from('merchant_unmatched_deposits').update({ status: 'assigned', assigned_code: i.code, updated_at: new Date().toISOString() }).eq('id', dep.id)
      const fresh = await loadIntent(code)
      return jsonFor(req, publicView(fresh, await loadPayments(i.id)))
    }

    if (action === 'complete') {
      // Merchant marks the order completed (paid in cash, settled elsewhere…).
      // No payment is invented: received_amount stays what was really paid.
      const who = await caller(req)
      if (who?.authUid !== i.merchant_auth_uid) return jsonFor(req, { error: 'Not found' }, 404)
      const st = effectiveStatus(i)
      if (st === 'paid') return jsonFor(req, { error: `Order #${i.order_number} is already completed.` }, 409)
      if (st === 'cancelled') return jsonFor(req, { error: 'This order was cancelled.' }, 409)
      const note = typeof b.note === 'string' ? b.note.trim().slice(0, 140) : ''
      const now = new Date().toISOString()
      await db.from('merchant_payment_intents').update({
        status: 'paid', paid_at: i.paid_at ?? now, completed_by_merchant: true, completed_at: now, completed_note: note || null,
      }).eq('id', i.id)
      const fresh = await loadIntent(code)
      return jsonFor(req, publicView(fresh, await loadPayments(i.id)))
    }

    if (action === 'submit' || action === 'verify') {
      const who = await caller(req)
      if (action === 'verify' && who?.authUid !== i.merchant_auth_uid) return jsonFor(req, { error: 'Not found' }, 404)
      if (i.status === 'cancelled') return jsonFor(req, { error: 'This payment request was cancelled.' }, 409)
      const orderNumber = typeof b.orderNumber === 'string' ? b.orderNumber.trim().slice(0, 32) : ''
      const amt = b.amount == null ? null : Number(b.amount)
      if (amt != null && !(Number.isFinite(amt) && amt > 0)) return jsonFor(req, { error: 'Invalid amount' }, 400)
      const out: any = await recordPayment(req, i, String(b.chain ?? ''), String(b.txHash ?? ''), who, { orderNumber: orderNumber || null, amount: amt }, action === 'verify' ? 'merchant' : 'customer')
      if (out.error) return jsonFor(req, { error: out.error }, out.status ?? 400)
      const fresh = await loadIntent(code)
      return jsonFor(req, { ...publicView(fresh, await loadPayments(i.id)), pending: !!out.pending })
    }

    if (action === 'cancel') {
      const who = await caller(req)
      if (who?.authUid !== i.merchant_auth_uid) return jsonFor(req, { error: 'Not found' }, 404)
      if (!['pending', 'expired'].includes(effectiveStatus(i)) || Number(i.received_amount) > 0) return jsonFor(req, { error: 'A payment was already made on this request.' }, 409)
      await db.from('merchant_payment_intents').update({ status: 'cancelled' }).eq('id', i.id)
      return jsonFor(req, publicView({ ...i, status: 'cancelled' }, []))
    }

    return jsonFor(req, { error: 'Unknown action' }, 400)
  } catch (e) {
    console.error('[merchant-pay]', e instanceof Error ? e.message : e)
    return jsonFor(req, { error: 'Something went wrong — try again' }, 500)
  }
})
