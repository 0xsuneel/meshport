// api/solana-fee-payer.ts - MeshPort pays Solana network fees (docs/SOLANA.md).
//
// POST { transaction } - a Solana transaction (base64 wire format) whose fee
// payer is MeshPort's key and which the sender's Privy wallet has already
// signed. server/solana/feePayer.ts checks it (USDC transfers and opening USDC
// accounts only), MeshPort co-signs as fee payer, and it is sent to Solana
// devnet. → { signature, confirmed }. GET → { feePayer } (the address to use).
//
// Only signed-in Google / email accounts (Supabase session, not anonymous),
// rate-limited per account and per IP. Env: SOLANA_FEE_PAYER_SECRET (base58,
// 64-byte secret key; sensitive), SUPABASE_URL, SUPABASE_SERVICE_KEY.
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getBase64EncodedWireTransaction, getSignatureFromTransaction } from '@solana/kit'
import { checkFeePayerTransaction, coSign, FeePayerError, feePayerKeys } from '../server/solana/feePayer'

const SOLANA_RPC = 'https://api.devnet.solana.com'
const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim()
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()

let payer: Promise<{ keys: CryptoKeyPair; address: string }> | null = null
function getPayer() {
  if (!payer) {
    const secret = (process.env.SOLANA_FEE_PAYER_SECRET || '').trim()
    if (!secret) throw new Error('SOLANA_FEE_PAYER_SECRET is not set')
    payer = feePayerKeys(secret)
    payer.catch(() => { payer = null })
  }
  return payer
}

async function caller(req: VercelRequest): Promise<{ uid: string; anonymous: boolean } | null> {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token || !SERVICE_KEY || !SUPABASE_URL) return null
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } })
  if (!r.ok) return null
  const u = await r.json().catch(() => null) as { id?: string; is_anonymous?: boolean } | null
  return u?.id ? { uid: u.id, anonymous: u.is_anonymous === true } : null
}

// Per warm instance: 10 a minute and 100 an hour per account, 30 a minute per IP.
const recent = new Map<string, number[]>()
function allow(key: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  const hits = (recent.get(key) ?? []).filter(t => now - t < windowMs)
  if (hits.length >= max) return false
  hits.push(now)
  recent.set(key, hits)
  if (recent.size > 5000) recent.delete(recent.keys().next().value!)
  return true
}
const clientIp = (req: VercelRequest) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown'

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(SOLANA_RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000),
  })
  const j = await r.json().catch(() => null) as { result?: T; error?: { message?: string } } | null
  if (!r.ok || !j || j.error) throw new Error(j?.error?.message || `Solana RPC ${method} failed (${r.status})`)
  return j.result as T
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const started = Date.now()
  const send = (status: number, payload: unknown, note = '') => {
    console.log(`[solana-fee-payer] ${req.method} ${status} ${Date.now() - started}ms${note}`) // no keys or transactions
    return res.status(status).json(payload)
  }

  if (req.method === 'GET') {
    try { return send(200, { feePayer: (await getPayer()).address }) } catch { return send(503, { error: 'Solana fees are not available right now' }) }
  }
  if (req.method !== 'POST') return send(405, { error: 'GET or POST only' })

  const who = await caller(req)
  if (!who) return send(401, { error: 'Sign in to MeshPort first' })
  if (who.anonymous) return send(403, { error: 'Sign in with Google or email to use Solana' })
  if (!allow('ip:' + clientIp(req), 30, 60_000) || !allow('m:' + who.uid, 10, 60_000) || !allow('h:' + who.uid, 100, 3_600_000)) {
    return send(429, { error: 'Too many Solana transactions - try again shortly' })
  }

  const b64 = (req.body as { transaction?: unknown } | undefined)?.transaction
  if (typeof b64 !== 'string' || b64.length > 4000) return send(400, { error: 'transaction is missing' })

  try {
    const { keys, address } = await getPayer()
    const checked = checkFeePayerTransaction(new Uint8Array(Buffer.from(b64, 'base64')), address)
    const signed = await coSign(checked, keys)
    const signature = getSignatureFromTransaction(signed)
    await rpc('sendTransaction', [getBase64EncodedWireTransaction(signed), { encoding: 'base64', preflightCommitment: 'confirmed' }])
    // Wait briefly for confirmation; the app keeps checking if this runs out.
    let confirmed = false
    for (let i = 0; i < 20 && !confirmed; i++) {
      await new Promise(r => setTimeout(r, 750))
      const st = await rpc<{ value: Array<{ confirmationStatus?: string; err?: unknown } | null> }>('getSignatureStatuses', [[signature]]).catch(() => null)
      const s = st?.value?.[0]
      if (s?.err) return send(422, { error: 'The transaction failed on Solana', signature }, ' failed on-chain')
      confirmed = s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized'
    }
    return send(200, { signature, confirmed }, ` usdc=${checked.usdcUnits} opened=${checked.accountsOpened}`)
  } catch (e) {
    if (e instanceof FeePayerError) return send(400, { error: e.message }, ' refused')
    console.error('[solana-fee-payer]', e instanceof Error ? e.message : e)
    return send(502, { error: 'Solana is not reachable right now - try again' })
  }
}
