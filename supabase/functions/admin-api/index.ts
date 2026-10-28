// admin-api - the one server entry point for the admin console.
//
// Every request: a valid Supabase session → a row in public.admin_users →
// that row's role allows the action → (when ADMIN_REQUIRE_MFA=true) the
// session passed 2FA (aal2). Anything that changes data writes one row to
// public.admin_audit_log in the same request, with the admin's reason.
//
// Reads the canonical data directly (service role) - nothing here keeps its
// own copy:
//   tx.*      activity (user-facing history, incl. failure reasons),
//             transaction_intents / transaction_attempts (server records),
//             ledger_events, client_errors, and the chain itself (receipt)
//   rpc.*     probes ARC_RPCS / ARC_PUBLIC_RPCS / CHAIN_RPCS (_shared/chains)
//             and reads rpc_usage (written by /api/arc-rpc)
//   logs.list admin_audit_log + settings_logs + admin_recovery_log +
//             p2p_trade_audit_log, merged
//   admins.*  admin_users (+ auth: last sign-in, 2FA set up)

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { handleOptionsFor, jsonFor } from '../_shared/cors.ts'
import { ARC_RPCS, ARC_PUBLIC_RPCS, CHAIN_RPCS } from '../_shared/chains.ts'

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
const REQUIRE_MFA = (Deno.env.get('ADMIN_REQUIRE_MFA') ?? '').trim() === 'true'

// ── Roles ─────────────────────────────────────────────────────────────────
type Role = 'owner' | 'operations' | 'support' | 'viewer'
const ROLES: Role[] = ['owner', 'operations', 'support', 'viewer']
const ALL: Role[] = ROLES
const CAN: Record<string, Role[]> = {
  'me':            ALL,
  'tx.list':       ALL,
  'tx.stats':      ALL,
  'tx.detail':     ALL,
  'rpc.health':    ALL,
  'rpc.usage':     ALL,
  'errors.list':   ALL,
  'logs.list':     ALL,
  'admins.list':   ['owner'],
  'admins.setRole': ['owner'],
}

type Admin = { id: string; email: string | null; role: Role; aal: string; ip: string | null; ua: string | null }

function jwtClaims(jwt: string): Record<string, unknown> {
  try {
    const part = jwt.split('.')[1] ?? ''
    return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')))
  } catch { return {} }
}

async function identify(req: Request): Promise<Admin | null> {
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!jwt) return null
  const { data } = await db.auth.getUser(jwt)
  const uid = data?.user?.id
  if (!uid) return null
  const { data: a } = await db.from('admin_users').select('*').eq('id', uid).maybeSingle()
  if (!a) return null
  // No role column yet (migration not applied) = today's all-powerful admin.
  const role = a.role === undefined ? 'owner' : (ROLES as string[]).includes(String(a.role)) ? (a.role as Role) : 'viewer'
  return {
    id: uid,
    email: (a.email as string | null) ?? data.user?.email ?? null,
    role,
    aal: String(jwtClaims(jwt).aal ?? 'aal1'),
    ip: (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || null,
    ua: (req.headers.get('user-agent') ?? '').slice(0, 300) || null,
  }
}

async function audit(a: Admin, action: string, targetType: string, targetId: string, reason: string, before: unknown, after: unknown) {
  const { error } = await db.from('admin_audit_log').insert({
    admin_id: a.id, admin_email: a.email, admin_role: a.role, action,
    target_type: targetType, target_id: targetId, reason,
    before: before ?? null, after: after ?? null, ip: a.ip, user_agent: a.ua,
  })
  // A change that can't be recorded must not look like it went through.
  if (error) throw new Error(`audit log write failed: ${error.message}`)
}

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const isAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s)
const isHash = (s: string) => /^0x[0-9a-fA-F]{64}$/.test(s)
const baseHash = (h: string | null | undefined) => String(h ?? '').replace(/^(send_|recv_)/, '').toLowerCase()

const RANGES: Record<string, number> = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 }
const since = (range: unknown, dflt = '24h') => new Date(Date.now() - (RANGES[String(range)] ?? RANGES[dflt])).toISOString()

