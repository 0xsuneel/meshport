import { useState, useEffect, useRef, useCallback } from 'react'
import {useLocation, useSearchParams} from 'react-router-dom'
import { RefreshCw, Loader2, Search, X, Check, Copy } from 'lucide-react'
import { useAuthStore, useUIStore } from '@/store'
import { useActivity } from '@/hooks/useActivity'
import { ActivityRecord, ActivityType } from '@/lib/ActivityService'
import { backfillP2PActivity } from '@/lib/p2pService'
import { cn, timeAgo, copyToClipboard, trimTrailingZeros } from '@/lib/utils'
import { explorerTxUrl, arcExplorerTxUrl } from '@/lib/chainExplorers'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'

const FILTERS: { id: ActivityType | 'all' | 'p2p'; label: string }[] = [
  { id: 'all',     label: 'All'       },
  { id: 'send',    label: 'Sent'      },
  { id: 'receive', label: 'Received'  },
  { id: 'swap',    label: 'Swap'      },
  { id: 'bridge',  label: 'Multichain'},
  { id: 'bulk',    label: 'Bulk'      },
  { id: 'p2p',     label: 'P2P'       },
]

// Non-MeshPort-username senders/recipients (system-generated activity) — shown
// as-is, never given the '.arc' suffix real usernames get.
const SYSTEM_LABELS: Record<string, string> = {
  'MeshPort Reward':  'MeshPort Reward',
  'MeshPort Rewards': 'MeshPort Reward', // legacy rows, pre-rename
}

const CHAIN_LABELS: Record<string, string> = {
  Ethereum_Sepolia: 'Ethereum', Base_Sepolia: 'Base', Arbitrum_Sepolia: 'Arbitrum',
  Optimism_Sepolia: 'Optimism', Polygon_Sepolia: 'Polygon', Avalanche_Fuji: 'Avalanche',
  HyperEVM_Testnet: 'HyperEVM', Sei_Testnet: 'Sei', Sonic_Testnet: 'Sonic',
  Unichain_Sepolia: 'Unichain', World_Chain_Sepolia: 'World Chain', Arc_Testnet: 'Arc',
}

// EXPLORERS map removed — this was a fifth independently-maintained copy of
// the same chain→explorer-URL data (see MultichainTransferPage.tsx,
// MultichainPage.tsx, and src/lib/chainExplorers.ts's own header comment for
// the history of how these drifted apart and produced wrong links). Now
// imports explorerTxUrl/arcExplorerTxUrl from that single shared source.

function chainLabel(raw?: string) {
  if (!raw) return ''
  if (CHAIN_LABELS[raw]) return CHAIN_LABELS[raw]
  return raw.replace('_Sepolia','').replace('_Testnet','').replace('_Fuji','').replace(/_/g,' ').trim()
}

// Shared by the mobile card (ActivityRow) and the desktop table
// (ActivityTableRow) — see this file's own header comment on
// activityDisplayFields. Picks a precision tier by magnitude so small
// amounts still show meaningful digits, then trims any trailing zeros that
// tier's toFixed() padded on (e.g. "1.00" -> "1", "0.00000100" ->
// "0.000001") so real numbers are never hidden behind zeros.
//
// BUG FIX: the small-amount precision tiers used to only apply to
// BTC/ETH-like symbols. A USDC/EURC amount like 0.000004 fell into the
// plain "else" branch (toFixed(4)), which rounds 0.000004 to "0.0000" —
// trimmed, that's "0", silently hiding a real, nonzero received amount.
// Chat-pay/dust-size transfers on this testnet can be this small for ANY
// token, so the fine-precision tiers now apply regardless of symbol; only
// the >= 0.01 tier still varies by token (USDC/EURC show 2 decimals there,
// BTC-like tokens show 4).
function formatAmt(n: number, symbol?: string) {
  if (!n) return '0'
  const abs = Math.abs(n)
  const sym = (symbol || '').toLowerCase()
  const isBtcLike = sym.includes('btc') || sym.includes('eth') || sym.includes('wbtc')
  if (abs < 0.0001) return trimTrailingZeros(n.toFixed(8))
  if (abs < 0.01)   return trimTrailingZeros(n.toFixed(6))
  return trimTrailingZeros(n.toFixed(isBtcLike ? 4 : 2))
}

