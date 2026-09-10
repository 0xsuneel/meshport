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
import { motion, AnimatePresence } from 'framer-motion'
import {
  Search, ExternalLink, ChevronDown, ChevronUp, RefreshCw, Copy, Check,
  ArrowDownToLine, ArrowUpFromLine,
} from 'lucide-react'
import { useAuthStore, useUIStore } from '@/store'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { COLORS, Header, statusMeta } from './P2PPage'
import {
  fetchMyTrades, fetchCounterpartyProfiles, currencySymbol,
  type P2PTrade, type CounterpartyProfile,
} from '@/lib/p2pService'
import { fetchTxChainInfo, type TxChainInfo } from '@/lib/p2pChain'
import { copyToClipboard } from '@/lib/utils'

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

/** Label + monospace value + copy button — same copy/check pattern as the tx hash's copy button, reused here so Trade ID gets the same one-tap copy. */
function CopyableField({ label, value, display }: { label: string; value: string; display: string }) {
  const [copied, setCopied] = useState(false)
  const { showToastMessage } = useUIStore()
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const ok = await copyToClipboard(value)
    setCopied(true)
    showToastMessage(ok ? `${label} copied` : `Could not copy ${label.toLowerCase()}`, ok ? 'success' : 'error')
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div>
      <span style={{ color: COLORS.muted }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 1 }}>
        <span style={{ color: COLORS.text, fontFamily: 'monospace', fontSize: 11 }}>{display}</span>
        <button onClick={copy} aria-label={`Copy ${label}`} style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', display: 'flex', flexShrink: 0 }}>
          {copied ? <Check size={11} color={COLORS.success} /> : <Copy size={11} color={COLORS.muted} />}
        </button>
      </div>
    </div>
  )
}

