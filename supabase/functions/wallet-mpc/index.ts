// supabase/functions/wallet-mpc/index.ts
//
// HTTP entry for MeshPort's side of the MPC wallet (logic.ts). One POST
// endpoint, JSON body { action, ... }, caller = the signed-in Supabase user:
//
//   keygen-begin   {}                         → { sid, out, token }
//   keygen-step    { token, msgs }            → { out, token } | { address }
//   sign-begin     { with, request }          → { signId, hash, address, out, token }
//   sign-step      { token, msgs }            → { out, token }
//
// sign-begin's `request` is what to sign - never a bare hash: the server
// computes the hash itself, so it knows (and logs) what it co-signs:
//   { kind: 'tx', tx: <unsigned serialized transaction> }
//   { kind: 'message', message: string | { raw: hex } }
//   { kind: 'typed', typedData: { domain, types, primaryType, message } }
//
// TESTNET ONLY: transactions and typed data must be for a known testnet.
// Secrets: MPC_SECRET (64 hex chars) - derives the sealing keys.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { hashMessage, hashTypedData, keccak256, parseTransaction, type Hex } from 'npm:viem@2'
import { loadMpc, type Mpc } from '../_shared/mpc/wasm.ts'
import { MPC_WASM_BASE64 } from '../_shared/mpc/wasmBytes.ts'
import { BACKUP, PHONE, type PartyNo } from '../_shared/mpc/protocol.ts'
import { createMpcService, MpcServiceError, type MpcRepo, type MpcService } from './logic.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

// Arc testnet, and the testnets MeshPort bridges with.
const TESTNET_CHAIN_IDS = new Set([5042002, 11155111, 84532, 421614, 11155420, 43113, 80002])

function getServiceRoleKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (legacy) return legacy
  const secretKeysRaw = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (secretKeysRaw) {
    try {
      const parsed = JSON.parse(secretKeysRaw)
      const candidate = parsed?.service_role ?? parsed?.SUPABASE_SERVICE_ROLE_KEY ?? Object.values(parsed ?? {})[0]
      if (typeof candidate === 'string' && candidate) return candidate
    } catch { /* fall through to the error below */ }
  }
  throw new Error('No Supabase service role key found -- checked SUPABASE_SERVICE_ROLE_KEY and SUPABASE_SECRET_KEYS.')
}

const db = createClient(Deno.env.get('SUPABASE_URL')!, getServiceRoleKey())

const repo: MpcRepo = {
  async activeShare(authUid) {
    const { data, error } = await db.from('wallet_mpc_shares')
      .select('address, share_ct').eq('auth_uid', authUid).is('revoked_at', null).maybeSingle()
    if (error) throw error
    return data ? { address: data.address, shareCt: data.share_ct } : null
  },
  async saveShare(authUid, address, shareCt) {
    const { error } = await db.from('wallet_mpc_shares').insert({ auth_uid: authUid, address, share_ct: shareCt })
    if (error?.code === '23505') return 'exists'
    if (error) throw error
    return 'saved'
  },
  async logSign(e) {
    const { error } = await db.from('wallet_mpc_sign_log').insert({
      auth_uid: e.authUid, address: e.address, sign_id: e.signId, hash: e.hash, kind: e.kind, summary: e.summary,
    })
    if (error) throw error
  },
}

let service: Promise<MpcService> | null = null
function getService(): Promise<MpcService> {
  if (service) return service
  const hex = (Deno.env.get('MPC_SECRET') ?? '').trim()
  if (!/^[0-9a-fA-F]{64,}$/.test(hex)) throw new MpcServiceError('bad-request', 'MPC wallet is not configured')
  const secret = Uint8Array.from(hex.match(/../g)!, b => parseInt(b, 16))
  const bytes = Uint8Array.from(atob(MPC_WASM_BASE64), c => c.charCodeAt(0))
  service = loadMpc(bytes).then((mpc: Mpc) => createMpcService({ mpc, repo, secret }))
  service.catch(() => { service = null })
  return service
}

async function callerUid(req: Request): Promise<string | null> {
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!jwt) return null
  try {
    const { data } = await db.auth.getUser(jwt)
    return data?.user?.id ?? null
  } catch { return null }
}

/** The hash the server will co-sign, computed here from what is being signed. */
// deno-lint-ignore no-explicit-any
function hashFor(request: any): { hash: Hex; kind: string; summary: unknown } {
  const bad = (m: string) => { throw new MpcServiceError('bad-request', m) }
  if (request?.kind === 'tx') {
    if (typeof request.tx !== 'string' || !/^0x[0-9a-fA-F]+$/.test(request.tx)) bad('tx must be a serialized transaction')
    const tx = parseTransaction(request.tx as Hex)
    if (tx.r || tx.s) bad('Send the unsigned transaction')
    if (!tx.chainId || !TESTNET_CHAIN_IDS.has(tx.chainId)) bad('MPC wallet signs testnet transactions only')
    return {
      hash: keccak256(request.tx as Hex),
      kind: 'tx',
      summary: { chainId: tx.chainId, to: tx.to ?? null, value: String(tx.value ?? 0n), nonce: tx.nonce ?? null, selector: tx.data?.slice(0, 10) ?? null },
    }
  }
  if (request?.kind === 'message') {
    const m = request.message
    if (typeof m !== 'string' && !(m && typeof m.raw === 'string')) bad('message must be text or { raw }')
    return { hash: hashMessage(m), kind: 'message', summary: { length: typeof m === 'string' ? m.length : (m.raw.length - 2) / 2 } }
  }
  if (request?.kind === 'typed') {
    const t = request.typedData
    const chainId = Number(t?.domain?.chainId)
    if (!TESTNET_CHAIN_IDS.has(chainId)) bad('MPC wallet signs testnet typed data only')
    return { hash: hashTypedData(t), kind: 'typed', summary: { chainId, primaryType: t.primaryType, verifyingContract: t.domain?.verifyingContract ?? null } }
  }
  return bad('Unknown request kind')
}

const STATUS: Record<MpcServiceError['code'], number> = { 'bad-request': 400, 'no-wallet': 404, exists: 409, expired: 410, protocol: 422 }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  const uid = await callerUid(req)
  if (!uid) return json({ error: 'Sign in first' }, 401)
  try {
    const body = await req.json()
    const svc = await getService()
    switch (body?.action) {
      case 'keygen-begin': return json(await svc.keygenBegin(uid))
      case 'keygen-step': return json(await svc.keygenStep(uid, String(body.token ?? ''), body.msgs))
      case 'sign-begin': {
        const withParty = Number(body.with) as PartyNo
        if (withParty !== PHONE && withParty !== BACKUP) return json({ error: 'with must be 1 (phone) or 3 (backup)' }, 400)
        return json(await svc.signBegin(uid, { ...hashFor(body.request), with: withParty }))
      }
      case 'sign-step': return json(await svc.signStep(uid, String(body.token ?? ''), body.msgs))
      default: return json({ error: 'Unknown action' }, 400)
    }
  } catch (e) {
    if (e instanceof MpcServiceError) return json({ error: e.message, code: e.code }, STATUS[e.code])
    console.error('[wallet-mpc]', e instanceof Error ? e.message : e)
    return json({ error: 'MPC wallet error' }, 500)
  }
})
