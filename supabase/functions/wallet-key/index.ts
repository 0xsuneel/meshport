// supabase/functions/wallet-key/index.ts
//
// POST /wallet-key  (deployed as the Supabase Edge Function "wallet-key")
// Body: { action, device_id? }
// Auth: caller's Supabase session JWT (Authorization header), re-verified
// server-side on every call via supabase.auth.getUser(jwt) — the row
// touched is always the VERIFIED user id, never anything the client claims.
//
// ── CHANGELOG (this revision) ────────────────────────────────────────────
// Addresses every High/Medium finding in docs/SECURITY_AUDIT_FINAL.md,
// within the existing server-custodial envelope-encryption architecture —
// no MPC, no architecture change. See docs/PRODUCTION_READINESS_REPORT.md
// for the full file-by-file summary.
//
//   1. RACE CONDITION: wallet_vault is written BEFORE users.wallet_address
//      is ever touched; user_id is its primary key, so exactly one
//      concurrent generate-wallet call for a brand-new user can win. The
//      loser re-reads and returns the winner's wallet rather than erroring.
//   2. AUTHORIZATION: real, server-verified check against a persisted
//      users.login_type column (new — see the accompanying migration),
//      not just a client-side assumption. Self-custodial accounts get 403.
//      Falls back to a pragmatic heuristic for rows that predate the
//      column (see checkAccountIsSocial()).
//   3. ERROR HANDLING: clientSafeError() is the only thing that decides
//      what text a client ever sees — full detail always goes to
//      console.error only.
//   4. AUDIT LOG INTEGRITY: getClientIp() prefers a trusted platform
//      header, else the LAST (not first/spoofable) X-Forwarded-For hop,
//      validated before use.
//   5. RATE LIMITING: configurable, per-user AND per-IP, applied to both
//      actions — see checkRateLimit() and the WALLET_KEY_RATE_LIMIT_* env
//      vars in .env.example.
//   6. CORS: origin-aware via _shared/cors.ts's corsHeadersFor/jsonFor/
//      handleOptionsFor — no wildcard on an endpoint returning a private key.
//   7. KMS PREPARATION: all master-KEK-dependent operations now go through
//      a KeyProvider interface (see below). EnvKeyProvider is the only
//      implementation today (env-var secrets, as before) — swapping to a
//      real KMS later means writing one new class, with zero changes to
//      any business logic. Not migrated to a real KMS in this revision,
//      per instruction — this is preparation only.
//
// ── DESIGN: PER-WALLET DERIVED KEK (ENVELOPE ENCRYPTION) ─────────────────
//   Master KEK (env secret, WALLET_MASTER_KEK_V<n>)
//           |  HKDF-SHA256(info = kek_version + user_id + wallet_id)
//           v
//   Per-wallet KEK (in-memory only, one request's lifetime)
//           |  AES-256-GCM  →  wraps/unwraps the MEK
//           v
//   MEK (32 random bytes, unique per wallet)
//           |  HKDF-SHA256(info = user_id + wallet_id, salt = row.salt)
//           v
//   Wallet-encryption key (in-memory only)
//           |  AES-256-GCM  →  wraps/unwraps the private key
//
// See docs/SECURITY_ARCHITECTURE.md and docs/SECURITY_AUDIT_FINAL.md for
// the full threat model, standards review, and the honestly-stated
// residual risk (a live master KEK + a full DB dump together remain
// sufficient to reconstruct wallets — see Priority 7 above for the
// concrete, non-MPC path to narrowing that further).

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { getPublicKey, utils as secpUtils } from 'npm:@noble/secp256k1@2.1.0'
import { keccak_256 } from 'npm:@noble/hashes@1.4.0/sha3'
import { corsHeadersFor, handleOptionsFor, jsonFor } from '../_shared/cors.ts'

const CURRENT_SCHEME_VERSION = 2
const ALGORITHM_LABEL = 'AES-256-GCM+HKDF-SHA256'
const GCM_TAG_LENGTH_BITS = 128