// ── Transactions ──────────────────────────────────────────────────────────
async function walletNames(wallets: string[]) {
  const list = [...new Set(wallets.filter(Boolean).map(w => w.toLowerCase()))]
  if (!list.length) return {}
  const { data } = await db.rpc('admin_wallet_names', { p_wallets: list })
  const out: Record<string, { username: string | null; display_name: string | null; user_id: string; auth_uid: string | null }> = {}
  for (const r of (data ?? []) as any[]) out[r.wallet] = { username: r.username, display_name: r.display_name, user_id: r.user_id, auth_uid: r.auth_uid }
  return out
}

/** A search box value → the filter it means: wallet, tx hash or username. */
async function resolveQuery(q: string): Promise<{ wallets?: string[]; hash?: string; none?: boolean }> {
  if (!q) return {}
  if (isAddr(q)) return { wallets: [q.toLowerCase()] }
  if (isHash(q) || /^(send_|recv_)0x[0-9a-fA-F]{64}$/.test(q)) return { hash: baseHash(q) }
  const name = q.replace(/^@/, '').replace(/\.arc$/i, '').toLowerCase()
  const { data } = await db.from('users').select('wallet_address').ilike('username', name).limit(5)
  const wallets = (data ?? []).map((r: any) => String(r.wallet_address ?? '').toLowerCase()).filter(Boolean)
  return wallets.length ? { wallets } : { none: true }
}

async function txList(b: Record<string, unknown>) {
  const q = await resolveQuery(str(b.q, 120))
  if (q.none) return { rows: [], names: {}, next: null }
  const limit = Math.min(Math.max(Number(b.limit) || 50, 1), 200)
  const { data, error } = await db.rpc('admin_tx_search', {
    p_kind: str(b.kind, 20) || null,
    p_status: str(b.status, 20) || null,
    p_wallets: q.wallets ?? null,
    p_hash: q.hash ?? null,
    p_from: str(b.from, 40) || null,
    p_to: str(b.to, 40) || null,
    p_before: str(b.before, 40) || null,
    p_limit: limit,
  })
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as any[]
  const names = await walletNames(rows.flatMap(r => [r.wallet_address, r.counterparty_address]))
  return { rows, names, next: rows.length === limit ? rows[rows.length - 1].created_at : null }
}

async function txStats(b: Record<string, unknown>) {
  const { data, error } = await db.rpc('admin_tx_stats', { p_since: since(b.range) })
  if (error) throw new Error(error.message)
  return data
}

async function arcReceipt(hash: string) {
  const urls = [...ARC_RPCS, ...ARC_PUBLIC_RPCS]
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }),
        signal: AbortSignal.timeout(4000),
      })
      if (!r.ok) continue
      const j = await r.json()
      if (j.error) continue
      const rc = j.result
      if (!rc) return { found: false }
      return {
        found: true,
        status: rc.status === '0x1' ? 'success' : 'reverted',
        block: parseInt(rc.blockNumber, 16),
        gasUsed: parseInt(rc.gasUsed, 16),
        from: rc.from, to: rc.to,
      }
    } catch { /* next endpoint */ }
  }
  return { found: null } // couldn't ask the chain
}

