// business-direct (28 Nov): every payment into a business is a business
// payment, like Paytm for Business - its Shop QR, its username, its wallet
// address all pay the shop. USDC that lands in an approved business's Arc
// wallet without paying an order (sent by username or address, from
// MeshPort or any wallet) is checked on-chain and recorded as a Shop QR
// payment marked direct (merchant_record_direct): "Received on <shop>"
// alert and voice, the Payments list, totals, reports, refunds.
//
// Runs every minute (cron) and looks every 5 s for about 55 s. A receive is
// left 15 s first, so an order's own match (merchant-pay) always wins. Not
// counted: the business's own moves (Unified Balance, CCTP, swaps, BulkPay,
// P2P escrow) and MeshPortCheckout payouts (those always pay an order).
//
// POST {} (cron) · POST { backfill: true, days: 30 } (older ones, quietly,
// on their own dates).
//
// Self-contained on purpose (no shared imports), so it deploys as this one file.
import { createClient } from 'jsr:@supabase/supabase-js@2'

function serviceKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (legacy) return legacy
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (raw) {
    try {
      const p = JSON.parse(raw)
      const k = p?.service_role ?? p?.SUPABASE_SERVICE_ROLE_KEY ?? Object.values(p ?? {})[0]
      if (typeof k === 'string' && k) return k
    } catch { /* fall through */ }
  }
  throw new Error('No Supabase service role key found')
}
const db = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey())

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}
function isCron(req: Request): boolean {
  const t = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!t) return false
  return [Deno.env.get('CRON_SECRET') ?? '', Deno.env.get('LEGACY_CRON_SECRET') ?? ''].some(s => !!s && same(t, s))
}

const DRPC_KEY = Deno.env.get('DRPC_KEY') ?? ''
const ARC_RPCS = [
  ...((Deno.env.get('ARC_RPC_URL') ?? '').trim() ? [(Deno.env.get('ARC_RPC_URL') ?? '').trim()] : []),
  ...(DRPC_KEY ? [`https://lb.drpc.live/arc-testnet/${DRPC_KEY}`] : []),
  'https://rpc.testnet.arc.io',
  'https://rpc.blockdaemon.testnet.arc.io',
  'https://rpc.drpc.testnet.arc.io',
  'https://rpc.quicknode.testnet.arc.io',
]
const ARC_USDC = '0x3600000000000000000000000000000000000000'
// Arc's native USDC moves are logged as Transfer by the EIP-7708 emitter
// (18 decimals); blocks before the Zero5 fork used the legacy event.
const ARC_NATIVE_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ARC_LEGACY_AUTHORITY = '0x1800000000000000000000000000000000000000'
const ARC_LEGACY_TOPIC = '0x62f084c00a442dcf51cdbb51beed2839bf42a268da8474b0e98f38edb7db5a22'
const ZERO = '0x0000000000000000000000000000000000000000'
// A payment sent with an order attached (Arc memo) is that order's - left to merchant-pay.
const ARC_MEMO_CONTRACT = '0x5294e9927c3306dcbadb03fe70b92e01ccede505'
const MEMO_TOPIC = '0xeb15ee720798341c37739df41be53acfbbf70ae6802dade35457beec6e47a5e4'
const namesAnOrder = (receipt: any) => (receipt?.logs ?? []).some((l: any) =>
  String(l.address).toLowerCase() === ARC_MEMO_CONTRACT && String(l.topics?.[0]).toLowerCase() === MEMO_TOPIC)

// Never a customer paying: MeshPort's own contracts (same list as
// _shared/knownInternalContracts.ts), Gateway (Unified Balance), the P2P
// escrow, and MeshPortCheckout (its payouts always pay an order).
const NOT_A_CUSTOMER = new Set([
  ZERO,
  '0x0077777d7eba4688bdef3e311b846f25870a19b9',
  '0x0022222abe238cc2c7bb1f21003f0a260052475b',
  '0x9f3b8679c73c2fef8b59b4f3444d4e156fb70aa5',
  '0x7865fafc2db2093669d92c0f33aeef291086befd',
  '0xacf1ceef35caac005e15888ddb8a3515c41b4872',
  '0xc5567a5e3370d4dbfb0540025078e283e36a363d',
  '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b',
  '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',
  '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
  '0xca11bde05977b3631167028862be2a173976ca11',
  '0x5f88b9edc2d6805ea7a6975aeb151ceebb334022',
  ...[Deno.env.get('P2P_ESCROW_CONTRACT') ?? '', ...(Deno.env.get('P2P_ESCROW_CONTRACTS_LEGACY') ?? '').split(','),
    Deno.env.get('MESHPORT_CHECKOUT') ?? ''].map(s => s.trim().toLowerCase()).filter(Boolean),
])

const errText = (e: unknown) => e instanceof Error ? e.message : typeof e === 'object' ? JSON.stringify(e) : String(e)
async function rpc(method: string, params: unknown[], timeoutMs = 6000): Promise<any> {
  const errs: string[] = []
  for (const url of ARC_RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) })
      const j = await r.json()
      if (j.error) { errs.push(errText(j.error)); continue }
      return j.result
    } catch (e) { errs.push(errText(e)) }
  }
  throw new Error(errs.join(' | ') || `${method} failed`)
}