// ── Rate limiting config — configurable via env, sane defaults ──────────
const RATE_LIMIT_WINDOW_SECONDS   = parseIntEnv('WALLET_KEY_RATE_LIMIT_WINDOW_SECONDS', 60)
const RATE_LIMIT_MAX_PER_USER     = parseIntEnv('WALLET_KEY_RATE_LIMIT_PER_USER', 20)
const RATE_LIMIT_MAX_PER_IP       = parseIntEnv('WALLET_KEY_RATE_LIMIT_PER_IP', 60) // higher: an IP can be a shared NAT/office network

function parseIntEnv(name: string, fallback: number): number {
  const raw = (Deno.env.get(name) || '').trim()
  const n = parseInt(raw, 10)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

function getServiceRoleKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (legacy) return legacy
  const secretKeysRaw = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (secretKeysRaw) {
    try {
      const parsed = JSON.parse(secretKeysRaw)
      const candidate = parsed?.service_role ?? parsed?.SUPABASE_SERVICE_ROLE_KEY ?? Object.values(parsed ?? {})[0]
      if (typeof candidate === 'string' && candidate) return candidate
    } catch (e) {
      console.error('[wallet-key] SUPABASE_SECRET_KEYS present but failed to parse:', e instanceof Error ? e.message : e)
    }
  }
  throw new Error('No Supabase service role key found — checked SUPABASE_SERVICE_ROLE_KEY and SUPABASE_SECRET_KEYS.')
}

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = getServiceRoleKey()

// ── Ethereum key generation + address derivation — unchanged ─────────────
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}
function generateWalletServerSide(): { address: string; privateKey: string } {
  const privBytes = secpUtils.randomPrivateKey()
  const privateKey = '0x' + bytesToHex(privBytes)
  const pubKey = getPublicKey(privBytes, false)
  const pubKeyNoPrefix = pubKey.slice(1)
  const hash = keccak_256(pubKeyNoPrefix)
  const address = '0x' + bytesToHex(hash.slice(-20))
  return { address, privateKey }
}

function toB64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)) }
function fromB64(str: string): Uint8Array { return new Uint8Array(atob(str).split('').map(c => c.charCodeAt(0))) }

// ═══════════════════════════════════════════════════════════════════════
// ── KeyProvider abstraction (Priority 7: KMS preparation) ────────────────
// Every operation that needs the master KEK goes through this interface.
// EnvKeyProvider (below) is the only implementation today: it derives a
// per-wallet KEK from an environment-variable secret via HKDF, entirely
// in this process. A future KmsKeyProvider would implement the exact same
// interface by calling a real KMS's Encrypt/Decrypt or WrapKey/UnwrapKey
// API instead — every caller (envelopeEncryptWalletV2, decryptByVersion,
// rewrapIfStale) is written against this interface and would need zero
// changes. Not implemented against a real KMS in this revision.
// ═══════════════════════════════════════════════════════════════════════
interface KeyProvider {
  /** Which kek_version new wraps should use right now. */
  currentVersion(): number
  /** Wrap a raw 32-byte MEK for a specific wallet under a given kek_version. Returns a self-contained, storable string. */
  wrapMEK(mek: Uint8Array, userId: string, walletId: string, kekVersion: number): Promise<string>
  /** Unwrap a previously-wrapped MEK for a specific wallet/kek_version. */
  unwrapMEK(wrapped: string, userId: string, walletId: string, kekVersion: number): Promise<Uint8Array>
}

class EnvKeyProvider implements KeyProvider {
  // Fixed, documented salt — reviewed and confirmed correct usage in
  // docs/SECURITY_AUDIT_FINAL.md §2: IKM here is already uniform
  // (SHA-256 of a high-entropy secret), so per-wallet uniqueness comes
  // from `info`, not `salt`. Standard "HKDF as per-context KDF" usage.
  private static readonly DERIVATION_SALT = new TextEncoder().encode('arcpay-per-wallet-kek-derivation-v1')