async function txDetail(b: Record<string, unknown>) {
  const id = str(b.id, 80)
  if (!id) throw new Error('id required')
  const { data: row, error } = await db.from('activity').select('*').eq('id', id).maybeSingle()
  if (error) throw new Error(error.message)
  if (!row) return { row: null }

  const hash = baseHash(row.tx_hash)
  const failedHash = String(row.metadata?.failed_tx_hash ?? '').toLowerCase()
  const hashes = [...new Set([hash, failedHash, String(row.destination_tx_hash ?? '').toLowerCase()].filter(isHash))]

  // The payee's / payer's copy of the same in-app payment.
  const twinKey = String(row.tx_hash).startsWith('send_') ? `recv_${String(row.tx_hash).slice(5)}`
    : String(row.tx_hash).startsWith('recv_') ? `send_${String(row.tx_hash).slice(5)}` : null
  const twin = twinKey ? (await db.from('activity').select('id, wallet_address, status, created_at').eq('tx_hash', twinKey).maybeSingle()).data : null

  // Server-side record: intent ← attempt(s) with this hash.
  let attempts: any[] = []
  let intents: any[] = []
  if (hashes.length) {
    const { data: at } = await db.from('transaction_attempts').select('*').in('tx_hash', hashes)
    attempts = at ?? []
    const intentIds = [...new Set(attempts.map(a => a.intent_id))]
    if (intentIds.length) {
      const { data: it } = await db.from('transaction_intents').select('*').in('id', intentIds)
      intents = it ?? []
      const { data: all } = await db.from('transaction_attempts').select('*').in('intent_id', intentIds).order('created_at')
      attempts = all ?? attempts
    }
  }
  const ledger = hashes.length ? ((await db.from('ledger_events').select('*').in('tx_hash', hashes).order('created_at')).data ?? []) : []

  const names = await walletNames([row.wallet_address, row.counterparty_address])
  // App errors from the payer's device in the five minutes around it.
  const authUid = names[String(row.wallet_address ?? '').toLowerCase()]?.auth_uid
  let appErrors: any[] = []
  if (authUid) {
    const t = new Date(row.created_at).getTime()
    const { data: ce } = await db.from('client_errors').select('created_at, kind, path, message, build')
      .eq('auth_uid', authUid)
      .gte('created_at', new Date(t - 5 * 60e3).toISOString())
      .lte('created_at', new Date(t + 5 * 60e3).toISOString())
      .order('created_at').limit(20)
    appErrors = ce ?? []
  }

  // What the chain says right now (Arc only - other chains are on their explorers).
  const chainHash = hashes[0]
  const onArc = !row.source_chain || /arc/i.test(String(row.source_chain))
  const chain = chainHash && onArc ? await arcReceipt(chainHash) : null

  return { row, twin, intents, attempts, ledger, names, appErrors, chain }
}

// ── RPC health & usage ────────────────────────────────────────────────────
/** Host (and dRPC network) only - the key in the path never leaves here. */
function rpcLabel(url: string): { label: string; authenticated: boolean } {
  try {
    const u = new URL(url)
    if (u.host === 'lb.drpc.live') return { label: `lb.drpc.live/${u.pathname.split('/')[1] ?? ''}`, authenticated: true }
    if (u.host.endsWith('.g.alchemy.com') && u.pathname.startsWith('/v2/')) return { label: u.host, authenticated: true }
    return { label: u.host + (u.pathname.length > 1 && !/[0-9a-f]{16,}/i.test(u.pathname) ? u.pathname : ''), authenticated: false }
  } catch { return { label: 'rpc', authenticated: false } }
}

async function probe(url: string) {
  const started = Date.now()
  const call = async (method: string) => {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
      signal: AbortSignal.timeout(5000),
    })
    if (r.status === 429) throw Object.assign(new Error('rate limited (429)'), { rateLimited: true })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const j = await r.json()
    if (j.error) throw new Error(String(j.error.message ?? 'RPC error').slice(0, 120))
    return j.result
  }
  try {
    const [chainId, block] = await Promise.all([call('eth_chainId'), call('eth_blockNumber')])
    return { ok: true, latencyMs: Date.now() - started, chainId: parseInt(chainId, 16), block: parseInt(block, 16) }
  } catch (e) {
    const err = e as Error & { rateLimited?: boolean }
    return { ok: false, latencyMs: Date.now() - started, error: err.name === 'TimeoutError' ? 'timed out (5s)' : err.message, rateLimited: !!err.rateLimited }
  }
}

async function rpcHealth() {
  const groups: Record<string, string[]> = {
    Arc_Testnet: [...new Set([...ARC_RPCS, ...ARC_PUBLIC_RPCS])],
    ...CHAIN_RPCS,
  }
  const jobs = Object.entries(groups).flatMap(([chain, urls]) =>
    // A dRPC URL ending in "/" has no key configured - nothing to check.
    urls.filter(u => u && !(u.includes('lb.drpc.live') && u.endsWith('/')))
      .map(async url => ({ chain, ...rpcLabel(url), ...(await probe(url)) })))
  const results = await Promise.all(jobs)
  // How far behind the best endpoint of the same chain each one is.
  const head: Record<string, number> = {}
  for (const r of results) if (r.ok && typeof r.block === 'number') head[r.chain] = Math.max(head[r.chain] ?? 0, r.block)
  return {
    checkedAt: new Date().toISOString(),
    endpoints: results.map(r => ({ ...r, lag: r.ok && typeof r.block === 'number' ? head[r.chain] - r.block : null })),
  }
}

