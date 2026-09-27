/**
 * /api/transactions — DISABLED 2026-09-19 (P0 security remediation).
 *
 * This endpoint used the Supabase service-role key with NO ownership check
 * on either verb:
 *   - POST accepted an arbitrary { id, type, status, amount, senderAddress,
 *     receiverAddress, txHash, note, fee } body and upserted it directly,
 *     with status defaulting to 'completed' — anyone could write a
 *     fabricated "completed" transaction attributing any amount to any two
 *     wallet addresses, with no signature, session, or other proof of
 *     ownership.
 *   - GET returned every transaction for any wallet address passed in the
 *     query string — no ownership check either, so any address's full
 *     transaction history was readable by anyone who knew (or enumerated)
 *     the address.
 *
 * This repo's own docs already flagged this as a confirmed P0
 * (docs/TRANSACTION_ARCHITECTURE_AUDIT.md, docs/PHASE_1_SCHEMA_DESIGN.md)
 * and marked the underlying `transactions` table "DEPRECATE LATER —
 * superseded by transaction_intents + ledger_events + the activity
 * projection." A repo-wide grep (src/**, api/**, docs/**) found zero
 * callers of this endpoint on either verb — the frontend reads/writes
 * transaction history through the `activity` table / transaction_intents
 * pipeline instead. Safe to disable outright rather than patch.
 *
 * Left in place (rather than deleted) as a 410 so any stray caller gets a
 * clear, diagnosable error instead of a generic 404/crash. Delete the file
 * entirely once you've confirmed nothing calls it in production traffic —
 * check Vercel's runtime logs for hits on this path over a full billing
 * cycle first.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin ?? ''
  res.setHeader('Access-Control-Allow-Origin',
    origin.includes('localhost') ? origin : (process.env.ALLOWED_ORIGIN ?? '*'))
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Content-Type', 'application/json')
  if (req.method === 'OPTIONS') return res.status(200).end()

  console.warn('[/api/transactions] disabled endpoint was hit:', req.method, req.headers['user-agent'])

  return res.status(410).json({
    error: 'This endpoint has been disabled — it had no ownership/auth check on either verb. ' +
           'Transaction history is read from the activity table / transaction_intents pipeline instead.',
  })
}