  currentVersion(): number {
    return parseIntEnv('WALLET_MASTER_KEK_CURRENT_VERSION', 1)
  }

  private getMasterSecret(kekVersion: number): string {
    const secret = (Deno.env.get(`WALLET_MASTER_KEK_V${kekVersion}`) || '').trim()
    if (!secret) {
      // Detailed guidance is fine here — this Error is only ever consumed
      // server-side (console.error via clientSafeError), never returned
      // to a client directly.
      throw new Error(
        `WALLET_MASTER_KEK_V${kekVersion} not configured. Set via: ` +
        `supabase secrets set WALLET_MASTER_KEK_V${kekVersion}=<a long random value>`
      )
    }
    return secret
  }

  private async deriveUserKEK(userId: string, walletId: string, kekVersion: number): Promise<CryptoKey> {
    const masterSecret = this.getMasterSecret(kekVersion)
    const masterHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(masterSecret))
    const ikm = await crypto.subtle.importKey('raw', masterHash, 'HKDF', false, ['deriveKey'])
    const info = new TextEncoder().encode(`arcpay-user-kek:v${kekVersion}:${userId}:${walletId}`)
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: EnvKeyProvider.DERIVATION_SALT, info },
      ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    )
  }

  async wrapMEK(mek: Uint8Array, userId: string, walletId: string, kekVersion: number): Promise<string> {
    const userKEK = await this.deriveUserKEK(userId, walletId, kekVersion)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: GCM_TAG_LENGTH_BITS }, userKEK, mek)
    return `v1:${toB64(iv)}:${toB64(new Uint8Array(ciphertext))}`
  }

  async unwrapMEK(wrapped: string, userId: string, walletId: string, kekVersion: number): Promise<Uint8Array> {
    const parts = wrapped.split(':')
    if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('Unsupported or corrupt encrypted_mek envelope')
    const userKEK = await this.deriveUserKEK(userId, walletId, kekVersion)
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(parts[1]), tagLength: GCM_TAG_LENGTH_BITS }, userKEK, fromB64(parts[2])
    )
    return new Uint8Array(plaintext)
  }
}

const keyProvider: KeyProvider = new EnvKeyProvider()

// ── Wallet-encryption key — derived from the MEK, independent of the KeyProvider ──
async function deriveWalletKeyV2(mek: Uint8Array, salt: Uint8Array, userId: string, walletId: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', mek, 'HKDF', false, ['deriveKey'])
  const info = new TextEncoder().encode(`arcpay-wallet-v2:${userId}:${walletId}`)
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  )
}

type VaultRow = {
  wallet_id: string
  wallet_address: string
  encrypted_wallet: string
  encrypted_mek: string
  iv: string
  salt: string
  version: number
  algorithm: string
  kek_version: number
}
const VAULT_SELECT = 'wallet_id, wallet_address, encrypted_wallet, encrypted_mek, iv, salt, version, algorithm, kek_version'

async function envelopeEncryptWalletV2(privateKey: string, userId: string, walletId: string, walletAddress: string): Promise<VaultRow> {
  const kekVersion = keyProvider.currentVersion()
  const mek = crypto.getRandomValues(new Uint8Array(32))
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))

  const walletKey = await deriveWalletKeyV2(mek, salt, userId, walletId)
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: GCM_TAG_LENGTH_BITS }, walletKey, new TextEncoder().encode(privateKey))
  const encrypted_mek = await keyProvider.wrapMEK(mek, userId, walletId, kekVersion)
  mek.fill(0)

  return {
    wallet_id: walletId,
    wallet_address: walletAddress,
    encrypted_wallet: toB64(new Uint8Array(ciphertext)),
    encrypted_mek,
    iv: toB64(iv),
    salt: toB64(salt),
    version: CURRENT_SCHEME_VERSION,
    algorithm: ALGORITHM_LABEL,
    kek_version: kekVersion,
  }
}

