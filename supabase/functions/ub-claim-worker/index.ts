// supabase/functions/ub-claim-worker/index.ts
//
// Finishes "Bring Funds via Unified Balance" claims on the server, so they
// land on Arc even if the phone is locked or the app is closed.
//
// The device already did the only steps that need the user's key:
//   1. deposited USDC into Gateway on the source chain, and
//   2. signed the Gateway burn intent (recipient = the user's own Arc wallet)
//      — stored as ub_claim_intents.transfer_body.
// This worker (pg_cron, every minute) waits until Gateway shows the deposit
// as confirmed, submits the signed intent to POST /v1/transfer with
// enableForwarder=true (Circle's forwarder mints on Arc — no relayer gas),
// then polls GET /v1/transfer/{id} and writes the Activity row.
//
// A signed intent can only ever move the user's own Gateway balance to the
// recipient inside the signed spec, so storing it holds no spending power
// beyond finishing this exact claim. No private key is involved.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const GATEWAY = 'https://gateway-api-testnet.circle.com'
const ARC_EXPLORER = 'https://testnet.arcscan.app'
const WAIT_LIMIT_MS = 24 * 60 * 60 * 1000 // give up waiting for a confirmed deposit after 24h
const MAX_ERRORS = 20

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

// Only the cron job (service-role JWT) may run the sweep. verify_jwt has
// already checked the signature; here we check the role claim.
function isServiceCaller(req: Request): boolean {
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const part = jwt.split('.')[1]
  if (!part) return false
  try {
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')))
    return json?.role === 'service_role'
  } catch { return false }
}

type Intent = { maxFee: string; spec: { sourceDomain: number; sourceDepositor: string; value: string; destinationRecipient: string } }

function intentsOf(body: any): Intent[] {
  const out: Intent[] = []
  for (const entry of Array.isArray(body) ? body : []) {
    if (entry?.burnIntent) out.push(entry.burnIntent)
    for (const i of entry?.burnIntentSet?.intents ?? []) out.push(i)
  }
  return out
}

const toAddress = (b32: string) => '0x' + String(b32).replace(/^0x/, '').slice(-40).toLowerCase()