async function rpcUsage(b: Record<string, unknown>) {
  const from = since(b.range, '24h')
  const { data, error } = await db.from('rpc_usage').select('*').gte('bucket', from).order('bucket').limit(20000)
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as any[]
  const sum = (xs: any[]) => xs.reduce((s, r) => ({
    calls: s.calls + r.calls, ok: s.ok + r.ok, errors: s.errors + r.errors,
    rate_limited: s.rate_limited + r.rate_limited, cancelled: s.cancelled + r.cancelled,
    latency_ms_total: s.latency_ms_total + Number(r.latency_ms_total),
  }), { calls: 0, ok: 0, errors: 0, rate_limited: 0, cancelled: 0, latency_ms_total: 0 })
  const groupBy = (xs: any[], key: (r: any) => string) => {
    const m = new Map<string, any[]>()
    for (const r of xs) { const k = key(r); m.set(k, [...(m.get(k) ?? []), r]) }
    return [...m.entries()].map(([k, v]) => ({ key: k, ...sum(v) })).sort((a, z) => z.calls - a.calls)
  }
  const client = rows.filter(r => r.layer === 'client')
  const upstream = rows.filter(r => r.layer === 'upstream')
  return {
    from,
    totals: { client: sum(client), upstream: sum(upstream) },
    byEndpoint: groupBy(upstream, r => r.endpoint),
    byMethod: groupBy(client, r => r.method),
    series: groupBy(client, r => r.bucket).sort((a, z) => a.key.localeCompare(z.key)),
  }
}

async function errorsList(b: Record<string, unknown>) {
  const { data, error } = await db.from('client_errors').select('created_at, kind, path, message, build, auth_uid')
    .gte('created_at', since(b.range, '24h')).order('created_at', { ascending: false }).limit(1000)
  if (error) throw new Error(error.message)
  const groups = new Map<string, { message: string; kind: string; count: number; users: Set<string>; lastAt: string; paths: Set<string>; builds: Set<string> }>()
  for (const e of (data ?? []) as any[]) {
    const key = `${e.kind}|${String(e.message ?? '').slice(0, 200)}`
    const g = groups.get(key) ?? { message: String(e.message ?? ''), kind: e.kind, count: 0, users: new Set(), lastAt: e.created_at, paths: new Set(), builds: new Set() }
    g.count++
    if (e.auth_uid) g.users.add(e.auth_uid)
    if (e.path) g.paths.add(e.path)
    if (e.build) g.builds.add(e.build)
    groups.set(key, g)
  }
  return {
    total: (data ?? []).length,
    groups: [...groups.values()].sort((a, z) => z.count - a.count).slice(0, 100).map(g => ({
      message: g.message, kind: g.kind, count: g.count, users: g.users.size, lastAt: g.lastAt,
      paths: [...g.paths].slice(0, 5), builds: [...g.builds].slice(0, 5),
    })),
  }
}

// ── Admin logs (all trails, merged) ───────────────────────────────────────
async function logsList(b: Record<string, unknown>) {
  const source = str(b.source, 20) || 'all'
  const before = str(b.before, 40) || null
  const limit = 100
  const read = (source_: string, table: string, col: string, adminOnly = false) => {
    if (source !== 'all' && source !== source_) return null
    let q = db.from(table).select('*')
    if (adminOnly) q = q.eq('is_admin_actor', true)
    if (before) q = q.lt(col, before)
    return q.order(col, { ascending: false }).limit(limit)
  }
  const [adm, set, rec, p2p] = await Promise.all([
    read('admin', 'admin_audit_log', 'created_at'),
    read('settings', 'settings_logs', 'created_at'),
    read('recovery', 'admin_recovery_log', 'created_at'),
    read('p2p', 'p2p_trade_audit_log', 'occurred_at', true),
  ])
  const items = [
    ...((adm?.data ?? []) as any[]).map(r => ({ at: r.created_at, source: 'admin', who: r.admin_email, role: r.admin_role, action: r.action, target: [r.target_type, r.target_id].filter(Boolean).join(' '), reason: r.reason, before: r.before, after: r.after })),
    ...((set?.data ?? []) as any[]).map(r => ({ at: r.created_at, source: 'settings', who: r.changed_by, action: `setting ${r.feature}`, target: r.feature, before: r.old_value, after: r.new_value })),
    ...((rec?.data ?? []) as any[]).map(r => ({ at: r.created_at, source: 'recovery', who: r.admin_email, action: r.action, target: `${r.target_kind} ${r.target_id}`, after: r.result })),
    ...((p2p?.data ?? []) as any[]).map(r => ({ at: r.occurred_at, source: 'p2p', who: r.actor_id, action: r.action, target: `trade ${r.trade_id}`,
      before: { status: r.old_status, dispute: r.old_dispute_status, frozen: r.old_admin_frozen },
      after: { status: r.new_status, dispute: r.new_dispute_status, frozen: r.new_admin_frozen } })),
  ].sort((a, z) => String(z.at).localeCompare(String(a.at))).slice(0, limit)
  return { items, next: items.length === limit ? items[items.length - 1].at : null }
}