// ═══ LEGACY DECRYPTION — read-only, never written by new code ═══════════
async function decryptMEK_v1Legacy(payload: string): Promise<Uint8Array> {
  const secret = (Deno.env.get('WALLET_KEK') || '').trim()
  if (!secret) throw new Error('WALLET_KEK not configured — required to read pre-existing version=1 rows.')
  const parts = payload.split(':')
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('Unsupported or corrupt legacy encrypted_mek envelope')
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  const key = await crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['decrypt'])
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(parts[1]), tagLength: GCM_TAG_LENGTH_BITS }, key, fromB64(parts[2])
  )
  return new Uint8Array(plaintext)
}
async function deriveWalletKeyV1Legacy(mek: Uint8Array, salt: Uint8Array, userId: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', mek, 'HKDF', false, ['deriveKey'])
  const info = new TextEncoder().encode('arcpay-wallet-v1:' + userId)
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info }, ikm, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
}
async function decryptLegacyDirectKeyV0(payload: string): Promise<string | null> {
  const legacySecret = (Deno.env.get('WALLET_KEY_ENCRYPTION_SECRET') || '').trim()
  if (!legacySecret) return null
  const parts = payload.split(':')
  if (parts.length !== 3 || parts[0] !== 'srv1') return null
  try {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(legacySecret))
    const key = await crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['decrypt'])
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(parts[1]), tagLength: GCM_TAG_LENGTH_BITS }, key, fromB64(parts[2])
    )
    return new TextDecoder().decode(plaintext)
  } catch {
    return null
  }
}

async function decryptByVersion(row: VaultRow, userId: string): Promise<string> {
  if (row.version === CURRENT_SCHEME_VERSION) {
    const mek = await keyProvider.unwrapMEK(row.encrypted_mek, userId, row.wallet_id, row.kek_version)
    try {
      const walletKey = await deriveWalletKeyV2(mek, fromB64(row.salt), userId, row.wallet_id)
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64(row.iv), tagLength: GCM_TAG_LENGTH_BITS }, walletKey, fromB64(row.encrypted_wallet)
      )
      return new TextDecoder().decode(plaintext)
    } finally { mek.fill(0) }
  }
  if (row.version === 1) {
    const mek = await decryptMEK_v1Legacy(row.encrypted_mek)
    try {
      const walletKey = await deriveWalletKeyV1Legacy(mek, fromB64(row.salt), userId)
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64(row.iv), tagLength: GCM_TAG_LENGTH_BITS }, walletKey, fromB64(row.encrypted_wallet)
      )
      return new TextDecoder().decode(plaintext)
    } finally { mek.fill(0) }
  }
  throw new Error(`Unsupported wallet_vault row version: ${row.version}`)
}

// ── Client-safe error mapping — nothing internal ever reaches a response ──
function clientSafeError(logPrefix: string, err: unknown): void {
  console.error(logPrefix, err instanceof Error ? err.message : err)
}

// ── Audit logging ────────────────────────────────────────────────────────
type AuditOperation = 'generate_wallet' | 'restore_wallet' | 'kek_rotation' | 'legacy_migration' | 'decrypt_failure'
async function logAudit(
  supabase: ReturnType<typeof createClient>,
  f: { userId: string | null; walletId: string | null; operation: AuditOperation; success: boolean; deviceId: string | null; ipAddress: string | null }
): Promise<void> {
  try {
    await supabase.from('wallet_audit_log').insert({
      user_id: f.userId, wallet_id: f.walletId, operation: f.operation,
      success: f.success, device_id: f.deviceId, ip_address: f.ipAddress,
    })
  } catch (e) {
    console.error('[wallet-key] audit log write failed:', e instanceof Error ? e.message : e)
  }
}

// ── Client IP — trusted-header first, else last (not first) X-Forwarded-For hop ──
const IP_LIKE = /^[0-9a-fA-F.:]{2,45}$/
function getClientIp(req: Request): string | null {
  const trusted = req.headers.get('x-vercel-forwarded-for') || req.headers.get('x-real-ip')
  if (trusted && IP_LIKE.test(trusted.trim())) return trusted.trim()
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) {
    const hops = forwarded.split(',').map(h => h.trim())
    const last = hops[hops.length - 1]
    if (last && IP_LIKE.test(last)) return last
  }
  const cf = req.headers.get('cf-connecting-ip')
  if (cf && IP_LIKE.test(cf.trim())) return cf.trim()
  return null
}

