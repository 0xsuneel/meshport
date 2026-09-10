import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { ActivityRecord, activityLabel, activitySign, activityColor, fetchActivityById } from '@/lib/ActivityService'
import { useAuthStore } from '@/store'
import { timeAgo, trimTrailingZeros } from '@/lib/utils'
import { useMediaQuery } from '@/hooks/useMediaQuery'

// Non-MeshPort-username senders/recipients (system-generated activity) — shown
// as-is, never given the '.arc' suffix real usernames get.
const SYSTEM_LABELS: Record<string, string> = {
  'MeshPort Reward':  'MeshPort Reward',
  'MeshPort Rewards': 'MeshPort Reward', // legacy rows, pre-rename
}

export function TransactionDetailPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate  = useNavigate()
  const location  = useLocation()
  const { id }    = useParams<{ id: string }>()
  const walletAddress = useAuthStore(s => s.walletAddress)
  const [record, setRecord] = useState<ActivityRecord | null>(location.state?.record ?? null)
  const [loading, setLoading] = useState(!record)

  useEffect(() => {
    if (record || !id) return
    setLoading(true)
    fetchActivityById(id)
      .then(found => { if (found) setRecord(found) })
      .finally(() => setLoading(false))
  }, [id])

  if (loading) return (
    <div className="flex flex-col h-full bg-bg items-center justify-center">
      <div className="w-8 h-8 border-2 border-brand/30 border-t-brand rounded-full animate-spin" />
    </div>
  )

  if (!record) return (
    <div className="flex flex-col h-full bg-bg items-center justify-center gap-3">
      <p className="text-text-secondary">Transaction not found</p>
      {!isDesktop && (
        <button onClick={() => navigate(-1)} className="back-btn"><ArrowLeft className="w-5 h-5 text-text-primary"/></button>
      )}
    </div>
  )

  const meta   = record.metadata ?? {}
  const isBulkReceived = record.activityType === 'bulk' && meta.direction === 'received'
  const sign   = activitySign(record.activityType, meta.direction)
  const color  = activityColor(record.activityType, record.status, meta.direction)

  const isMultichain = record.activityType === 'claim' || record.activityType === 'deposit' || record.activityType === 'bridge'
  const cleanChain = (c?: string) => c?.replace(/[_ ](Sepolia|Testnet|Fuji|Amoy)/gi, '').trim() ?? ''
  const fromChain  = cleanChain(record.sourceChain) || 'External'

  const isClaim = record.activityType === 'claim'
  const isTransfer = record.activityType === 'bridge'
  const isBulk  = record.activityType === 'bulk'

  // Self-transfer: counterparty IS this same wallet — see ActivityPage.tsx's
  // identical check (deriveActivityRow / DetailSheet) for the full reasoning.
  const isSelfTransfer = !!(
    record.counterpartyAddress && record.walletAddress &&
    record.counterpartyAddress.toLowerCase() === record.walletAddress.toLowerCase()
  )

  const cpUsername = meta.toUsername || meta.fromUsername || ''
  const cpLabel = isSelfTransfer
    ? 'Self'
    : cpUsername
    ? (SYSTEM_LABELS[cpUsername] ?? `${cpUsername.replace(/\.arc$/i, '')}.arc`)
    : record.counterpartyAddress || ''

  // Local display label, distinct from the shared activityLabel() helper
  // (still used elsewhere, e.g. HomePage's notification text, which this
  // change doesn't touch) — this page's own heading/Type row only.
  const label = isSelfTransfer && record.activityType === 'send'    ? 'Paid to Self'
              : isSelfTransfer && record.activityType === 'receive' ? 'Received from Self'
              : isClaim    ? 'Claimed from'
              : isTransfer ? 'Transfer to'
              : record.activityType === 'send'    ? 'Paid to'
              : record.activityType === 'receive' ? 'Received from'
              : record.activityType === 'p2p_refund' ? 'P2P Sell Order Cancelled'
              : activityLabel(record.activityType)

  // Smart decimal formatting — show enough precision for small token amounts,
  // then trim any trailing zeros that precision tier's toFixed() padded on
  // (e.g. "1.00" -> "1", "0.00000100" -> "0.000001") so real numbers never
  // show padded zeros. Mirrors ActivityPage.tsx's formatAmt. Declared before
  // `rows` below so the Amount/Swapped rows can use it too, instead of their
  // own separate raw toFixed(2)/toFixed(4) calls.
  //
  // BUG FIX: the precision tiers used to only kick in for BTC/ETH-like
  // symbols — a USDC/EURC amount like 0.000004 fell into the "else" branch,
  // which only ever shows up to 4 decimals (toFixed(4) rounds 0.000004 to
  // "0.0000", which then trims to "0"). Real transfers on this testnet can
  // be this small for ANY token (chat-pay/dust amounts, fee remainders), so
  // the magnitude-based precision tiers now apply regardless of symbol —
  // only the LARGE-amount tier (>= 0.01) still varies by token, since a
  // normal-sized USDC amount should show 2 decimals, not 4.
  const formatTokenAmount = (amount: number, symbol?: string): string => {
    if (!amount) return '0'
    const abs = Math.abs(amount)
    const sym = (symbol || '').toLowerCase()
    const isBtcLike = sym.includes('btc') || sym.includes('eth') || sym.includes('wbtc')
    if (abs < 0.0001) return trimTrailingZeros(amount.toFixed(8))
    if (abs < 0.01)   return trimTrailingZeros(amount.toFixed(6))
    return trimTrailingZeros(amount.toFixed(isBtcLike ? 4 : 2))
  }

  const rows = [
    !isMultichain && { label: 'Type',   value: label },
    !isMultichain && { label: 'Chain',  value: 'Arc' },
    isBulk && meta.purpose && { label: 'Purpose', value: meta.purpose },
    isBulk && !isBulkReceived && meta.recipientCount && { label: 'Recipients', value: String(meta.recipientCount) },
    { label: 'Status', value: record.status.charAt(0).toUpperCase() + record.status.slice(1) },
    record.activityType === 'swap' && meta.tokenIn
      ? { label: 'Swapped', value: `${formatTokenAmount(Number(meta.amountIn), meta.tokenIn)} ${meta.tokenIn} → ${formatTokenAmount(Number(meta.amountOut), meta.tokenOut)} ${meta.tokenOut}` }
      : { label: 'Amount',  value: `${sign !== '↔' ? sign : ''}${formatTokenAmount(record.amount, record.tokenSymbol)} ${record.tokenSymbol}` },
    record.counterpartyAddress && { label: (record.activityType === 'send' || isTransfer || (isBulk && !isBulkReceived)) ? 'To' : 'From', value: cpLabel },
    isClaim && record.txHash && { label: `${fromChain} Tx Hash`, value: `${record.txHash.slice(0,10)}…${record.txHash.slice(-8)}` },
    !isClaim && record.txHash && { label: 'Tx Hash', value: `${record.txHash.slice(0,10)}…${record.txHash.slice(-8)}` },
    { label: 'Date', value: new Date(record.createdAt).toLocaleDateString([], {weekday:'short',month:'short',day:'numeric',year:'numeric'}) + ' ' + new Date(record.createdAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}) },
    meta.note && { label: 'Note', value: meta.note },
  ].filter(Boolean) as { label: string; value: string }[]

  const recipients: { label: string; amount: number; txHash?: string }[] = meta.recipients ?? []

  const isSwap = record.activityType === 'swap'
  // For swaps: show "X tokenIn → Y tokenOut" in hero
  const swapAmountIn  = meta.amountIn  ?? record.amount
  const swapAmountOut = meta.amountOut ?? 0
  const swapTokenIn   = meta.tokenIn   ?? record.tokenSymbol
  const swapTokenOut  = meta.tokenOut  ?? ''

  return (
    <div className="flex flex-col h-full bg-bg overflow-hidden">
      {/* Sticky header */}
      <div className="header-row px-5 pt-header pb-header gap-3 flex-shrink-0"
        style={{ background: 'color-mix(in srgb, var(--bg) 95%, transparent)', backdropFilter: 'blur(12px)' }}>
        {!isDesktop && (
          <button onClick={() => navigate(-1)} className="back-btn">
            <ArrowLeft className="w-5 h-5 text-text-primary" />
          </button>
        )}
        <h1 className="text-xl font-bold text-text-primary">Transaction</h1>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
        {/* Amount hero */}
        <div className="flex flex-col items-center py-6 gap-2">
          <p className="text-xs font-semibold uppercase tracking-widest text-text-secondary">{label}</p>
          {isSwap ? (
            <div className="flex flex-col items-center gap-1">
              <p className={`text-4xl font-bold ${color}`}>
                -{formatTokenAmount(swapAmountIn, swapTokenIn)}
                <span className="text-xl font-normal text-text-secondary ml-2">{swapTokenIn}</span>
              </p>
              <p className="text-lg font-semibold text-success">
                +{formatTokenAmount(swapAmountOut, swapTokenOut)}
                <span className="text-base font-normal text-text-secondary ml-1">{swapTokenOut}</span>
              </p>
            </div>
          ) : (
            <p className={`text-4xl font-bold ${color}`}>
              {sign !== '↔' ? sign : ''}{formatTokenAmount(record.amount, record.tokenSymbol)}
              <span className="text-xl font-normal text-text-secondary ml-2">{record.tokenSymbol}</span>
            </p>
          )}
          <p className="text-sm text-text-secondary">{timeAgo(record.createdAt)}</p>
          <span className={`text-xs font-semibold px-3 py-1 rounded-full ${
            record.status === 'completed' ? 'bg-success/15 text-success' :
            record.status === 'failed'    ? 'bg-danger/15 text-danger' :
                                            'bg-warning/15 text-warning'
          }`}>{record.status}</span>
        </div>

        {/* Multichain route visualizer */}
        {isMultichain && (
          <div className="flex items-center justify-center gap-2 py-4 px-2 rounded-3xl"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            <div className="flex flex-col items-center gap-1">
              <div className="w-10 h-10 rounded-full flex items-center justify-center"
                style={{ background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', border: '1px solid var(--border)' }}>
                <span className="text-[10px] font-bold text-text-primary">{fromChain.slice(0,4).toUpperCase()}</span>
              </div>
              <span className="text-[9px] text-text-secondary text-center">{fromChain}</span>
            </div>
            <div className="flex-1 flex flex-col items-center gap-0.5">
              <div className="w-full h-px" style={{ background: 'color-mix(in srgb, var(--accent) 50%, transparent)' }}/>
              <span className="text-[8px] text-accent-text">CCTP</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <div className="w-10 h-10 rounded-full flex items-center justify-center"
                style={{ background: 'color-mix(in srgb, var(--accent) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)' }}>
                <span className="text-[10px] font-bold text-accent-text">UB</span>
              </div>
              <span className="text-[9px] text-text-secondary text-center">Unified Balance</span>
            </div>
            <div className="flex-1 flex flex-col items-center gap-0.5">
              <div className="w-full h-px" style={{ background: 'color-mix(in srgb, var(--accent) 50%, transparent)' }}/>
              <span className="text-[8px] text-accent-text">CCTP</span>
            </div>
            <div className="flex flex-col items-center gap-1">
              <div className="w-10 h-10 rounded-full flex items-center justify-center"
                style={{ background: 'color-mix(in srgb, var(--brand) 15%, transparent)', border: '1.5px solid color-mix(in srgb, var(--brand) 30%, transparent)' }}>
                <span className="text-[10px] font-bold text-brand">ARC</span>
              </div>
              <span className="text-[9px] text-text-secondary text-center">Arc</span>
            </div>
          </div>
        )}

        {/* Details */}
        <div className="rounded-3xl overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          {rows.map((row, i) => (
            <div key={i} className="flex items-start justify-between px-4 py-3.5 border-b border-border last:border-0">
              <p className="text-[13px] text-text-secondary flex-shrink-0">{row.label}</p>
              <p className="text-[13px] font-semibold text-text-primary text-right ml-4 break-all max-w-[60%]">{row.value}</p>
            </div>
          ))}
        </div>

        {/* Bulk recipients list — fixed height, only this section scrolls */}
        {isBulk && recipients.length > 0 && (
          <div className="rounded-3xl overflow-hidden flex flex-col" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            {/* Section header — always visible */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
              <p className="text-xs font-semibold uppercase tracking-widest text-text-secondary">
                Recipients ({recipients.length})
              </p>
            </div>
            {/* Scrollable recipients only */}
            <div className="overflow-y-auto" style={{ maxHeight: '240px' }}>
              {recipients.map((r, i) => {
                const initials = (r.label || '?').replace(/\.arc$/i, '').slice(0, 2).toUpperCase()
                const colors = ['var(--avatar-1)','var(--avatar-2)','var(--avatar-3)','var(--avatar-4)']
                const bg = colors[i % colors.length]
                return (
                  <div key={i} className="flex items-center justify-between px-4 py-3 border-b border-[rgb(var(--text-primary-rgb)/0.04)] last:border-0">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
                        style={{ background: bg }}>
                        <span className="text-xs font-bold text-white">{initials}</span>
                      </div>
                      <p className="text-sm font-medium text-text-primary">{r.label}</p>
                    </div>
                    <p className="text-sm font-semibold text-danger">-${formatTokenAmount(Number(r.amount))}</p>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Explorer button */}
        {record.txHash && (
          <a
            href={record.explorerUrl || `https://testnet.arcscan.app/tx/${record.txHash}`}
            target="_blank" rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full py-4 rounded-2xl text-sm font-semibold text-text-primary active:scale-95 transition-transform"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            {isClaim ? `View on ${fromChain} Explorer` : 'View on Explorer'}
            <ExternalLink className="w-4 h-4" />
          </a>
        )}
      </div>
    </div>
  )
}