// Pure derivation shared by the mobile card (ActivityRow) and the desktop
// table (ActivityTableRow) — same record in, same title/subtitle/status/
// amount fields out, so the two render paths can never drift apart.
// Exported so other surfaces showing the same records (currently:
// HomePage's desktop "Recent Activity" panel) can reuse the exact same
// title/subtitle wording — including self-transfer "Self" labeling, the
// chain-aware Claimed from/Transfer to text, and the P2P Sell Order
// Cancelled rename — instead of drifting from a second, hand-copied
// implementation. Nothing about this changes the row/table rendering
// itself, only makes the derivation reusable.
// ── Dedup + deterministic sort for the Activity list ────────────────────────
// Lifted out to a pure, exported function for the same reason
// useActivity.ts's mergeOnchainIntoRecords was: testable without mounting a
// component, and the merge/dedup/order semantics get the same scrutiny as
// any other correctness-critical logic here.
export function dedupeAndSortActivityRecords(records: ActivityRecord[]): ActivityRecord[] {
  const seen = new Set<string>()
  const base = records.filter(r => {
    // BUG FIX (2026-09-02): a self-bulk-payout (you're one of your own
    // batch's recipients) writes TWO rows under the SAME activityType
    // ('bulk') and the SAME on-chain hash — a sent-summary row and a
    // received-leg row, distinguished only by metadata.direction (see
    // Activity.bulk()/bulkReceived()'s bulk_/bulkrecv_ prefix comment;
    // the client-facing `txHash` here is the STRIPPED, unprefixed hash —
    // see ActivityService.ts's stripHashPrefix — so both legs collapse to
    // the identical `bulk:0x...` string). Every other type-pair (send vs
    // receive, p2p_purchase vs p2p_refund, etc.) already has a different
    // activityType per leg, so this collision is unique to bulk
    // self-payouts — this was silently dropping one of the two rows from
    // history, intermittently, depending on array order. Including
    // direction in the key (when present) keeps both legs distinct
    // without changing dedup behavior for every other type, which never
    // sets a conflicting direction on two same-typed rows sharing a hash.
    const direction = (r as any).metadata?.direction
    const k = r.txHash ? `${r.activityType}:${r.txHash}:${direction || ''}` : r.id
    if (!k || seen.has(k)) return false
    seen.add(k); return true
  })

  const swaps = base.filter(r => r.activityType === 'swap')
  const afterSwapFilter = swaps.length === 0 ? base : base.filter(r => {
    if (r.activityType !== 'receive') return true
    const isSwapOutputLeg = swaps.some(s => {
      const meta: any = (s as any).metadata || {}
      const outAmount = meta.amountOut
      const outToken  = meta.tokenOut
      if (outAmount == null || !outToken) return false
      const amountClose = Math.abs((r.amount ?? 0) - outAmount) < 0.01
      const tokenMatches = (r.tokenSymbol || '').toUpperCase() === String(outToken).toUpperCase()
      const timeClose = Math.abs(new Date(r.createdAt).getTime() - new Date(s.createdAt).getTime()) < 5 * 60_000
      return amountClose && tokenMatches && timeClose
    })
    return !isSwapOutputLeg
  })

  // Sort strictly by timestamp, newest first — with a deterministic
  // tiebreaker. `createdAt` alone isn't enough: Postgres stores
  // microsecond precision but JS's `Date` truncates to milliseconds, so
  // two rows genuinely can tie at this resolution (e.g. a bulk payout's
  // sent + received legs, written back-to-back). Array.prototype.sort's
  // comparator returning 0 for a tie relies on sort stability, which is
  // guaranteed by the spec in modern engines but still leaves the ORDER
  // dependent on whatever order the array happened to be in beforehand
  // (pagination arrival order, realtime insert order, dedup filtering
  // order) rather than on anything about the records themselves — so the
  // same two rows could visibly swap position across a refresh even
  // though nothing about the underlying data changed. `id` (a UUID, but
  // still a fixed value per row) as a secondary key makes the final order
  // a pure function of the records themselves, not of how they arrived.
  return [...afterSwapFilter].sort((a, b) => {
    const t = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    if (t !== 0) return t
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
  })
}

export function deriveActivityRow(record: ActivityRecord) {
  const { activityType: type, status, sourceChain, destinationChain, createdAt, amount, tokenSymbol } = record
  const metadata: any = (record as any).metadata || {}

  const isClaim    = type === 'claim'
  const isTransfer = type === 'bridge'
  const isSend     = type === 'send'
  const isReceive  = type === 'receive'
  const isSwap     = type === 'swap'
  const isBulk     = type === 'bulk'
  const isBulkReceived = isBulk && metadata.direction === 'received'
  const isP2PSellOrder = type === 'p2p_sell_order'
  const isP2PRefund    = type === 'p2p_refund'
  const isP2PPurchase  = type === 'p2p_purchase'
  const isP2PCredit    = isP2PRefund || isP2PPurchase // both show as '+', same as a receive

  const isPending  = status === 'pending'
  const isSuccess  = status === 'completed'
  const isFailed   = status === 'failed'

  const statusColor = isPending ? 'var(--warning)' : isFailed ? 'var(--danger)' : 'var(--success)'
  const statusLabel = isPending ? 'Processing…' : isFailed ? 'Failed' : 'Completed'

  const chain = isClaim
    ? chainLabel(sourceChain)
    : isTransfer
    ? chainLabel(destinationChain || sourceChain)
    : (isSend || isReceive || isSwap || isBulk || isP2PSellOrder || isP2PRefund || isP2PPurchase)
    ? 'Arc'
    : ''

  // Subtitle line — shows who / what
  const counterparty = (record as any).counterpartyAddress || ''
  const meta = (record as any).metadata || {}
  const counterpartyUsername = meta.toUsername || meta.fromUsername || ''

  const counterpartyLabel = counterpartyUsername
    ? (SYSTEM_LABELS[counterpartyUsername] ?? `${counterpartyUsername.replace(/\.arc$/i, '')}.arc`)
    : counterparty
    ? (counterparty.startsWith('0x')
        ? counterparty.slice(0, 6) + '...' + counterparty.slice(-6)
        : counterparty)
    : ''

  const swapPair = isSwap
    ? `${formatAmt(metadata.amountIn ?? amount, metadata.tokenIn || tokenSymbol)} ${metadata.tokenIn || tokenSymbol || 'USDC'} → ${formatAmt(metadata.amountOut ?? 0, metadata.tokenOut)} ${metadata.tokenOut || '?'}`
    : ''

  // Self-transfer: the counterparty IS this same wallet — a send/receive
  // pair created by paying your own username (see ActivityService.ts's own
  // comment on the send_/recv_ hash-prefix convention this relies on to
  // keep the two legs from colliding on the DB's unique index). Detected
  // purely by address equality, not by username, so it's correct even if
  // toUsername/fromUsername metadata is ever missing. Also covers a bulk
  // payout that includes the payer's own wallet as one recipient — that
  // received-leg row carries the same counterpartyAddress == walletAddress
  // shape (see Activity.bulk()/bulkReceived()'s own bulk_/bulkrecv_ prefix
  // comment for why both legs can now coexist at all).
  const isSelfTransfer = !!(
    counterparty && (record as any).walletAddress &&
    counterparty.toLowerCase() === String((record as any).walletAddress).toLowerCase()
  )

  const bulkSubtitle = isBulkReceived
    ? `from ${isSelfTransfer ? 'Self' : (counterpartyLabel || 'payer')}`
    : isBulk
    ? meta.recipientCount ? `${meta.recipientCount} recipients` : meta.purpose || ''
    : ''

  // P2P subtitle: "Offer #ab12cd34" / "Trade #ab12cd34" — the short id is
  // enough to tell entries apart without needing a full counterparty
  // lookup here (the P2P History page is where the full trade detail —
  // counterparty, status, etc. — actually lives).
  const p2pRefId = meta.tradeId || meta.offerId
  const p2pSubtitle = (isP2PSellOrder || isP2PRefund || isP2PPurchase) && p2pRefId
    ? `${meta.tradeId ? 'Trade' : 'Offer'} #${String(p2pRefId).slice(0, 8)}`
    : ''

  const subtitle = isSelfTransfer && (isSend || isReceive) ? 'Self'
                 : isSend     ? counterpartyLabel
                 : isReceive  ? counterpartyLabel
                 : isSwap     ? swapPair
                 : isBulk     ? bulkSubtitle
                 : isClaim    ? (chain || 'External')
                 : isTransfer ? counterpartyLabel
                 : (isP2PSellOrder || isP2PRefund || isP2PPurchase) ? p2pSubtitle
                 : ''

  const title = isSelfTransfer && isSend    ? 'Paid to'
              : isSelfTransfer && isReceive ? 'Received from'
              : isClaim    ? 'Claimed from'
              : isTransfer ? 'Transfer to'
              : isSend     ? 'Paid to'
              : isReceive  ? 'Received from'
              : isSwap     ? 'Swap'
              : isBulk     ? 'Bulk Payment'
              : isP2PSellOrder ? 'P2P Sell Order Created'
              // P2P Refund covers both a cancelled sell offer and a
              // cancelled/expired buy-offer trade (see the ActivityType
              // comment at the top of this file) — labeled here as "Sell
              // Order Cancelled" per product decision, not a claim that
              // every p2p_refund row is literally a sell-order cancellation.
              : isP2PRefund    ? 'P2P Sell Order Cancelled'
              : isP2PPurchase  ? 'P2P Purchase'
              : 'Transaction'

  const amountColor = isFailed ? 'var(--danger)' : (isClaim || isReceive || isBulkReceived || isP2PCredit) ? 'var(--success)' : 'var(--danger)'
  const amountPrefix = isFailed ? '' : (isClaim || isReceive || isBulkReceived || isP2PCredit) ? '+' : '-'

  return {
    metadata, amount, tokenSymbol, createdAt,
    isClaim, isTransfer, isSend, isReceive, isSwap, isBulk, isBulkReceived, isP2PSellOrder, isP2PRefund, isP2PPurchase, isP2PCredit,
    isPending, isSuccess, isFailed,
    statusColor, statusLabel, chain, subtitle, title, amountColor, amountPrefix, counterpartyLabel,
  }
}

