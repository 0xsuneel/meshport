// bind-session - links the caller's Supabase session to their MeshPort
// account, but only with PROOF: a signature from the account's own wallet.
//
// Why: every access rule (chats, messages, merchant data) trusts
// users.auth_uid = auth.uid(). That link used to be written by the app itself
// with no proof, so anyone could point any account at their own session.
// Now clients can't write auth_uid at all (database trigger); only this
// function can, after checking:
//   1. the request's JWT → the session id (auth.uid),
//   2. the signed message names exactly that session and this account, and is
//      at most 10 minutes old,
//   3. the signature recovers the account's wallet_address.
//
// Message (signed with personal_sign / signMessage):
//   MeshPort sign-in
//   Account: <users.id>
//   Session: <auth uid>
//   Time: <ISO timestamp>
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { verifyMessage } from 'npm:viem@2'
import { handleOptionsFor, jsonFor } from '../_shared/cors.ts'

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

const MAX_AGE_MS = 10 * 60 * 1000

Deno.serve(async req => {
  const pre = handleOptionsFor(req)
  if (pre) return pre
  if (req.method !== 'POST') return jsonFor(req, { error: 'Method not allowed' }, 405)

  // 1. Who is calling (the session this request carries).
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const { data: authData } = await db.auth.getUser(jwt).catch(() => ({ data: null as any }))
  const sessionId: string | undefined = authData?.user?.id
  if (!sessionId) return jsonFor(req, { error: 'Not signed in' }, 401)

  let body: any = {}
  try { body = await req.json() } catch { /* validated below */ }
  const userId = String(body.userId ?? '')
  const message = String(body.message ?? '')
  const signature = String(body.signature ?? '')
  if (!/^[0-9a-f-]{36}$/i.test(userId) || !/^0x[0-9a-f]+$/i.test(signature) || message.length > 400) {
    return jsonFor(req, { error: 'Bad request' }, 400)
  }

  // 2. The message must name this account and THIS session, and be fresh.
  const m = /^MeshPort sign-in\nAccount: ([0-9a-f-]{36})\nSession: ([0-9a-f-]{36})\nTime: (\S+)$/i.exec(message)
  if (!m || m[1].toLowerCase() !== userId.toLowerCase() || m[2].toLowerCase() !== sessionId.toLowerCase()) {
    return jsonFor(req, { error: 'Message does not match this sign-in' }, 400)
  }
  const at = Date.parse(m[3])
  if (!Number.isFinite(at) || Math.abs(Date.now() - at) > MAX_AGE_MS) return jsonFor(req, { error: 'Sign-in message expired' }, 400)

  // 3. The account's own wallet must have signed it.
  const { data: user } = await db.from('users').select('id, wallet_address, auth_uid').eq('id', userId).maybeSingle()
  if (!user?.wallet_address) return jsonFor(req, { error: 'Account not found' }, 404)
  let ok = false
  try {
    ok = await verifyMessage({ address: user.wallet_address as `0x${string}`, message, signature: signature as `0x${string}` })
  } catch { ok = false }
  if (!ok) return jsonFor(req, { error: 'Signature does not match this account' }, 403)

  // 4. One account, one sign-in identity across all its devices (19 Nov 2026).
  // Every access rule trusts users.auth_uid = auth.uid(), and that column
  // holds one session. Re-pointing it at each device's own (anonymous)
  // session meant the phone and the computer took turns: unlocking the
  // wallet on one hid the chats, splits and business data on the other
  // until it unlocked again. Now, when the account is already linked to
  // another session, this device is given THAT identity instead: the server
  // (after the wallet's signature above - the same proof the link needs)
  // sets a fresh random password on the linked identity, under an address
  // only MeshPort uses, and returns it; the app signs in with it once and
  // the link never changes. A linked identity with a real e-mail login is
  // left alone (its owner signs in with it on every device already).
  // Only for an app that asks for it (`canShare`); `noShare`: the app couldn't
  // sign in that way (password sign-in off) - link this session directly.
  if (user.auth_uid && user.auth_uid !== sessionId && body.canShare === true && body.noShare !== true) {
    const { data: linked } = await db.auth.admin.getUserById(user.auth_uid).catch(() => ({ data: null as any }))
    const linkedUser = linked?.user
    if (linkedUser) {
      const deviceEmail = `wallet-${userId}@accounts.meshport.xyz`
      const ours = !linkedUser.email || linkedUser.email === deviceEmail
      if (ours) {
        const bytes = new Uint8Array(32); crypto.getRandomValues(bytes)
        const password = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
        const { error: upErr } = await db.auth.admin.updateUserById(user.auth_uid, { email: deviceEmail, email_confirm: true, password })
        // Couldn't (e.g. e-mail sign-in switched off): link directly below, as before.
        if (!upErr) return jsonFor(req, { ok: true, adopt: { email: deviceEmail, password } })
        console.warn('[bind-session] sharing the sign-in failed, linking directly:', upErr.message)
      }
    }
  }

  // Once the account uses the shared identity, an app that can't share
  // (an older version still open on another device) never moves the link
  // away from it - that flip is what blanked the other device. It gets
  // "not linked" and signs in properly once it updates. Same for the app's
  // own fallback (`noShare`): it never pulls a shared link away either.
  if (user.auth_uid && user.auth_uid !== sessionId && (body.canShare !== true || body.noShare === true)) {
    const { data: linked } = await db.auth.admin.getUserById(user.auth_uid).catch(() => ({ data: null as any }))
    if (linked?.user?.email === `wallet-${userId}@accounts.meshport.xyz`) {
      return jsonFor(req, { error: 'Update the app to sign in on this device' }, 409)
    }
  }

  if (user.auth_uid !== sessionId) {
    const { error } = await db.from('users').update({ auth_uid: sessionId }).eq('id', userId)
    if (error) return jsonFor(req, { error: 'Could not link session' }, 500)
  }
  return jsonFor(req, { ok: true, changed: user.auth_uid !== sessionId })
})
