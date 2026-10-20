// supabase/functions/merchant-pay/index.ts
//
// Merchant payment requests - the only place a request's status changes.
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
//   POST { action: 'reopen', code }                 merchant: a cancelled / expired order is open again
//                                                   (money paid after the cancel counts towards it)
//
// Nothing is trusted from the client except "look at this transaction":
// the receipt is fetched from the chain, the USDC Transfer to the merchant's
// wallet is read from its logs, and one chain tx can only ever count once
// per merchant (merchant_payments unique source_chain + tx_hash + merchant_wallet).
// Other chains are credited only once the block is CONFIRMATIONS deep.
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
import { isCronOrLegacyServiceCaller } from '../_shared/cronAuth.ts'

const DRPC_KEY = Deno.env.get('DRPC_KEY') ?? ''
const ARC_RPCS = [
  ...((Deno.env.get('ARC_RPC_URL') ?? '').trim() ? [(Deno.env.get('ARC_RPC_URL') ?? '').trim()] : []),
  ...(DRPC_KEY ? [`https://lb.drpc.live/arc-testnet/${DRPC_KEY}`] : []),
  'https://rpc.testnet.arc.io',
  'https://rpc.blockdaemon.testnet.arc.io',
  'https://rpc.drpc.testnet.arc.io',
  'https://rpc.quicknode.testnet.arc.io',
]
const d = (net: string) => (DRPC_KEY ? [`https://lb.drpc.live/${net}/${DRPC_KEY}`] : [])

// Chains a customer can pay on. Arc = direct; the rest are other chains with
// a known chain id + USDC contract (same values the app uses in
// src/blockchain/chains.ts). Nothing here is guessed. route 'ub' just means
// "another chain" (stored as method external_ub); merchants collect them to
// Arc over CCTP with Claim All.
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
  // MeshPort bridge-router (CCTP) chains - values copied from src/blockchain/chains.ts.
  Sonic_Testnet: { label: 'Sonic', chainId: 14601, usdc: '0x0BA304580ee7c9a980CF72e55f5Ed2E9fd30Bc51', rpcs: ['https://rpc.testnet.soniclabs.com', 'https://sonic-testnet.rpc.thirdweb.com'], route: 'ub' },
  World_Chain_Sepolia: { label: 'World Chain', chainId: 4801, usdc: '0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88', rpcs: ['https://worldchain-sepolia.g.alchemy.com/public', 'https://worldchain-sepolia.rpc.thirdweb.com'], route: 'ub' },
  Linea_Sepolia: { label: 'Linea', chainId: 59141, usdc: '0xFEce4462D57bD51A6A552365A011b95f0E16d9B7', rpcs: ['https://rpc.sepolia.linea.build'], route: 'ub' },
  Ink_Testnet: { label: 'Ink', chainId: 763373, usdc: '0xFabab97dCE620294D2B0b0e46C68964e326300Ac', rpcs: ['https://rpc-gel-sepolia.inkonchain.com', 'https://rpc-qnd-sepolia.inkonchain.com'], route: 'ub' },
  Monad_Testnet: { label: 'Monad', chainId: 10143, usdc: '0x534b2f3A21130d7a60830c2Df862319e593943A3', rpcs: ['https://testnet-rpc.monad.xyz'], route: 'ub' },
  Morph_Testnet: { label: 'Morph', chainId: 2910, usdc: '0x7433b41C6c5e1d58D4Da99483609520255ab661B', rpcs: ['https://rpc-hoodi.morphl2.io'], route: 'ub' },
  Pharos_Testnet: { label: 'Pharos', chainId: 688689, usdc: '0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B', rpcs: ['https://atlantic.dplabs-internal.com'], route: 'ub' },
  Plume_Testnet: { label: 'Plume', chainId: 98867, usdc: '0xcB5f30e335672893c7eb944B374c196392C19D18', rpcs: ['https://testnet-rpc.plume.org'], route: 'ub' },
  Codex_Testnet: { label: 'Codex', chainId: 812242, usdc: '0x6d7f141b6819C2c9CC2f818e6ad549E7Ca090F8f', rpcs: ['https://rpc.codex-stg.xyz'], route: 'ub' },
  Injective_Testnet: { label: 'Injective', chainId: 1439, usdc: '0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d', rpcs: ['https://k8s.testnet.json-rpc.injective.network'], route: 'ub' },
  XDC_Apothem: { label: 'XDC', chainId: 51, usdc: '0xb5AB69F7bBada22B28e79C8FFAECe55eF1c771D4', rpcs: ['https://rpc.apothem.network', 'https://erpc.apothem.network'], route: 'ub' },
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

// Blocks a payment must be under the chain head before it's credited (reorg
// safety). Arc has deterministic finality: a block is final when produced.
export const CONFIRMATIONS: Record<string, number> = {
  Arc_Testnet: 0,
  Ethereum_Sepolia: 12,
  Base_Sepolia: 10, Optimism_Sepolia: 10, Unichain_Sepolia: 10, World_Chain_Sepolia: 10, Ink_Testnet: 10, Linea_Sepolia: 10,
  Arbitrum_Sepolia: 20, // ~0.25 s blocks
  Polygon_Sepolia: 64,
  Avalanche_Fuji: 3, Sonic_Testnet: 3, Sei_Testnet: 3, Injective_Testnet: 3, // fast-finality chains
  XDC_Apothem: 5, HyperEVM_Testnet: 5,
}
export const DEFAULT_CONFIRMATIONS = 10
export const confirmationsFor = (chainId: string) => CONFIRMATIONS[chainId] ?? DEFAULT_CONFIRMATIONS

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

