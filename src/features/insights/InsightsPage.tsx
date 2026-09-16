import React, { useMemo, useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {ArrowLeft, Calendar, ChevronDown, ArrowUp, ArrowDown, Link2, Sparkles} from 'lucide-react'
import { motion } from 'framer-motion'
import { useAuthStore } from '@/store'
import { formatAmount } from '@/lib/utils'
import { fetchActivity } from '@/lib/ActivityService'
type ActivityRecord = any
import {
  startOfMonth, endOfMonth, subMonths, isWithinInterval,
  format, getDate, getDaysInMonth, getHours, startOfWeek, endOfWeek, startOfYear
} from 'date-fns'
import { useMediaQuery } from '@/hooks/useMediaQuery'

// ─── Constants ────────────────────────────────────────────────────────────────
const CHAINS: Record<string, { name: string; color: string; bg: string; logo?: string }> = {
  Ethereum:    { name: 'Ethereum',   color: '#8b8fbe', bg: 'radial-gradient(circle,#4a4ea8,#1d2059)', logo: '/logos/chains/ethereum.svg'           },
  Base:        { name: 'Base',       color: '#2563eb', bg: '#2563EB',                                  logo: '/logos/chains/base.svg'            },
  Arbitrum:    { name: 'Arbitrum',   color: '#28A0F0', bg: '#213147',                                  logo: '/logos/chains/arbitrum.svg'            },
  Optimism:    { name: 'Optimism',   color: '#ff0420', bg: '#ff0420',                                  logo: '/logos/chains/optimism.svg'       },
  Polygon:     { name: 'Polygon',    color: '#8247e5', bg: 'radial-gradient(circle,#9558f5,#5a1fa8)', logo: '/logos/chains/polygon.svg'         },
  Avalanche:   { name: 'Avalanche',  color: '#E84142', bg: '#E84142',                                  logo: '/logos/chains/avalanche.svg' },
  HyperEVM:    { name: 'HyperEVM',   color: '#00C4FF', bg: '#020B22',                                  logo: '/logos/chains/hyperevm.svg'    },
  Sei:         { name: 'Sei',        color: '#9D3BE0', bg: '#9d2235',                                  logo: '/logos/chains/sei.svg'       },
  Sonic:       { name: 'Sonic',      color: '#FF6B2B', bg: '#0A1B3D',                                  logo: '/logos/chains/sonic.svg'         },
  Unichain:      { name: 'Unichain',   color: '#FF007A', bg: '#FF007A',                                  logo: '/logos/chains/unichain.svg'       },
  'World Chain': { name: 'World Chain',color: '#ffffff', bg: '#191919',                                  logo: '/logos/chains/world.svg'      },
  'Arc Testnet': { name: 'Arc',        color: '#2563EB', bg: '#2563EB', logo: '/logos/chains/arc.svg' },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function normalizeType(t: string) { return t === 'bridge' ? 'multichain' : t }

function filterByPeriod(txs: ActivityRecord[], period: 'month' | 'week' | 'year') {
  const now = new Date()
  const start = period === 'month' ? startOfMonth(now)
              : period === 'week'  ? startOfWeek(now, { weekStartsOn: 1 })
              :                      startOfYear(now)
  const end = period === 'month' ? endOfMonth(now)
            : period === 'week'  ? endOfWeek(now, { weekStartsOn: 1 })
            :                      now
  return txs.filter(tx => {
    try {
      const d = new Date(tx.createdAt || tx.timestamp)
      if (isNaN(d.getTime())) return false
      return isWithinInterval(d, { start, end })
    } catch { return false }
  })
}

function filterPrevPeriod(txs: ActivityRecord[], period: 'month' | 'week' | 'year') {
  const now = new Date()
  const safeInterval = (d: Date, start: Date, end: Date) => {
    try { return !isNaN(d.getTime()) && isWithinInterval(d, { start, end }) } catch { return false }
  }
  if (period === 'month') {
    const prev = subMonths(now, 1)
    return txs.filter(tx => safeInterval(new Date(tx.createdAt || tx.timestamp), startOfMonth(prev), endOfMonth(prev)))
  }
  if (period === 'week') {
    const prev = new Date(now.getTime() - 7 * 86400000)
    return txs.filter(tx => safeInterval(new Date(tx.createdAt || tx.timestamp),
      startOfWeek(prev, { weekStartsOn: 1 }),
      endOfWeek(prev, { weekStartsOn: 1 })))
  }
  const prevYear = new Date(now.getFullYear() - 1, 0, 1)
  return txs.filter(tx => safeInterval(new Date(tx.createdAt || tx.timestamp), prevYear,
    new Date(now.getFullYear() - 1, 11, 31)))
}

function pctChange(curr: number, prev: number) {
  if (prev === 0) return curr > 0 ? 100 : 0
  return Math.round(((curr - prev) / prev) * 100)
}

// ─── Sparkline SVG ────────────────────────────────────────────────────────────
function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (!values.length) return <svg className="w-full h-5" viewBox="0 0 72 20" preserveAspectRatio="none"/>
  const max = Math.max(...values, 1)
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * 72
    const y = 18 - (v / max) * 15
    return `${x},${y}`
  }).join(' ')
  return (
    <svg className="w-full h-5" viewBox="0 0 72 20" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.7"
        strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

// ─── Area Chart SVG (hero) ────────────────────────────────────────────────────
function HeroChart({ values }: { values: number[] }) {
  const HEIGHT = 72
  if (values.length < 2) {
    return (
      <svg className="w-full" style={{ height: HEIGHT, display: 'block', marginBottom: 10, overflow: 'visible' }}
        viewBox={`0 0 340 ${HEIGHT}`} preserveAspectRatio="none"/>
    )
  }
  const max = Math.max(...values, 1)
  const W = 340, H = HEIGHT - 4
  const pad = 4
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (W - pad * 2) + pad
    const y = H - pad - (v / max) * (H - pad * 2)
    return [x, y] as [number, number]
  })

  // Catmull-Rom → cubic bezier for a genuinely smooth curve through points
  const smoothPath = (points: [number, number][]) => {
    if (points.length < 2) return ''
    let d = `M ${points[0][0]},${points[0][1]}`
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i === 0 ? 0 : i - 1]
      const p1 = points[i]
      const p2 = points[i + 1]
      const p3 = points[i + 2 < points.length ? i + 2 : i + 1]
      const c1x = p1[0] + (p2[0] - p0[0]) / 6
      const c1y = p1[1] + (p2[1] - p0[1]) / 6
      const c2x = p2[0] - (p3[0] - p1[0]) / 6
      const c2y = p2[1] - (p3[1] - p1[1]) / 6
      d += ` C ${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${p2[1]}`
    }
    return d
  }

  const d = smoothPath(pts)
  const area = d + ` L ${pts[pts.length - 1][0]},${H} L ${pts[0][0]},${H} Z`
  const endX = pts[pts.length - 1][0]
  const endY = pts[pts.length - 1][1]

  return (
    <svg className="w-full" style={{ height: HEIGHT, display: 'block', marginBottom: 10, overflow: 'visible' }}
      viewBox={`0 0 ${W} ${HEIGHT}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="hag" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--brand)" stopOpacity=".32"/>
          <stop offset="100%" stopColor="var(--brand)" stopOpacity="0"/>
        </linearGradient>
      </defs>
      {/* grid */}
      {[0.25, 0.5, 0.75].map(f => (
        <line key={f} x1="0" y1={H * f} x2={W} y2={H * f}
          stroke="color-mix(in srgb, var(--text-primary) 5%, transparent)" strokeWidth="1"/>
      ))}
      <path d={area} fill="url(#hag)"/>
      <path d={d} fill="none" stroke="var(--brand)" strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round"/>
      {/* end dot */}
      <circle cx={endX} cy={endY} r="7" fill="var(--brand)" opacity=".2"/>
      <circle cx={endX} cy={endY} r="4.5" fill="var(--brand)" opacity=".45"/>
      <circle cx={endX} cy={endY} r="2.5" fill="var(--accent)"/>
    </svg>
  )
}

// ─── Bar Chart ────────────────────────────────────────────────────────────────
function BarChart({ data, labels, highlightIdx, tooltip }:
  { data: number[]; labels: string[]; highlightIdx: number; tooltip: { label: string; value: number } | null }) {
  const max = Math.max(...data, 1)
  return (
    <div style={{ position: 'relative', marginTop: 4 }}>
      {/* tooltip */}
      {tooltip && (
        <div style={{
          position: 'absolute', top: 0, left: '36%',
          background: 'var(--surface)', border: '1px solid color-mix(in srgb, var(--brand) 38%, transparent)',
          borderRadius: 9, padding: '6px 10px', zIndex: 6, pointerEvents: 'none', whiteSpace: 'nowrap',
        }}>
          <div style={{ fontSize: 11, color: 'var(--brand)', fontWeight: 600, marginBottom: 1 }}>{tooltip.label}</div>
          <div style={{ fontSize: 12, color: 'var(--text-primary)', fontWeight: 700 }}>{tooltip.value} transactions</div>
        </div>
      )}

      {/* bars + y-axis */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3.5, height: 118, paddingLeft: 22, position: 'relative' }}>
        {/* y-axis */}
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 20, width: 20,
          display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        }}>
          {[max, Math.round(max * 0.67), Math.round(max * 0.33), 0].map((v, i) => (
            <span key={i} style={{ fontSize: 9, color: 'var(--text-muted)', textAlign: 'right', lineHeight: 1 }}>{v}</span>
          ))}
        </div>
        {data.map((v, i) => {
          const hi = i === highlightIdx
          const pct = max > 0 ? (v / max) * 100 : 3
          return (
            <div key={i} style={{ flex: 1, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', height: '100%' }}>
              <div style={{
                width: '100%', maxWidth: 9, minHeight: 3,
                borderRadius: '3px 3px 0 0',
                height: `${pct}%`,
                background: hi
                  ? 'linear-gradient(180deg,var(--accent) 0%,var(--brand) 100%)'
                  : 'linear-gradient(180deg,color-mix(in srgb, var(--accent) 85%, transparent) 0%,color-mix(in srgb, var(--brand) 45%, transparent) 100%)',
              }}/>
            </div>
          )
        })}
      </div>

      {/* x-axis */}
      <div style={{ display: 'flex', justifyContent: 'space-between', paddingLeft: 22, paddingTop: 5 }}>
        {labels.map((l, i) => (
          <span key={i} style={{ fontSize: 9.5, color: 'var(--text-secondary)' }}>{l}</span>
        ))}
      </div>
    </div>
  )
}

// ─── Chain Logo ───────────────────────────────────────────────────────────────
function ChainLogo({ name, size = 22 }: { name: string; size?: number }) {
  const cfg = CHAINS[name]
  const [ok, setOk] = React.useState(true)
  if (cfg?.logo && ok) {
    return (
      <img src={cfg.logo} alt={name} width={size} height={size}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
        onError={() => setOk(false)} />
    )
  }
  const bg  = cfg?.bg  || 'var(--surface)'
  const lbl = (cfg?.name || name).slice(0, 1).toUpperCase()
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', background: bg,
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <span style={{ fontSize: size * 0.45, fontWeight: 700, color: cfg?.bg ? '#fff' : 'var(--text-primary)' }}>{lbl}</span>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────
export function InsightsPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const user = useAuthStore(s => s.user)
  const [transactions, setTransactions] = useState<ActivityRecord[]>([])
  const [balance, setBalance] = useState(0)
  const walletAddress = useAuthStore(s => s.walletAddress) ?? ''

  const [period, setPeriod] = useState<'month' | 'week' | 'year'>('month')
  const [actTab, setActTab] = useState<'daily' | 'weekly' | 'monthly'>('daily')

  // Load activity from Supabase
  useEffect(() => {
    if (!walletAddress) return
    fetchActivity(walletAddress, { limit: 200 }).then(records => {
      setTransactions(records as any)
    }).catch(() => {})
    import('@/store').then(({ useWalletStore }) => {
      setBalance(useWalletStore.getState().balance)
    })
  }, [walletAddress])

  // ── Derived analytics from real transaction data ──────────────────────────
  const stats = useMemo(() => {
    const all = transactions.map(tx => ({ ...tx, type: normalizeType(tx.type) }))
    const curr = filterByPeriod(all, period)
    const prev = filterPrevPeriod(all, period)

    // Sent
    const sentTxs  = curr.filter((t: any) => t.activityType === 'send' || t.activityType === 'bulk' || t.type === 'sent' || t.type === 'bulk_payout')
    const sentPrev  = prev.filter((t: any) => t.activityType === 'send' || t.activityType === 'bulk' || t.type === 'sent' || t.type === 'bulk_payout')
    const sentVol   = sentTxs.reduce((s, t) => s + t.amount, 0)
    const sentPrevV = sentPrev.reduce((s, t) => s + t.amount, 0)
    const sentPct   = pctChange(sentVol, sentPrevV)

    // Received
    const recvTxs  = curr.filter((t: any) => t.activityType === 'receive' || t.type === 'received' || t.type === 'rewards')
    const recvPrev  = prev.filter((t: any) => t.activityType === 'receive' || t.type === 'received' || t.type === 'rewards')
    const recvVol   = recvTxs.reduce((s, t) => s + t.amount, 0)
    const recvPrevV = recvPrev.reduce((s, t) => s + t.amount, 0)
    const recvPct   = pctChange(recvVol, recvPrevV)

    // Total volume
    const totalVol  = sentVol + recvVol
    const totalPrev = sentPrevV + recvPrevV
    const volPct    = pctChange(totalVol, totalPrev)

    // Net flow
    const netFlow = recvVol - sentVol

    // Treasury (use wallet balance as proxy for total assets)
    const treasuryVal     = balance
    const treasuryPrevTxs = prev.filter(t => (t as any).type === 'treasury')
    const treasuryPct     = 18 // static since no live treasury history yet

    // Active contacts — unique counterparties this period
    // toUsername/fromUsername live inside metadata, not as top-level fields
    // on ActivityRecord (confirmed against ActivityService.ts and the
    // working reference implementation in ActivityPage.tsx) — checking
    // t.toUsername directly was always undefined, so this never populated.
    const contactSet = new Set<string>()
    curr.forEach(t => {
      const meta = (t as any).metadata || {}
      if (meta.toUsername)   contactSet.add(meta.toUsername)
      if (meta.fromUsername) contactSet.add(meta.fromUsername)
    })
    const prevContactSet = new Set<string>()
    prev.forEach(t => {
      const meta = (t as any).metadata || {}
      if (meta.toUsername)   prevContactSet.add(meta.toUsername)
      if (meta.fromUsername) prevContactSet.add(meta.fromUsername)
    })
    const activeContacts = contactSet.size
    const contactPct     = pctChange(contactSet.size, prevContactSet.size)

    // Most active contact
    const contactCounts: Record<string, number> = {}
    curr.forEach(t => {
      const meta = (t as any).metadata || {}
      // Only count .arc usernames — skip raw wallet addresses
      const toName   = meta.toUsername   || ''
      const fromName = meta.fromUsername || ''
      if (toName   && !toName.startsWith('0x'))   contactCounts[toName]   = (contactCounts[toName]   || 0) + 1
      if (fromName && !fromName.startsWith('0x'))  contactCounts[fromName] = (contactCounts[fromName] || 0) + 1
    })
    const mostActiveContact = Object.entries(contactCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || user?.username || '—'

    // Multichain usage - bridge=sent, deposit=sent to UB, claim=received
    const mcTxs = curr.filter(t => ['bridge','deposit','claim'].includes((t as any).activityType))
    const mcSent     = mcTxs.filter(t => (t as any).activityType === 'bridge' || (t as any).activityType === 'deposit')
    const mcReceived = mcTxs.filter(t => (t as any).activityType === 'claim')
    const mcSentVol  = mcSent.reduce((s: number, t: any) => s + (t.amount || 0), 0)
    const mcRecvVol  = mcReceived.reduce((s: number, t: any) => s + (t.amount || 0), 0)
    const chainCounts: Record<string, number> = {}
    // Placeholder destination labels that don't represent a real external
    // chain (Arc itself, or the internal Unified Balance ledger) — these
    // must never be counted as "chain usage" in the breakdown below. Real
    // claim records store 'Arc_Testnet' (underscore) and deposit records
    // store 'Unified Balance' (see ActivityService.ts), not 'Arc Testnet'
    // (space) — the old check only matched the space variant, so claims and
    // deposits were leaking in as fake "chains" named Arc_Testnet / Unified
    // Balance in the top-chains list.
    const NON_EXTERNAL_CHAIN_LABELS = new Set(['Arc Testnet', 'Arc_Testnet', 'Unified Balance', 'Unknown'])
    mcTxs.forEach((t: any) => {
      const src = t.sourceChain || t.bridgeSourceChain || 'Unknown'
      const dst = t.destinationChain || t.bridgeDestChain || 'Arc Testnet'
      if (!NON_EXTERNAL_CHAIN_LABELS.has(src)) chainCounts[src] = (chainCounts[src] || 0) + 1
      if (!NON_EXTERNAL_CHAIN_LABELS.has(dst)) chainCounts[dst] = (chainCounts[dst] || 0) + 1
    })
    const totalMcTxs = mcTxs.length
    const chainUsage = Object.entries(chainCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([chain, count]) => ({
        chain,
        count,
        pct: totalMcTxs > 0 ? Math.round((count / totalMcTxs) * 100) : 0,
      }))

    // Top 3 chains for hero
    const topChains = chainUsage.slice(0, 3).map(c => c.chain)
    // Fill with defaults if not enough multichain txs
    const defaultChains = ['Arbitrum', 'Base', 'Ethereum']
    const displayChains = topChains.length >= 3 ? topChains
      : [...new Set([...topChains, ...defaultChains])].slice(0, 3)

    // Payment intelligence
    const payAmounts = curr
      .filter(t => (t as any).activityType === 'send' || (t as any).activityType === 'receive' || (t as any).type === 'sent' || (t as any).type === 'received')
      .map(t => t.amount)
    const avgPayment  = payAmounts.length
      ? payAmounts.reduce((s, v) => s + v, 0) / payAmounts.length
      : 0
    const largestPayment = payAmounts.length ? Math.max(...payAmounts) : 0

    // Most active hour
    const hourCounts: Record<number, number> = {}
    curr.forEach(t => {
      const h = getHours(new Date(t.createdAt || t.timestamp))
      hourCounts[h] = (hourCounts[h] || 0) + 1
    })
    const mostActiveHour = Object.entries(hourCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0]
    const mostActiveHourLabel = mostActiveHour !== undefined
      ? format(new Date().setHours(Number(mostActiveHour), 0, 0, 0), 'h:00 a')
      : 'N/A'

    // Payment frequency (txs per day in period)
    const daysInPeriod = period === 'week' ? 7 : period === 'month' ? 30 : 365
    const txFreq = curr.length > 0
      ? (curr.length / daysInPeriod).toFixed(1)
      : '0.0'

    // Swap volume from Supabase activity records
    let swapVol = 0
    let swapCount = 0
    const swapTxs = all.filter((tx: any) => tx.activityType === 'swap' || tx.activityType === 'swap')
    swapTxs.forEach((sw: any) => {
        const d = new Date(sw.createdAt || sw.timestamp)
        const now2 = new Date()
        const start2 = period === 'week'
          ? new Date(now2.getTime() - 7*86400000)
          : period === 'month'
          ? new Date(now2.getFullYear(), now2.getMonth(), 1)
          : new Date(now2.getFullYear(), 0, 1)
        if (d >= start2 && (sw.status === 'completed' || sw.status === 'success')) {
          swapVol += parseFloat(sw.metadata?.amountIn || sw.amount || '0')
          swapCount++
        }
    })
    return {
      sentVol, sentPct,
      recvVol, recvPct,
      totalVol, volPct,
      netFlow,
      mcSentVol, mcRecvVol,
      activeContacts, contactPct,
      mostActiveContact,
      topChains: displayChains,
      chainUsage: chainUsage.length > 0 ? chainUsage : [
        { chain: 'Arbitrum', count: 0, pct: 0 },
        { chain: 'Base',     count: 0, pct: 0 },
        { chain: 'Ethereum', count: 0, pct: 0 },
      ],
      totalMcTxs,
      swapVol, swapCount,
      avgPayment, largestPayment, mostActiveHourLabel, txFreq,
      recvPctForPI: recvPct,
      totalTxCount: curr.length,
      all, curr,
    }
  }, [transactions, balance, period, user, walletAddress])

  // ── Activity chart data ───────────────────────────────────────────────────
  const chartData = useMemo(() => {
    const now = new Date()
    const { all } = stats

    if (actTab === 'daily') {
      // Last 28 days of current month
      const days = getDaysInMonth(now)
      const counts = Array(days).fill(0)
      all.forEach(tx => {
        const d = new Date(tx.createdAt || tx.timestamp)
        if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) {
          counts[getDate(d) - 1]++
        }
      })
      const maxIdx = counts.indexOf(Math.max(...counts))
      const maxDay = maxIdx >= 0 ? maxIdx + 1 : 1
      const monthName = format(now, 'MMM')
      const labels = [1, 8, 15, 22, 29].map(d => `${monthName} ${d}`)
      const tooltip = counts[maxIdx] > 0
        ? { label: `${monthName} ${maxDay}`, value: counts[maxIdx] }
        : null
      return { bars: counts.slice(0, 28), labels, highlightIdx: maxIdx, tooltip }
    }

    if (actTab === 'weekly') {
      // Last 12 weeks
      const counts = Array(12).fill(0)
      all.forEach(tx => {
        const diffMs = now.getTime() - new Date(tx.createdAt || tx.timestamp).getTime()
        const diffWeeks = Math.floor(diffMs / (7 * 86400000))
        if (diffWeeks < 12) counts[11 - diffWeeks]++
      })
      const maxIdx = counts.indexOf(Math.max(...counts))
      const labels = ['W-11', 'W-8', 'W-5', 'W-2', 'Now']
      return { bars: counts, labels, highlightIdx: maxIdx,
        tooltip: counts[maxIdx] > 0 ? { label: `Week ${maxIdx + 1}`, value: counts[maxIdx] } : null }
    }

    // monthly — last 12 months
    const counts = Array(12).fill(0)
    all.forEach(tx => {
      const d = new Date(tx.createdAt || tx.timestamp)
      const diffMonths = (now.getFullYear() - d.getFullYear()) * 12
        + (now.getMonth() - d.getMonth())
      if (diffMonths >= 0 && diffMonths < 12) counts[11 - diffMonths]++
    })
    const maxIdx = counts.indexOf(Math.max(...counts))
    const months = Array.from({ length: 12 }, (_, i) => {
      const d = subMonths(now, 11 - i)
      return format(d, 'MMM')
    })
    const labels = [months[0], months[3], months[6], months[9], months[11]]
    return { bars: counts, labels, highlightIdx: maxIdx,
      tooltip: counts[maxIdx] > 0
        ? { label: months[maxIdx], value: counts[maxIdx] }
        : null }
  }, [stats, actTab])

  // ── Hero chart values (daily totals for smooth curve) ────────────────────
  const heroValues = useMemo(() => {
    const now = new Date()
    const days = 20
    const vals: number[] = []
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000)
      const dayTotal = stats.curr
        .filter(tx => {
          const td = new Date(tx.createdAt || tx.timestamp)
          return td.getDate() === d.getDate()
            && td.getMonth() === d.getMonth()
            && td.getFullYear() === d.getFullYear()
        })
        .reduce((s, tx) => s + tx.amount, 0)
      vals.push(dayTotal)
    }
    // If no data, generate a gentle rising curve so the chart looks right
    if (vals.every(v => v === 0)) {
      return [0, 0.1, 0.2, 0.15, 0.25, 0.3, 0.28, 0.35, 0.4, 0.38,
              0.45, 0.5, 0.55, 0.52, 0.6, 0.7, 0.75, 0.8, 0.9, 1.0].map(v => v * 100)
    }
    return vals
  }, [stats])

  // ── Sparkline per-day values for stat cards ───────────────────────────────
  const sparklines = useMemo(() => {
    const days = 14
    const now = new Date()
    const sentD   = Array(days).fill(0)
    const recvD   = Array(days).fill(0)
    const treasD  = Array(days).fill(0)
    const contD   = Array(days).fill(0)
    const contactSets: Set<string>[] = Array.from({ length: days }, () => new Set())

    stats.all.forEach(tx => {
      const d = new Date(tx.createdAt || tx.timestamp)
      const diffD = Math.floor((now.getTime() - d.getTime()) / 86400000)
      if (diffD < 0 || diffD >= days) return
      const idx = days - 1 - diffD
      const meta = (tx as any).metadata || {}
      const at = (tx as any).activityType
      if (at === 'send' || at === 'bulk') sentD[idx] += tx.amount
      if (at === 'receive') recvD[idx] += tx.amount
      if (at === 'deposit') treasD[idx] += tx.amount
      if (meta.toUsername)   contactSets[idx].add(meta.toUsername)
      if (meta.fromUsername) contactSets[idx].add(meta.fromUsername)
    })
    contactSets.forEach((s, i) => { contD[i] = s.size })
    return { sentD, recvD, treasD, contD }
  }, [stats])

  const periodLabel = period === 'month' ? 'This Month' : period === 'week' ? 'This Week' : 'This Year'

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 overflow-y-auto lg:max-w-[900px]" style={{ background: 'var(--bg)' }}>

      {/* ── Page Header ────────────────────────────────────────────────── */}
      <div style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 22px)', paddingLeft: 20, paddingRight: 20, paddingBottom: 0, position: 'sticky', top: 0, zIndex: 20, background: 'color-mix(in srgb, var(--bg) 95%, transparent)', backdropFilter: 'blur(12px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {!isDesktop && (
              <button onClick={() => navigate('/')} className="back-btn">
                <ArrowLeft className="w-5 h-5 text-text-primary"/>
              </button>
            )}
            <div>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.2px', lineHeight: 1.2 }}>
                Insights
              </div>
              <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 3 }}>Your payment intelligence</div>
            </div>
          </div>
        </div>
      </div>

      {/* ── HERO CARD ──────────────────────────────────────────────────── */}
      <div style={{ margin: '0 14px 12px' }}>
        <motion.div
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
          style={{
            borderRadius: 20,
            background: 'var(--surface)',
            border: '1px solid color-mix(in srgb, var(--brand) 28%, transparent)',
            padding: '16px 16px 14px', position: 'relative', overflow: 'hidden',
          }}
        >
          <div style={{ position: 'relative', zIndex: 1 }}>

            {/* Period selector */}
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              {['month', 'week', 'year'].map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p as any)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    padding: '5px 11px', marginRight: 6,
                    background: period === p ? 'color-mix(in srgb, var(--brand) 25%, transparent)' : 'color-mix(in srgb, var(--brand) 10%, transparent)',
                    border: period === p ? '1px solid color-mix(in srgb, var(--brand) 45%, transparent)' : '1px solid color-mix(in srgb, var(--brand) 20%, transparent)',
                    borderRadius: 22, fontSize: 12, fontWeight: 600,
                    color: period === p ? 'var(--text-primary)' : 'var(--brand)',
                    cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  {p === period && <Calendar size={12}/>}
                  {p === 'month' ? 'This Month' : p === 'week' ? 'This Week' : 'This Year'}
                  {p === period && <ChevronDown size={10} color="var(--brand)"/>}
                </button>
              ))}
            </div>

            {/* Volume */}
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 3 }}>
              Total Volume
            </div>
            <div style={{ fontSize: 40, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-1.5px', lineHeight: 1, marginBottom: 10 }}>
              ${formatAmount(stats.totalVol)}
            </div>

            <HeroChart values={heroValues}/>

            {/* Divider */}
            <div style={{ height: 1, background: 'color-mix(in srgb, var(--text-primary) 7%, transparent)', margin: '0 0 13px' }}/>

            {/* 3 cols: Net Flow | Most Active Contact | Most Used Multichain */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr' }}>
              {/* Net Flow */}
              <div style={{ paddingRight: 8 }}>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 3 }}>
                  Net Flow
                </div>
                <div style={{ fontSize: 20, fontWeight: 700, color: stats.netFlow >= 0 ? 'var(--success)' : 'var(--danger)', letterSpacing: '-.4px', lineHeight: 1 }}>
                  {stats.netFlow >= 0 ? '+' : '-'}${formatAmount(Math.abs(stats.netFlow))}
                </div>
              </div>

              {/* Most Active Contact */}
              <div style={{ paddingRight: 8 }}>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 5 }}>Most Active Contact</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
                  <div style={{
                    width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                    background: 'var(--brand)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 9, fontWeight: 700, color: '#fff',
                  }}>
                    {(stats.mostActiveContact[0] || 'U').toUpperCase()}
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
                    {stats.mostActiveContact.replace(/\.arc$/, '')}.arc
                  </span>
                </div>
              </div>

              {/* Swap Volume */}
              <div>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 3 }}>
                  Swap Volume
                </div>
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--brand)', letterSpacing: '-.4px', lineHeight: 1, marginBottom: 2 }}>
                  ${formatAmount(stats.swapVol)}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{stats.swapCount} swaps</div>
              </div>
            </div>

          </div>
        </motion.div>
      </div>

      {/* ── STAT CARDS ──────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, padding: '0 14px 12px' }}>
        {[
          {
            icon: <ArrowUp size={14} color="var(--brand)"/>,
            iconBg: 'color-mix(in srgb, var(--brand) 20%, transparent)',
            label: 'Paid',
            value: `$${formatAmount(stats.sentVol)}`,
            pct: stats.sentPct,
            pctPositive: false,
            spark: sparklines.sentD,
            sparkColor: 'var(--brand)',
          },
          {
            icon: <ArrowDown size={14} color="var(--success)"/>,
            iconBg: 'color-mix(in srgb, var(--success) 18%, transparent)',
            label: 'Received',
            value: `$${formatAmount(stats.recvVol)}`,
            pct: stats.recvPct,
            pctPositive: true,
            spark: sparklines.recvD,
            sparkColor: 'var(--success)',
          },

          {
            icon: (
              <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>
              </svg>
            ),
            iconBg: 'color-mix(in srgb, var(--accent) 16%, transparent)',
            label: 'Active Contacts',
            value: String(stats.activeContacts),
            pct: stats.contactPct,
            pctPositive: true,
            spark: sparklines.contD,
            sparkColor: 'var(--accent)',
          },
        ].map((c, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 * i }}
            style={{
              background: 'var(--surface)', border: '1px solid color-mix(in srgb, var(--text-primary) 7%, transparent)',
              borderRadius: 16, padding: '11px 10px 9px', overflow: 'hidden',
            }}
          >
            <div style={{ width: 28, height: 28, borderRadius: 9, background: c.iconBg,
              display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 7 }}>
              {c.icon}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', fontWeight: 500, marginBottom: 5 }}>{c.label}</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-.4px', marginBottom: 3 }}>{c.value}</div>
            <div style={{ fontSize: 9, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 2, marginBottom: 6,
              color: c.pctPositive
                ? (c.pct >= 0 ? 'var(--success)' : 'var(--danger)')
                : (c.pct <= 0 ? 'var(--success)' : 'var(--danger)') }}>
              {(c.pctPositive ? c.pct >= 0 : c.pct <= 0) ? '↑' : '↓'}
              {Math.abs(c.pct)}% vs last month
            </div>
            <Sparkline values={c.spark} color={c.sparkColor}/>
          </motion.div>
        ))}
      </div>

      {/* ── ACTIVITY CARD ───────────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        style={{
          margin: '0 14px 12px',
          background: 'var(--surface)', border: '1px solid color-mix(in srgb, var(--text-primary) 7%, transparent)',
          borderRadius: 20, padding: '14px 14px 12px',
        }}
      >
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 10,
              background: 'color-mix(in srgb, var(--brand) 15%, transparent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Calendar size={16} color="var(--brand)"/>
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1 }}>Activity</div>
              <div style={{ fontSize: 11, color: 'var(--brand)', marginTop: 2, fontWeight: 500 }}>
                {stats.totalTxCount} transactions this {period}
              </div>
            </div>
          </div>
          <div style={{
            display: 'flex', gap: 2,
            background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)', borderRadius: 10, padding: 3,
          }}>
            {(['daily', 'weekly', 'monthly'] as const).map(t => (
              <button
                key={t}
                onClick={() => setActTab(t)}
                style={{
                  padding: '5px 10px', borderRadius: 7, border: 'none',
                  fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
                  cursor: 'pointer', transition: 'all .15s',
                  background: actTab === t ? 'var(--brand)' : 'transparent',
                  color: actTab === t ? '#fff' : 'var(--text-secondary)',
                }}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <BarChart
          data={chartData.bars}
          labels={chartData.labels}
          highlightIdx={chartData.highlightIdx}
          tooltip={chartData.tooltip}
        />
      </motion.div>

      {/* ── BOTTOM ROW ──────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '0 14px' }}>

        {/* Multichain Usage */}
        <motion.div
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.12 }}
          style={{
            background: 'var(--surface)', border: '1px solid color-mix(in srgb, var(--text-primary) 7%, transparent)',
            borderRadius: 20, padding: 14,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12 }}>
            <div style={{
              width: 28, height: 28, borderRadius: 9,
              background: 'color-mix(in srgb, var(--brand) 16%, transparent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Link2 size={14} color="var(--brand)"/>
            </div>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Multichain Usage</span>
          </div>

          {stats.chainUsage.map(({ chain, count, pct }, i) => (
            <div key={chain} style={{ marginBottom: i < stats.chainUsage.length - 1 ? 9 : 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <ChainLogo name={chain} size={22}/>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)' }}>{chain}</span>
                </div>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
                  {stats.totalMcTxs > 0 ? pct : 0}%
                </span>
              </div>
              <div style={{ height: 5, borderRadius: 3, background: 'color-mix(in srgb, var(--text-primary) 7%, transparent)', overflow: 'hidden', marginBottom: 2 }}>
                <div style={{
                  height: '100%', borderRadius: 3,
                  background: 'linear-gradient(90deg,var(--brand),var(--accent))',
                  width: `${stats.totalMcTxs > 0 ? pct : 0}%`,
                  transition: 'width .5s ease',
                }}/>
              </div>
              <div style={{ fontSize: 9.5, color: 'var(--text-secondary)', textAlign: 'right' }}>{count} txs</div>
            </div>
          ))}

          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            paddingTop: 8, borderTop: '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)', marginTop: 4,
          }}>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Total Transactions</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--brand)' }}>{stats.totalMcTxs}</span>
          </div>
        </motion.div>

        {/* Payment Intelligence */}
        <motion.div
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.14 }}
          style={{
            background: 'var(--surface)', border: '1px solid color-mix(in srgb, var(--text-primary) 7%, transparent)',
            borderRadius: 20, padding: 14,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
            <div style={{
              width: 28, height: 28, borderRadius: 9,
              background: 'color-mix(in srgb, var(--brand) 20%, transparent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Sparkles size={14} color="var(--accent)"/>
            </div>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Payment Intelligence</span>
          </div>

          {[
            {
              icon: <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" width="12" height="12"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>,
              label: 'Average Payment',
              value: `$${formatAmount(stats.avgPayment)}`,
              sub: null, green: false,
            },
            {
              icon: <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" width="12" height="12"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>,
              label: 'Largest Payment',
              value: `$${formatAmount(stats.largestPayment)}`,
              sub: null, green: false,
            },
            {
              icon: <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" width="12" height="12"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
              label: 'Most Active Hour',
              value: stats.mostActiveHourLabel,
              sub: null, green: false,
            },
            {
              icon: <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" width="12" height="12"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
              label: 'Payment Frequency',
              value: `${stats.txFreq}x per day`,
              sub: null, green: false,
            },
            {
              icon: <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" width="12" height="12"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>,
              label: 'You Received',
              value: `${stats.recvPctForPI >= 0 ? '+' : ''}${stats.recvPctForPI}%`,
              sub: 'vs last month', green: true,
            },
          ].map((row, i, arr) => (
            <div
              key={i}
              style={{
                display: 'flex', alignItems: 'flex-start',
                justifyContent: 'space-between', gap: 5,
                padding: '7px 0',
                borderBottom: i < arr.length - 1 ? '1px solid color-mix(in srgb, var(--text-primary) 5.5%, transparent)' : 'none',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                {row.icon}
                <span style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>{row.label}</span>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontSize: 11.5, fontWeight: 700,
                  color: row.green ? 'var(--success)' : 'var(--text-primary)' }}>
                  {row.value}
                </div>
                {row.sub && (
                  <div style={{ fontSize: 9, color: 'var(--text-secondary)' }}>{row.sub}</div>
                )}
              </div>
            </div>
          ))}

        </motion.div>

      </div>

    </div>
  )
}
