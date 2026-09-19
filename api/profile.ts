import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyMessage } from 'viem'

/**
 * MERGED FUNCTIONS (to stay under Vercel's 12-function limit):
 * - GET  /api/profile?wallet=<address>  ← formerly api/get-profile.ts
 * - POST /api/profile                   ← formerly api/update-profile.ts
 *
 * ── 2026-09-19 SECURITY FIX ────────────────────────────────────────────────
 * handleUpdateProfile previously had NO auth check at all: any caller could
 * PATCH any user's display_name/avatar_url just by knowing (or guessing)
 * their id or wallet_address. Since this app has wallet-only users with no
 * Supabase Auth session (see the existing comment on the fetch-based headers
 * below), a normal Supabase-JWT check isn't available here — the only real
 * proof of identity this app has is a signature from the wallet's own
 * private key, the same key every send/claim/swap on this wallet already
 * signs with (see src/lib/arcService.ts's use of viem's
 * privateKeyToAccount). This fix requires exactly that: the client signs a
 * message over the wallet address, a timestamp, and the exact fields being
 * updated, and the server verifies that signature recovers to the claimed
 * wallet address before writing anything.
 *
 * The previous "match by id first, fall back to wallet" path is removed:
 * matching by id alone never proved the caller owned that row (id doesn't
 * require any signature), so it was a second way around the same hole even
 * with wallet-signature verification added elsewhere. Every update now goes
 * through the wallet-address path, which is the one that's actually
 * verified.
 *
 * REQUIRED CLIENT CHANGE: the caller must now sign the message this file
 * constructs (see buildProfileUpdateMessage below) with the wallet's
 * private key and send { walletAddress, timestamp, signature, displayName,
 * avatarUrl } instead of { id, walletAddress, displayName, avatarUrl }. See
 * the accompanying ProfileSubPages_signing_snippet.ts for the exact client
 * change — it needs to match however this app already retrieves the
 * signing key for a send (the same pattern PaySendPage.tsx uses), which
 * this patch can't see from api/profile.ts alone.
 */

// ── GET — fetch a user's public profile by wallet address ──────────────────
// Unchanged: this was never the flagged issue (a public display_name/avatar
// lookup by address is expected to be public), and locking it down further
// wasn't asked for here.
async function handleGetProfile(req: VercelRequest, res: VercelResponse) {
  const { wallet } = req.query

  const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim()
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || '').trim()

  if (!supabaseUrl || !key || !wallet) {
    return res.status(400).json({ error: 'missing params' })
  }

  const r = await fetch(
    `${supabaseUrl}/rest/v1/users?wallet_address=ilike.${wallet}&select=id,wallet_address,avatar_url,display_name`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  )
  const data = await r.json()
  return res.status(200).json(data)
}

// ── Signature verification ──────────────────────────────────────────────────
// 5-minute window bounds replay of a captured signature without needing a
// server-side nonce table — a captured signature is only ever valid for the
// exact (walletAddress, displayName, avatarUrl) triple it was signed over,
// for 5 minutes, and only ever lets someone re-apply the SAME update, not an
// arbitrary one.
const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000
const CLOCK_SKEW_SLACK_MS = 60 * 1000

function buildProfileUpdateMessage(
  walletAddress: string, timestamp: number, displayName?: string, avatarUrl?: string | null,
): string {
  return [
    'MeshPort profile update',
    `wallet: ${walletAddress.toLowerCase()}`,
    `timestamp: ${timestamp}`,
    `displayName: ${displayName ?? ''}`,
    `avatarUrl: ${avatarUrl ?? ''}`,
  ].join('\n')
}

async function verifyProfileUpdateSignature(
  walletAddress: string, timestamp: number, signature: string,
  displayName?: string, avatarUrl?: string | null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!walletAddress || !/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
    return { ok: false, reason: 'invalid or missing walletAddress' }
  }
  if (!signature || typeof signature !== 'string') {
    return { ok: false, reason: 'missing signature' }
  }
  if (!Number.isFinite(timestamp)) {
    return { ok: false, reason: 'missing or invalid timestamp' }
  }
  const age = Date.now() - timestamp
  if (age > SIGNATURE_MAX_AGE_MS || age < -CLOCK_SKEW_SLACK_MS) {
    return { ok: false, reason: 'signature expired or timestamp is in the future' }
  }
  const message = buildProfileUpdateMessage(walletAddress, timestamp, displayName, avatarUrl)
  try {
    const valid = await verifyMessage({
      address: walletAddress as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    })
    if (!valid) return { ok: false, reason: 'signature does not match walletAddress' }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, reason: `signature verification threw: ${e?.message ?? e}` }
  }
}