const errText = (e: unknown) => e instanceof Error ? e.message : typeof e === 'object' ? JSON.stringify(e) : String(e)

async function rpc(urls: string[], method: string, params: unknown[]): Promise<any> {
  // Every endpoint's refusal is kept, not just the last one: a node's
  // "pruned history" answer followed by a dead fallback's timeout must still
  // read as pruned history to scanLogs.
  const errors: string[] = []
  for (const url of urls) {
    if (!url || url.endsWith('/')) continue
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(8000),
      })
      const j = await r.json()
      if (j.error) { errors.push(errText(j.error)); continue }
      return j.result
    } catch (e) { errors.push(errText(e)) }
  }
  throw new Error(errors.join(' | ') || `${method} failed`)
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

// How an order is named (same as the app's src/lib/orderLabels.ts):
// "Bill #42" / "Request #43" / "Requested Payment #44" / "Payment #45" (Shop QR).
// Stored numbers count from 100001; they're shown as #N from #1.
function orderDisplay(n: string | null | undefined): string {
  const m = /^ORD-(\d+)$/i.exec(n || '')
  if (!m || Number(m[1]) <= 100000) return n || ''
  return `#${Number(m[1]) - 100000}`
}
function orderName(i: any): string {
  const no = orderDisplay(i.order_number)
  return i.kind === 'invoice' ? `Bill ${no}` : i.via === 'shop_qr' ? `Payment ${no}` : i.personal === false ? `Requested Payment ${no}` : `Request ${no}`
}

function publicView(i: any, payments: any[]) {
  return {
    code: i.code, orderNumber: i.order_number ?? null, merchantName: i.merchant_name, merchantWallet: i.merchant_wallet,
    merchantUsername: i._merchant_username ?? null, merchantAvatar: i._merchant_avatar ?? null,
    amount: Number(i.requested_amount), received: Number(i.received_amount), overpaid: Number(i.overpaid_amount ?? 0), currency: i.currency,
    note: i.note, customerUsername: i.customer_username, status: effectiveStatus(i),
    kind: i.kind ?? 'request', personal: typeof i.personal === 'boolean' ? i.personal : null, items: Array.isArray(i.items) ? i.items : null,
    via: i.via ?? null,
    taxPercent: Number(i.tax_percent ?? 0),
    createdAt: i.created_at, expiresAt: i.expires_at, paidAt: i.paid_at, dueDate: i.due_date ?? null,
    completedByMerchant: !!i.completed_by_merchant, completedNote: i.completed_note ?? null,
    chains: Object.entries(PAY_CHAINS).map(([id, c]) => ({ id, label: c.label, chainId: c.chainId, usdc: c.usdc, route: c.route })),
    payments: payments.map(p => ({ chain: p.source_chain, amount: Number(p.amount), status: p.status, txHash: p.tx_hash, method: p.method, late: !!p.late, createdAt: p.created_at })),
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

// Arc: USDC is the native coin. Every native movement - a plain native send
// (what MeshPort Pay/Chat Pay does) and the native leg of an ERC-20
// transfer() - emits a standard Transfer log from the EIP-7708 system
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
    // Native emitter only - an ERC-20 transfer() also logs on 0x3600…, and
    // counting both would double the amount.
    const native = sum(ARC_NATIVE_EMITTER, TRANSFER_TOPIC, 18)
    if (native.amount > 0) return native
    const legacy = sum(ARC_LEGACY_AUTHORITY, ARC_LEGACY_TOPIC, 18)
    if (legacy.amount > 0) return legacy
  }
  return sum(usdc.toLowerCase(), TRANSFER_TOPIC, 6)
}

// ── Incoming payment screening ───────────────────────────────────────────
// Two independent checks on the paying address, run in parallel:
//   1. USDC's own blocklist (FiatToken isBlacklisted(address) → bool) on the
//      chain the money came in on - authoritative for USDC freezes.
//   2. Circle's Compliance Engine (address screening) - sanctions, frozen
//      wallets and other high-risk categories USDC's own list doesn't cover.
// A hit is still recorded (the money arrived) but flagged, and the merchant
// is told. Cached per address for a while. Circle's richer flag wins when
// present; the on-chain result stands otherwise.
export type ScreenFlag = 'usdc_blocklisted' | 'sanctions' | 'frozen' | 'high_risk'
const screenCache = new Map<string, { at: number; flag: ScreenFlag | null }>()
const SCREEN_TTL_MS = 10 * 60_000

const CIRCLE_API_KEY = Deno.env.get('CIRCLE_API_KEY') ?? ''
// MeshPort chain → Circle Compliance Engine chain enum. Circle has no Arc
// value (and no Base/Optimism/… testnet), but every MeshPort chain is EVM and
// Circle's address risk is address-keyed: a sanctions/blocklist hit is the
// same address on any EVM chain. So unmapped chains screen under ETH-SEPOLIA
// as an EVM proxy rather than going unscreened.
const CIRCLE_CHAIN: Record<string, string> = {
  Ethereum_Sepolia: 'ETH-SEPOLIA',
  Arbitrum_Sepolia: 'ARB-SEPOLIA',
  Polygon_Sepolia:  'MATIC-AMOY',
  Avalanche_Fuji:   'AVAX-FUJI',
  Unichain_Sepolia: 'UNI-SEPOLIA',
}
const circleChainFor = (chainId: string) => CIRCLE_CHAIN[chainId] ?? 'ETH-SEPOLIA'