/** USDC this transaction moved into `to` on Arc (6-decimal amount) and who sent it. */
function paidInto(receipt: any, to: string): { amount: number; from: string | null } {
  const want = '0x' + to.replace(/^0x/, '').toLowerCase().padStart(64, '0')
  const sum = (emitter: string, topic: string) => {
    let atomic = 0n
    let from: string | null = null
    for (const log of receipt?.logs ?? []) {
      if (String(log.address).toLowerCase() !== emitter || String(log.topics?.[0]).toLowerCase() !== topic) continue
      if (String(log.topics?.[2]).toLowerCase() !== want) continue
      try { atomic += BigInt(log.data) } catch { continue }
      from = from ?? ('0x' + String(log.topics?.[1]).slice(-40)).toLowerCase()
    }
    return { amount: Number(atomic / 1_000_000_000_000n) / 1e6, from }
  }
  const now = sum(ARC_NATIVE_EMITTER, TRANSFER_TOPIC)
  return now.amount > 0 ? now : sum(ARC_LEGACY_AUTHORITY, ARC_LEGACY_TOPIC)
}

/** USDC's own blocklist (isBlacklisted) for the sender - flagged, still recorded. */
async function blocklisted(addr: string): Promise<string | null> {
  const data = '0xfe575a87' + addr.replace(/^0x/, '').toLowerCase().padStart(64, '0')
  const r = await rpc('eth_call', [{ to: ARC_USDC, data }, 'latest']).catch(() => null)
  return typeof r === 'string' && /^0x[0-9a-f]+$/i.test(r) && BigInt(r) !== 0n ? 'usdc_blocklisted' : null
}

const seen = (tx: string, wallet: string, result: string) =>
  db.from('business_direct_seen').upsert({ tx_hash: tx, merchant_wallet: wallet, result }, { onConflict: 'tx_hash,merchant_wallet', ignoreDuplicates: true })

async function pass(opts: { since: Date; quiet: boolean; limit: number }) {
  const { data, error } = await db.rpc('business_direct_candidates', {
    p_since: opts.since.toISOString(), p_min_age: '15 seconds', p_limit: opts.limit,
  })
  if (error) throw new Error(`candidates: ${error.message}`)
  let recorded = 0, skipped = 0
  for (const c of (data ?? []) as Array<{ wallet: string; tx: string; amount: number; at: string }>) {
    const receipt = await rpc('eth_getTransactionReceipt', [c.tx]).catch(() => null)
    if (!receipt) continue // not readable yet - next pass
    if (receipt.status !== '0x1') { await seen(c.tx, c.wallet, 'failed'); skipped++; continue }
    if (namesAnOrder(receipt)) { await seen(c.tx, c.wallet, 'order_memo'); skipped++; continue }
    const { amount, from } = paidInto(receipt, c.wallet)
    if (!(amount > 0) || !from) { await seen(c.tx, c.wallet, 'no_transfer'); skipped++; continue }
    if (from === c.wallet || NOT_A_CUSTOMER.has(from)) { await seen(c.tx, c.wallet, 'own_or_internal'); skipped++; continue }
    const screen = await blocklisted(from)
    const { data: out, error: rErr } = await db.rpc('merchant_record_direct', {
      p_wallet: c.wallet, p_tx: c.tx, p_from: from, p_amount: amount, p_screen: screen,
      p_at: opts.quiet ? c.at : null, p_quiet: opts.quiet,
    })
    if (rErr) { console.error('[business-direct] record', c.tx, rErr.message); continue }
    if (out === 'recorded') recorded++
    else { await seen(c.tx, c.wallet, String(out)); skipped++ }
  }
  return { checked: (data ?? []).length, recorded, skipped }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  if (!isCron(req)) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
  let body: any = {}
  try { body = await req.json() } catch { /* cron sends {} */ }

  if (body?.backfill === true) {
    const days = Math.min(Math.max(Number(body.days) || 30, 1), 90)
    const out = await pass({ since: new Date(Date.now() - days * 86400_000), quiet: true, limit: 500 })
    return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } })
  }

  // Live: payments from the last hour (older ones only by backfill), every 5 s for ~55 s.
  const work = (async () => {
    const end = Date.now() + 55_000
    while (Date.now() < end) {
      const t0 = Date.now()
      try {
        const r = await pass({ since: new Date(Date.now() - 3600_000), quiet: false, limit: 50 })
        if (r.recorded) console.info('[business-direct]', JSON.stringify(r))
      } catch (e) { console.error('[business-direct]', errText(e)) }
      const wait = 5000 - (Date.now() - t0)
      if (Date.now() + Math.max(wait, 0) >= end) break
      if (wait > 0) await new Promise(r => setTimeout(r, wait))
    }
  })()
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime
  if (rt?.waitUntil) { rt.waitUntil(work); return new Response(JSON.stringify({ started: true }), { headers: { 'Content-Type': 'application/json' } }) }
  await work
  return new Response(JSON.stringify({ done: true }), { headers: { 'Content-Type': 'application/json' } })
})