/** Inline "tx hash → confirmations / block / timestamp" panel, fetched on demand. */
function ChainDetails({ txHash }: { txHash: string }) {
  const [info, setInfo] = useState<TxChainInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const { showToastMessage } = useUIStore()

  const load = useCallback(() => {
    setLoading(true)
    fetchTxChainInfo(txHash).then(i => { setInfo(i); setLoading(false) })
  }, [txHash])

  const copyHash = async () => {
    const ok = await copyToClipboard(txHash)
    setCopied(true)
    showToastMessage(ok ? 'Transaction hash copied' : 'Could not copy hash', ok ? 'success' : 'error')
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div style={{ marginTop: 10, padding: 12, borderRadius: 12, background: COLORS.surfaceSecondary, border: `1px solid ${COLORS.border}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{ fontSize: 11, color: COLORS.muted }}>Tx:</span>
          <span style={{ fontSize: 11.5, color: COLORS.text, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortHash(txHash)}</span>
          <button onClick={copyHash} style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', display: 'flex', flexShrink: 0 }}>
            {copied ? <Check size={12} color={COLORS.success} /> : <Copy size={12} color={COLORS.muted} />}
          </button>
        </div>
        {!info && (
          <button onClick={load} disabled={loading} style={{ flexShrink: 0, fontSize: 11, fontWeight: 600, color: COLORS.primary, background: 'color-mix(in srgb, var(--brand) 12%, transparent)', border: 'none', borderRadius: 8, padding: '5px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> {loading ? 'Checking…' : 'Check confirmations'}
          </button>
        )}
      </div>

      {info && (
        <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 11.5 }}>
          <div><span style={{ color: COLORS.muted }}>Status: </span>
            <span style={{ color: info.status === 'success' ? COLORS.success : info.status === 'reverted' ? COLORS.error : COLORS.warning, fontWeight: 600 }}>
              {info.status === 'success' ? 'Confirmed' : info.status === 'reverted' ? 'Reverted' : 'Pending'}
            </span>
          </div>
          <div><span style={{ color: COLORS.muted }}>Confirmations: </span><span style={{ color: COLORS.text, fontWeight: 600 }}>{info.confirmations ?? '—'}</span></div>
          <div><span style={{ color: COLORS.muted }}>Block: </span><span style={{ color: COLORS.text, fontWeight: 600 }}>{info.blockNumber ?? '—'}</span></div>
          <div><span style={{ color: COLORS.muted }}>Time: </span><span style={{ color: COLORS.text, fontWeight: 600 }}>{info.timestamp ? new Date(info.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—'}</span></div>
        </div>
      )}

      {info?.explorerUrl && (
        <a href={info.explorerUrl} target="_blank" rel="noopener noreferrer"
          style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 600, color: 'var(--accent-text)', textDecoration: 'none' }}>
          View on Explorer <ExternalLink size={11} />
        </a>
      )}
    </div>
  )
}

export function P2PHistoryPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate = useNavigate()
  const user = useAuthStore(s => s.user)
  const [trades, setTrades] = useState<P2PTrade[]>([])
  const [counterparties, setCounterparties] = useState<Map<string, CounterpartyProfile>>(new Map())
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState<CategoryTab>('all')
  const [search, setSearch] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

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

      {/* List */}
      <div style={{ padding: '4px 16px' }}>
        {loading ? (
          <p style={{ textAlign: 'center', color: COLORS.muted, fontSize: 13, padding: 40 }}>Loading history…</p>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '50px 20px', background: COLORS.surface, borderRadius: 18, border: `1px dashed ${COLORS.border}` }}>
            <p style={{ color: COLORS.muted, fontSize: 13, margin: 0 }}>No transactions match these filters.</p>
          </div>
        ) : filtered.map(t => {
          const isBuyer = t.buyerId === user?.id
          const meta = badgeMeta(t)
          const cp = counterparties.get(isBuyer ? t.sellerId : t.buyerId)
          const isExpanded = expandedId === t.id

          return (
            <div key={t.id} style={{ background: COLORS.surface, borderRadius: 16, marginBottom: 10, border: `1px solid ${COLORS.border}`, overflow: 'hidden' }}>
              <div onClick={() => setExpandedId(isExpanded ? null : t.id)} style={{ padding: 14, cursor: 'pointer' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {isBuyer ? <ArrowDownToLine size={13} color={COLORS.success} /> : <ArrowUpFromLine size={13} color={COLORS.error} />}
                    <span style={{ fontSize: 13, fontWeight: 700, color: isBuyer ? COLORS.success : COLORS.error }}>{isBuyer ? 'Buy' : 'Sell'}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: meta.color, background: `color-mix(in srgb, ${meta.color} 10%, transparent)`, padding: '3px 9px', borderRadius: 10 }}>
                      {meta.label}
                    </span>
                    {isExpanded ? <ChevronUp size={16} color={COLORS.muted} /> : <ChevronDown size={16} color={COLORS.muted} />}
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

              <AnimatePresence>
                {isExpanded && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                    style={{ overflow: 'hidden' }}>
                    <div style={{ padding: '0 14px 14px', borderTop: `1px solid ${COLORS.border}`, marginTop: -1 }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12, fontSize: 11.5 }}>
                        <CopyableField label="Trade ID" value={t.id} display={shortHash(t.id)} />
                        <CopyableField label="Offer ID" value={t.offerId} display={shortHash(t.offerId)} />
                        <div><span style={{ color: COLORS.muted }}>Payment method</span><div style={{ color: COLORS.text }}>{t.paymentMethod}</div></div>
                        <div><span style={{ color: COLORS.muted }}>Counterparty wallet</span><div style={{ color: COLORS.text, fontFamily: 'monospace', fontSize: 11 }}>{shortHash(cp?.walletAddress || (isBuyer ? t.sellerWallet : t.buyerWallet))}</div></div>
                        <div><span style={{ color: COLORS.muted }}>Created</span><div style={{ color: COLORS.text }}>{fmtDate(t.createdAt)}</div></div>
                        <div><span style={{ color: COLORS.muted }}>Completed</span><div style={{ color: COLORS.text }}>{fmtDate(t.completedAt)}</div></div>
                      </div>

                      {t.txHash ? (
                        <ChainDetails txHash={t.txHash} />
                      ) : (
                        <div style={{ marginTop: 10, fontSize: 11, color: COLORS.muted }}>No on-chain transaction yet for this trade.</div>
                      )}

                      <button onClick={(e) => { e.stopPropagation(); navigate(`/p2p/trade/${t.id}`) }}
                        style={{ marginTop: 10, width: '100%', padding: '9px 0', borderRadius: 10, border: `1px solid ${COLORS.border}`, background: 'none', color: COLORS.primary, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                        Open Trade
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )
        })}
      </div>
    </div>
  )
}