// Best-effort: any failure (no key, network, timeout, unexpected shape, a
// non-DENIED result) returns null so the on-chain check still stands and
// payment recording never blocks on screening.
async function screenWithCircle(chainId: string, addr: string): Promise<ScreenFlag | null> {
  if (!CIRCLE_API_KEY) return null
  try {
    const res = await fetch('https://api.circle.com/v1/w3s/compliance/screening/addresses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${CIRCLE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), address: addr, chain: circleChainFor(chainId) }),
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) return null
    // Response is wrapped: { data: { result, decision: { reasons: [{ riskCategories }] } } }.
    const d = (await res.json().catch(() => null) as any)?.data
    if (!d || d.result !== 'DENIED') return null
    const cats: string[] = (d.decision?.reasons ?? []).flatMap((r: any) => r?.riskCategories ?? [])
    if (cats.includes('SANCTIONS') || cats.includes('TERRORIST_FINANCING')) return 'sanctions'
    if (cats.includes('FROZEN')) return 'frozen'
    return 'high_risk'
  } catch { return null }
}

async function screenSender(chainId: string, from: string | null): Promise<ScreenFlag | null> {
  const chain = PAY_CHAINS[chainId]
  if (!chain || !from || !/^0x[0-9a-f]{40}$/i.test(from) || /^0x0{40}$/i.test(from)) return null
  const key = `${chainId}:${from.toLowerCase()}`
  const hit = screenCache.get(key)
  if (hit && Date.now() - hit.at < SCREEN_TTL_MS) return hit.flag
  const data = '0xfe575a87' + from.replace(/^0x/, '').toLowerCase().padStart(64, '0')
  const [out, circleFlag] = await Promise.all([
    rpc(chain.rpcs, 'eth_call', [{ to: chain.usdc, data }, 'latest']).catch(() => null),
    screenWithCircle(chainId, from),
  ])
  const onchainReadable = typeof out === 'string' && /^0x[0-9a-f]+$/i.test(out)
  const onchain: ScreenFlag | null = onchainReadable && BigInt(out as string) !== 0n ? 'usdc_blocklisted' : null
  // Circle's richer flag wins when present; otherwise the on-chain result.
  const flag: ScreenFlag | null = circleFlag ?? onchain
  // Cache only a definitive read: if the on-chain call was unreadable and
  // Circle gave nothing, a null here might be a false "clear" - don't cache.
  if (onchainReadable || circleFlag) screenCache.set(key, { at: Date.now(), flag })
  return flag
}

// Merchant-facing wording for each screening flag.
function screenMsg(flag: ScreenFlag): { title: string; why: string } {
  switch (flag) {
    case 'sanctions': return { title: 'Payment from a sanctioned address', why: 'is on a sanctions blocklist' }
    case 'frozen':    return { title: 'Payment from a frozen wallet',       why: 'is a frozen wallet' }
    case 'high_risk': return { title: 'Payment flagged by screening',       why: 'was flagged as high-risk by compliance screening' }
    default:          return { title: 'Payment from a blocked address',     why: "is on USDC's blocklist" }
  }
}

const usd2 = (n: number) => '$' + n.toFixed(2)
const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4)
async function notifyMerchant(wallet: string, type: string, title: string, message: string) {
  await db.rpc('merchant_notify', { p_wallet: wallet, p_type: type, p_title: title, p_message: message }).then(() => {}, () => {})
}

type OrderCheck = { orderNumber: string | null; amount: number | null }
type MatchedBy = 'customer' | 'merchant' | 'watcher'