// ── Admins ────────────────────────────────────────────────────────────────
async function adminsList() {
  const { data, error } = await db.from('admin_users').select('*')
  if (error) throw new Error(error.message)
  const out = []
  for (const a of (data ?? []) as any[]) {
    const { data: u } = await db.auth.admin.getUserById(a.id)
    out.push({
      id: a.id, email: a.email ?? u?.user?.email ?? null, role: a.role ?? 'owner',
      lastSignInAt: u?.user?.last_sign_in_at ?? null,
      twoFactor: (u?.user?.factors ?? []).some((f: any) => f.status === 'verified'),
    })
  }
  return { admins: out }
}

async function adminsSetRole(a: Admin, b: Record<string, unknown>) {
  const id = str(b.id, 80), role = str(b.role, 20) as Role, reason = str(b.reason, 500)
  if (!id || !ROLES.includes(role)) throw new Error('id and a valid role are required')
  if (reason.length < 3) throw new Error('A reason is required')
  const { data: cur } = await db.from('admin_users').select('*').eq('id', id).maybeSingle()
  if (!cur) throw new Error('Admin not found')
  if (cur.role === role) return { ok: true, unchanged: true }
  if (cur.role === 'owner' && role !== 'owner') {
    const { count } = await db.from('admin_users').select('id', { count: 'exact', head: true }).eq('role', 'owner')
    if ((count ?? 0) <= 1) throw new Error('This is the last owner - make someone else owner first')
  }
  await audit(a, 'admin.set_role', 'admin', id, reason, { role: cur.role, email: cur.email }, { role, email: cur.email })
  const { error } = await db.from('admin_users').update({ role }).eq('id', id)
  if (error) throw new Error(error.message)
  return { ok: true }
}

// ── Router ────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  const preflight = handleOptionsFor(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return jsonFor(req, { error: 'Method not allowed' }, 405)

  let b: Record<string, unknown> = {}
  try { b = await req.json() } catch { /* validated below */ }
  const action = str(b.action, 40)

  const admin = await identify(req)
  if (!admin) return jsonFor(req, { error: 'Not an admin session' }, 401)
  if (REQUIRE_MFA && admin.aal !== 'aal2') return jsonFor(req, { error: 'mfa_required' }, 403)
  const allowed = CAN[action]
  if (!allowed) return jsonFor(req, { error: `Unknown action: ${action}` }, 400)
  if (!allowed.includes(admin.role)) return jsonFor(req, { error: `Your role (${admin.role}) can't do this` }, 403)

  try {
    switch (action) {
      case 'me':             return jsonFor(req, { id: admin.id, email: admin.email, role: admin.role, aal: admin.aal, mfaRequired: REQUIRE_MFA })
      case 'tx.list':        return jsonFor(req, await txList(b))
      case 'tx.stats':       return jsonFor(req, await txStats(b))
      case 'tx.detail':      return jsonFor(req, await txDetail(b))
      case 'rpc.health':     return jsonFor(req, await rpcHealth())
      case 'rpc.usage':      return jsonFor(req, await rpcUsage(b))
      case 'errors.list':    return jsonFor(req, await errorsList(b))
      case 'logs.list':      return jsonFor(req, await logsList(b))
      case 'admins.list':    return jsonFor(req, await adminsList())
      case 'admins.setRole': return jsonFor(req, await adminsSetRole(admin, b))
    }
    return jsonFor(req, { error: 'Unhandled action' }, 400)
  } catch (e) {
    console.error(`[admin-api] ${action} failed:`, e instanceof Error ? e.message : e)
    return jsonFor(req, { error: e instanceof Error ? e.message : 'Failed' }, 500)
  }
})
