/**
 * /api/activity — Supabase bulk_payments metadata only
 *
 * Transaction history (sent/received/multichain) is fetched directly
 * from Arc RPC (eth_getLogs) in the browser — no server proxy needed.
 *
 * This endpoint exists only to read bulk_payments from Supabase
 * using the service key (which can't be exposed to the browser).
 *
 * GET /api/activity?address=0x...&limit=50
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'

const SUPABASE_URL         = process.env.SUPABASE_URL ?? ''
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
                          ?? process.env.SUPABASE_SERVICE_ROLE_KEY
                          ?? process.env.SUPABASE_ANON_KEY ?? ''

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin ?? ''
  res.setHeader('Access-Control-Allow-Origin',
    origin.includes('localhost') ? origin : (process.env.ALLOWED_ORIGIN ?? '*'))
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Content-Type', 'application/json')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { address, limit = '50' } = req.query as Record<string, string>
  if (!address || !isValidAddress(address)) {
    return res.status(400).json({ error: 'Invalid or missing address' })
  }

  const addr = address.toLowerCase()
  const lim  = Math.min(parseInt(limit) || 50, 100)
  const activities: any[] = []

  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5_000)
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/bulk_payments?wallet_address=ilike.${addr}&order=created_at.desc&limit=${lim}`,
        {
          signal: controller.signal,
          headers: {
            'apikey':        SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          },
        }
      )
      clearTimeout(timeout)
      if (r.ok) {
        const rows: any[] = await r.json()
        console.log(`[Activity] bulk_payments: ${rows?.length ?? 0} rows`)
        for (const row of (rows ?? [])) {
          const hash = (row.tx_hash ?? '').toLowerCase()
          activities.push({
            id:                 `bulk_${(row.id ?? hash) || Date.now()}`,
            type:               'bulk_payment',
            status:             row.status ?? 'completed',
            amount:             parseFloat(row.total_amount ?? '0'),
            usdValue:           parseFloat(row.total_amount ?? '0'),
            from:               addr,
            to:                 '',
            txHash:             hash,
            timestamp:          row.created_at ?? new Date().toISOString(),
            blockNumber:        0,
            explorerUrl:        hash ? `https://testnet.arcscan.app/tx/${hash}` : '',
            note:               row.purpose ?? 'Bulk Payment',
            bulkRecipientCount: row.recipient_count ?? 0,
            bulkPurpose:        row.purpose ?? '',
          })
        }
      } else {
        const body = await r.text().catch(() => '')
        console.warn('[Activity] Supabase error:', r.status, body.slice(0, 100))
      }
    } catch (e: any) {
      console.warn('[Activity] Supabase failed:', e?.name === 'AbortError' ? 'timeout' : e?.message)
    }
  }

  return res.status(200).json({
    success:    true,
    address:    addr,
    total:      activities.length,
    activities,
  })
}