type RecordOpts = { minedAt?: number }
async function recordPayment(req: Request | null, i: any, chainId: string, txHash: string, who: Awaited<ReturnType<typeof caller>>, order: OrderCheck, matchedBy: MatchedBy = 'customer', opts: RecordOpts = {}) {
  const chain = PAY_CHAINS[chainId]
  if (!chain) return { error: "This network isn't supported for this payment.", status: 400 }
  // Personal requests can be paid on another chain too: the USDC lands in the
  // requester's own wallet there (same address), shows in their Multichain
  // Hub, and they bring it to Arc - the order is paid on arrival either way.
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { error: 'Invalid transaction', status: 400 }
  const tx = txHash.toLowerCase()

  // Already counted (idempotent: same answer, never a second credit).
  // (Per merchant: one tx can pay two different merchants.)
  const merchantWallet = String(i.merchant_wallet).toLowerCase()
  const { data: dup } = await db.from('merchant_payments').select('intent_id').eq('source_chain', chainId).eq('tx_hash', tx).eq('merchant_wallet', merchantWallet).maybeSingle()
  if (dup) {
    if (dup.intent_id !== i.id) return { error: 'This transaction was already used for another payment.', status: 409 }
    return { ok: true, duplicate: true }
  }

  // Confirm against the order: the order number must be this request's,
  // the amount must be exactly what's due, and a paid order takes no more.
  const due = Math.max(0, Number(i.requested_amount) - Number(i.received_amount))
  if (effectiveStatus(i) === 'paid' || (Number(i.received_amount) > 0 && due <= 0.000001)) {
    return { error: `${orderName(i)} is already paid.`, status: 409 }
  }
  if (order.orderNumber && order.orderNumber.toUpperCase() !== String(i.order_number).toUpperCase()) {
    return { error: `That number doesn't match this payment (${orderName(i)}).`, status: 409 }
  }
  if (order.amount != null && Math.abs(order.amount - due) > 0.000001) {
    return { error: `Amount doesn't match ${orderName(i)} - $${due.toFixed(2)} USDC is due.`, status: 409 }
  }
  const receipt = await rpc(chain.rpcs, 'eth_getTransactionReceipt', [tx]).catch(() => null)
  if (!receipt) return { pending: true }
  if (receipt.status !== '0x1') return { error: 'The transaction failed on-chain.', status: 409 }
  // Other chains: credited once the block is deep enough (the watcher only
  // scans that deep already).
  const depth = confirmationsFor(chainId)
  if (depth > 0 && matchedBy !== 'watcher') {
    const head = parseInt(await rpc(chain.rpcs, 'eth_blockNumber', []).catch(() => '0x0'), 16)
    if (!(head - parseInt(receipt.blockNumber, 16) >= depth)) return { pending: true }
  }
  const { amount, from } = usdcToMerchant(receipt, chain.usdc, i.merchant_wallet, chainId)
  if (!(amount > 0) || !from) return { error: `This transaction didn't send USDC to ${i.merchant_name ?? 'the merchant'} on ${chain.label}.`, status: 409 }
  if (order.amount != null && amount + 0.000001 < order.amount) {
    return { error: `This transaction sent $${amount} USDC, but ${orderName(i)} is for $${order.amount} USDC.`, status: 409 }
  }

  // When the transfer was mined (for the customer checks and "late").
  let minedAtCache = opts.minedAt ?? 0
  const blockTime = async () => {
    if (!minedAtCache) {
      const block = await rpc(chain.rpcs, 'eth_getBlockByNumber', [receipt.blockNumber, false]).catch(() => null)
      minedAtCache = block?.timestamp ? parseInt(block.timestamp, 16) * 1000 : 0
    }
    return minedAtCache
  }

  // A payer claiming a transfer for an order must show it's really theirs and
  // really for this order - otherwise anyone could point an order at someone
  // else's (or an old) transfer into the merchant's wallet and get it marked paid.
  // (Merchant 'verify'/'assign' and the watcher are trusted paths.)
  if (matchedBy === 'customer') {
    if (who?.wallet && who.wallet !== from) return { error: "This transaction wasn't sent from your wallet.", status: 409 }
    if (i.customer_wallet && String(i.customer_wallet).toLowerCase() !== from) return { error: "This transaction wasn't sent by this order's customer.", status: 409 }
    if (!who?.wallet && order.amount == null) return { error: 'Amount is required to confirm this payment.', status: 400 }
    // Without a session nothing ties the sender to whoever is asking, so a
    // transfer only confirms here when it names this order (Arc memo).
    // Anything else waits for the watcher, which matches it on its own.
    if (!who?.wallet) {
      const ids = chain.route === 'direct' ? await txMemoIds(chain.rpcs, tx) : []
      if (!ids.includes(memoIdOf(String(i.code)))) return { pending: true }
    }
    const minedAt = await blockTime()
    const createdAt = new Date(i.created_at).getTime()
    if (!minedAt) return { pending: true }
    if (minedAt + 60_000 < createdAt) return { error: 'This transaction was sent before the order was created.', status: 409 }
    if (!who?.wallet && Date.now() - minedAt > 30 * 60_000) {
      return { error: 'This transaction is too old to confirm here - ask the merchant to verify it.', status: 409 }
    }
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

  // Late: paid after the order expired, or onto an order that was already
  // cancelled / marked expired. Still recorded against the order.
  const statusNow = String(i.status)
  const expiresAt = i.expires_at ? new Date(i.expires_at).getTime() : null
  const minedAt = (statusNow === 'cancelled' || statusNow === 'expired' || expiresAt != null) ? await blockTime() : minedAtCache
  const late = statusNow === 'cancelled' || statusNow === 'expired' || (expiresAt != null && minedAt > 0 && minedAt > expiresAt)
  const screenFlag = await screenSender(chainId, from)

  const { error: insErr } = await db.from('merchant_payments').insert({
    intent_id: i.id, merchant_wallet: merchantWallet, source_chain: chainId, tx_hash: tx, from_address: from,
    amount, method, status: 'confirmed', customer_user_id: customerUserId, customer_username: customerUsername,
    order_number: i.order_number, matched_by: matchedBy, late, screen_flag: screenFlag,
    ...(chain.route === 'direct' ? { arc_tx_hash: tx } : {}),
  })
  if (insErr) {
    if (/duplicate|unique/i.test(insErr.message)) return { ok: true, duplicate: true }
    throw insErr
  }
  // The same transfer recorded as a plain receive on another chain is this
  // order's payment now - named, so it isn't counted (or refunded) twice.
  await db.from('merchant_chain_receipts').update({ order_number: i.order_number })
    .eq('source_chain', chainId).eq('tx_hash', tx).eq('merchant_wallet', merchantWallet).is('order_number', null)
  // A deposit the watcher parked as "needs review" is settled now.
  await db.from('merchant_unmatched_deposits').update({ status: 'assigned', assigned_code: i.code, updated_at: new Date().toISOString() })
    .eq('source_chain', chainId).eq('tx_hash', tx).eq('merchant_wallet', merchantWallet).eq('status', 'needs_review')

  // Received total, overpayment and status in one locked step in the
  // database (no read-then-write race with a concurrent payment). A
  // cancelled order stays cancelled; paid on arrival otherwise, whichever
  // chain - only the conversion to Arc waits for the merchant's Claim All.
  const { error: rcErr } = await db.rpc('merchant_intent_recompute', { p_intent: i.id })
  if (rcErr) throw rcErr

  const label = `${usd2(amount)} USDC${chain.route === 'direct' ? '' : ` on ${chain.label}`}`
  if (screenFlag) {
    const m = screenMsg(screenFlag)
    await notifyMerchant(merchantWallet, 'merchant_payment_screened', m.title,
      `${label} for ${orderName(i)} came from ${short(from)}, which ${m.why}. Check before you hand over goods or refund.`)
  }
  if (late && statusNow === 'cancelled') {
    await notifyMerchant(merchantWallet, 'merchant_payment_late', `Payment for cancelled ${orderName(i)}`,
      `${label} from ${customerUsername ?? short(from)} arrived after the order was cancelled - reopen it in Orders to count the payment, or refund it.`)
  }
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
// (18 decimals) - https://docs.arc.io/integrate/exchanges/deposits
// World Chain's and Monad's public RPCs only answer eth_getLogs for 100 blocks.
const SCAN_RANGE: Record<string, number> = { Arc_Testnet: 3000, World_Chain_Sepolia: 100, Monad_Testnet: 100 }
const DEFAULT_RANGE = 1000
const START_LOOKBACK = 300
// Fallbacks when a node refuses a log query (see scanLogs).
const SMALL_RANGE = 100
const PRUNED_JUMP = 1000

/**
 * eth_getLogs for [from, to], recovering from the two refusals public RPCs
 * give: "pruned history" (the node no longer keeps blocks that old - the
 * cursor fell behind, e.g. Ethereum Sepolia's publicnode keeps ~10k blocks,
 * which left this watcher stuck there for days) → skip ahead to recent
 * blocks; and a block-range limit → retry with a 100-block window.
 * Returns the range actually read, so the cursor moves on from there.
 */
async function scanLogs(rpcs: string[], filter: Record<string, unknown>, from: number, to: number, latest: number): Promise<{ fromBlock: number; toBlock: number; logs: any[] }> {
  const query = async (f: number, t: number) => (await rpc(rpcs, 'eth_getLogs', [{ ...filter, fromBlock: hex(f), toBlock: hex(t) }])) ?? []
  try {
    return { fromBlock: from, toBlock: to, logs: await query(from, to) }
  } catch (e) {
    const msg = errText(e)
    if (/prun|history|not available|missing trie/i.test(msg) && latest - from > PRUNED_JUMP) {
      const f = latest - PRUNED_JUMP + 1, t = Math.min(latest, f + (to - from))
      console.warn('[merchant-pay/watch] history pruned - skipping ahead to block', f)
      return { fromBlock: f, toBlock: t, logs: await query(f, t) }
    }
    if (/range|limit|too many|exceed/i.test(msg) && to - from + 1 > SMALL_RANGE) {
      const t = from + SMALL_RANGE - 1
      return { fromBlock: from, toBlock: t, logs: await query(from, t) }
    }
    throw e
  }
}
const ZERO = '0x0000000000000000000000000000000000000000'
// A CCTP mint counts as the merchant's own transfer if they sent from Arc to
// that chain within this window (the mint lands minutes after the burn).
const OWN_TRANSFER_WINDOW_MS = 6 * 3600_000
// The merchant's Transfer Funds is written to activity only once it has
// arrived, so its mint can be scanned a few seconds before that row exists
// (seen: Base receipt 21:40:21, activity row 21:40:26 -> wrongly "from a
// bridge"). An unexplained mint younger than this is left for the next run
// (cron, every minute) instead of being recorded as someone else's payment.
const OWN_TRANSFER_HOLD_MS = 5 * 60_000
// Circle Gateway wallet + minter (same on every EVM testnet).
const GATEWAY_CONTRACTS = new Set(['0x0077777d7eba4688bdef3e311b846f25870a19b9', '0x0022222abe238cc2c7bb1f21003f0a260052475b'])

// Key-migration cutover: this used to decode the bearer token's JWT payload
// and trust its `role` claim without verifying the signature - only safe
// while verify_jwt=true already verified that signature upstream. Now that
// verify_jwt is coming off (the new sb_secret_... key format isn't a JWT and
// can never pass that gate), a decode-without-verify check would be
// forgeable by anyone sending a JWT-shaped string with the right claim and
// no valid signature. Delegates to the shared exact-string-match check
// instead - see _shared/cronAuth.ts.
function isServiceCaller(req: Request): boolean {
  return isCronOrLegacyServiceCaller(req)
}

// Arc Memo contract: a payment sent with the order code as memoId is matched
// to that order directly - https://docs.arc.io/arc/concepts/transaction-memos
const ARC_MEMO_CONTRACT = '0x5294e9927c3306dcbadb03fe70b92e01ccede505'
const MEMO_TOPIC = '0xeb15ee720798341c37739df41be53acfbbf70ae6802dade35457beec6e47a5e4'
const memoIdOf = (code: string) => '0x' + [...new TextEncoder().encode(code.toLowerCase())].map(b => b.toString(16).padStart(2, '0')).join('').padEnd(64, '0')

/** memoIds the sender attached to this transaction (Memo events). */
async function txMemoIds(rpcs: string[], tx: string): Promise<string[]> {
  const receipt = await rpc(rpcs, 'eth_getTransactionReceipt', [tx]).catch(() => null)
  return (receipt?.logs ?? [])
    .filter((l: any) => String(l.address).toLowerCase() === ARC_MEMO_CONTRACT && String(l.topics?.[0]).toLowerCase() === MEMO_TOPIC)
    .map((l: any) => String(l.topics?.[3] ?? '').toLowerCase())
}

// A payment up to a day after an order expired (or was cancelled) is still
// recorded against it, flagged late.
const LATE_WINDOW_MS = 86400_000

const pad = (a: string) => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0')
const hex = (n: number) => '0x' + n.toString(16)

async function watchDeposits() {
  // Open orders, plus orders that expired or were cancelled within the last
  // day: a payment for one of those is still recorded against it (late).
  const { data: open } = await db.from('merchant_payment_intents').select('*')
    .in('status', ['pending', 'partially_paid', 'expired', 'cancelled'])
    .gt('created_at', new Date(Date.now() - 30 * 86400_000).toISOString())
  const dayAgo = Date.now() - LATE_WINDOW_MS
  const intents = (open ?? []).filter((i: any) => i.status === 'cancelled'
    ? new Date(i.updated_at ?? i.created_at).getTime() > dayAgo
    : !i.expires_at || new Date(i.expires_at).getTime() > dayAgo)
  // Every approved merchant's address is watched on the other chains, so any
  // payment there (order or not) is recorded and notified ("Payment received
  // on Base"). It stays on that chain until the merchant's auto-convert.
  // Business accounts too (approved or not): their Business tab shows these.
  const [{ data: apps }, { data: biz }] = await Promise.all([
    db.from('merchant_applications').select('wallet_address').eq('status', 'approved'),
    db.from('users').select('wallet_address').eq('account_type', 'business').not('wallet_address', 'is', null),
  ])
  const merchantWallets = new Set([...(apps ?? []), ...(biz ?? [])].map((a: any) => String(a.wallet_address ?? '').toLowerCase()).filter(Boolean))
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
    const isArc = chainId === 'Arc_Testnet'
    // Arc: open orders only (plain Arc receives are handled by the app).
    const wallets = isArc ? orderWallets : [...new Set([...orderWallets, ...merchantWallets])]
    // One RPC endpoint per chain per run for the head, the logs and the
    // check below, so the logs come from a node that has reached toBlock
    // (two load-balanced endpoints can be at different heights, and a
    // lagging one would let the cursor skip blocks it hadn't indexed).
    let lastErr: unknown = null
    for (const url of chain.rpcs.filter(u => u && !u.endsWith('/'))) {
      try {
        const head = parseInt(await rpc([url], 'eth_blockNumber', []), 16)
        if (!Number.isFinite(head)) throw new Error('bad eth_blockNumber')
        // Only blocks deep enough to be safe from reorgs (Arc: final at once).
        const latest = head - confirmationsFor(chainId)
        const fromBlock = (cursorOf.get(chainId) ?? (latest - START_LOOKBACK)) + 1
        const toBlock = Math.min(latest, fromBlock + (SCAN_RANGE[chainId] ?? DEFAULT_RANGE) - 1)
        if (fromBlock > toBlock) return [chainId, null]
        if (wallets.length === 0) return [chainId, { fromBlock, toBlock, logs: null }]
        const read = await scanLogs([url], {
          address: isArc ? ARC_NATIVE_EMITTER : chain.usdc,
          topics: [TRANSFER_TOPIC, null, wallets.map(pad)],
        }, fromBlock, toBlock, latest)
        // The node that answered must have the last block it was asked about.
        const end = await rpc([url], 'eth_getBlockByNumber', [hex(read.toBlock), false])
        if (!end?.hash) throw new Error(`node behind block ${read.toBlock}`)
        return [chainId, read]
      } catch (e) {
        lastErr = e
      }
    }
    return [chainId, { error: lastErr ?? new Error('no RPC answered') }]
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
      // Lowest block holding a mint we couldn't explain yet: rescanned next run.
      let holdBlock: number | null = null
      for (const log of logs ?? []) {
        const to = ('0x' + String(log.topics?.[2]).slice(-40)).toLowerCase()
        const from = ('0x' + String(log.topics?.[1]).slice(-40)).toLowerCase()
        if (from === to) continue // self-sends
        if (GATEWAY_CONTRACTS.has(from)) continue // the merchant's own Ledger withdrawals
        // A mint (from 0x0) on another chain is USDC arriving through CCTP:
        // usually the merchant's own Transfer Funds from Arc, otherwise
        // someone paying through a bridge. Recorded (own transfers with the
        // merchant's own address as sender, bridge payments with 0x0) and
        // never auto-matched to an order - there's no paying wallet to check.
        const minted = from === ZERO
        if (minted && (isArc || !merchantWallets.has(to))) continue
        let atomic = 0n
        try { atomic = BigInt(log.data) } catch { continue }
        const amount = Number(isArc ? atomic / 1_000_000_000_000n : atomic) / 1e6
        if (!(amount > 0)) continue
        const tx = String(log.transactionHash).toLowerCase()

        const { data: known } = await db.from('merchant_payments').select('id').eq('source_chain', chainId).eq('tx_hash', tx).eq('merchant_wallet', to).maybeSingle()
        const { data: queued } = await db.from('merchant_unmatched_deposits').select('id').eq('source_chain', chainId).eq('tx_hash', tx).eq('merchant_wallet', to).maybeSingle()
        const matchOrder = async () => {

        if (!blockTime.has(log.blockNumber)) {
          const b = await rpc(chain.rpcs, 'eth_getBlockByNumber', [log.blockNumber, false]).catch(() => null)
          blockTime.set(log.blockNumber, b?.timestamp ? parseInt(b.timestamp, 16) * 1000 : Date.now())
        }
        const at = blockTime.get(log.blockNumber)!

        // This merchant's orders that existed when the deposit landed: open
        // ones, and (as a last resort, recorded late) ones that had expired
        // within a day or were cancelled.
        const mine = intents.filter((i: any) => {
          if (String(i.merchant_wallet).toLowerCase() !== to) return false
          if (new Date(i.created_at).getTime() > at + 60_000) return false
          return true
        })
        const isLate = (i: any) => i.status === 'cancelled' || i.status === 'expired'
          || (!!i.expires_at && new Date(i.expires_at).getTime() < at)
        const live = mine.filter((i: any) => !isLate(i))
        const lateOnes = mine.filter((i: any) => isLate(i)
          && (i.status === 'cancelled' || !i.expires_at || at - new Date(i.expires_at).getTime() <= LATE_WINDOW_MS))
        const dueOf = (i: any) => Number(i.requested_amount) - Number(i.received_amount)
        const custOf = (i: any) => (i.customer_user_id ? custWallet.get(String(i.customer_user_id)) : null) ?? null
        // An order naming a customer only ever takes deposits from that customer.
        const allowed = live.filter((i: any) => { const cw = custOf(i); return !cw || cw === from })

        const record = async (i: any) => {
          const out: any = await recordPayment(null, i, chainId, tx, null, { orderNumber: null, amount: null }, 'watcher', { minedAt: at })
          if (out?.ok && !out.duplicate) {
            matched += 1
            // Refresh what's still due for the next deposit in this run.
            const { data: fresh } = await db.from('merchant_payment_intents').select('*').eq('id', i.id).maybeSingle()
            const k = intents.indexOf(i)
            if (k >= 0) { if (fresh && ['pending', 'partially_paid', 'expired'].includes(fresh.status)) intents[k] = fresh; else intents.splice(k, 1) }
          }
        }
        const park = async (list: any[], reason: 'multiple_orders' | 'amount_mismatch') => {
          await db.from('merchant_unmatched_deposits').insert({
            merchant_wallet: to, source_chain: chainId, tx_hash: tx, from_address: from, amount, reason,
            candidate_codes: list.map((c: any) => c.code),
          })
          review += 1
        }

        // 0) Sent with the order attached (Arc memo): that order, whatever the
        //    amount - also an expired or cancelled one (recorded late).
        if (isArc && mine.length) {
          const ids = new Set(await txMemoIds(chain.rpcs, tx))
          // An order made for a named customer still only takes that customer's payment.
          const byMemo = (list: any[]) => list.find((i: any) => ids.has(memoIdOf(String(i.code))) && (!custOf(i) || custOf(i) === from))
          const named = ids.size ? (byMemo(live) ?? byMemo(lateOnes)) : undefined
          if (named) { await record(named); return }
        }

        // 1) Exact amount.
        const exact = allowed.filter((i: any) => Math.abs(dueOf(i) - amount) <= 0.000001)
        if (exact.length === 1) { await record(exact[0]); return }
        if (exact.length > 1) { await park(exact, 'multiple_orders'); return }

        // 2) From the customer an order was made for: partial / split payment
        //    (less than due) or overpayment (more) - linked to that order.
        const theirs = live.filter((i: any) => custOf(i) === from)
        if (theirs.length === 1) { await record(theirs[0]); return }
        if (theirs.length > 1) { await park(theirs, 'amount_mismatch'); return }

        // 3) Anyone else, within ±10% of what an order is due → merchant decides.
        const close = allowed
          .filter((i: any) => !custOf(i) && Math.abs(dueOf(i) - amount) <= Math.max(0.1 * dueOf(i), 0.01))
          .sort((a: any, b: any) => Math.abs(dueOf(a) - amount) - Math.abs(dueOf(b) - amount))
        if (close.length > 0) { await park(close, 'amount_mismatch'); return }

        // 4) No open order fits: one that expired within a day or was
        //    cancelled, for exactly this amount (or from its named customer),
        //    gets it - recorded late. Ambiguous → left as a plain transfer.
        const lateAllowed = lateOnes.filter((i: any) => { const cw = custOf(i); return !cw || cw === from })
        const lateExact = lateAllowed.filter((i: any) => Math.abs(dueOf(i) - amount) <= 0.000001)
        if (lateExact.length === 1) { await record(lateExact[0]); return }
        const lateTheirs = lateOnes.filter((i: any) => custOf(i) === from)
        if (lateExact.length === 0 && lateTheirs.length === 1) { await record(lateTheirs[0]); return }
        // 5) Nothing close - an ordinary transfer, not an order payment.
        }
        if (!known && !queued && !minted) await matchOrder()

        // Other chains: record the payment for the merchant (notified as
        // "Payment received on Base"; orders are named, so they aren't
        // notified twice). Moved to Arc by the merchant's Claim All.
        if (!isArc && merchantWallets.has(to)) {
          const { data: paid } = await db.from('merchant_payments').select('order_number').eq('source_chain', chainId).eq('tx_hash', tx).eq('merchant_wallet', to).maybeSingle()
          // Own transfer: the merchant sent USDC from Arc to this chain lately.
          let sender = from
          if (minted) {
            // Exactly this mint as the arrival of one of the merchant's own transfers…
            const { data: exact } = await db.from('activity').select('id')
              .eq('activity_type', 'bridge').eq('destination_tx_hash', tx).ilike('wallet_address', to).limit(1)
            // …or a recent own transfer to this chain (older rows without the arrival hash).
            const { data: own } = exact?.length ? { data: exact } : await db.from('activity').select('id')
              .eq('wallet_address', to).eq('activity_type', 'bridge')
              .in('destination_chain', [chainId, chainId === 'Polygon_Sepolia' ? 'Polygon_Amoy_Testnet' : chainId])
              .gte('created_at', new Date(Date.now() - OWN_TRANSFER_WINDOW_MS).toISOString()).limit(1)
            if (!own?.length) {
              // Held only with a known block time - an unreadable one must never stall the cursor.
              const b = await rpc(chain.rpcs, 'eth_getBlockByNumber', [log.blockNumber, false]).catch(() => null)
              const minedAt = b?.timestamp ? parseInt(b.timestamp, 16) * 1000 : NaN
              if (Number.isFinite(minedAt) && Date.now() - minedAt < OWN_TRANSFER_HOLD_MS) {
                const bn = parseInt(String(log.blockNumber), 16)
                if (Number.isFinite(bn)) holdBlock = holdBlock == null ? bn : Math.min(holdBlock, bn)
                continue
              }
            }
            sender = own?.length ? to : ZERO
          }
          const { data: already } = await db.from('merchant_chain_receipts').select('id')
            .eq('source_chain', chainId).eq('tx_hash', tx).eq('merchant_wallet', to).maybeSingle()
          if (!already) {
            const screenFlag = sender !== to ? await screenSender(chainId, sender) : null
            const { data: added } = await db.from('merchant_chain_receipts').upsert({
              merchant_wallet: to, source_chain: chainId, tx_hash: tx, from_address: sender, amount,
              order_number: paid?.order_number ?? null, screen_flag: screenFlag,
            }, { onConflict: 'source_chain,tx_hash,merchant_wallet', ignoreDuplicates: true }).select('id')
            // An order payment was already flagged (and notified) by recordPayment.
            if (screenFlag && added?.length && !paid) {
              const m = screenMsg(screenFlag)
              await notifyMerchant(to, 'merchant_payment_screened', m.title,
                `${usd2(amount)} USDC on ${chain.label} came from ${short(sender)}, which ${m.why}. Check before you hand over goods or refund.`)
            }
          }
        }
      }
      // A held mint's block is read again next run (every write above is idempotent).
      await db.from('merchant_deposit_cursors').upsert({ chain: chainId, last_block: holdBlock != null ? holdBlock - 1 : toBlock, updated_at: new Date().toISOString() })
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
    // Signed-in MeshPort users only (the in-app scanner) - open order codes
    // must not be enumerable by anyone walking amounts for a public wallet.
    const finder = await caller(req)
    if (!finder?.userId) return jsonFor(req, { order: null })
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
      if (i.status === 'cancelled') return jsonFor(req, { error: 'This order was cancelled.' }, 409)
      if (!dep || dep.status !== 'needs_review' || dep.merchant_wallet !== String(i.merchant_wallet).toLowerCase()) return jsonFor(req, { error: 'Deposit not found' }, 404)
      const out: any = await recordPayment(req, i, dep.source_chain, dep.tx_hash, who, { orderNumber: null, amount: null }, 'merchant')
      if (out.error) return jsonFor(req, { error: out.error }, out.status ?? 400)
      if (out.pending) return jsonFor(req, { error: 'Not confirmed on-chain yet - try again shortly' }, 409)
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
      if (st === 'paid') return jsonFor(req, { error: `${orderName(i)} is already completed.` }, 409)
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
      // The owner, or the active staff member who made this charge (staff mode
      // shows Cancel payment on their own charges).
      const ownStaffCharge = !!who?.authUid && who.authUid === i.created_by_staff
        && !!(await db.from('business_staff').select('id').eq('owner_auth_uid', i.merchant_auth_uid)
          .eq('staff_auth_uid', who.authUid).eq('status', 'active').maybeSingle()).data
      if (who?.authUid !== i.merchant_auth_uid && !ownStaffCharge) return jsonFor(req, { error: 'Not found' }, 404)
      if (!['pending', 'expired'].includes(effectiveStatus(i)) || Number(i.received_amount) > 0) return jsonFor(req, { error: 'A payment was already made on this request.' }, 409)
      await db.from('merchant_payment_intents').update({ status: 'cancelled' }).eq('id', i.id)
      return jsonFor(req, publicView({ ...i, status: 'cancelled' }, []))
    }

    if (action === 'reopen') {
      // Owner only. The order is open again with no expiry; what was paid on
      // it (late payments included) is counted, so a sale paid after a
      // cancel becomes paid / part paid instead of only refundable.
      // Refused once anything on it was refunded: those payments are no
      // longer the merchant's to count.
      const who = await caller(req)
      if (who?.authUid !== i.merchant_auth_uid) return jsonFor(req, { error: 'Not found' }, 404)
      const st = effectiveStatus(i)
      const pastExpiry = !!i.expires_at && new Date(i.expires_at).getTime() < Date.now()
      if (!(st === 'cancelled' || st === 'expired' || (pastExpiry && (st === 'pending' || st === 'partially_paid')))) {
        return jsonFor(req, { error: `${orderName(i)} is still open.` }, 409)
      }
      const { data: refunded } = await db.from('merchant_refunds').select('id').eq('intent_id', i.id).limit(1)
      if (refunded?.length) return jsonFor(req, { error: `Money on ${orderName(i)} was refunded - create a new order instead.` }, 409)
      // Only from the state just read, so a concurrent cancel / reopen can't be undone.
      const { data: moved } = await db.from('merchant_payment_intents').update({ status: 'pending', expires_at: null })
        .eq('id', i.id).eq('status', i.status).select('id')
      if (!moved?.length) return jsonFor(req, { error: 'This order just changed - refresh and try again.' }, 409)
      const { error: rcErr } = await db.rpc('merchant_intent_recompute', { p_intent: i.id })
      if (rcErr) throw rcErr
      const fresh = await loadIntent(code)
      return jsonFor(req, publicView(fresh, await loadPayments(i.id)))
    }

    return jsonFor(req, { error: 'Unknown action' }, 400)
  } catch (e) {
    console.error('[merchant-pay]', e instanceof Error ? e.message : e)
    return jsonFor(req, { error: 'Something went wrong - try again' }, 500)
  }
})