// ── Single row — hub style ─────────────────────────────────────────────────────
function ActivityRow({ record, isFirst, isLast, onSelect }: {
  record: ActivityRecord; isFirst: boolean; isLast: boolean; onSelect: () => void
}) {
  const {
    metadata, amount, tokenSymbol, createdAt,
    isClaim, isTransfer, isSend, isReceive, isSwap, isBulk, isBulkReceived, isP2PSellOrder, isP2PRefund, isP2PPurchase, isP2PCredit,
    isPending, isFailed,
    statusColor, statusLabel, chain, subtitle, title, amountColor, amountPrefix, counterpartyLabel,
  } = deriveActivityRow(record)

  return (
    <div onClick={onSelect} style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px',
      borderTop: isFirst ? 'none' : '1px solid color-mix(in srgb, var(--text-primary) 5%, transparent)',
      cursor: 'pointer',
    }}>
      {/* Icon */}
      <div style={{
        width: 38, height: 38, borderRadius: '50%', flexShrink: 0,
        background: (isClaim || isReceive || isBulkReceived || isP2PCredit) ? 'color-mix(in srgb, var(--success) 10%, transparent)' : 'color-mix(in srgb, var(--brand) 10%, transparent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative',
      }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          {(isClaim || isReceive || isBulkReceived || isP2PCredit)
            ? <><path d="M8 2v9M5 8l3 3 3-3M2 13h12" stroke="var(--success)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></>
            : isSwap
            ? <><path d="M3 5h10M10 2l3 3-3 3M13 11H3M6 8l-3 3 3 3" stroke="var(--brand)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></>
            : isBulk
            ? <><circle cx="6" cy="5" r="2" stroke="var(--brand)" strokeWidth="1.4"/><path d="M2 13c0-2.2 1.8-4 4-4M9 7h5M9 10h5" stroke="var(--brand)" strokeWidth="1.4" strokeLinecap="round"/></>
            : <><path d="M2 8h12M10 5l3 3-3 3" stroke="var(--brand)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></>
          }
        </svg>
        {isPending && (
          <div style={{
            position: 'absolute', inset: -2, borderRadius: '50%',
            border: '2px solid color-mix(in srgb, var(--warning) 30%, transparent)', borderTop: '2px solid var(--warning)',
            animation: 'spin 0.8s linear infinite',
          }}/>
        )}
      </div>

      {/* Details */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
        {subtitle ? (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: counterpartyLabel && !isSwap ? 'monospace' : undefined }}>
            {subtitle}
          </div>
        ) : null}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: subtitle ? 2 : 2 }}>
          <span style={{ fontSize: 11, color: statusColor, fontWeight: 600 }}>{statusLabel}</span>
          {/* BUG FIX: claim rows already show the source chain as the
              subtitle right above ("Claimed from" / "Linea") — showing it
              again here duplicated the chain name on the same card, and
              the two ended up visually overlapping on narrow screens.
              Every other row type doesn't repeat itself this way (their
              subtitle is the counterparty/swap pair/etc., not the chain),
              so this only needed to be suppressed for claims specifically. */}
          {(chain && !isClaim) ? <><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>·</span><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{chain}</span></> : null}
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· {timeAgo(createdAt)}</span>
        </div>
      </div>

      {/* Amount */}
      {isSwap ? (
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
            -{formatAmt(metadata.amountIn ?? amount, metadata.tokenIn || tokenSymbol)} {metadata.tokenIn || tokenSymbol || 'USDC'}
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--success)', marginTop: 2 }}>
            +{formatAmt(metadata.amountOut ?? 0, metadata.tokenOut)} {metadata.tokenOut || '?'}
          </div>
        </div>
      ) : (
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: amountColor }}>
            {amountPrefix}{formatAmt(amount, tokenSymbol)} {tokenSymbol || 'USDC'}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Detail Sheet ───────────────────────────────────────────────────────────────