// ── POST — update (or upsert) a user's profile ──────────────────────────────
async function handleUpdateProfile(req: VercelRequest, res: VercelResponse) {
  try {
    const { walletAddress, timestamp, signature, displayName, avatarUrl } = req.body ?? {}
    if (!walletAddress) return res.status(400).json({ error: 'walletAddress required' })

    const verification = await verifyProfileUpdateSignature(
      String(walletAddress), Number(timestamp), String(signature ?? ''), displayName, avatarUrl,
    )
    if (!verification.ok) {
      console.warn('[profile/update] rejected — signature check failed:', verification.reason, 'wallet:', String(walletAddress).slice(0, 12))
      return res.status(401).json({ error: `Unauthorized: ${verification.reason}` })
    }

    const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim()
    const serviceKey  = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
    const anonKey     = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '').trim()
    const key         = serviceKey || anonKey

    if (!supabaseUrl || !key) {
      return res.status(500).json({ error: 'Missing SUPABASE_URL or key env var' })
    }

    // Use fetch-based HTTP calls directly — avoids WebSocket issue entirely
    const headers = {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    }

    const updates: Record<string, any> = {}
    if (displayName !== undefined) updates.display_name = String(displayName).trim()
    if (avatarUrl    !== undefined) updates.avatar_url  = avatarUrl || null

    const addr = String(walletAddress).toLowerCase()
    console.log('[profile/update] verified update, updates:', JSON.stringify(updates), 'wallet:', addr.slice(0, 12))

    // Find by wallet address — the ONLY identity this request has actually
    // proven ownership of. (The old "match by id first" path is gone: id
    // never proved ownership even before this fix.)
    const findR = await fetch(
      `${supabaseUrl}/rest/v1/users?wallet_address=ilike.${encodeURIComponent(addr)}&select=id,wallet_address&limit=1`,
      { method: 'GET', headers }
    )
    const rows = await findR.json()

    if (Array.isArray(rows) && rows.length > 0) {
      const rowId = rows[0].id
      const r = await fetch(`${supabaseUrl}/rest/v1/users?id=eq.${encodeURIComponent(rowId)}`, {
        method: 'PATCH', headers, body: JSON.stringify(updates),
      })
      const data = await r.json()
      console.log('[profile/update] patch result:', r.status, JSON.stringify(data).slice(0, 100))
      if (r.ok) return res.status(200).json({ success: true, method: 'by_wallet', rowId })
      return res.status(500).json({ error: JSON.stringify(data) })
    }

    // Not found — upsert. New id is derived from the VERIFIED wallet
    // address, not client-supplied, so it can't be used to collide with or
    // impersonate an existing user row.
    const newId = `w_${addr.slice(2, 18)}`
    const r = await fetch(`${supabaseUrl}/rest/v1/users`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({
        id: newId, wallet_address: addr,
        email: '', username: '',
        display_name: updates.display_name || '',
        avatar_url:   updates.avatar_url   || null,
      }),
    })
    const data = await r.json()
    console.log('[profile/update] upsert:', r.status, JSON.stringify(data).slice(0, 100))
    if (r.ok) return res.status(200).json({ success: true, method: 'upserted' })
    return res.status(500).json({ error: JSON.stringify(data) })

  } catch (err: any) {
    console.error('[profile/update] crash:', err?.message)
    return res.status(500).json({ error: err?.message || 'Internal error' })
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Content-Type', 'application/json')

  if (req.method === 'GET')  return handleGetProfile(req, res)
  if (req.method === 'POST') return handleUpdateProfile(req, res)

  return res.status(405).json({ error: 'Method not allowed' })
}
