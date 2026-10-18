import type { ReactNode } from 'react'

// ─── Domain types ────────────────────────────────────────────────────────────

export type PaymentStatus = 'received' | 'to_settle' | 'refunded'

export interface Payment {
  id: string
  from: string        // e.g. "rahul.arc" or "0x8f2a…41c9"
  amount: string      // pre-formatted, e.g. "$48.00"
  chainLabel: string  // e.g. "Arc", "Base"
  chainLogo: string   // URL; falls back to letter circle
  time: string        // ISO timestamp
  order?: string      // optional order reference
  status: PaymentStatus
  /** Arrived after its order expired */
  late?: boolean
  /** Sender is on USDC's blocklist (screening) - don't ship, no refund */
  blocked?: boolean
}

export interface Chain {
  id: string
  label: string
  logo: string
  balance: string     // pre-formatted, e.g. "$312.40"
  /** Settle just this chain (like Bring Funds); absent = no button. */
  onSettle?: () => void
  settleDisabled?: boolean
}

export interface SettlementHistoryItem {
  id: string
  amount: string      // pre-formatted
  chainLabels: string[]
  when: string        // ISO
  status: 'completed' | 'in_progress' | 'failed'
}

export interface SettleProgressRow {
  id: string
  label: string       // chain name
  logo: string
  amount: string      // pre-formatted
  stage: 'waiting' | 'sending' | 'bridging' | 'verifying' | 'arrived' | 'failed'
  message?: string
}

// ─── Spring presets ──────────────────────────────────────────────────────────

export const springs = {
  snappy: { type: 'spring' as const, stiffness: 420, damping: 32 },
  gentle: { type: 'spring' as const, stiffness: 300, damping: 26 },
  sheet:  { type: 'spring' as const, stiffness: 400, damping: 36 },
}

// ─── Tiny formatting helpers (pure, no deps) ─────────────────────────────────

export function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function formatDay(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return 'Today'
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

export function groupByDay(payments: Payment[]): Array<{ day: string; total: string; items: Payment[] }> {
  const map = new Map<string, Payment[]>()
  for (const p of payments) {
    const key = new Date(p.time).toDateString()
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(p)
  }
  return Array.from(map.entries()).map(([key, items]) => {
    // Sum amounts for the day header
    const sum = items.reduce((acc, p) => {
      const n = parseFloat(p.amount.replace(/[^0-9.]/g, ''))
      return acc + (isNaN(n) ? 0 : n)
    }, 0)
    return {
      day: formatDay(new Date(key).toISOString()),
      total: `$${sum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      items,
    }
  })
}

// ─── Re-export ReactNode so components only need one import ──────────────────
export type { ReactNode }