export function DetailSheet({ record, onClose }: { record: ActivityRecord; onClose: () => void }) {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const { showToastMessage } = useUIStore()
  const [rowCopied, setRowCopied] = useState<string | null>(null)
  const { activityType: type, status, sourceChain, destinationChain, createdAt, amount, tokenSymbol, txHash, destinationTxHash, metadata } = record

  const isClaim    = type === 'claim'
  const isTransfer = type === 'bridge'
  const isReceive  = type === 'receive'
  const isP2PSellOrder = type === 'p2p_sell_order'
  const isP2PRefund    = type === 'p2p_refund'
  const isP2PPurchase  = type === 'p2p_purchase'
  const isP2PCredit    = isP2PRefund || isP2PPurchase

  // Recovered claims (see claim-recovery-scan) genuinely don't know the real
  // source-chain burn hash — only the Arc-side mint was ever observed. Both
  // tx_hash and destinationTxHash get set to that same mint hash as a
  // required-field placeholder, which would otherwise render a "Source Tx
  // (Burn on X)" link built from an Arc hash under the SOURCE chain's
  // explorer — a link to a transaction that doesn't exist there at all.
  //
  // BUG FIX: this used to be `!!metadata?.recovered && !metadata?.hasRealSourceHash`
  // with no `isClaim` check at all — but `metadata.recovered` is ALSO set to
  // true on plain 'receive' rows, by both claim-recovery-scan's backstop
  // path and deposit-scan-all's reconcile path (see supabase/functions/
  // deposit-scan-all and claim-recovery-scan — `recovered` there just means
  // "found via the slower backstop scan, not the fast direct one," nothing
  // to do with claims). That meant ANY backstop-caught receive — including
  // things like a Circle testnet faucet claim — had its Explorer link
  // silently hidden, even though its tx_hash is a completely real, valid,
  // linkable Arc transaction hash. Only actual multichain claims are
  // missing a real source hash; receives always have one.
  const isRecoveredClaim = isClaim && !!metadata?.recovered && !metadata?.hasRealSourceHash
  const isBulkReceived = type === 'bulk' && (record as any).metadata?.direction === 'received'
  const isFailed   = status === 'failed'
  const isSuccess  = status === 'completed'

  // Both Claim and Transfer now show the chain matching the PRIMARY txHash —
  // Claims: sourceChain (the external chain being claimed from, where the
  // burn happens). Transfers: sourceChain is 'Arc_Testnet' (where the burn
  // happens on this side) — previously this used destinationChain instead,
  // which meant the link opened the destination chain's explorer while
  // txHash could still be Arc's burn hash (whenever destinationTxHash
  // wasn't captured), producing a link to a hash that doesn't exist on that
  // chain at all.

  const chain = isClaim
    ? chainLabel(sourceChain)
    : isTransfer ? chainLabel(destinationChain || sourceChain)
    : 'Arc'

  // Self-transfer detection — see deriveActivityRow's identical comment
  // above (ActivityRow/ActivityTableRow's shared derivation) for why this
  // is address-based, not username-based.
  const isSelfTransferDetail = !!(
    (record as any).counterpartyAddress && (record as any).walletAddress &&
    String((record as any).counterpartyAddress).toLowerCase() === String((record as any).walletAddress).toLowerCase()
  )

  const title = isSelfTransferDetail && type === 'send'    ? 'Paid to Self'
              : isSelfTransferDetail && type === 'receive' ? 'Received from Self'
              : isClaim    ? `Claimed from ${chainLabel(sourceChain) || 'External'}`
              : isTransfer ? 'Transfer to'
              : type === 'send' ? 'Paid to' : type === 'receive' ? 'Received from' : type === 'swap' ? 'Swap' : type === 'bulk' ? 'Bulk Payment'
              // See deriveActivityRow's identical comment on why p2p_refund
              // is labeled "Sell Order Cancelled" here — product decision,
              // not a claim every row is literally that.
              : isP2PSellOrder ? 'P2P Sell Order Created' : isP2PRefund ? 'P2P Sell Order Cancelled' : isP2PPurchase ? 'P2P Purchase'
              : 'Transaction'

  const amountColor = isFailed ? 'var(--danger)' : (isClaim || isReceive || isBulkReceived || isP2PCredit) ? 'var(--success)' : 'var(--danger)'
  const amountPrefix = isFailed ? '' : (isClaim || isReceive || isBulkReceived || isP2PCredit) ? '+' : '-'

  // Claims: source = the external chain's burn (sourceChain + txHash);
  // destination = Arc's mint (destinationTxHash). Transfers: source = Arc's
  // burn (txHash, Activity.bridge() always records this on the `txHash`
  // field for transfers — see MultichainTransferPage.tsx); destination = the
  // external chain's mint (destinationChain + destinationTxHash).
  //
  // BUG FIX: `showDestLink` used to require `isTransfer` — meaning claims
  // NEVER showed a destination (Arc mint) link at all, even though
  // destinationTxHash was already present in the data the whole time (see
  // the Hub page, which already displayed it correctly). Only a single
  // "View on Explorer" link (source only) ever rendered for claims. Also
  // switched off the local EXPLORERS map (incomplete + several wrong URLs —
  // see chainExplorers.ts's header comment) onto the same shared, verified
  // map every other page now uses.
  const sourceHref = isRecoveredClaim
    ? null
    : isClaim
    ? explorerTxUrl(sourceChain ?? '', txHash)
    : arcExplorerTxUrl(txHash) // transfers (and send/receive/swap/bulk) all burn/settle on Arc
  const destinationHref = isClaim
    ? arcExplorerTxUrl(destinationTxHash)
    : isTransfer
    ? explorerTxUrl(destinationChain ?? '', destinationTxHash)
    : null
  const sourceLinkLabel = isClaim
    ? `View Burn on ${chainLabel(sourceChain) || 'Source'} ↗`
    : isTransfer
    ? 'View Burn on Arc ↗'
    : 'View on Explorer ↗'
  const destinationLinkLabel = isClaim
    ? 'View Mint on Arc ↗'
    : `View Mint on ${chainLabel(destinationChain) || 'Destination'} ↗`

  // Row labels for the plain copyable hash text (distinct from the button
  // labels above) — same source/destination split as the Hub page, so a
  // claim/transfer card here shows both hashes as rows AND both explorer
  // links as buttons, instead of the single generic "Tx Hash" row it used
  // to collapse everything into (which only ever showed the source hash —
  // the destination hash existed in the data but was never surfaced here).
  const sourceHashLabel = isClaim
    ? `Source Tx (Burn on ${chainLabel(sourceChain) || 'Source'})`
    : isTransfer
    ? 'Source Tx (Arc Burn)'
    : 'Tx Hash'
  const destinationHashLabel = isClaim
    ? 'Destination Tx (Arc Mint)'
    : `Destination Tx (${chainLabel(destinationChain) || 'Destination'} Mint)`

  const counterparty = (record as any).counterpartyAddress || ''
  const cpUsername = metadata?.toUsername || metadata?.fromUsername || ''
  const cpLabel = isSelfTransferDetail
    ? 'Self'
    : cpUsername
    ? (SYSTEM_LABELS[cpUsername] ?? `${cpUsername.replace(/\.arc$/i, '')}.arc`)
    : counterparty
    ? counterparty.slice(0, 6) + '...' + counterparty.slice(-6)
    : ''
  const isSwapType = type === 'swap'

  const rows = [
    { label: 'Type',   value: isClaim ? 'Claim to Arc' : isTransfer ? 'Transfer out' : type === 'swap' ? 'Swap' : type === 'bulk' ? 'Bulk Payment' : type },
    { label: 'Chain',  value: chain },
    ...(type === 'bulk' && metadata.purpose ? [{ label: 'Purpose', value: metadata.purpose }] : []),
    ...(type === 'bulk' && !isBulkReceived && metadata.recipientCount ? [{ label: 'Recipients', value: String(metadata.recipientCount) }] : []),
    ...(isSwapType ? [
      { label: 'From',   value: `${metadata.amountIn || formatAmt(amount)} ${metadata.tokenIn || tokenSymbol || 'USDC'}` },
      { label: 'To',     value: `${metadata.amountOut ? formatAmt(metadata.amountOut) : '?'} ${metadata.tokenOut || '?'}` },
    ] : [
      { label: 'Amount', value: `$${formatAmt(amount)} ${tokenSymbol || 'USDC'}` },
    ]),
    ...(cpLabel ? [{ label: (type === 'receive' || isBulkReceived) ? 'From' : 'To', value: cpLabel, copy: counterparty || undefined }] : []),
    { label: 'Status', value: isFailed ? 'Failed ✗' : isSuccess ? 'Completed ✓' : 'Processing…' },
    { label: 'Date',   value: new Date(createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) },
    { label: 'Time',   value: new Date(createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) },
    ...(txHash && !isRecoveredClaim ? [{ label: sourceHashLabel, value: txHash.slice(0,6) + '…' + txHash.slice(-6), copy: txHash }] : []),
    ...((isClaim || isTransfer) && destinationTxHash ? [{ label: destinationHashLabel, value: destinationTxHash.slice(0,6) + '…' + destinationTxHash.slice(-6), copy: destinationTxHash }] : []),
  ]

  const detailContent = (
    <>
        {/* Header — desktop gets 20px top padding (was 0) so the icon/title
            don't sit flush against DesktopDialogFrame's rounded top corners
            (that frame has no padding of its own). Mobile's sheet already
            has its own drag-handle spacer above this, so it keeps the
            original 0 top padding unchanged. */}
        <div style={{ padding: isDesktop ? '20px 20px 16px' : '0 20px 16px', borderBottom: '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 44, height: 44, borderRadius: '50%', flexShrink: 0,
            background: (isClaim || isReceive || isBulkReceived) ? 'color-mix(in srgb, var(--success) 12%, transparent)' : 'color-mix(in srgb, var(--brand) 12%, transparent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              {(isClaim || isReceive || isBulkReceived)
                ? <path d="M9 2v10M5 9l4 4 4-4M2 15h14" stroke="var(--success)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                : <path d="M2 9h14M11 5l4 4-4 4" stroke="var(--brand)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              }
            </svg>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
            <div style={{ fontSize: 12, marginTop: 2, fontWeight: 600,
              color: isFailed ? 'var(--danger)' : isSuccess ? 'var(--success)' : 'var(--warning)' }}>
              {isFailed ? 'Failed' : isSuccess ? 'Completed ✓' : 'Processing…'}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: amountColor }}>
              {amountPrefix}{formatAmt(isSwapType ? (metadata.amountIn ?? amount) : amount, isSwapType ? (metadata.tokenIn || tokenSymbol) : tokenSymbol)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{isSwapType ? (metadata.tokenIn || tokenSymbol || 'USDC') : (tokenSymbol || 'USDC')}</div>
          </div>
        </div>

        {/* Rows */}
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {rows.map(row => (
            <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{row.label}</span>
              <span
                style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500,
                  fontFamily: (row as any).copy ? 'monospace' : 'inherit',
                  cursor: (row as any).copy ? 'pointer' : 'default', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                onClick={async () => {
                  const copyVal = (row as any).copy
                  if (!copyVal) return
                  const ok = await copyToClipboard(copyVal)
                  setRowCopied(row.label)
                  showToastMessage(ok ? `${row.label} copied` : `Could not copy ${row.label.toLowerCase()}`, ok ? 'success' : 'error')
                  setTimeout(() => setRowCopied(null), 1500)
                }}>
                {row.value}
                {(row as any).copy && (rowCopied === row.label
                  ? <Check className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--success)' }} />
                  : <Copy className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--brand)' }} />)}
              </span>
            </div>
          ))}

          {sourceHref && (
            <a href={sourceHref} target="_blank" rel="noopener noreferrer"
              style={{ display: 'block', textAlign: 'center', padding: '12px', borderRadius: 14, marginTop: 4,
                background: 'color-mix(in srgb, var(--brand) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--brand) 20%, transparent)',
                color: 'var(--brand)', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
              {sourceLinkLabel}
            </a>
          )}

          {destinationHref && (
            <a href={destinationHref} target="_blank" rel="noopener noreferrer"
              style={{ display: 'block', textAlign: 'center', padding: '12px', borderRadius: 14, marginTop: 4,
                background: 'color-mix(in srgb, var(--brand) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--brand) 15%, transparent)',
                color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
              {destinationLinkLabel}
            </a>
          )}
        </div>

        {/* Bulk recipients list */}
        {type === 'bulk' && (
          <div style={{ padding: '0 20px 8px' }}>
            {metadata.recipients && metadata.recipients.length > 0 ? (
              <>
                <p style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '0.06em', textTransform: 'uppercase', margin: '0 0 8px' }}>
                  🧾 Recipients ({metadata.recipients.length})
                </p>
                <div style={{ background: 'var(--surface)', borderRadius: 14, border: '1px solid color-mix(in srgb, var(--text-primary) 7%, transparent)', overflow: 'hidden' }}>
                  {metadata.recipients.map((r: any, i: number) => (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '9px 14px',
                      borderTop: i > 0 ? '1px solid color-mix(in srgb, var(--text-primary) 5%, transparent)' : 'none',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 28, height: 28, borderRadius: '50%', background: `hsl(${(i * 47) % 360},40%,25%)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: '#fff' }}>{(r.label || '?').charAt(0).toUpperCase()}</span>
                        </div>
                        <span style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500, fontFamily: r.label?.startsWith('0x') ? 'monospace' : undefined }}>
                          {r.label?.startsWith('0x') ? r.label.slice(0, 6) + '...' + r.label.slice(-6) : r.label}
                        </span>
                      </div>
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--danger)' }}>-${formatAmt(r.amount)}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : metadata.recipientCount ? (
              <div style={{ padding: '10px 14px', background: 'var(--surface)', borderRadius: 14, border: '1px solid color-mix(in srgb, var(--text-primary) 7%, transparent)' }}>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
                  🧾 {metadata.recipientCount} recipients — full list available for new payments
                </p>
              </div>
            ) : null}
          </div>
        )}
    </>
  )

  if (isDesktop) {
    return (
      <DesktopDialogFrame onClose={onClose} maxWidth={460}>
        {detailContent}
      </DesktopDialogFrame>
    )
  }
  return (
    <div onClick={onClose} style={{
      position: 'fixed', top: 0, bottom: 0, left: 0, right: 0, maxWidth: 430, margin: '0 auto', zIndex: 50,
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'flex-end',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', background: 'var(--surface)',
        borderRadius: '20px 20px 0 0',
        border: '1px solid color-mix(in srgb, var(--text-primary) 10%, transparent)',
        padding: '8px 0 40px',
        animation: 'slideUp 0.25s ease',
        maxHeight: '85vh',
        overflowY: 'auto',
      }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: 'color-mix(in srgb, var(--text-primary) 20%, transparent)', margin: '8px auto 20px' }}/>
        {detailContent}
      </div>
    </div>
  )
}

// ── Group by date ──────────────────────────────────────────────────────────────
function groupByDate(records: ActivityRecord[]) {
  const now = new Date()
  const todayMs     = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayMs = todayMs - 86400000
  const weekAgoMs   = todayMs - 7 * 86400000
  const groups: Record<string, ActivityRecord[]> = {}
  for (const r of records) {
    const d = new Date(r.createdAt)
    const dayMs = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const label = dayMs >= todayMs ? 'Today'
                : dayMs >= yesterdayMs ? 'Yesterday'
                : dayMs >= weekAgoMs ? 'This Week'
                : 'Earlier'
    if (!groups[label]) groups[label] = []
    groups[label].push(r)
  }
  return ['Today','Yesterday','This Week','Earlier'].filter(l => groups[l]?.length).map(l => ({ label: l, items: groups[l] }))
}

// ── Filter sheet ──────────────────────────────────────────────────────────────
// Every category label that used to sit as a permanently-visible row of tabs
// under the header now lives in here instead, opened from the slider icon
// next to Search. "All" is always the default on load/reset — nothing here
// changes that; the user has to explicitly tap a label to narrow the list.
// Opens as a right-edge drawer (both mobile and desktop) rather than a
// bottom sheet or centered dialog, per product request.
function FilterSheet({ active, onSelect, onClose }: {
  active: ActivityType | 'all' | 'p2p'
  onSelect: (id: ActivityType | 'all' | 'p2p') => void
  onClose: () => void
}) {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const panelWidth = isDesktop ? 340 : 'min(80vw, 320px)'

  const listContent = (
    <>
      <div className="flex items-center justify-between px-5 pt-5 pb-2">
        <h2 className="text-base font-bold text-text-primary">Filter</h2>
        <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center"
          style={{ background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
          <X className="w-4 h-4 text-text-secondary" />
        </button>
      </div>
      <div className="px-3 pb-4">
        {FILTERS.map(f => {
          const isActive = active === f.id
          return (
            <button key={f.id} onClick={() => { onSelect(f.id); onClose() }}
              className="w-full flex items-center justify-between px-3 py-3 rounded-2xl text-left"
              style={{ background: isActive ? 'color-mix(in srgb, var(--brand) 12%, transparent)' : 'transparent' }}>
              <span className="text-sm font-semibold" style={{ color: isActive ? 'var(--brand)' : 'var(--text-primary)' }}>
                {f.label}
              </span>
              {isActive && <Check className="w-4 h-4" style={{ color: 'var(--brand)' }} />}
            </button>
          )
        })}
      </div>
    </>
  )

  return (
    <div onClick={onClose} style={{
      position: 'fixed', top: 0, bottom: 0, left: 0, right: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)',
      display: 'flex', justifyContent: 'flex-end',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: panelWidth, height: '100%', background: 'var(--surface)',
        borderLeft: '1px solid color-mix(in srgb, var(--text-primary) 10%, transparent)',
        boxShadow: 'var(--shadow-3, -8px 0 24px rgba(0,0,0,0.25))',
        animation: 'slideInRight 0.22s ease-out',
        overflowY: 'auto',
      }}>
        {listContent}
      </div>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export function ActivityPage() {
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const walletAddress = useAuthStore(s => s.walletAddress)
  const userId = useAuthStore(s => s.user?.id)
  const [activeTab, setActiveTab] = useState<ActivityType | 'all' | 'p2p'>(
    searchParams.get('filter') === 'bridge' ? 'bridge'
      : searchParams.get('filter') === 'p2p' ? 'p2p'
      : searchParams.get('filter') === 'swap' ? 'swap'
      : 'all'
  )
  const [selected, setSelected] = useState<ActivityRecord | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const tokenFilter = new URLSearchParams(location.search).get('token')

  const { records, loading, loadingMore, error, hasMore, setFilter, setSearch, loadMore, refresh } = useActivity(walletAddress)

  // Debounce the search box → useActivity's `search` state, which re-queries
  // Supabase (see fetchActivity's search clause) rather than only filtering
  // whatever page of records happens to already be loaded — so a hash or
  // username from months ago still surfaces even if it isn't in the first
  // loaded page.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(t)
  }, [searchInput, setSearch])

  // One-time catch-up for P2P history that happened before this feature
  // existed — see backfillP2PActivity's own doc comment for why this is
  // safe to call every time this page mounts (self-deduplicating).
  useEffect(() => {
    if (!userId || !walletAddress) return
    backfillP2PActivity(userId, walletAddress).then(() => refresh())
  }, [userId, walletAddress])

  const handleTabChange = useCallback((tab: ActivityType | 'all' | 'p2p') => {
    setActiveTab(tab)
    // For bridge/p2p tabs: pass a special value; useActivity/fetchActivity will handle it
    if (tab === 'all') setFilter(undefined)
    else if (tab === 'bridge') setFilter('bridge' as ActivityType)  // handled below in fetchActivity
    else if (tab === 'p2p') setFilter('p2p' as ActivityType)        // handled below in fetchActivity
    else setFilter(tab as ActivityType)
  }, [setFilter])

  useEffect(() => {
    const el = bottomRef.current
    if (!el) return
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && hasMore && !loadingMore && !loading) loadMore()
    }, { threshold: 0.1 })
    obs.observe(el)
    return () => obs.disconnect()
  }, [hasMore, loadingMore, loading, loadMore])

  const displayed = (tokenFilter
    ? records.filter(r => r.tokenSymbol?.toUpperCase() === tokenFilter.toUpperCase())
    : records
  ).filter(r => {
    if (r.activityType === 'deposit') return false
    if (activeTab === 'all')     return true
    if (activeTab === 'send')    return r.activityType === 'send'
    if (activeTab === 'receive') return r.activityType === 'receive'
    if (activeTab === 'swap')    return r.activityType === 'swap'
    if (activeTab === 'bulk')    return r.activityType === 'bulk'
    if (activeTab === 'bridge')  return r.activityType === 'claim' || r.activityType === 'bridge'
    if (activeTab === 'p2p')     return r.activityType === 'p2p_sell_order' || r.activityType === 'p2p_refund' || r.activityType === 'p2p_purchase'
    return true
  })

  const deduped = dedupeAndSortActivityRecords(displayed)
  const sorted = deduped
  const groups = groupByDate(sorted)

  return (
    <div className="flex flex-col h-full overflow-hidden bg-bg">
      <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}} @keyframes slideInRight{from{transform:translateX(100%)}to{transform:translateX(0)}}`}</style>

      {/* Header */}
      <div className="sticky top-0 z-20 backdrop-blur-md" style={{ background: 'color-mix(in srgb, var(--bg) 95%, transparent)' }}>
        <div className="header-row px-5 pt-header pb-header justify-between">
          <h1 className="text-xl font-bold text-text-primary">Activity</h1>
          <button onClick={refresh} disabled={loading}
            className="w-9 h-9 rounded-2xl flex items-center justify-center active:scale-95 disabled:opacity-40"
            style={{ background: 'var(--surface)', border: '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
            <RefreshCw className={cn('w-4 h-4 text-text-secondary', loading && 'animate-spin')} />
          </button>
        </div>
        <div className="px-4 pb-3 lg:max-w-[900px] lg:mx-auto">
          <div className="flex items-center gap-2 rounded-2xl px-3.5 py-2.5 transition-colors focus-within:border-brand/40"
            style={{ background: 'var(--surface)', border: '1px solid color-mix(in srgb, var(--text-primary) 10%, transparent)', boxShadow: '0 1px 2px color-mix(in srgb, var(--text-primary) 3%, transparent)' }}>
            <Search className="w-4 h-4 flex-shrink-0 text-text-muted" />
            <input
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder="Search username, wallet, or tx hash"
              className="flex-1 min-w-0 bg-transparent border-none outline-none text-sm text-text-primary placeholder:text-text-muted"
            />
            {searchInput && (
              <button onClick={() => setSearchInput('')} className="flex-shrink-0 flex items-center justify-center w-5 h-5 rounded-full"
                style={{ background: 'color-mix(in srgb, var(--text-primary) 10%, transparent)' }}>
                <X className="w-3 h-3 text-text-secondary" />
              </button>
            )}
            <div className="w-px h-5 flex-shrink-0" style={{ background: 'color-mix(in srgb, var(--text-primary) 12%, transparent)' }} />
            <button onClick={() => setFilterOpen(true)} aria-label="Filter"
              className="flex-shrink-0 flex items-center justify-center relative w-7 h-7 -mr-1 rounded-full active:scale-90 transition-transform">
              {/* Two-line filter icon (was SlidersHorizontal's 3 rows) — same
                  slider-row visual language, one row fewer, per request. */}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                style={{ color: activeTab === 'all' ? 'var(--text-secondary)' : 'var(--brand)' }}>
                <line x1="3" y1="7" x2="21" y2="7" />
                <circle cx="15" cy="7" r="2.25" fill="var(--bg)" />
                <line x1="3" y1="17" x2="21" y2="17" />
                <circle cx="9" cy="17" r="2.25" fill="var(--bg)" />
              </svg>
              {activeTab !== 'all' && (
                <span style={{ position: 'absolute', top: 2, right: 2, width: 7, height: 7, borderRadius: '50%', background: 'var(--brand)' }} />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto pb-6">
        {loading && records.length === 0 && (
          <div className="px-4 pt-4 space-y-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="rounded-3xl overflow-hidden animate-pulse" style={{ background: 'var(--surface)', border: '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
                <div className="px-4 py-3.5 flex items-center gap-3.5">
                  <div className="w-10 h-10 rounded-full bg-[rgb(var(--text-primary-rgb)/0.05)] flex-shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3.5 bg-[rgb(var(--text-primary-rgb)/0.05)] rounded-full w-1/3" />
                    <div className="h-3 bg-[rgb(var(--text-primary-rgb)/0.05)] rounded-full w-1/4" />
                  </div>
                  <div className="h-4 bg-[rgb(var(--text-primary-rgb)/0.05)] rounded-full w-16" />
                </div>
              </div>
            ))}
          </div>
        )}

        {error && !loading && (
          <div className="mx-4 mt-4 p-4 rounded-2xl" style={{ background: 'color-mix(in srgb, var(--danger) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--danger) 20%, transparent)' }}>
            <p className="text-sm text-danger">{error}</p>
            <button onClick={refresh} className="mt-2 text-xs text-danger underline">Try again</button>
          </div>
        )}

        {!loading && !error && deduped.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-2">
            <p className="text-text-secondary font-semibold">No activity yet</p>
            <p className="text-sm text-text-muted text-center px-8">Your transactions will appear here.</p>
          </div>
        )}

        {/* Mobile: grouped cards. Desktop: a proper table below, driven by
            the exact same `groups` data and onSelect handler — no
            duplicated fetching/filtering, just a different markup shape. */}
        <div className="lg:hidden">
          {!loading && groups.map(group => (
            <div key={group.label} className="px-4 mb-4">
              <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-2 mt-4 px-1">{group.label}</p>
              <div style={{ background: 'var(--surface)', border: '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)', borderRadius: 20, overflow: 'hidden' }}>
                {group.items.map((item, i, arr) => (
                  <ActivityRow key={item.id} record={item}
                    isFirst={i === 0} isLast={i === arr.length - 1}
                    onSelect={() => setSelected(item)} />
                ))}
              </div>
            </div>
          ))}
        </div>

        {!loading && (
          <div className="hidden lg:block px-4 lg:max-w-[1100px] lg:mx-auto">
            {groups.map(group => (
              <div key={group.label} className="mb-6">
                <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-2 px-1">{group.label}</p>
                <table style={{ width: '100%', borderCollapse: 'collapse', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, overflow: 'hidden', boxShadow: 'var(--shadow-1)' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)', background: 'color-mix(in srgb, var(--text-primary) 3%, transparent)' }}>
                      {['Type', 'Details', 'Chain', 'Status', 'Time', 'Amount'].map((h, i) => (
                        <th key={h} style={{ textAlign: i === 5 ? 'right' : 'left', padding: '10px 16px', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {group.items.map(item => {
                      const row = deriveActivityRow(item)
                      return (
                        <tr key={item.id} onClick={() => setSelected(item)} className="desktop-table-row"
                          style={{ cursor: 'pointer', borderTop: '1px solid color-mix(in srgb, var(--text-primary) 5%, transparent)', background: 'var(--dt-hover-bg, transparent)', transition: 'background-color 150ms ease' }}>
                          <td style={{ padding: '12px 16px', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{row.title}</td>
                          <td style={{ padding: '12px 16px', fontSize: 13, color: 'var(--text-secondary)', fontFamily: row.counterpartyLabel && !row.isSwap ? 'monospace' : undefined }}>{row.subtitle || '—'}</td>
                          <td style={{ padding: '12px 16px', fontSize: 13, color: 'var(--text-secondary)' }}>{row.chain || '—'}</td>
                          <td style={{ padding: '12px 16px', fontSize: 13, fontWeight: 600, color: row.statusColor }}>{row.statusLabel}</td>
                          <td style={{ padding: '12px 16px', fontSize: 13, color: 'var(--text-muted)' }}>{timeAgo(row.createdAt)}</td>
                          <td style={{ padding: '12px 16px', fontSize: 13, fontWeight: 700, color: row.isSwap ? 'var(--success)' : row.amountColor, textAlign: 'right' }}>
                            {row.isSwap
                              ? `+${formatAmt(row.metadata.amountOut ?? 0, row.metadata.tokenOut)} ${row.metadata.tokenOut || '?'}`
                              : `${row.amountPrefix}${formatAmt(row.amount, row.tokenSymbol)} ${row.tokenSymbol || 'USDC'}`}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}

        <div ref={bottomRef} className="py-2 flex justify-center">
          {loadingMore && <Loader2 className="w-5 h-5 text-text-muted animate-spin" />}
        </div>

        {!loading && records.length > 0 && (
          <p className="text-center text-[11px] text-text-muted pb-2">{records.length} records</p>
        )}
      </div>

      {selected && <DetailSheet record={selected} onClose={() => setSelected(null)} />}
      {filterOpen && (
        <FilterSheet active={activeTab} onSelect={handleTabChange} onClose={() => setFilterOpen(false)} />
      )}
    </div>
  )
}
