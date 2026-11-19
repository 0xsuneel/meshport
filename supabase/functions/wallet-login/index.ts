// wallet-login - sign in to MeshPort's server with the wallet itself, like
// "Sign-In with Ethereum" (19 Nov 2026).
//
// MeshPort wallets are private-key wallets: the key stays encrypted on the
// device (wallet frame), unlocked by the passcode, and never leaves it. The
// server only ever sees a SIGNATURE. Any device that unlocks the wallet signs
// one short message; this function checks it and gives that device a
// sign-in for the account's one server identity - the same identity on every
// device, so the phone and the computer see the account's data together
// (chats, splits, rewards…), the way importing a wallet into MetaMask works
// on any device.
//
// Message (signed with personal_sign / signMessage, in the wallet frame):
//   MeshPort sign-in
//   Wallet: <0x address>
//   Nonce: <32 hex chars, random per sign-in>
//   Time: <ISO timestamp>
//
// Checks: the format; the time (within 5 minutes); the signature recovers that
// wallet; the nonce was never used before (stored - a captured message can't
// be replayed); the wallet has a MeshPort account. Then: the account's server
// identity (made once if it has none, under an address only MeshPort uses -
// no e-mail is ever sent), and a one-time sign-in token for it (admin
// magic-link token) that the app exchanges for a session. Nothing about the
// identity changes, so other devices stay signed in. An account whose identity
// has a real e-mail login is left to sign in with it.
//
// No session needed to call it (verify_jwt off): the signature IS the proof.
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

const MAX_AGE_MS = 5 * 60 * 1000
const MSG = /^MeshPort sign-in\nWallet: (0x[0-9a-fA-F]{40})\nNonce: ([0-9a-f]{32})\nTime: (\S+)$/

Deno.serve(async req => {
  const pre = handleOptionsFor(req)
  if (pre) return pre
  if (req.method !== 'POST') return jsonFor(req, { error: 'Method not allowed' }, 405)

  let body: any = {}
  try { body = await req.json() } catch { /* validated below */ }
  const message = String(body.message ?? '')
  const signature = String(body.signature ?? '')
  if (message.length > 300 || !/^0x[0-9a-f]{130}$/i.test(signature)) return jsonFor(req, { error: 'Bad request' }, 400)

  // 1. The message: this wallet, a fresh random nonce, a recent time.
  const m = MSG.exec(message)
  if (!m) return jsonFor(req, { error: 'Bad sign-in message' }, 400)
  const wallet = m[1].toLowerCase()
  const nonce = m[2]
  const at = Date.parse(m[3])
  if (!Number.isFinite(at) || Math.abs(Date.now() - at) > MAX_AGE_MS) return jsonFor(req, { error: 'Sign-in message expired' }, 400)

  // 2. The wallet signed it.
  let ok = false
  try { ok = await verifyMessage({ address: m[1] as `0x${string}`, message, signature: signature as `0x${string}` }) } catch { ok = false }
  if (!ok) return jsonFor(req, { error: 'Signature does not match this wallet' }, 403)

  // 3. Never used before (a captured message can't be replayed).
  const { error: nonceErr } = await db.from('wallet_login_nonces').insert({ nonce, wallet })
  if (nonceErr) return jsonFor(req, { error: 'Sign-in message already used' }, 409)
  // Old nonces are only kept while their messages could still be valid.
  void db.from('wallet_login_nonces').delete().lt('used_at', new Date(Date.now() - 86400_000).toISOString())

  // 4. The account.
  const { data: user } = await db.from('users').select('id, auth_uid').ilike('wallet_address', wallet).maybeSingle()
  if (!user?.id) return jsonFor(req, { error: 'No MeshPort account for this wallet' }, 404)

  // 5. Its one server identity (made once if needed).
  const email = `wallet-${user.id}@accounts.meshport.xyz`
  let identityId: string | null = null
  if (user.auth_uid) {
    const { data: linked } = await db.auth.admin.getUserById(user.auth_uid).catch(() => ({ data: null as any }))
    const lu = linked?.user
    if (lu) {
      if (lu.email && lu.email !== email) return jsonFor(req, { error: 'This account signs in with its e-mail' }, 409)
      if (!lu.email) {
        const { error } = await db.auth.admin.updateUserById(lu.id, { email, email_confirm: true })
        if (error) return jsonFor(req, { error: 'Could not prepare sign-in' }, 500)
      }
      identityId = lu.id
    }
  }
  if (!identityId) {
    const { data: created, error } = await db.auth.admin.createUser({ email, email_confirm: true })
    if (created?.user?.id) identityId = created.user.id
    else if (!error || !/already|exists|registered/i.test(error.message)) return jsonFor(req, { error: 'Could not prepare sign-in' }, 500)
  }

  // 6. A one-time sign-in token for it (no e-mail is sent).
  const { data: link, error: linkErr } = await db.auth.admin.generateLink({ type: 'magiclink', email })
  const tokenHash = (link as any)?.properties?.hashed_token
  const linkUserId: string | undefined = (link as any)?.user?.id
  if (linkErr || !tokenHash || !linkUserId) return jsonFor(req, { error: 'Could not issue sign-in' }, 500)
  if (identityId && identityId !== linkUserId) return jsonFor(req, { error: 'Sign-in identity mismatch' }, 500)

  // 7. The account points at that identity (every access rule checks it).
  if (user.auth_uid !== linkUserId) {
    const { error } = await db.from('users').update({ auth_uid: linkUserId }).eq('id', user.id)
    if (error) return jsonFor(req, { error: 'Could not link sign-in' }, 500)
  }
  return jsonFor(req, { ok: true, tokenHash, userId: user.id })
})
