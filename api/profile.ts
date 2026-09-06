import type { VercelRequest, VercelResponse } from '@vercel/node'

/**
 * MERGED FUNCTIONS (to stay under Vercel's 12-function limit):
 * - GET  /api/profile?wallet=<address>  ← formerly api/get-profile.ts
 * - POST /api/profile                   ← formerly api/update-profile.ts
 */

// ── GET — fetch a user's public profile by wallet address ──────────────────
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

// ── POST — update (or upsert) a user's profile ──────────────────────────────
async function handleUpdateProfile(req: VercelRequest, res: VercelResponse) {
  try {
    const { id, walletAddress, displayName, avatarUrl } = req.body ?? {}
    if (!id && !walletAddress) return res.status(400).json({ error: 'id or walletAddress required' })

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

    console.log('[profile/update] updates:', JSON.stringify(updates), 'wallet:', walletAddress?.slice(0,12))

    // Try update by id first
    if (id && !String(id).startsWith('usr_')) {
      const r = await fetch(`${supabaseUrl}/rest/v1/users?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', headers, body: JSON.stringify(updates),
      })
      const data = await r.json()
      console.log('[profile/update] by id status:', r.status, JSON.stringify(data).slice(0,100))
      if (r.ok && Array.isArray(data) && data.length > 0) {
        return res.status(200).json({ success: true, method: 'by_id' })
      }
    }

    // Find by wallet address
    if (walletAddress) {
      const addr = String(walletAddress).toLowerCase()

      // Search case-insensitive
      const findR = await fetch(
        `${supabaseUrl}/rest/v1/users?wallet_address=ilike.${encodeURIComponent(addr)}&select=id,wallet_address&limit=1`,
        { method: 'GET', headers }
      )
      const rows = await findR.json()
      console.log('[profile/update] found:', JSON.stringify(rows).slice(0,100))

      if (Array.isArray(rows) && rows.length > 0) {
        const rowId = rows[0].id
        const r = await fetch(`${supabaseUrl}/rest/v1/users?id=eq.${encodeURIComponent(rowId)}`, {
          method: 'PATCH', headers, body: JSON.stringify(updates),
        })
        const data = await r.json()
        console.log('[profile/update] patch result:', r.status, JSON.stringify(data).slice(0,100))
        if (r.ok) return res.status(200).json({ success: true, method: 'by_wallet', rowId })
        return res.status(500).json({ error: JSON.stringify(data) })
      }

      // Not found — upsert
      const newId = id || `w_${addr.slice(2, 18)}`
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
      console.log('[profile/update] upsert:', r.status, JSON.stringify(data).slice(0,100))
      if (r.ok) return res.status(200).json({ success: true, method: 'upserted' })
      return res.status(500).json({ error: JSON.stringify(data) })
    }

    return res.status(404).json({ error: 'User not found' })

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
