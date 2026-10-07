// features/p2p/HistoryPage.tsx
//
// P2P transaction history — every trade the current user has ever been a
// party to (buyer or seller), with filtering, search, and blockchain
// confirmation details for released/completed trades. Reuses fetchMyTrades
// (same data source as P2PMyTradesPage) rather than a separate query — this
// page is the same underlying trades, presented as a full searchable ledger
// instead of a simple active-trades list.

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search,
  ArrowDownToLine, ArrowUpFromLine,
} from 'lucide-react'
import { useAuthStore } from '@/store'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { COLORS, Header, statusMeta } from './P2PPage'
import {
  fetchMyTrades, fetchCounterpartyProfiles, currencySymbol,
  type P2PTrade, type CounterpartyProfile,
} from '@/lib/p2pService'
import { ReceiptPopup } from '@/components/ui/ReceiptPopup'
import { SkeletonCards } from '@/components/ui/Skeleton'
import { AnimatePresence } from 'framer-motion'
import { arcExplorerTxUrl } from '@/lib/chainExplorers'

type CategoryTab = 'all' | 'buy' | 'sell' | 'completed' | 'cancelled' | 'disputed' | 'refunded'

// The DB's TradeStatus enum has no 'disputed'/'refunded' values of its own
// (dispute is a separate column; a "refund" is just a cancelled buy-offer
// trade whose escrow was actually returned — see the notification trigger's
// own comment on this same distinction).
//
// IMPORTANT — Buy/Sell and Completed/Cancelled/Disputed/Refunded are TWO
// SEPARATE DIMENSIONS, not one bucket per trade: a trade is simultaneously
// "a Buy" (your role) AND "Completed" (its status) — it's never just one
// or the other. The previous version tried to force every trade into a
// single category (checking status first, falling through to buy/sell only
// if nothing else matched), so a completed trade could NEVER match 'buy' or
// 'sell' — it always stopped at 'completed' first. Since every trade here
// finishes as completed/cancelled/etc., the Buy and Sell tabs matched
// nothing at all. Fixed by giving each tab its own independent predicate —
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
// only ever show one label — so this one stays priority-ordered (dispute
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
      rows={[
        { label: isBuyer ? 'You received' : 'You sold', value: `${t.amountUsdc} USDC`, positive: isBuyer && status === 'success' },
        { label: isBuyer ? 'You paid' : 'You receive', value: `${currencySymbol(t.currency)}${t.amountFiat} ${t.currency}` },
        { label: isBuyer ? 'Seller' : 'Buyer', value: counterparty, positive: true },
        ...(hash ? [{ label: 'Transaction Hash', value: `${hash.slice(0, 6)}…${hash.slice(-4)}` }] : []),
        { label: 'Time', value: fmtDate(t.completedAt || t.createdAt) },
      ]}
      detailRows={[
        { label: 'Status', value: label, positive: status === 'success' },
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
  if (!iso) return '—'
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function shortHash(h?: string): string {
  if (!h) return '—'
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
        // Every field null-guarded with `?? ''` — a single missing wallet/
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

  return (
    <div className="lg:max-w-[900px]" style={{ background: COLORS.bg, minHeight: '100%', height: '100%', overflowY: 'auto', paddingBottom: 40 }}>
      <Header title="Transaction History" onBack={() => navigate('/p2p')} />

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
            background: category === c.key ? 'color-mix(in srgb, var(--brand) 15%, transparent)' : 'transparent', cursor: 'pointer',
          }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: category === c.key ? 'var(--accent-text)' : COLORS.muted }}>{c.label}</span>
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
          onClose={() => setReceiptTrade(null)} />
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

          return (
            <div key={t.id} style={{ background: COLORS.surface, borderRadius: 16, marginBottom: 10, border: `1px solid ${COLORS.border}`, overflow: 'hidden' }}>
              <div onClick={() => setReceiptTrade(t)} style={{ padding: 14, cursor: 'pointer' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {isBuyer ? <ArrowDownToLine size={13} color={COLORS.success} /> : <ArrowUpFromLine size={13} color={COLORS.error} />}
                    <span style={{ fontSize: 13, fontWeight: 700, color: isBuyer ? COLORS.success : COLORS.error }}>{isBuyer ? 'Buy' : 'Sell'}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: meta.color, background: `color-mix(in srgb, ${meta.color} 10%, transparent)`, padding: '3px 9px', borderRadius: 10 }}>
                      {meta.label}
                    </span>
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 8 }}>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.text }}>{t.amountUsdc} USDC</div>
                    <div style={{ fontSize: 11.5, color: COLORS.muted, marginTop: 2 }}>{currencySymbol(t.currency)}{t.amountFiat} {t.currency} · {t.pricePerUsdc}/USDC</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 11.5, color: COLORS.text }}>{cp?.displayName || cp?.username || 'Trader'}</div>
                    <div style={{ fontSize: 10.5, color: COLORS.muted, marginTop: 2 }}>{fmtDate(t.createdAt)}</div>
                  </div>
                </div>
              </div>

            </div>
          )
        })}
      </div>
    </div>
  )
}