// ── Rate limiting — per-user AND per-IP, reusing wallet_audit_log ────────
// Fails OPEN on a query error (availability for legitimate users takes
// priority over a rate-limit check that can't complete); every actual
// outcome is still audit-logged regardless of whether this check ran.
async function checkRateLimit(supabase: ReturnType<typeof createClient>, userId: string, ipAddress: string | null): Promise<{ allowed: boolean; reason?: string }> {
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_SECONDS * 1000).toISOString()
  try {
    const { count: userCount, error: userErr } = await supabase
      .from('wallet_audit_log').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).gte('occurred_at', since)
    if (!userErr && (userCount ?? 0) >= RATE_LIMIT_MAX_PER_USER) return { allowed: false, reason: 'per-user' }
  } catch { /* fail open */ }

  if (ipAddress) {
    try {
      const { count: ipCount, error: ipErr } = await supabase
        .from('wallet_audit_log').select('id', { count: 'exact', head: true })
        .eq('ip_address', ipAddress).gte('occurred_at', since)
      if (!ipErr && (ipCount ?? 0) >= RATE_LIMIT_MAX_PER_IP) return { allowed: false, reason: 'per-ip' }
    } catch { /* fail open */ }
  }

  return { allowed: true }
}

// ── Authorization: confirm this account is actually social-login ────────
// Real fix (Priority 2): checks the persisted users.login_type column
// (see the accompanying migration) rather than trusting the client.
//   - login_type = 'wallet'  → definitely self-custodial → reject (403).
//   - login_type = 'social'  → confirmed → allow.
//   - login_type is null AND no users row exists yet → this is a brand-new
//     signup (both social and create/import accounts only get a
//     public.users row later, at username-claim time — see
//     ClaimUsernamePage/upsertUserProfile) → allow; there is nothing to
//     distinguish here yet, and a self-custodial account's local wallet
//     generation never calls this endpoint anyway, so this path is not a
//     bypass for one.
//   - login_type is null BUT a users row exists with a non-empty
//     wallet_address and no wallet_vault entry → pragmatic legacy
//     heuristic: this looks like a self-custodial account that predates
//     the login_type column → reject, same conservative outcome as before
//     this migration existed.
//   - login_type is null, users row exists, wallet_address empty → allow
//     (ambiguous, but not the dangerous case — no address to protect yet).
async function checkAccountIsSocial(supabase: ReturnType<typeof createClient>, userId: string, hasVaultRow: boolean): Promise<boolean> {
  const { data: u } = await supabase.from('users').select('login_type, wallet_address').eq('id', userId).maybeSingle()
  if (!u) return true // no row yet — brand-new signup, see comment above
  if (u.login_type === 'wallet') return false
  if (u.login_type === 'social') return true
  // login_type unknown (legacy row) — fall back to the heuristic
  if (!hasVaultRow && u.wallet_address) return false
  return true
}

