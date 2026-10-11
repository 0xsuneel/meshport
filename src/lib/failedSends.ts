// Failed sends, for the Pay page's Recent rows ("✕ $2 failed · Today, 4:03 PM").
//
// Only DEFINITE failures are recorded: the send threw (every node refused it,
// nothing went out) or its receipt reverted (result.state === 'failed'). A
// send whose receipt wait timed out is 'pending' - SUBMITTED_UNKNOWN, it may
// still land (Architecture rule 5) - and is never recorded here.
//
// Kept on this device per sending wallet, never in the activity ledger: a
// failed attempt moved no money, so it must not appear in history or
// balances. A later successful payment to the same person simply wins
// (newest first) when the Recent row picks what to show.

export type FailedSend = { to: string; amount: number; token: string; at: string }

const MAX = 50
const key = (wallet: string) => `meshport_failed_sends_${wallet.toLowerCase()}`

function read(wallet: string): FailedSend[] {
  try {
    const v = JSON.parse(localStorage.getItem(key(wallet)) || '[]')
    return Array.isArray(v) ? v.filter(f => f && typeof f.to === 'string' && typeof f.at === 'string') : []
  } catch { return [] }
}

export function recordFailedSend(fromWallet: string | null | undefined, f: { to: string; amount: number; token: string }) {
  if (!fromWallet || !f.to) return
  const entry: FailedSend = { to: f.to.toLowerCase(), amount: Number(f.amount) || 0, token: f.token || 'USDC', at: new Date().toISOString() }
  try { localStorage.setItem(key(fromWallet), JSON.stringify([entry, ...read(fromWallet)].slice(0, MAX))) } catch { /* storage full or blocked */ }
}

/** Latest failed send per recipient address (lowercase). */
export function failedSendsByAddress(fromWallet: string | null | undefined): Map<string, FailedSend> {
  const out = new Map<string, FailedSend>()
  if (!fromWallet) return out
  for (const f of read(fromWallet)) {
    const prev = out.get(f.to)
    if (!prev || prev.at < f.at) out.set(f.to, f)
  }
  return out
}
