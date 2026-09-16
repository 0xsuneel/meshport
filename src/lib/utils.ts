import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import {format} from 'date-fns'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatAmount(amount: number | null | undefined, decimals = 2): string {
  const n = amount == null || isNaN(Number(amount)) ? 0 : Number(amount)
  // minimumFractionDigits: 0 (not `decimals`) so a whole number renders as
  // "1", not "1.00", and a value like 1.5 renders as "1.5", not "1.50" —
  // Intl's toLocaleString already drops any trailing zeros beyond what the
  // number actually needs once the minimum no longer forces them. `decimals`
  // still caps the maximum precision shown, so this is purely trimming
  // trailing zeros, never adding or hiding real digits.
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  })
}

/**
 * Strip trailing zeros (and a now-dangling decimal point) from a fixed-
 * precision numeric string, e.g. "1.00" -> "1", "0.00000100" -> "0.000001",
 * "1.50" -> "1.5". Used by the tiered BTC/EURC/USDC amount formatters below
 * (ActivityPage.tsx's formatAmt, TransactionDetail.tsx's formatTokenAmount)
 * so real precision is preserved but padded zeros never show.
 */
export function trimTrailingZeros(fixed: string): string {
  if (!fixed.includes('.')) return fixed
  return fixed.replace(/0+$/, '').replace(/\.$/, '')
}

export function formatUSDC(amount: number): string {
  return `${formatAmount(amount)} USDC`
}

export function formatCurrency(amount: number): string {
  return `$${formatAmount(amount)}`
}

export function shortenAddress(address: string): string {
  if (!address) return ''
  return `${address.slice(0, 6)}...${address.slice(-6)}`
}

// Standard short address like MetaMask: 0x1a2b3c...d4e5f6
export function midShortenAddress(address: string): string {
  if (!address) return ''
  if (address.length <= 14) return address
  return `${address.slice(0, 6)}...${address.slice(-6)}`
}

export function timeAgo(dateString: string): string {
  try {
    const date = new Date(dateString)
    const now  = new Date()
    const diff = now.getTime() - date.getTime()
    const secs = Math.floor(diff / 1000)
    const mins = Math.floor(diff / 60000)
    const hrs  = Math.floor(diff / 3600000)
    const days = Math.floor(diff / 86400000)

    if (secs < 60)   return 'Just now'
    if (mins < 60)   return `${mins}m ago`
    if (hrs  < 24)   return `${hrs}h ago`
    if (days === 1)  return `Yesterday ${format(date, 'h:mm a')}`
    if (days < 7)    return format(date, 'EEE h:mm a')        // Mon 3:45 PM
    if (days < 365)  return format(date, 'MMM d, h:mm a')     // Jun 10, 3:45 PM
    return format(date, 'MMM d yyyy, h:mm a')                 // Jun 10 2024, 3:45 PM
  } catch {
    return ''
  }
}

export function formatDate(dateString: string): string {
  try {
    return format(new Date(dateString), 'MMM d, yyyy')
  } catch {
    return ''
  }
}

export function formatTime(dateString: string): string {
  try {
    return format(new Date(dateString), 'h:mm a')
  } catch {
    return ''
  }
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

// Cycles through the 4 exact avatar colors from the design spec
// (src/index.css --avatar-1..4, theme-aware) instead of an arbitrary
// Tailwind gradient palette — keeps every avatar in the app on-brand.
export function getAvatarColor(username: string): string {
  const colors = ['bg-avatar-1', 'bg-avatar-2', 'bg-avatar-3', 'bg-avatar-4']
  const index = username.charCodeAt(0) % colors.length
  return colors[index]
}

export function formatTVL(tvl: number): string {
  if (tvl >= 1_000_000) return `$${(tvl / 1_000_000).toFixed(1)}M`
  if (tvl >= 1_000) return `$${(tvl / 1_000).toFixed(0)}K`
  return `$${tvl}`
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const el = document.createElement('textarea')
      el.value = text
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      return true
    } catch {
      return false
    }
  }
}

// Same as copyToClipboard, but for genuinely sensitive values only (seed
// phrase / private key) — schedules an automatic clipboard clear after a
// short delay. Security-audit finding: every "Copy" button on the seed
// phrase and private key screens copied the raw secret to the OS clipboard
// with nothing ever clearing it afterward, so it sat there indefinitely —
// readable by any other app with clipboard access (clipboard managers,
// keyboards with clipboard history, etc.) until the user happened to copy
// something else over it. Every wallet's non-secret copy actions (address,
// tx hash, payment link, username) are UNCHANGED and still use plain
// copyToClipboard — only the four seed/private-key copy sites use this.
//
// Verifies the clipboard still holds exactly what was copied before
// clearing it, so this can't clobber something the user deliberately
// copied afterward (e.g. copied the seed, then immediately copied an
// address elsewhere before the timer fired).
export async function copySensitiveToClipboard(text: string, clearAfterMs = 45_000): Promise<boolean> {
  const ok = await copyToClipboard(text)
  if (!ok) return false
  setTimeout(async () => {
    try {
      const current = await navigator.clipboard.readText()
      if (current === text) await navigator.clipboard.writeText('')
    } catch {
      // Clipboard read permission denied, or execCommand fallback was used
      // (which has no read equivalent) — nothing more we can do here
      // without risking clobbering something unrelated the user copied.
    }
  }, clearAfterMs)
  return true
}

/**
 * Runs `fn` over `items` in small batches instead of all at once, awaiting
 * each batch before starting the next (with a short pause between them).
 * Preserves input order in the returned array — result[i] always
 * corresponds to items[i], same as a plain Promise.all(items.map(fn)) would.
 *
 * Built specifically to fix a confirmed, real rate-limit source: several
 * places in this app (HomePage's scanExternalBalances, MultichainPage's
 * scanBalances, MultichainClaimPage's claimable-balance scan) each fire one
 * eth_call per supported chain — around 21 of them — via a single
 * Promise.all, meaning all 21 requests hit their respective RPC endpoints
 * in the same instant. That happens on each page's own 60s interval AND
 * every time the tab regains focus, so a user bouncing between Home → Hub →
 * Claim within a short window can trigger several of these 21-way bursts in
 * quick succession. Several of those chains' free-tier RPC providers
 * (Alchemy, publicnode, etc.) enforce per-second request limits, not just
 * total volume — a burst of 21 simultaneous calls is exactly the shape of
 * traffic that trips those limits, which lines up with the repeated
 * "All RPCs failed" / 429 / 503 errors seen across many different chains
 * throughout this project, independent of any one chain's RPC list itself
 * being wrong. Batching spreads the same 21 requests over roughly 1.5-2
 * seconds instead of one instant — a trivial cost for a background balance
 * refresh, and it meaningfully reduces how often any single provider sees
 * a same-instant burst from just this one scan (still not a *complete* fix
 * if many users' scans happen to land in the same second — this is a
 * surgical, not systemic, fix).
 */
export async function staggeredMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  batchSize = 5,
  delayMs = 400,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    const batchResults = await Promise.all(batch.map(fn))
    for (let j = 0; j < batchResults.length; j++) results[i + j] = batchResults[j]
    if (i + batchSize < items.length) await new Promise(r => setTimeout(r, delayMs))
  }
  return results
}
