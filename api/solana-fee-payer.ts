// api/solana-fee-payer.ts - MeshPort pays Solana network fees (docs/SOLANA.md).
//
// POST { transaction } - a Solana transaction (base64 wire format) whose fee
// payer is MeshPort's key and which the sender's Solana wallet has already
// signed. server/solana/feePayer.ts checks it (USDC transfers, opening USDC
// accounts, CCTP burns to Arc only), MeshPort co-signs as fee payer, and it is
// sent to Solana devnet. → { signature, confirmed }.
// POST { openAccount: <Solana wallet> } - MeshPort opens that wallet's USDC
// account if it has none (Arc → Solana transfers need it). → { account, created }.
// GET → { feePayer } (the address to use).
//
// Only signed-in MeshPort accounts (a Supabase session linked to the account,
// users.auth_uid; Google / email or a wallet login), rate-limited per account and per IP. Env: SOLANA_FEE_PAYER_SECRET (base58,
// 64-byte secret key; sensitive), SUPABASE_URL, SUPABASE_SERVICE_KEY.
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getBase58Encoder, getBase64EncodedWireTransaction, getSignatureFromTransaction } from '@solana/kit'
import { checkFeePayerTransaction, coSign, FeePayerError, feePayerKeys, openUsdcAccountTransaction, usdcTokenAccount } from '../server/solana/feePayer'
import { attestedMessage, burnSignatureOf, reclaimableAccounts, reclaimTransaction } from '../server/solana/reclaim'

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

// A Supabase session alone isn't enough: anyone can mint anonymous sessions.
// The session must be linked to a MeshPort account (users.auth_uid, set by
// bind-session with a wallet signature); limits are counted per account.
async function caller(req: VercelRequest): Promise<{ account: string } | null> {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token || !SERVICE_KEY || !SUPABASE_URL) return null
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } })
  if (!r.ok) return null
  const u = await r.json().catch(() => null) as { id?: string } | null
  if (!u?.id || !/^[0-9a-f-]{36}$/i.test(u.id)) return null
  const ur = await fetch(`${SUPABASE_URL}/rest/v1/users?auth_uid=eq.${u.id}&select=id&limit=1`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  })
  const rows = ur.ok ? await ur.json().catch(() => []) as Array<{ id?: string }> : []
  return rows[0]?.id ? { account: String(rows[0].id) } : null
}

// Per warm instance: 10 a minute and 100 an hour per account, 30 a minute per
// IP; opening USDC accounts (on their own or inside a submitted transaction)
// also 30 a day per account and per IP.
const recent = new Map<string, number[]>()
function allow(key: string, max: number, windowMs: number, n = 1): boolean {
  const now = Date.now()
  const hits = (recent.get(key) ?? []).filter(t => now - t < windowMs)
  if (hits.length + n > max) return false
  for (let i = 0; i < n; i++) hits.push(now)
  recent.set(key, hits)
  if (recent.size > 5000) recent.delete(recent.keys().next().value!)
  return true
}
/** Opening USDC accounts costs MeshPort rent (~0.002 SOL each): 30 a day per account and per IP. */
function allowOpens(account: string, ip: string, n: number): boolean {
  const day = 86_400_000
  const now = Date.now()
  const room = (k: string) => (recent.get(k) ?? []).filter(t => now - t < day).length + n <= 30
  if (!room('od:' + account) || !room('oi:' + ip)) return false
  return allow('od:' + account, 30, day, n) && allow('oi:' + ip, 30, day, n)
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

async function sendAndConfirm(wireB64: string, signature: string): Promise<'confirmed' | 'failed' | 'sent'> {
  await rpc('sendTransaction', [wireB64, { encoding: 'base64', preflightCommitment: 'confirmed' }])
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 750))
    const st = await rpc<{ value: Array<{ confirmationStatus?: string; err?: unknown } | null> }>('getSignatureStatuses', [[signature]]).catch(() => null)
    const s = st?.value?.[0]
    if (s?.err) return 'failed'
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return 'confirmed'
  }
  return 'sent'
}

// MeshPort's fee on a Solana Bring is paid to the fee payer's own USDC
// account (feePolicy solanaBringFee); opened once, the first time it's needed.
let feeAccountReady: Promise<string> | null = null
function ensureFeeAccount(): Promise<string> {
  if (!feeAccountReady) {
    feeAccountReady = (async () => {
      const { keys, address } = await getPayer()
      const account = await usdcTokenAccount(address)
      const info = await rpc<{ value: unknown | null }>('getAccountInfo', [account, { encoding: 'base64', commitment: 'confirmed' }])
      if (info.value) return account
      const lt = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])
      const tx = await openUsdcAccountTransaction(address, keys, address, { blockhash: lt.value.blockhash, lastValidBlockHeight: BigInt(lt.value.lastValidBlockHeight) })
      const outcome = await sendAndConfirm(getBase64EncodedWireTransaction(tx), getSignatureFromTransaction(tx))
      if (outcome === 'failed') throw new Error("Couldn't open MeshPort's USDC fee account on Solana")
      return account
    })()
    feeAccountReady.catch(() => { feeAccountReady = null })
  }
  return feeAccountReady
}

