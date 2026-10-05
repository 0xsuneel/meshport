/**
 * /api/activity — DISABLED (security audit 2026-10-04).
 *
 * It returned any wallet's bulk_payments (amounts, purposes, recipient
 * counts) to anyone who passed an address, using the service-role key and
 * no session check. Nothing in the app calls it — activity is read through
 * the `activity` table under RLS — so it's switched off rather than patched,
 * same as /api/transactions.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  return res.status(410).json({ error: 'This endpoint has been removed.' })
}
