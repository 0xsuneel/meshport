/**
 * /api/transactions — Save and fetch transactions using Supabase service key.
 *
 * Using the service key bypasses RLS entirely — wallet-only users (no Supabase
 * auth session) can save and read their own transactions by wallet_address.
 *
 * GET  /api/transactions?address=0x...        — fetch all txns for wallet
 * POST /api/transactions                       — save a transaction record
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'

const SUPABASE_URL  = process.env.SUPABASE_URL ?? ''
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY
                   ?? process.env.SUPABASE_SERVICE_ROLE_KEY
                   ?? process.env.SUPABASE_ANON_KEY ?? ''

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/i.test(addr)
}

async function supabaseFetch(path: string, options: RequestInit = {}) {
  const url = `${SUPABASE_URL}/rest/v1${path}`
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Prefer':        'return=minimal',
      ...(options.headers ?? {}),
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Supabase ${res.status}: ${text}`)
  }
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin ?? ''
  res.setHeader('Access-Control-Allow-Origin',
    origin.includes('localhost') ? origin : (process.env.ALLOWED_ORIGIN ?? '*'))
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Content-Type', 'application/json')
  if (req.method === 'OPTIONS') return res.status(200).end()

  // ── GET — fetch all transactions for a wallet ────────────────────────────
  if (req.method === 'GET') {
    const address = (req.query.address as string ?? '').toLowerCase()
    if (!isValidAddress(address)) {
      return res.status(400).json({ error: 'Invalid wallet address' })
    }
    try {
      const params = new URLSearchParams({
        select: '*',
        or:     `sender_address.eq.${address},receiver_address.eq.${address}`,
        order:  'created_at.desc',
        limit:  '200',
      })
      const data = await supabaseFetch(`/transactions?${params}`)
      return res.status(200).json({ transactions: data ?? [] })
    } catch (e: any) {
      console.error('[/api/transactions GET]', e.message)
      return res.status(500).json({ error: e.message, transactions: [] })
    }
  }

  // ── POST — save a transaction record ────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body ?? {}
    const { id, type, status, amount, senderAddress, receiverAddress, txHash, note, fee } = body

    if (!id || !type || !senderAddress || !receiverAddress) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const record = {
      id,
      type,
      status:           status ?? 'completed',
      amount:           parseFloat(amount) || 0,
      usd_value:        parseFloat(amount) || 0,
      sender_address:   (senderAddress as string).toLowerCase(),
      receiver_address: (receiverAddress as string).toLowerCase(),
      tx_hash:          txHash || null,
      note:             note || null,
      fee:              fee ?? null,
    }

    try {
      await supabaseFetch('/transactions?on_conflict=id', {
        method:  'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body:    JSON.stringify(record),
      })
      return res.status(200).json({ ok: true })
    } catch (e: any) {
      console.error('[/api/transactions POST]', e.message)
      return res.status(500).json({ error: e.message })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