Deno.serve(async (req: Request) => {
  const preflight = handleOptionsFor(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return jsonFor(req, { error: 'Method not allowed' }, 405)

  let body: any
  try { body = await req.json() } catch { return jsonFor(req, { error: 'Invalid JSON body' }, 400) }

  const action = String(body?.action || '')
  const deviceId: string | null = typeof body?.device_id === 'string' ? body.device_id.slice(0, 128) : null
  const ipAddress = getClientIp(req)

  const authHeader = req.headers.get('Authorization') ?? ''
  const jwt = authHeader.replace(/^Bearer\s+/i, '')
  if (!jwt) return jsonFor(req, { error: 'Missing session' }, 401)

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  const { data: authData, error: authErr } = await supabase.auth.getUser(jwt)
  const authUid = authData?.user?.id
  if (authErr || !authUid) return jsonFor(req, { error: 'Invalid or expired session' }, 401)

  // Bug fix: authUid (above) is the raw Supabase Auth session id, and every
  // query below this point — wallet_vault, checkAccountIsSocial, the
  // legacy-migration users lookup, rate limiting, audit logging — expects
  // public.users.id instead, which is a DIFFERENT uuid for the same
  // person once a session drifts (e.g. a re-auth that lands on a
  // different underlying auth.users row while the stable public.users.id
  // stays put). Using authUid directly for those meant a real, correctly
  // -encrypted vault row could sit permanently unreachable — confirmed
  // against a production case where the row existed (created days
  // earlier) but restore-full-key always reported "No wallet on file,"
  // no matter how many times it was retried, since retrying doesn't
  // change which id is being searched for.
  //
  // Resolved here once and used throughout — but NOT required to
  // succeed for generate-wallet: a brand-new social signup calls this
  // action before any public.users row exists at all (that row is only
  // created later, during username claim — see upsertUserProfile in
  // lib/supabase.ts), so failing outright here would break every new
  // signup. Falling back to authUid in that case is safe specifically
  // because there's no pre-existing row to mismatch against — whatever
  // id the fresh wallet_vault row gets written with now is correct by
  // definition, and matches what public.users.id becomes moments later
  // in the same signup session (no time for drift yet). restore-full-key
  // is different: by definition the account and its vault row already
  // exist, so a failed resolve there is a real problem worth surfacing
  // rather than silently falling back to a raw id that's already proven
  // itself unreliable for this exact case.
  const { data: resolvedUser } = await supabase
    .from('users').select('id').eq('auth_uid', authUid).maybeSingle()
  let userId = resolvedUser?.id
  if (!userId) {
    if (action === 'restore-full-key') {
      clientSafeError(`[wallet-key] no users row found for auth_uid ${authUid} on restore-full-key`, null)
      return jsonFor(req, { error: 'Account not found for this session' }, 404)
    }
    userId = authUid // generate-wallet fallback — see comment above
  }

  if (action !== 'generate-wallet' && action !== 'restore-full-key') {
    return jsonFor(req, { error: `Unknown action: ${action}` }, 400)
  }

  const auditOp: AuditOperation = action === 'generate-wallet' ? 'generate_wallet' : 'restore_wallet'

  const rate = await checkRateLimit(supabase, userId, ipAddress)
  if (!rate.allowed) {
    await logAudit(supabase, { userId, walletId: null, operation: auditOp, success: false, deviceId, ipAddress })
    return jsonFor(req, { error: 'Too many requests — please wait a moment and try again.' }, 429)
  }

  const loadOrMigrateVaultRow = async (): Promise<VaultRow | null> => {
    const { data: vault } = await supabase.from('wallet_vault').select(VAULT_SELECT).eq('user_id', userId).maybeSingle()
    if (vault) return vault as VaultRow

    const { data: legacyUser } = await supabase.from('users').select('wallet_address, encrypted_wallet_key').eq('id', userId).maybeSingle()
    if (!legacyUser?.wallet_address || !legacyUser?.encrypted_wallet_key) return null

    const privateKey = await decryptLegacyDirectKeyV0(legacyUser.encrypted_wallet_key)
    if (!privateKey) {
      clientSafeError(`[wallet-key] legacy v0 decrypt failed for user ${userId} — WALLET_KEY_ENCRYPTION_SECRET may be missing/rotated`, null)
      await logAudit(supabase, { userId, walletId: null, operation: 'legacy_migration', success: false, deviceId, ipAddress })
      return null
    }

    const walletId = crypto.randomUUID()
    const migrated = await envelopeEncryptWalletV2(privateKey, userId, walletId, legacyUser.wallet_address)
    const { error: insertErr } = await supabase.from('wallet_vault').insert({ user_id: userId, ...migrated })
    if (insertErr) {
      const { data: retryVault } = await supabase.from('wallet_vault').select(VAULT_SELECT).eq('user_id', userId).maybeSingle()
      if (retryVault) return retryVault as VaultRow
      clientSafeError(`[wallet-key] failed to write migrated vault row for user ${userId}:`, insertErr)
      await logAudit(supabase, { userId, walletId, operation: 'legacy_migration', success: false, deviceId, ipAddress })
      return null
    }
    await supabase.from('users').update({ encrypted_wallet_key: null, login_type: 'social' }).eq('id', userId)
    await logAudit(supabase, { userId, walletId, operation: 'legacy_migration', success: true, deviceId, ipAddress })
    return migrated
  }

  // Load (and lazily migrate, if needed) the vault row ONCE, before
  // deciding authorization — checkAccountIsSocial's heuristic branch
  // needs to know whether a vault row genuinely exists, not a guess.
  // Calling this here (rather than separately inside each action branch)
  // also means generate-wallet's "already exists" fast path and
  // restore-full-key both reuse the same lookup instead of querying twice.
  const vaultRow = await loadOrMigrateVaultRow()

  const isSocial = await checkAccountIsSocial(supabase, userId, vaultRow !== null)
  if (!isSocial) {
    await logAudit(supabase, { userId, walletId: null, operation: auditOp, success: false, deviceId, ipAddress })
    return jsonFor(req, { error: 'This account type is not eligible for this operation.' }, 403)
  }

  const currentKekVersion = keyProvider.currentVersion()
  const rewrapIfStale = async (row: VaultRow, plaintextKey: string): Promise<void> => {
    if (row.version === CURRENT_SCHEME_VERSION && row.kek_version === currentKekVersion) return
    try {
      const fresh = await envelopeEncryptWalletV2(plaintextKey, userId, row.wallet_id, row.wallet_address)
      await supabase.from('wallet_vault').update({
        encrypted_wallet: fresh.encrypted_wallet, encrypted_mek: fresh.encrypted_mek,
        iv: fresh.iv, salt: fresh.salt, version: fresh.version,
        algorithm: fresh.algorithm, kek_version: fresh.kek_version,
      }).eq('wallet_id', row.wallet_id)
      await logAudit(supabase, { userId, walletId: row.wallet_id, operation: 'kek_rotation', success: true, deviceId, ipAddress })
    } catch (e) {
      clientSafeError(`[wallet-key] rewrapIfStale failed for wallet_id ${row.wallet_id}:`, e)
      await logAudit(supabase, { userId, walletId: row.wallet_id, operation: 'kek_rotation', success: false, deviceId, ipAddress })
    }
  }

  // ── Race-safe new-wallet commit ──────────────────────────────────────
  // wallet_vault write happens FIRST (user_id is its primary key — exactly
  // one concurrent insert for the same brand-new user can win). Only the
  // winner goes on to sync users.wallet_address, and that sync is
  // best-effort: a brand-new social signup legitimately has NO
  // public.users row yet (one is only created later, at username-claim
  // time, by upsertUserProfile using the client's already-correct local
  // state) — so 0 rows matched here is an expected, benign outcome, not a
  // failure. Only a real Postgres error, or a row that exists but ends up
  // holding a DIFFERENT address than we just wrote, is treated as fatal.
  const commitNewWallet = async (address: string, walletId: string, vaultRow: VaultRow): Promise<{ address: string; privateKey: string } | null> => {
    const { data: inserted, error: insertErr } = await supabase
      .from('wallet_vault').insert({ user_id: userId, ...vaultRow }).select('user_id')

    if (insertErr || !inserted || inserted.length === 0) {
      // Most likely: a concurrent request for this same user already won.
      const { data: winner } = await supabase.from('wallet_vault').select(VAULT_SELECT).eq('user_id', userId).maybeSingle()
      if (winner) {
        try {
          const winnerKey = await decryptByVersion(winner as VaultRow, userId)
          return { address: (winner as VaultRow).wallet_address, privateKey: winnerKey }
        } catch (e) {
          clientSafeError(`[wallet-key] failed to decrypt concurrent-winner row for user ${userId}:`, e)
        }
      }
      clientSafeError(`[wallet-key] wallet_vault insert failed for user ${userId} and no winning row could be recovered:`, insertErr)
      return null
    }

    const { error: userUpdateErr } = await supabase.from('users').update({ wallet_address: address, login_type: 'social' }).eq('id', userId)
    if (userUpdateErr) {
      clientSafeError(`[wallet-key] users.wallet_address sync failed after vault insert for user ${userId}:`, userUpdateErr)
      // Not fatal to the wallet itself — wallet_vault is the source of
      // truth and already committed successfully. users.wallet_address
      // will be corrected the next time this row is read (rewrapIfStale-
      // adjacent paths don't touch it, but upsertUserProfile at
      // claim-username time always writes the correct value from the
      // client's local state regardless).
    } else {
      const { data: verify } = await supabase.from('users').select('wallet_address').eq('id', userId).maybeSingle()
      if (verify && verify.wallet_address !== address) {
        clientSafeError(`[wallet-key] users.wallet_address verify mismatch for user ${userId}`, null)
      }
    }

    return { address, privateKey: '' } // filled in by the caller, which already holds it
  }

  if (action === 'generate-wallet') {
    const existing = vaultRow
    if (existing) {
      try {
        const privateKey = await decryptByVersion(existing, userId)
        await rewrapIfStale(existing, privateKey)
        await logAudit(supabase, { userId, walletId: existing.wallet_id, operation: 'generate_wallet', success: true, deviceId, ipAddress })
        return jsonFor(req, { address: existing.wallet_address, privateKey })
      } catch (e) {
        clientSafeError('[wallet-key] decrypt of existing vault row failed:', e)
        await logAudit(supabase, { userId, walletId: existing.wallet_id, operation: 'decrypt_failure', success: false, deviceId, ipAddress })
        return jsonFor(req, { error: 'Failed to decrypt existing wallet' }, 500)
      }
    }

    const { address, privateKey } = generateWalletServerSide()
    const walletId = crypto.randomUUID()

    let newVaultRow: VaultRow
    try {
      newVaultRow = await envelopeEncryptWalletV2(privateKey, userId, walletId, address)
    } catch (e) {
      clientSafeError(`[wallet-key] encryption failed for user ${userId}:`, e)
      return jsonFor(req, { error: 'Failed to secure the generated wallet. Please try again.' }, 500)
    }

    const result = await commitNewWallet(address, walletId, newVaultRow)
    if (!result) {
      await logAudit(supabase, { userId, walletId, operation: 'generate_wallet', success: false, deviceId, ipAddress })
      return jsonFor(req, { error: 'Failed to durably store the generated wallet. Please try again.' }, 500)
    }

    const finalPrivateKey = result.privateKey || privateKey // '' means we won → use our own key; non-empty means we lost the race → use the winner's
    await logAudit(supabase, { userId, walletId, operation: 'generate_wallet', success: true, deviceId, ipAddress })
    return jsonFor(req, { address: result.address, privateKey: finalPrivateKey })
  }

  // action === 'restore-full-key'
  const row = vaultRow
  if (!row) {
    await logAudit(supabase, { userId, walletId: null, operation: 'restore_wallet', success: false, deviceId, ipAddress })
    return jsonFor(req, { error: 'No wallet on file for this account' }, 404)
  }
  try {
    const privateKey = await decryptByVersion(row, userId)
    await rewrapIfStale(row, privateKey)
    await logAudit(supabase, { userId, walletId: row.wallet_id, operation: 'restore_wallet', success: true, deviceId, ipAddress })
    return jsonFor(req, { privateKey })
  } catch (e) {
    clientSafeError('[wallet-key] restore-full-key decrypt failed:', e)
    await logAudit(supabase, { userId, walletId: row.wallet_id, operation: 'decrypt_failure', success: false, deviceId, ipAddress })
    return jsonFor(req, { error: 'Decryption failed' }, 500)
  }
})