async function gw(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; json: any }> {
  const r = await fetch(`${GATEWAY}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
  })
  const json = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, json }
}

/** true when every depositor's confirmed Gateway balance covers value + maxFee. */
async function depositConfirmed(intents: Intent[]): Promise<boolean> {
  const need = new Map<string, { domain: number; depositor: string; atomic: bigint }>()
  for (const i of intents) {
    const depositor = toAddress(i.spec.sourceDepositor)
    const key = `${i.spec.sourceDomain}:${depositor}`
    const cur = need.get(key) ?? { domain: Number(i.spec.sourceDomain), depositor, atomic: 0n }
    cur.atomic += BigInt(i.spec.value) + BigInt(i.maxFee ?? '0')
    need.set(key, cur)
  }
  const sources = [...need.values()].map(n => ({ domain: n.domain, depositor: n.depositor }))
  const res = await gw('/v1/balances', { method: 'POST', body: JSON.stringify({ token: 'USDC', sources }) })
  if (!res.ok) throw new Error(`balances http ${res.status}: ${JSON.stringify(res.json).slice(0, 200)}`)
  for (const n of need.values()) {
    const row = (res.json?.balances ?? []).find((b: any) =>
      Number(b.domain) === n.domain && String(b.depositor).toLowerCase() === n.depositor)
    // API returns a decimal string in USDC units.
    const [whole, frac = ''] = String(row?.balance ?? '0').split('.')
    const atomic = BigInt(whole || '0') * 1_000_000n + BigInt((frac + '000000').slice(0, 6))
    if (atomic < n.atomic) return false
  }
  return true
}

async function recordActivity(row: any, mintTx: string | null) {
  const key = row.deposit_tx ? String(row.deposit_tx).toLowerCase() : `ubclaim_${row.id}`
  const amount = Number(row.send_amount ?? row.amount)
  const sourceChain = row.source_chain === 'Polygon_Amoy_Testnet' ? 'Polygon_Sepolia' : row.source_chain
  const { error } = await db.from('activity').upsert({
    wallet_address:      String(row.wallet_address).toLowerCase(),
    tx_hash:             key,
    destination_tx_hash: mintTx ? mintTx.toLowerCase() : null,
    activity_type:       'claim',
    amount,
    usd_value:           amount,
    arrived_amount:      amount,
    token_symbol:        'USDC',
    source_chain:        sourceChain,
    destination_chain:   'Arc_Testnet',
    status:              'completed',
    explorer_url:        mintTx ? `${ARC_EXPLORER}/tx/${mintTx}` : null,
    metadata:            {
      route: 'ub', claimed_amount: Number(row.amount), ub_intent_id: row.id, server_finished: true,
      ...(row.merchant ? { merchant: true } : {}),
      ...(row.auto_convert ? { auto_convert: true, chains: row.source_chains ?? [] } : {}),
    },
  }, { onConflict: 'tx_hash,wallet_address', ignoreDuplicates: true })
  if (error) console.error('[ub-claim-worker] activity write failed', row.id, error.message)
}

async function processWaiting(row: any) {
  // Merchant auto-convert: the combined Ledger → Arc transfer is signed at
  // the deposit run and submitted at its scheduled time (an hour later).
  if (row.not_before && new Date(row.not_before).getTime() > Date.now()) return 'scheduled'
  const intents = intentsOf(row.transfer_body)
  if (intents.length === 0) {
    await db.from('ub_claim_intents').update({ status: 'failed', last_error: 'No burn intent in body' }).eq('id', row.id)
    return 'failed'
  }
  if (!(await depositConfirmed(intents))) {
    const since = Math.max(new Date(row.created_at).getTime(), row.not_before ? new Date(row.not_before).getTime() : 0)
    if (Date.now() - since > WAIT_LIMIT_MS) {
      // Funds (if any) are still in the user's Unified Balance; the app's
      // auto-finish / Recover takes over.
      await db.from('ub_claim_intents').update({ status: 'expired', last_error: 'Deposit never confirmed within 24h' }).eq('id', row.id)
      return 'expired'
    }
    return 'waiting'
  }
  const res = await gw('/v1/transfer?enableForwarder=true', { method: 'POST', body: JSON.stringify(row.transfer_body) })
  const transferId = res.json?.transferId
  if (res.ok && transferId) {
    await db.from('ub_claim_intents').update({ status: 'submitted', transfer_id: transferId, last_error: null }).eq('id', row.id)
    return 'submitted'
  }
  const msg = `transfer http ${res.status}: ${JSON.stringify(res.json).slice(0, 300)}`
  const attempts = (row.attempts ?? 0) + 1
  await db.from('ub_claim_intents').update({
    attempts, last_error: msg, ...(attempts >= MAX_ERRORS ? { status: 'failed' } : {}),
  }).eq('id', row.id)
  return 'error'
}

async function processSubmitted(row: any) {
  const res = await gw(`/v1/transfer/${encodeURIComponent(row.transfer_id)}`)
  if (!res.ok) return 'pending'
  const status = String(res.json?.status ?? '')
  const mintTx = typeof res.json?.transactionHash === 'string' ? res.json.transactionHash : null
  if (status === 'finalized' || (status === 'confirmed' && mintTx)) {
    await db.from('ub_claim_intents').update({ status: 'completed', mint_tx: mintTx, completed_at: new Date().toISOString(), last_error: null })
      .eq('id', row.id).neq('status', 'completed')
    await recordActivity(row, mintTx)
    return 'completed'
  }
  if (status === 'failed' || status === 'expired') {
    const reason = res.json?.forwardingDetails?.failureReason ?? status
    await db.from('ub_claim_intents').update({ status: 'failed', last_error: `Gateway transfer ${reason}` }).eq('id', row.id)
    return 'failed'
  }
  return 'pending'
}

Deno.serve(async (req: Request) => {
  if (!isServiceCaller(req)) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
  const { data: rows, error } = await db.from('ub_claim_intents')
    .select('*').in('status', ['waiting', 'submitted'])
    .order('created_at', { ascending: true }).limit(50)
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 })

  const results: Record<string, string> = {}
  for (const row of rows ?? []) {
    try {
      results[row.id] = row.status === 'waiting' ? await processWaiting(row) : await processSubmitted(row)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      results[row.id] = `error: ${msg}`
      await db.from('ub_claim_intents').update({ last_error: msg.slice(0, 300) }).eq('id', row.id)
    }
  }
  return new Response(JSON.stringify({ processed: rows?.length ?? 0, results }), { headers: { 'Content-Type': 'application/json' } })
})
