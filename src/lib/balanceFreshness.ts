// When the balance on screen was last read from the chain.
//
// Home opens with the last known balance straight away (cached-first, like
// other wallet apps). On 2G or offline the live read can take a while, so a
// balance that is more than STALE_MS old says how old it is ("Updated 5 min
// ago") until a live read lands - it is never presented as current.
// Payments don't rely on it: each send checks the balance live before signing.
import { useEffect, useState } from 'react'

export const STALE_MS = 2 * 60_000
const KEY = 'mp_balance_read_at:'
const listeners = new Set<() => void>()

function key(addr: string): string { return KEY + addr.toLowerCase() }

/** A live balance read for `addr` just succeeded. */
export function markBalanceRead(addr: string | null | undefined, at = Date.now()): void {
  if (!addr) return
  try { localStorage.setItem(key(addr), String(at)) } catch { /* private mode */ }
  listeners.forEach(l => l())
}

/** When `addr`'s balance was last read live, or null if never recorded. */
export function balanceReadAt(addr: string | null | undefined): number | null {
  if (!addr) return null
  try {
    const n = Number(localStorage.getItem(key(addr)))
    return Number.isFinite(n) && n > 0 ? n : null
  } catch { return null }
}

/** "5 min ago" / "3 h ago" / "2 days ago". */
export function formatAge(ms: number): string {
  const min = Math.max(1, Math.floor(ms / 60_000))
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.floor(h / 24)
  return d === 1 ? '1 day ago' : `${d} days ago`
}

/** "Updated 5 min ago" while `addr`'s shown balance is stale, else null. */
export function staleBalanceLabel(addr: string | null | undefined, now = Date.now()): string | null {
  const at = balanceReadAt(addr)
  if (at == null || now - at <= STALE_MS) return null
  return `Updated ${formatAge(now - at)}`
}

/** Live staleBalanceLabel: re-checked on each read and every 30 s. */
export function useStaleBalanceLabel(addr: string | null | undefined): string | null {
  const [label, setLabel] = useState(() => staleBalanceLabel(addr))
  useEffect(() => {
    const update = () => setLabel(staleBalanceLabel(addr))
    update()
    listeners.add(update)
    const t = setInterval(update, 30_000)
    return () => { listeners.delete(update); clearInterval(t) }
  }, [addr])
  return label
}
