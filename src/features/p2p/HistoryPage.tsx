// features/p2p/HistoryPage.tsx
//
// P2P transaction history - every trade the current user has ever been a
// party to (buyer or seller), with filtering, search, and blockchain
// confirmation details for released/completed trades. Reuses fetchMyTrades
// (same data source as P2PMyTradesPage) rather than a separate query - this
// page is the same underlying trades, presented as a full searchable ledger
// instead of a simple active-trades list.

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search,
} from 'lucide-react'
import { useAuthStore } from '@/store'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { COLORS, Header, statusMeta } from './P2PPage'
import {
  fetchMyTrades, fetchCounterpartyProfiles, currencySymbol,
  type P2PTrade, type CounterpartyProfile,
} from '@/lib/p2pService'
import { ReceiptPopup } from '@/components/ui/ReceiptPopup'
import { DesktopTwoColumn } from '@/components/layout/DesktopTwoColumn'
import { SkeletonCards } from '@/components/ui/Skeleton'
import { HistoryRow, HistoryIcon } from '@/components/ui/HistoryRow'
import { useReturnFlash } from '@/hooks/useReturnFlash'
import { AnimatePresence } from 'framer-motion'
import { arcExplorerTxUrl } from '@/lib/chainExplorers'

type CategoryTab = 'all' | 'buy' | 'sell' | 'completed' | 'cancelled' | 'disputed' | 'refunded'

// The DB's TradeStatus enum has no 'disputed'/'refunded' values of its own
// (dispute is a separate column; a "refund" is just a cancelled buy-offer
// trade whose escrow was actually returned - see the notification trigger's
// own comment on this same distinction).
//
// IMPORTANT - Buy/Sell and Completed/Cancelled/Disputed/Refunded are TWO
// SEPARATE DIMENSIONS, not one bucket per trade: a trade is simultaneously
// "a Buy" (your role) AND "Completed" (its status) - it's never just one
// or the other. The previous version tried to force every trade into a
// single category (checking status first, falling through to buy/sell only
// if nothing else matched), so a completed trade could NEVER match 'buy' or
// 'sell' - it always stopped at 'completed' first. Since every trade here
// finishes as completed/cancelled/etc., the Buy and Sell tabs matched
// nothing at all. Fixed by giving each tab its own independent predicate -
// tapping "Buy" checks only "was I the buyer", regardless of status.
function matchesCategory(t: P2PTrade, myUserId: string | undefined, category: CategoryTab): boolean {
  switch (category) {
    case 'all':       return true
    case 'buy':       return t.buyerId === myUserId
    case 'sell':      return t.sellerId === myUserId
    case 'completed': return t.status === 'completed' || t.status === 'released'
    case 'cancelled': return t.status === 'expired' || (t.status === 'cancelled' && t.offerType !== 'buy')
    case 'disputed':  return t.disputeStatus === 'open'
    case 'refunded':  return t.status === 'cancelled' && t.offerType === 'buy'
    default:          return true
  }
}

// Unlike matchesCategory above, the little status PILL on each card can
// only ever show one label - so this one stays priority-ordered (dispute
// beats refund beats plain cancel beats completed) purely for display, and
// is never used for filtering.
function badgeMeta(t: P2PTrade): { label: string; color: string } {
  if (t.disputeStatus === 'open') return { label: 'Disputed', color: COLORS.warning }
  if (t.status === 'cancelled' && t.offerType === 'buy') return { label: 'Refunded', color: 'var(--accent-text)' }
  return statusMeta(t.status)
}

