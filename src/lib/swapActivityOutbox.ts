// Durable queue for a swap's Activity row.
//
// A swap that has landed on Arc must always show up in Activity. The row used
// to be written once, fire-and-forget, right after the swap: a dropped
// connection, an expired session, or a closed tab at that moment lost it for
// good. Now the row is saved to this device first, written to Activity, and
// removed from the queue only once the write is confirmed. Anything left over
// is retried when the app opens, when the tab becomes visible, and when the
// connection returns.
import { arcRpcJson } from './arc'

export type PendingSwapActivity = {
  walletAddress: string
  txHash: string
  amountIn: number
  amountOut: number
  tokenIn: string
  tokenOut: string
  queuedAt: number
  attempts: number
}

const KEY = 'meshport_swap_outbox_v1'
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_ATTEMPTS = 25

function load(): PendingSwapActivity[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(v) ? v : []
  } catch { return [] }
}
function save(items: PendingSwapActivity[]) {
  try { localStorage.setItem(KEY, JSON.stringify(items)) } catch { /* storage full or blocked: the in-flight write still runs */ }
}

export function enqueueSwapActivity(p: Omit<PendingSwapActivity, 'queuedAt' | 'attempts'>): void {
  if (!p.walletAddress || !p.txHash) return
  const hash = p.txHash.toLowerCase()
  const items = load()
  const existing = items.find(i => i.txHash.toLowerCase() === hash && i.walletAddress.toLowerCase() === p.walletAddress.toLowerCase())
  if (existing) {
    // A later call may know the real amount the first one did not.
    if (!(existing.amountOut > 0) && p.amountOut > 0) existing.amountOut = p.amountOut
    save(items)
    return
  }
  save([...items, { ...p, txHash: hash, queuedAt: Date.now(), attempts: 0 }])
}

/** The amount of tokenOut the swap really sent to the wallet, read from its receipt (0 when unknown). */
async function amountFromChain(item: PendingSwapActivity): Promise<number> {
  try {
    const [{ amountOutFromReceipt }] = await Promise.all([import('./swapService')])
    const j = await arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [item.txHash] })
    return parseFloat(amountOutFromReceipt(j?.result, item.tokenOut, item.walletAddress) || '0') || 0
  } catch { return 0 }
}

let flushing: Promise<void> | null = null

/** Writes every queued swap row for this wallet; whatever fails stays queued for the next run. */
export function flushSwapActivityOutbox(walletAddress: string | null | undefined): Promise<void> {
  if (!walletAddress) return Promise.resolve()
  if (flushing) return flushing
  flushing = (async () => {
    const addr = walletAddress.toLowerCase()
    const now = Date.now()
    const all = load().filter(i => now - i.queuedAt < MAX_AGE_MS && i.attempts < MAX_ATTEMPTS)
    save(all)
    const mine = all.filter(i => i.walletAddress.toLowerCase() === addr)
    if (!mine.length) return
    const { Activity } = await import('./ActivityService')
    for (const item of mine) {
      let ok = false
      try {
        if (!(item.amountOut > 0)) item.amountOut = await amountFromChain(item)
        ok = await Activity.swap({
          walletAddress: item.walletAddress, txHash: item.txHash,
          amountIn: item.amountIn, amountOut: item.amountOut,
          tokenIn: item.tokenIn, tokenOut: item.tokenOut, status: 'completed',
        })
      } catch { ok = false }
      const cur = load()
      if (ok) save(cur.filter(i => !(i.txHash === item.txHash && i.walletAddress.toLowerCase() === addr)))
      else save(cur.map(i => (i.txHash === item.txHash && i.walletAddress.toLowerCase() === addr) ? { ...i, amountOut: item.amountOut, attempts: i.attempts + 1 } : i))
    }
  })().finally(() => { flushing = null })
  return flushing
}

/** Retries on open, on returning to the tab and on reconnecting. Returns the cleanup. */
export function startSwapActivityOutbox(walletAddress: string | null | undefined): () => void {
  if (!walletAddress) return () => {}
  const run = () => { void flushSwapActivityOutbox(walletAddress) }
  const onVisible = () => { if (document.visibilityState === 'visible') run() }
  run()
  window.addEventListener('online', run)
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    window.removeEventListener('online', run)
    document.removeEventListener('visibilitychange', onVisible)
  }
}