// Rent back from Circle (server/solana/reclaim.ts): MeshPort paid ~0.003 SOL
// rent per Solana Bring's event account; 5 days later reclaim_event_account
// returns it. POST { action: 'reclaim' } from MeshPort's daily job only
// (Authorization: the internal secret /api/push uses), a few per run.
function internalSecretOk(req: VercelRequest): boolean {
  const secret = (process.env.PUSH_INTERNAL_SECRET || '').trim()
  const h = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  if (!secret || h.length !== secret.length) return false
  let diff = 0
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ h.charCodeAt(i)
  return diff === 0
}
const IRIS_SANDBOX = 'https://iris-api-sandbox.circle.com'
async function reclaimRent(max = 6) {
  const { keys, address } = await getPayer()
  const due = await reclaimableAccounts(rpc, address, Math.floor(Date.now() / 1000))
  const out: Array<{ account: string; lamports: number; result: string; signature?: string }> = []
  for (const a of due.slice(0, max)) {
    try {
      const burn = await burnSignatureOf(rpc, a.account)
      const att = burn ? await attestedMessage(IRIS_SANDBOX, burn) : null
      if (!att) { out.push({ account: a.account, lamports: a.lamports, result: 'no attestation' }); continue }
      const lt = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])
      const tx = await reclaimTransaction({ eventAccount: a.account, attestation: att.attestation, message: att.message, keys, feePayer: address,
        lifetime: { blockhash: lt.value.blockhash, lastValidBlockHeight: BigInt(lt.value.lastValidBlockHeight) } })
      const signature = getSignatureFromTransaction(tx)
      out.push({ account: a.account, lamports: a.lamports, result: await sendAndConfirm(getBase64EncodedWireTransaction(tx), signature), signature })
    } catch (e) {
      out.push({ account: a.account, lamports: a.lamports, result: (e instanceof Error ? e.message : String(e)).slice(0, 120) })
    }
  }
  return { due: due.length, done: out }
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

  if ((req.body as { action?: string } | undefined)?.action === 'reclaim') {
    if (!internalSecretOk(req)) return send(403, { error: 'Forbidden' })
    try {
      const r = await reclaimRent()
      const back = r.done.filter(d => d.result === 'confirmed' || d.result === 'sent').reduce((s, d) => s + d.lamports, 0)
      return send(200, r, ` reclaim: ${r.done.length}/${r.due} ${back / 1e9} SOL`)
    } catch (e) {
      console.error('[solana-fee-payer] reclaim', e instanceof Error ? e.message : e)
      return send(502, { error: 'Reclaim failed' })
    }
  }

  const who = await caller(req)
  if (!who) return send(401, { error: 'Sign in to MeshPort first' })
  const acct = who.account
  if (!allow('ip:' + clientIp(req), 30, 60_000) || !allow('m:' + acct, 10, 60_000) || !allow('h:' + acct, 100, 3_600_000)) {
    return send(429, { error: 'Too many Solana transactions - try again shortly' })
  }

  const body = (req.body ?? {}) as { transaction?: unknown; openAccount?: unknown }
  if (typeof body.openAccount === 'string') {
    // base58 of exactly 32 bytes (a lowercased address decodes to another length)
    let ok = false
    try { ok = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(body.openAccount) && getBase58Encoder().encode(body.openAccount).length === 32 } catch { /* not base58 */ }
    if (!ok) return send(400, { error: 'Not a valid Solana address' })
    // Opening an account costs MeshPort its rent (~0.002 SOL): 30 a day per account and per IP.
    if (!allowOpens(acct, clientIp(req), 1)) {
      return send(429, { error: 'Too many new Solana accounts today - try again tomorrow' })
    }
    try {
      const { keys, address } = await getPayer()
      const account = await usdcTokenAccount(body.openAccount)
      const info = await rpc<{ value: unknown | null }>('getAccountInfo', [account, { encoding: 'base64', commitment: 'confirmed' }])
      if (info.value) return send(200, { account, created: false }, ' open: exists')
      const lt = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])
      const tx = await openUsdcAccountTransaction(body.openAccount, keys, address, { blockhash: lt.value.blockhash, lastValidBlockHeight: BigInt(lt.value.lastValidBlockHeight) })
      const signature = getSignatureFromTransaction(tx)
      await rpc('sendTransaction', [getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }])
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 750))
        const st = await rpc<{ value: Array<{ confirmationStatus?: string; err?: unknown } | null> }>('getSignatureStatuses', [[signature]]).catch(() => null)
        const s = st?.value?.[0]
        if (s?.err) return send(422, { error: "Couldn't open the USDC account on Solana", signature }, ' open: failed')
        if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return send(200, { account, created: true, signature }, ' open: created')
      }
      return send(200, { account, created: true, signature, confirmed: false }, ' open: sent')
    } catch (e) {
      console.error('[solana-fee-payer] open', e instanceof Error ? e.message : e)
      return send(502, { error: 'Solana is not reachable right now - try again' })
    }
  }

  const b64 = body.transaction
  if (typeof b64 !== 'string' || b64.length > 4000) return send(400, { error: 'transaction is missing' })

  try {
    const { keys, address } = await getPayer()
    const feeAccount = await usdcTokenAccount(address)
    const checked = checkFeePayerTransaction(new Uint8Array(Buffer.from(b64, 'base64')), address, undefined, feeAccount)
    // A Bring pays MeshPort's fee into that account: it must exist first (once).
    if (checked.burnUnits > 0n) await ensureFeeAccount()
    // Accounts opened inside the transaction cost MeshPort rent too: same daily cap.
    if (checked.accountsOpened > 0 && !allowOpens(acct, clientIp(req), checked.accountsOpened)) {
      return send(429, { error: 'Too many new Solana accounts today - try again tomorrow' })
    }
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
    return send(200, { signature, confirmed }, ` usdc=${checked.usdcUnits} opened=${checked.accountsOpened} burn=${checked.burnUnits} fee=${checked.feeUnits}`)
  } catch (e) {
    if (e instanceof FeePayerError) return send(400, { error: e.message }, ' refused')
    console.error('[solana-fee-payer]', e instanceof Error ? e.message : e)
    return send(502, { error: 'Solana is not reachable right now - try again' })
  }
}