// A P2P trade reopened as a receipt: the buyer gets the receiver version
// (USDC received from escrow), the seller the sender version. Completed
// trades show success; cancelled / refunded ones failed; anything still open
// or disputed shows as in progress. "Open Trade" goes to the full trade.
function TradeReceipt({ t, isBuyer, label, counterparty, counterpartyWallet, onOpenTrade, onClose }: {
  t: P2PTrade; isBuyer: boolean; label: string; counterparty: string; counterpartyWallet?: string
  onOpenTrade: () => void; onClose: () => void
}) {
  const disputed = t.disputeStatus === 'open'
  const status = disputed ? 'pending' : t.status === 'completed' ? 'success' : t.status === 'cancelled' ? 'failed' : 'pending'
  const title = status === 'success' ? (isBuyer ? 'USDC Received' : 'USDC Sold')
    : status === 'failed' ? `Trade ${label}` : `Trade ${label}`
  const hash = t.txHash || null
  return (
    <ReceiptPopup
      onClose={onClose}
      status={status}
      title={title}
      subtitle={<>
        <span style={{ display: 'block', fontSize: 20, fontWeight: 800, color: status === 'failed' ? 'var(--danger)' : isBuyer ? 'var(--success)' : 'var(--text-primary)', marginBottom: 4 }}>
          {status === 'failed' ? '' : isBuyer ? '+' : '-'}{t.amountUsdc} USDC
        </span>
        {isBuyer ? 'Bought from' : 'Sold to'} {counterparty}
      </>}
      // The header shows the USDC and who it was with, and the title the
      // status - rows only add the fiat side and the rest.
      rows={[
        { label: isBuyer ? 'You paid' : 'You receive', value: `${currencySymbol(t.currency)}${t.amountFiat} ${t.currency}` },
        ...(hash ? [{ label: 'Transaction Hash', value: `${hash.slice(0, 6)}…${hash.slice(-4)}` }] : []),
        { label: 'Time', value: fmtDate(t.completedAt || t.createdAt) },
      ]}
      detailRows={[
        { label: 'Price', value: `${t.pricePerUsdc} ${t.currency}/USDC` },
        { label: 'Payment method', value: t.paymentMethod },
        { label: 'Trade ID', value: shortHash(t.id) },
        { label: 'Offer ID', value: shortHash(t.offerId) },
        ...(counterpartyWallet ? [{ label: 'Counterparty wallet', value: shortHash(counterpartyWallet) }] : []),
        { label: 'Created', value: fmtDate(t.createdAt) },
        ...(t.completedAt ? [{ label: 'Completed', value: fmtDate(t.completedAt) }] : []),
      ]}
      detailsTitle="Trade details"
      fullHash={hash || undefined}
      links={hash ? [{ title: 'View on ArcScan', explorer: 'ArcScan', hash, href: arcExplorerTxUrl(hash) }] : undefined}
      linksNote={hash ? undefined : 'No on-chain transaction yet for this trade.'}
      primaryLabel="Open Trade"
      onPrimary={onOpenTrade}
    />
  )
}

function fmtDate(iso?: string): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function shortHash(h?: string): string {
  if (!h) return '-'
  return h.length > 14 ? `${h.slice(0, 8)}...${h.slice(-6)}` : h
}

const CATEGORY_TABS: { key: CategoryTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'buy', label: 'Buy' },
  { key: 'sell', label: 'Sell' },
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'disputed', label: 'Disputed' },
  { key: 'refunded', label: 'Refunded' },
]

