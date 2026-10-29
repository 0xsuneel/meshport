// A payment saved as Processing whose screen was closed before it settled would
// stay Processing forever. On open, look each one up on Arc again: confirmed
// becomes Completed, reverted becomes Failed. One with no receipt yet is left
// as Processing (the payment screen is what knows its nonce).
import { fetchActivity, updateActivityStatus } from './ActivityService'
import { trackPendingSend } from './arcService'
import { FAILURE_MESSAGES } from './failure'

const WATCH_MS = 60_000
const seen = new Set<string>()

export async function sweepPendingSends(walletAddress: string | null | undefined): Promise<void> {
  if (!walletAddress) return
  try {
    const rows = await fetchActivity(walletAddress, { activityType: 'send', limit: 30 })
    for (const r of rows) {
      if (r.status !== 'pending' || !r.txHash) continue
      const hash = r.txHash.toLowerCase()
      if (seen.has(hash)) continue
      seen.add(hash)
      trackPendingSend(hash, { maxMs: WATCH_MS }, outcome => {
        const key = `send_${hash}`
        if (outcome === 'success') void updateActivityStatus(key, walletAddress, 'completed')
        else void updateActivityStatus(key, walletAddress, 'failed', FAILURE_MESSAGES.reverted)
      })
    }
  } catch { /* best-effort: the row stays Processing */ }
}