export function P2PHistoryPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const user = useAuthStore(s => s.user)
  const [trades, setTrades] = useState<P2PTrade[]>([])
  const [counterparties, setCounterparties] = useState<Map<string, CounterpartyProfile>>(new Map())
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState<CategoryTab>('all')
  const [search, setSearch] = useState('')
  // Tapping a trade opens it as a receipt (see TradeReceipt).
  const [receiptTrade, setReceiptTrade] = useState<P2PTrade | null>(null)
  const receiptFlash = useReturnFlash()

  const load = useCallback(async () => {
    if (!user?.id) { setLoading(false); return }
    setLoading(true)
    const rows = await fetchMyTrades(user.id)
    setTrades(rows)
    setCounterparties(await fetchCounterpartyProfiles(rows, user.id))
    setLoading(false)
  }, [user?.id])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    let rows = trades

    if (category !== 'all') rows = rows.filter(t => matchesCategory(t, user?.id, category))

    const q = search.trim().toLowerCase()
    if (q) {
      rows = rows.filter(t => {
        const cp = counterparties.get(t.buyerId === user?.id ? t.sellerId : t.buyerId)
        // Every field null-guarded with `?? ''` - a single missing wallet/
        // username on any one trade used to throw here (`.toLowerCase()` on
        // undefined), which silently blanked the ENTIRE list the instant
        // you typed anything, even though the unfiltered list rendered
        // fine. That was the real cause of "search shows nothing".
        return (
          (t.id ?? '').toLowerCase().includes(q) ||
          (t.offerId ?? '').toLowerCase().includes(q) ||
          (t.buyerWallet ?? '').toLowerCase().includes(q) ||
          (t.sellerWallet ?? '').toLowerCase().includes(q) ||
          (cp?.username ?? '').toLowerCase().includes(q) ||
          (cp?.displayName ?? '').toLowerCase().includes(q) ||
          (cp?.walletAddress ?? '').toLowerCase().includes(q)
        )
      })
    }

    return rows
  }, [trades, category, search, counterparties, user?.id])

  // Desktop summary beside the list (same 65/35 split as Recent / Activity).
  const summary = useMemo(() => {
    const isDone = (t: P2PTrade) => t.status === 'completed' || t.status === 'released'
    const done = trades.filter(isDone)
    const usdc = (list: P2PTrade[]) => list.reduce((a, t) => a + (Number(t.amountUsdc) || 0), 0)
    return {
      total: trades.length,
      completed: done.length,
      open: trades.filter(t => !isDone(t) && t.status !== 'cancelled' && t.status !== 'expired').length,
      bought: usdc(done.filter(t => t.buyerId === user?.id)),
      sold: usdc(done.filter(t => t.sellerId === user?.id)),
    }
  }, [trades, user?.id])

  const page = (
    <div style={{ background: COLORS.bg, minHeight: '100%', height: '100%', overflowY: 'auto', paddingBottom: 40 }}>
      <Header title="P2P History" onBack={() => navigate('/p2p')} />

      {/* Search */}
      <div style={{ padding: '4px 16px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: COLORS.surface, borderRadius: 12, padding: '10px 12px', border: `1px solid ${COLORS.border}` }}>
          <Search size={15} color={COLORS.muted} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search Trade ID, wallet, or username"
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: COLORS.text, fontSize: 13 }} />
        </div>
      </div>

      {/* Category tabs */}
      <div style={{ display: 'flex', gap: 6, padding: '0 16px 12px', overflowX: 'auto' }}>
        {CATEGORY_TABS.map(c => (
          <button key={c.key} onClick={() => setCategory(c.key)} style={{
            flexShrink: 0, padding: '7px 13px', borderRadius: 20,
            border: `1px solid ${category === c.key ? COLORS.primary : COLORS.border}`,
            background: category === c.key ? 'var(--brand)' : 'transparent', cursor: 'pointer',
          }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: category === c.key ? '#fff' : COLORS.muted }}>{c.label}</span>
          </button>
        ))}
      </div>

      <AnimatePresence>
      {receiptTrade && (() => {
        const t = receiptTrade
        const isBuyer = t.buyerId === user?.id
        const cp = counterparties.get(isBuyer ? t.sellerId : t.buyerId)
        return <TradeReceipt key="receipt" t={t} isBuyer={isBuyer} label={badgeMeta(t).label}
          counterparty={cp?.displayName || cp?.username || 'Trader'}
          counterpartyWallet={cp?.walletAddress || (isBuyer ? t.sellerWallet : t.buyerWallet)}
          onOpenTrade={() => { setReceiptTrade(null); navigate(`/p2p/trade/${t.id}`) }}
          onClose={() => { receiptFlash.closed(t.id); setReceiptTrade(null) }} />
      })()}
      </AnimatePresence>

      {/* List */}
      <div style={{ padding: '4px 16px' }}>
        {loading ? (
          <SkeletonCards count={4} className="pt-2" />
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '50px 20px', background: COLORS.surface, borderRadius: 18, border: `1px dashed ${COLORS.border}` }}>
            <p style={{ color: COLORS.muted, fontSize: 13, margin: 0 }}>No transactions match these filters.</p>
          </div>
        ) : filtered.map(t => {
          const isBuyer = t.buyerId === user?.id
          const meta = badgeMeta(t)
          const cp = counterparties.get(isBuyer ? t.sellerId : t.buyerId)

          const done = t.status === 'completed' || t.status === 'released'
          const tone = t.disputeStatus === 'open' ? 'attention' : done ? (isBuyer ? 'in' : 'out')
            : t.status === 'cancelled' || t.status === 'expired' ? 'muted' : 'pending'
          return (
            <HistoryRow key={t.id} flash={t.id === receiptFlash.flashId}
              onClick={() => { receiptFlash.opened(); setReceiptTrade(t) }}
              icon={<HistoryIcon tone={tone} icon="p2p" />}
              title={`${isBuyer ? 'Bought' : 'Sold'} USDC${cp ? ` · ${cp.displayName || cp.username}` : ''}`}
              sub={`${currencySymbol(t.currency)}${t.amountFiat} ${t.currency} · ${t.pricePerUsdc}/USDC`}
              meta={<><span style={{ color: meta.color, fontWeight: 600 }}>{meta.label}</span> · {fmtDate(t.createdAt)}</>}
              right={<div style={{ fontSize: 14, fontWeight: 700, color: done && isBuyer ? 'var(--success)' : 'var(--text-primary)' }}>
                {done ? (isBuyer ? '+' : '-') : ''}{t.amountUsdc} USDC
              </div>} />
          )
        })}
      </div>
    </div>
  )

  if (!isDesktop) return page

  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })
  const card: React.CSSProperties = { background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 16 }
  return (
    <DesktopTwoColumn main={page} side={
      <aside style={{ paddingTop: 84, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ ...card, display: 'flex' }}>
          {([['Trades', String(summary.total)], ['Completed', String(summary.completed)], ['In progress', String(summary.open)]] as const).map(([k, v], i) => (
            <div key={k} style={{ flex: 1, padding: '14px 16px', borderLeft: i ? `1px solid ${COLORS.border}` : 'none' }}>
              <div style={{ fontSize: 12, color: COLORS.muted }}>{k}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: COLORS.text, marginTop: 2 }}>{loading ? '–' : v}</div>
            </div>
          ))}
        </div>
        <div style={{ ...card, padding: '6px 16px' }}>
          {([['Bought', `+${fmt(summary.bought)} USDC`, 'var(--success)'], ['Sold', `-${fmt(summary.sold)} USDC`, COLORS.text]] as const).map(([k, v, c], i) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '11px 0', fontSize: 13.5, borderBottom: i === 0 ? `1px solid ${COLORS.border}` : 'none' }}>
              <span style={{ color: COLORS.muted }}>{k} <span style={{ fontSize: 11.5 }}>(completed)</span></span>
              <span style={{ fontWeight: 700, color: c }}>{loading ? '–' : v}</span>
            </div>
          ))}
        </div>
      </aside>
    } />
  )
}
