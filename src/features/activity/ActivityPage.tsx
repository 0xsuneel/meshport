import { DESKTOP_QUERY } from '@/lib/motion'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { AnimatePresence } from 'framer-motion'
import { createPortal } from 'react-dom'
import { useHideOnScroll, collapseStyle } from '@/hooks/useHideOnScroll'
import {useLocation, useNavigate, useSearchParams} from 'react-router-dom'
import { RefreshCw, Loader2, X } from 'lucide-react'
import { useAuthStore, useUIStore } from '@/store'
import { useActivity } from '@/hooks/useActivity'
import { ActivityRecord, ActivityType, recoveredViaLabel, merchantRefundInfo } from '@/lib/ActivityService'
import { needsRecovery, failureReason } from '@/lib/failure'
import { moveBreakdown, moveLabels, formatFee, formatMoveAmount, type MoveBreakdown } from '@/lib/moveFees'
import { backfillP2PActivity } from '@/lib/p2pService'
import { cn, timeAgo, copyToClipboard, trimTrailingZeros } from '@/lib/utils'
import { explorerTxUrl, arcExplorerTxUrl } from '@/lib/chainExplorers'
import { ReceiptPopup } from '@/components/ui/ReceiptPopup'
import { SearchField } from '@/components/ui/SearchField'
import { useMerchant, isMerchantClaim } from '@/lib/merchant'
import { orderTitle, displayOrderNumber, shortOrderNumber, type OrderKind } from '@/lib/merchantPay'
import { SkeletonCards } from '@/components/ui/Skeleton'
import { ActionIcon, type ActionIconName } from '@/components/ui/ActionIcon'
import { TokenMenu } from '@/components/ui/TokenMenu'
import { HistoryRow, HistoryIcon } from '@/components/ui/HistoryRow'
import { fetchPointHistory, rewardsUserId, rewardTaskOf } from '@/lib/rewards'
import { pressable } from '@/lib/pressable'

type ActivityTab = ActivityType | 'all' | 'p2p' | 'merchant' | 'rewards'

const FILTERS: { id: ActivityTab; label: string }[] = [
  { id: 'all',     label: 'All'       },
  { id: 'send',    label: 'Sent'      },
  { id: 'receive', label: 'Received'  },
  { id: 'swap',    label: 'Swap'      },
  { id: 'bridge',  label: 'Multichain'},
  { id: 'bulk',    label: 'Bulk'      },
  { id: 'p2p',     label: 'P2P'       },
  { id: 'rewards', label: 'Rewards'   },
  // Approved merchants only (hidden for everyone else in the filter sheet).
  { id: 'merchant', label: 'Business' },
]

// Non-MeshPort-username senders/recipients (system-generated activity) - shown
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

// EXPLORERS map removed - this was a fifth independently-maintained copy of
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
// (ActivityTableRow) - see this file's own header comment on
// activityDisplayFields. Picks a precision tier by magnitude so small
// amounts still show meaningful digits, then trims any trailing zeros that
// tier's toFixed() padded on (e.g. "1.00" -> "1", "0.00000100" ->
// "0.000001") so real numbers are never hidden behind zeros.
//
// BUG FIX: the small-amount precision tiers used to only apply to
// BTC/ETH-like symbols. A USDC/EURC amount like 0.000004 fell into the
// plain "else" branch (toFixed(4)), which rounds 0.000004 to "0.0000" -
// trimmed, that's "0", silently hiding a real, nonzero received amount.
// Chat-pay/dust-size transfers on this testnet can be this small for ANY
// token, so the fine-precision tiers now apply regardless of symbol; only
// the >= 0.01 tier still varies by token (USDC/EURC show 2 decimals there,
// BTC-like tokens show 4).
function formatAmt(value: number | string, symbol?: string) {
  // Metadata amounts can arrive as strings (e.g. a swap's amountOut).
  const n = Number(value)
  if (!n || !Number.isFinite(n)) return '0'
  const abs = Math.abs(n)
  const sym = (symbol || '').toLowerCase()
  const isBtcLike = sym.includes('btc') || sym.includes('eth') || sym.includes('wbtc')
  if (abs < 0.0001) return trimTrailingZeros(n.toFixed(8))
  if (abs < 0.01)   return trimTrailingZeros(n.toFixed(6))
  return trimTrailingZeros(n.toFixed(isBtcLike ? 4 : 2))
}

// Pure derivation shared by the mobile card (ActivityRow) and the desktop
// table (ActivityTableRow) - same record in, same title/subtitle/status/
// amount fields out, so the two render paths can never drift apart.
// Exported so other surfaces showing the same records (currently:
// HomePage's desktop "Recent Activity" panel) can reuse the exact same
// title/subtitle wording - including self-transfer "Self" labeling, the
// chain-aware Claimed from/Transfer to text, and the P2P Sell Order
// Cancelled rename - instead of drifting from a second, hand-copied
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
    // ('bulk') and the SAME on-chain hash - a sent-summary row and a
    // received-leg row, distinguished only by metadata.direction (see
    // Activity.bulk()/bulkReceived()'s bulk_/bulkrecv_ prefix comment;
    // the client-facing `txHash` here is the STRIPPED, unprefixed hash -
    // see ActivityService.ts's stripHashPrefix - so both legs collapse to
    // the identical `bulk:0x...` string). Every other type-pair (send vs
    // receive, p2p_purchase vs p2p_refund, etc.) already has a different
    // activityType per leg, so this collision is unique to bulk
    // self-payouts - this was silently dropping one of the two rows from
    // history, intermittently, depending on array order. Including
    // direction in the key (when present) keeps both legs distinct
    // without changing dedup behavior for every other type, which never
    // sets a conflicting direction on two same-typed rows sharing a hash.
    const direction = (r as any).metadata?.direction
    const k = r.txHash ? `${r.activityType}:${r.txHash}:${direction || ''}` : r.id
    if (!k || seen.has(k)) return false
    seen.add(k); return true
  })

  // A recovery's money landing on Arc can also have been logged on its own
  // (a scanner's "claim" or "External deposit" for the same mint). The
  // recovery row already shows it - drop the second one.
  const landed = new Set<string>()
  for (const r of base) {
    const m: any = (r as any).metadata ?? {}
    if (r.activityType !== 'withdraw' || !m.ub_recovery) continue
    for (const h of [r.destinationTxHash, m.completed_tx_hash]) if (h) landed.add(String(h).toLowerCase())
  }
  const afterRecoveryFilter = landed.size === 0 ? base : base.filter(r =>
    !((r.activityType === 'claim' || r.activityType === 'receive') && r.txHash && landed.has(r.txHash.toLowerCase())))

  const swaps = afterRecoveryFilter.filter(r => r.activityType === 'swap')
  const afterSwapFilter = swaps.length === 0 ? afterRecoveryFilter : afterRecoveryFilter.filter(r => {
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

  // Sort strictly by timestamp, newest first - with a deterministic
  // tiebreaker. `createdAt` alone isn't enough: Postgres stores
  // microsecond precision but JS's `Date` truncates to milliseconds, so
  // two rows genuinely can tie at this resolution (e.g. a bulk payout's
  // sent + received legs, written back-to-back). Array.prototype.sort's
  // comparator returning 0 for a tie relies on sort stability, which is
  // guaranteed by the spec in modern engines but still leaves the ORDER
  // dependent on whatever order the array happened to be in beforehand
  // (pagination arrival order, realtime insert order, dedup filtering
  // order) rather than on anything about the records themselves - so the
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

const SWAP_FAILED_FALLBACK = "The swap didn't go through - nothing was swapped."

// Failed P2P escrow steps (metadata.kind from lib/p2pProviders.ts).
const P2P_FAILED_TITLES: Record<string, string> = {
  deposit_offer_failed: 'P2P escrow deposit',
  deposit_trade_failed: 'P2P escrow deposit',
  register_trade_failed: 'P2P trade start',
  release_failed: 'P2P release',
  refund_failed: 'P2P refund',
}

// Business → Pay staff sends a batch tagged 'payroll' (lib/batchPay): it reads
// as paying staff, never as a bulk payment.
const isPayroll = (m: any) => m?.kind === 'payroll'
const bulkWord = (m: any) => isPayroll(m) ? (m?.direction === 'received' ? 'Staff payment' : 'Paid staff') : 'Bulk Payment'
// Selling USDC into a buyer's rupee ad is a cash out to the bank (Business →
// Cash out, or the same trade from P2P): lib/p2pService tags those rows.
const cashOutTitle = (type: string, m: any) => !m?.cashOut ? null
  : type === 'p2p_sell_order' ? 'Cash out to bank' : type === 'p2p_refund' ? 'Cash out cancelled' : null

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
  // Unified Balance money sent back to this wallet (Recover → "Send back to
  // my wallet") - it arrives here, so it reads as '+' like a receive.
  const isUbRefund     = type === 'withdraw' && !!metadata.ub_recovery && metadata.resolution !== 'forward'
  const isP2PCredit    = isP2PRefund || isP2PPurchase || isUbRefund // all show as '+', same as a receive

  const isPending  = status === 'pending'
  const isSuccess  = status === 'completed'
  const isFailed   = status === 'failed'
  // A Transfer / Bring Funds move whose money already left: not "Failed" -
  // it's finished in Multichain Hub → Recover (lib/failure.ts).
  const isRecovery = needsRecovery(record)
  // Older failed swaps were saved without a reason - say what happened anyway.
  const reason     = isFailed ? (failureReason(record) ?? (isSwap ? SWAP_FAILED_FALLBACK : null)) : null

  const statusColor = isPending || isRecovery ? 'var(--warning)' : isFailed ? 'var(--danger)' : 'var(--success)'
  const statusLabel = isRecovery ? 'Needs recovery' : isPending ? 'Processing…' : isFailed ? 'Failed' : 'Completed'

  const chain = isClaim
    ? chainLabel(sourceChain)
    : isTransfer
    ? chainLabel(destinationChain || sourceChain)
    : (isSend || isReceive || isSwap || isBulk || isP2PSellOrder || isP2PRefund || isP2PPurchase)
    ? 'Arc'
    : ''

  // Subtitle line - shows who / what
  const counterparty = (record as any).counterpartyAddress || ''
  const meta = (record as any).metadata || {}
  const counterpartyUsername = meta.toUsername || meta.fromUsername || ''

  const refund = merchantRefundInfo(record)
  const counterpartyLabel = refund ? `${refund.from}${refund.order ? ` · ${displayOrderNumber(refund.order)}` : ''}`
    : counterpartyUsername
    ? (SYSTEM_LABELS[counterpartyUsername] ?? `${counterpartyUsername.replace(/\.arc$/i, '')}.arc`)
    : counterparty
    ? (counterparty.startsWith('0x')
        ? counterparty.slice(0, 6) + '...' + counterparty.slice(-6)
        : counterparty)
    : ''

  const swapPair = isSwap
    ? `${formatAmt(metadata.amountIn ?? amount, metadata.tokenIn || tokenSymbol)} ${metadata.tokenIn || tokenSymbol || 'USDC'} → ${formatAmt(metadata.amountOut ?? 0, metadata.tokenOut)} ${metadata.tokenOut || '?'}`
    : ''

  // Self-transfer: the counterparty IS this same wallet - a send/receive
  // pair created by paying your own username (see ActivityService.ts's own
  // comment on the send_/recv_ hash-prefix convention this relies on to
  // keep the two legs from colliding on the DB's unique index). Detected
  // purely by address equality, not by username, so it's correct even if
  // toUsername/fromUsername metadata is ever missing. Also covers a bulk
  // payout that includes the payer's own wallet as one recipient - that
  // received-leg row carries the same counterpartyAddress == walletAddress
  // shape (see Activity.bulk()/bulkReceived()'s own bulk_/bulkrecv_ prefix
  // comment for why both legs can now coexist at all).
  const isSelfTransfer = !!(
    counterparty && (record as any).walletAddress &&
    counterparty.toLowerCase() === String((record as any).walletAddress).toLowerCase()
  )

  const bulkSubtitle = isBulkReceived
    ? `from ${isSelfTransfer ? 'Self' : (isPayroll(meta) && meta.fromName ? String(meta.fromName) : counterpartyLabel || 'payer')}`
    : isBulk && isPayroll(meta)
    ? [meta.purpose, meta.recipientCount ? `${meta.recipientCount} ${meta.recipientCount === 1 ? 'person' : 'people'}` : ''].filter(Boolean).join(' · ')
    : isBulk
    ? meta.recipientCount ? `${meta.recipientCount} recipients` : meta.purpose || ''
    : ''

  // P2P subtitle: "Offer #ab12cd34" / "Trade #ab12cd34" - the short id is
  // enough to tell entries apart without needing a full counterparty
  // lookup here (the P2P History page is where the full trade detail -
  // counterparty, status, etc. - actually lives).
  const p2pRefId = meta.tradeId || meta.offerId
  const p2pSubtitle = (isP2PSellOrder || isP2PRefund || isP2PPurchase) && p2pRefId
    ? `${meta.tradeId ? 'Trade' : 'Offer'} #${String(p2pRefId).slice(0, 8)}`
    : ''

  // Merchant order payment received on Arc (tagged server-side with the order).
  // Order payments (bill / request with an order number) are never shown as a
  // plain receive / paid - merchant side "Payment received", customer side
  // "Order payment".
  // A Shop QR payment isn't an order anyone requested: no order number - the
  // business sees "Payment Received", the customer "Paid to" the shop.
  const shopPay = (isReceive || isSend) && activityOrderKind(metadata) === 'shop'
  const merchantOrder = (isReceive || isSend) && metadata.merchantOrder && !shopPay ? String(metadata.merchantOrder) : null
  // Which of the business's stores took it (merchant side).
  const orderStore = isReceive && metadata.merchantStore ? String(metadata.merchantStore) : ''
  const subtitle = merchantOrder || shopPay ? (isSend && metadata.merchantName ? String(metadata.merchantName) : `${counterpartyLabel}${orderStore ? ` · ${orderStore}` : ''}`)
                 : isSelfTransfer && (isSend || isReceive) ? 'Self'
                 : isSend     ? counterpartyLabel
                 : isReceive  ? counterpartyLabel
                 : isSwap     ? swapPair
                 : isBulk     ? bulkSubtitle
                 : isClaim && metadata.auto_convert && Array.isArray(metadata.chains) ? `From ${metadata.chains.map((c: string) => c.split('_')[0]).join(', ')}`
                 : isClaim && isMerchantClaim(record as any) ? `From ${chain || 'other chain'}`
                 : isClaim    ? (chain || 'External')
                 : isTransfer ? (isSelfTransfer ? 'Self' : counterpartyLabel)
                 : (isP2PSellOrder || isP2PRefund || isP2PPurchase) ? p2pSubtitle
                 : ''

  const recoveredTitle = recoveredViaLabel(record)
  const title = isClaim && metadata.auto_convert ? (status === 'pending' ? 'Settling to Arc' : 'Settled to Arc')
              : isClaim && isMerchantClaim(record as any) ? (status === 'pending' ? 'Settling to Arc' : 'Settled to Arc')
              : merchantOrder ? paidOrderTitle(metadata, merchantOrder, isReceive, true)
              : shopPay && isReceive ? 'Payment Received'
              : recoveredTitle ? recoveredTitle
              : refund ? 'Refund from'
              // A rewards claim that didn't go through (lib/rewards.ts).
              : isReceive && isFailed && metadata.receiveKind === 'reward_claim' ? 'Reward claim'
              : isSelfTransfer && isSend    ? 'Paid to'
              : isSelfTransfer && isReceive ? 'Received from'
              : isClaim    ? 'Claimed from'
              : isTransfer ? 'Transfer to'
              : isSend     ? 'Paid to'
              : isReceive  ? 'Received from'
              : isSwap     ? 'Swap'
              : isBulk     ? bulkWord(meta)
              : cashOutTitle(type, meta) && !(typeof meta.kind === 'string' && meta.kind.endsWith('_failed')) ? cashOutTitle(type, meta)!
              // BUG FIX: a top-up (topUpOfferEscrow) writes the same
              // p2p_sell_order activityType as the original offer, so it
              // showed the exact same "P2P Sell Order Created" title -
              // looking like a brand-new offer had been created again,
              // when it was really just added funds. metadata.kind
              // distinguishes the two (see topUpOfferEscrow's own comment).
              // A failed P2P escrow step (lib/p2pProviders.ts noteP2PFailure).
              : (isP2PSellOrder || isP2PRefund) && typeof meta.kind === 'string' && meta.kind.endsWith('_failed')
                ? (P2P_FAILED_TITLES[meta.kind] ?? 'P2P escrow')
              : isP2PSellOrder ? (meta.kind === 'offer_topped_up' ? 'Escrow Top-up' : 'P2P Sell Order Created')
              // P2P Refund covers both a cancelled sell offer and a
              // cancelled/expired buy-offer trade (see the ActivityType
              // comment at the top of this file) - labeled here as "Sell
              // Order Cancelled" per product decision, not a claim that
              // every p2p_refund row is literally a sell-order cancellation.
              : isP2PRefund    ? 'P2P Sell Order Cancelled'
              : isP2PPurchase  ? 'P2P Purchase'
              : 'Transaction'

  // Failed: nothing moved, so the amount is neither + nor - (muted, struck).
  const amountColor = isRecovery ? 'var(--warning)' : isFailed ? 'var(--text-muted)' : (isClaim || isReceive || isBulkReceived || isP2PCredit) ? 'var(--success)' : 'var(--danger)'
  const amountPrefix = isFailed ? '' : (isClaim || isReceive || isBulkReceived || isP2PCredit) ? '+' : '-'

  return {
    metadata, amount, tokenSymbol, createdAt,
    isClaim, isTransfer, isSend, isReceive, isSwap, isBulk, isBulkReceived, isP2PSellOrder, isP2PRefund, isP2PPurchase, isP2PCredit,
    isPending, isSuccess, isFailed, isRecovery, reason,
    statusColor, statusLabel, chain, subtitle, title, amountColor, amountPrefix, counterpartyLabel,
  }
}

// Same icons as the action buttons (Pay, Receive, Swap, P2P, Bulk Pay,
// Multichain Hub, Rewards). null: the row keeps a plain arrow.
export function activityRowIcon(record: ActivityRecord): ActionIconName | null {
  const { metadata, isClaim, isTransfer, isSend, isReceive, isSwap, isBulk, isBulkReceived,
    isP2PSellOrder, isP2PRefund, isP2PPurchase, isP2PCredit } = deriveActivityRow(record)
  return (isP2PSellOrder || isP2PRefund || isP2PPurchase) ? 'p2p'
    // Rewards points claimed to USDC (older rows only carry the sender name).
    : isReceive && (metadata.receiveKind === 'reward_claim' || !!SYSTEM_LABELS[metadata.fromUsername]) ? 'rewards'
    : (isClaim || isReceive || isBulkReceived || isP2PCredit) ? 'receive'
    : isSwap     ? 'swap'
    : isBulk     ? 'bulk'
    : isTransfer ? 'hub'
    : isSend     ? 'pay'
    : null
}

// ── Single row - hub style ─────────────────────────────────────────────────────
// Shared with the asset page (Home → Assets → a token), so both show the
// exact same rows - failed / pending / needs-recovery included.
/** Which order a merchant-order activity row is about (metadata set by the
 *  server on receives and by Chat Pay on sends). null: an older row that
 *  doesn't say - shown as "Paid ORD-00042". */
export function activityOrderKind(md: any): OrderKind | null {
  if (md?.merchantOrderKind === 'invoice') return 'bill'
  if (md?.merchantVia === 'shop_qr') return 'shop'
  if (md?.merchantPersonal === true) return 'request'
  if (md?.merchantPersonal === false) return 'merchant_request'
  return null
}
/** Payer: "Paid Bill ORD-00042"; receiver: "Bill ORD-00042 Received".
 *  `short` (history rows): "Paid Bill #42". */
const paidOrderTitle = (md: any, number: string, received: boolean, short = false) => {
  const kind = activityOrderKind(md)
  const no = short ? shortOrderNumber(number) : displayOrderNumber(number)
  if (!kind) return received ? `${no} Received` : `Paid ${no}`
  return orderTitle(kind, number, received ? { received: true, short } : { paid: true, short })
}

/** Bring / Transfer out: what was sent, what landed, and the fees (once known). */
export function activityMove(record: ActivityRecord): MoveBreakdown | null {
  const md: any = record.metadata || {}
  if (record.activityType === 'bridge') {
    return moveBreakdown('transfer', { amount: record.amount, arrivedAmount: record.arrivedAmount, status: record.status })
  }
  if (record.activityType === 'claim') {
    return moveBreakdown('bring', {
      amount: record.amount, arrivedAmount: record.arrivedAmount, status: record.status,
      claimedAmount: md.claimed_amount != null ? Number(md.claimed_amount) : null,
      meshportFee: md.meshport_fee != null ? Number(md.meshport_fee) : null,
    })
  }
  return null
}

/** Name for Circle's part of a move's fee: Gateway for Unified Balance, else Circle (CCTP). */
export const networkFeeLabel = (record: ActivityRecord) =>
  (record.metadata as any)?.route === 'ub' ? 'Gateway fee' : 'Circle fee'

export function ActivityRow({ record, onSelect, flash, inPanel }: {
  record: ActivityRecord; isFirst: boolean; isLast: boolean; onSelect: () => void
  /** The row whose details were just closed - flashes once. */
  flash?: boolean
  /** Inside a desktop history panel (16px sides, like Swap's). */
  inPanel?: boolean
}) {
  const {
    metadata, amount, tokenSymbol, createdAt,
    isClaim, isReceive, isSwap, isBulkReceived, isP2PCredit,
    isPending, isFailed, isRecovery, reason,
    statusColor, statusLabel, chain, subtitle, title, amountColor, amountPrefix,
  } = deriveActivityRow(record)

  const rowIcon = activityRowIcon(record)
  const oneLine: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }

  return (
    <div {...pressable(onSelect)} data-activity-id={record.id} className={flash ? 'mp-last-opened' : undefined} style={{
      // A clean list: no card or divider lines, rows sit on the page.
      display: 'flex', alignItems: 'center', gap: 12, padding: inPanel ? '11px 16px' : '11px 4px',
      cursor: 'pointer',
    }}>
      {/* Icon */}
      <div style={{
        width: 38, height: 38, borderRadius: '50%', flexShrink: 0,
        background: isPending || isRecovery ? 'color-mix(in srgb, var(--warning) 12%, transparent)' : isFailed ? 'color-mix(in srgb, var(--danger) 10%, transparent)' : (isClaim || isReceive || isBulkReceived || isP2PCredit) ? 'color-mix(in srgb, var(--success) 10%, transparent)' : 'color-mix(in srgb, var(--brand) 10%, transparent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative',
      }}>
        {isPending ? (
          // Still processing: a clock from the same icon family, in the status colour.
          <ActionIcon name="clock" size={18} color="var(--warning)" />
        ) : isFailed && !isRecovery ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label="Failed">
            <circle cx="8" cy="8" r="6.2" stroke="var(--danger)" strokeWidth="1.4"/>
            <path d="M6.2 6.2l3.6 3.6M9.8 6.2l-3.6 3.6" stroke="var(--danger)" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
        ) : rowIcon ? (
          <ActionIcon name={rowIcon} size={18}
            color={(isClaim || isReceive || isBulkReceived || isP2PCredit) ? 'var(--success)' : 'var(--brand-text)'} />
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M2 8h12M10 5l3 3-3 3" stroke="var(--brand-text)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        )}
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
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', ...oneLine }}>{title}</div>
        {subtitle ? (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {subtitle}
          </div>
        ) : null}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, ...oneLine }}>
          <span style={{ fontSize: 11, color: statusColor, fontWeight: 600, flexShrink: 0 }}>{statusLabel}</span>
          {/* BUG FIX: claim rows already show the source chain as the
              subtitle right above ("Claimed from" / "Linea") - showing it
              again here duplicated the chain name on the same card, and
              the two ended up visually overlapping on narrow screens.
              Every other row type doesn't repeat itself this way (their
              subtitle is the counterparty/swap pair/etc., not the chain),
              so this only needed to be suppressed for claims specifically. */}
          {/* BUG FIX: swap rows already show a long "X USDC → Y EURC"
              subtitle right above - adding "· Arc ·" into the meta line
              here on top of that pushed the line onto a second row on
              narrow screens, wrapping the timestamp underneath and right
              on top of the row below it. Every swap on this app happens on
              Arc anyway (there's no cross-chain swap), so the chain label
              wasn't adding information here, just length. */}
          {(chain && !isClaim && !isSwap) ? <><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>·</span><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{chain}</span></> : null}
          <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>· {timeAgo(createdAt)}</span>
        </div>
        {/* Why it failed - one line here, the full sentence in the receipt. */}
        {isRecovery ? (
          <div style={{ fontSize: 11, color: 'var(--warning-text)', marginTop: 2, ...oneLine }}>Tap to finish it in Recover</div>
        ) : reason ? (
          <div style={{ fontSize: 11, color: 'var(--danger-text)', marginTop: 2, ...oneLine }} title={reason}>{reason}</div>
        ) : null}
      </div>

      {/* Amount */}
      {isSwap && !isFailed ? (
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
            -{formatAmt(metadata.amountIn ?? amount, metadata.tokenIn || tokenSymbol)} {metadata.tokenIn || tokenSymbol || 'USDC'}
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--success-text)', marginTop: 2 }}>
            +{formatAmt(metadata.amountOut ?? 0, metadata.tokenOut)} {metadata.tokenOut || '?'}
          </div>
        </div>
      ) : (
        <div style={{ textAlign: 'right', flexShrink: 0, maxWidth: '42%' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: amountColor, textDecoration: isFailed && !isRecovery ? 'line-through' : undefined, ...oneLine }}>
            {amountPrefix}{formatAmt(isSwap ? (metadata.amountIn ?? amount) : amount, isSwap ? (metadata.tokenIn || tokenSymbol) : tokenSymbol)} {(isSwap ? metadata.tokenIn : null) || tokenSymbol || 'USDC'}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Detail Sheet ───────────────────────────────────────────────────────────────
export function DetailSheet({ record, onClose }: { record: ActivityRecord; onClose: () => void }) {
  const { showToastMessage } = useUIStore()
  const navigate = useNavigate()
  const isRecovery = needsRecovery(record)
  const failReason = record.status === 'failed' ? (failureReason(record) ?? (record.activityType === 'swap' ? SWAP_FAILED_FALLBACK : null)) : null
  const [rowCopied, setRowCopied] = useState<string | null>(null)
  const { activityType: type, status, sourceChain, destinationChain, createdAt, amount, tokenSymbol, txHash, destinationTxHash, metadata } = record

  const isClaim    = type === 'claim'
  const isTransfer = type === 'bridge'
  const isReceive  = type === 'receive'
  const isP2PSellOrder = type === 'p2p_sell_order'
  const isP2PRefund    = type === 'p2p_refund'
  const isP2PPurchase  = type === 'p2p_purchase'
  const isUbRefund     = type === 'withdraw' && !!(metadata as any)?.ub_recovery && (metadata as any)?.resolution !== 'forward'
  const isP2PCredit    = isP2PRefund || isP2PPurchase || isUbRefund // '+', same as a receive

  // Recovered claims (see claim-recovery-scan) genuinely don't know the real
  // source-chain burn hash - only the Arc-side mint was ever observed. Both
  // tx_hash and destinationTxHash get set to that same mint hash as a
  // required-field placeholder, which would otherwise render a "Source Tx
  // (Burn on X)" link built from an Arc hash under the SOURCE chain's
  // explorer - a link to a transaction that doesn't exist there at all.
  //
  // BUG FIX: this used to be `!!metadata?.recovered && !metadata?.hasRealSourceHash`
  // with no `isClaim` check at all - but `metadata.recovered` is ALSO set to
  // true on plain 'receive' rows, by both claim-recovery-scan's backstop
  // path and deposit-scan-all's reconcile path (see supabase/functions/
  // deposit-scan-all and claim-recovery-scan - `recovered` there just means
  // "found via the slower backstop scan, not the fast direct one," nothing
  // to do with claims). That meant ANY backstop-caught receive - including
  // things like a Circle testnet faucet claim - had its Explorer link
  // silently hidden, even though its tx_hash is a completely real, valid,
  // linkable Arc transaction hash. Only actual multichain claims are
  // missing a real source hash; receives always have one.
  const isRecoveredClaim = isClaim && !!metadata?.recovered && !metadata?.hasRealSourceHash
  const isBulkReceived = type === 'bulk' && (record as any).metadata?.direction === 'received'
  const isFailed   = status === 'failed'
  const isSuccess  = status === 'completed'

  // Both Claim and Transfer now show the chain matching the PRIMARY txHash -
  // Claims: sourceChain (the external chain being claimed from, where the
  // burn happens). Transfers: sourceChain is 'Arc_Testnet' (where the burn
  // happens on this side) - previously this used destinationChain instead,
  // which meant the link opened the destination chain's explorer while
  // txHash could still be Arc's burn hash (whenever destinationTxHash
  // wasn't captured), producing a link to a hash that doesn't exist on that
  // chain at all.

  const chain = isClaim
    ? chainLabel(sourceChain)
    : isTransfer ? chainLabel(destinationChain || sourceChain)
    : 'Arc'

  // Self-transfer detection - see deriveActivityRow's identical comment
  // above (ActivityRow/ActivityTableRow's shared derivation) for why this
  // is address-based, not username-based.
  const isSelfTransferDetail = !!(
    (record as any).counterpartyAddress && (record as any).walletAddress &&
    String((record as any).counterpartyAddress).toLowerCase() === String((record as any).walletAddress).toLowerCase()
  )

  const transferCp = String((record as any).counterpartyAddress || '')
  const transferCpName = (metadata as any)?.toUsername ? `${String((metadata as any).toUsername).replace(/\.arc$/i, '')}.arc` : ''
  const transferToLabel = !isTransfer ? ''
    : isSelfTransferDetail ? 'Self'
    : transferCpName || (transferCp ? `${transferCp.slice(0, 6)}…${transferCp.slice(-4)}` : '')
  const recoveredDetail = recoveredViaLabel(record)
  const refundDetail = merchantRefundInfo(record)
  const merchantOrderDetail = (type === 'receive' || type === 'send') && (metadata as any)?.merchantOrder && activityOrderKind(metadata) !== 'shop' ? String((metadata as any).merchantOrder) : null
  const orderWord = merchantOrderDetail ? paidOrderTitle(metadata, merchantOrderDetail, type === 'receive') : ''
  const title = isClaim && (metadata as any)?.merchant ? `Payment received · ${chainLabel(sourceChain) || 'External'}`
              : merchantOrderDetail ? orderWord
              : type === 'receive' && activityOrderKind(metadata) === 'shop' ? 'Payment Received'
              : recoveredDetail && isClaim ? `${recoveredDetail} · ${chainLabel(sourceChain) || 'External'}`
              : recoveredDetail ? recoveredDetail
              : refundDetail ? `Refund from ${refundDetail.from}`
              : isSelfTransferDetail && type === 'send'    ? 'Paid to Self'
              : isSelfTransferDetail && type === 'receive' ? 'Received from Self'
              : isClaim    ? `Claimed from ${chainLabel(sourceChain) || 'External'}`
              // Who it went to: "Self" for your own wallet, else their
              // username or shortened address (the chain is in the details).
              : isTransfer ? (transferToLabel ? `Transfer to ${transferToLabel}` : `Transfer to ${chainLabel(destinationChain) || 'another chain'}`)
              : type === 'send' ? 'Paid to' : type === 'receive' ? 'Received from' : type === 'swap' ? 'Swap' : type === 'bulk' ? bulkWord(metadata)
              : cashOutTitle(type, metadata) ? cashOutTitle(type, metadata)!
              // See deriveActivityRow's identical comment on why p2p_refund
              // is labeled "Sell Order Cancelled" here - product decision,
              // not a claim every row is literally that.
              : isP2PSellOrder ? (metadata?.kind === 'offer_topped_up' ? 'Escrow Top-up' : 'P2P Sell Order Created') : isP2PRefund ? 'P2P Sell Order Cancelled' : isP2PPurchase ? 'P2P Purchase'
              : 'Transaction'

  const amountColor = isFailed ? 'var(--danger)' : (isClaim || isReceive || isBulkReceived || isP2PCredit) ? 'var(--success)' : 'var(--danger)'
  const amountPrefix = isFailed ? '' : (isClaim || isReceive || isBulkReceived || isP2PCredit) ? '+' : '-'

  // Claims: source = the external chain's burn (sourceChain + txHash);
  // destination = Arc's mint (destinationTxHash). Transfers: source = Arc's
  // burn (txHash, Activity.bridge() always records this on the `txHash`
  // field for transfers - see MultichainTransferPage.tsx); destination = the
  // external chain's mint (destinationChain + destinationTxHash).
  //
  // BUG FIX: `showDestLink` used to require `isTransfer` - meaning claims
  // NEVER showed a destination (Arc mint) link at all, even though
  // destinationTxHash was already present in the data the whole time (see
  // the Hub page, which already displayed it correctly). Only a single
  // "View on Explorer" link (source only) ever rendered for claims. Also
  // switched off the local EXPLORERS map (incomplete + several wrong URLs -
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
  // labels above) - same source/destination split as the Hub page, so a
  // claim/transfer card here shows both hashes as rows AND both explorer
  // links as buttons, instead of the single generic "Tx Hash" row it used
  // to collapse everything into (which only ever showed the source hash -
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
    : refundDetail ? refundDetail.from
    : cpUsername
    ? (SYSTEM_LABELS[cpUsername] ?? `${cpUsername.replace(/\.arc$/i, '')}.arc`)
    : counterparty
    ? counterparty.slice(0, 6) + '...' + counterparty.slice(-6)
    : ''
  const isSwapType = type === 'swap'

  const move = activityMove(record)
  const moveLbl = moveLabels(isTransfer ? 'transfer' : 'bring', (record as any).counterpartyAddress, (record as any).walletAddress)
  const rows = [
    { label: 'Type',   value: (isClaim && isMerchantClaim(record as any)) ? `Settlement from ${chain || 'other chain'}` : merchantOrderDetail ? orderWord : activityOrderKind(metadata) === 'shop' && (type === 'receive' || type === 'send') ? 'Payment' : isClaim ? 'Claim to Arc' : isTransfer ? 'Transfer out' : type === 'swap' ? 'Swap' : type === 'bulk' ? bulkWord(metadata) : cashOutTitle(type, metadata) ?? type },
    { label: 'Chain',  value: chain },
    ...(merchantOrderDetail ? [{ label: activityOrderKind(metadata) === 'bill' ? 'Bill' : activityOrderKind(metadata) === 'merchant_request' ? 'Requested Payment' : 'Request', value: displayOrderNumber(merchantOrderDetail) }] : []),
    ...(merchantOrderDetail && type === 'send' && (metadata as any)?.merchantName ? [{ label: 'Business', value: String((metadata as any).merchantName) }] : []),
    // The business's store that took the payment (merchant side).
    ...(type === 'receive' && (metadata as any)?.merchantStore ? [{ label: 'Store', value: String((metadata as any).merchantStore) }] : []),
    ...(isClaim && (metadata as any)?.merchant && (record as any).walletAddress
      ? [{ label: 'Paid to', value: `${String((record as any).walletAddress).slice(0, 6)}…${String((record as any).walletAddress).slice(-6)}`, copy: String((record as any).walletAddress) }]
      : []),
    ...(type === 'bulk' && metadata.purpose ? [{ label: 'Purpose', value: metadata.purpose }] : []),
    ...(type === 'bulk' && !isBulkReceived && metadata.recipientCount ? [{ label: isPayroll(metadata) ? 'People' : 'Recipients', value: String(metadata.recipientCount) }] : []),
    ...(isBulkReceived && isPayroll(metadata) && metadata.fromName ? [{ label: 'Business', value: String(metadata.fromName) }] : []),
    ...(isSwapType ? [
      { label: 'From',   value: `${metadata.amountIn || formatAmt(amount)} ${metadata.tokenIn || tokenSymbol || 'USDC'}` },
      { label: 'To',     value: isFailed ? `Not swapped${metadata.tokenOut ? ` (${metadata.tokenOut})` : ''}` : `${metadata.amountOut ? formatAmt(metadata.amountOut) : '?'} ${metadata.tokenOut || '?'}` },
    ] : [
      { label: 'Amount', value: `$${formatAmt(amount)} ${tokenSymbol || 'USDC'}` },
    ]),
    ...(cpLabel ? [{ label: (type === 'receive' || isBulkReceived) ? 'From' : 'To', value: cpLabel, copy: counterparty || undefined }] : []),
    ...(move ? [
      { label: moveLbl.sent, value: `${formatMoveAmount(move.sent)} ${tokenSymbol || 'USDC'}` },
      { label: moveLbl.received, value: `${formatMoveAmount(move.received)} ${tokenSymbol || 'USDC'}` },
      { label: 'Fees paid', value: formatFee(move.fees) },
      ...(move.meshportFee > 0 ? [
        { label: 'MeshPort fee', value: formatFee(move.meshportFee) },
        { label: networkFeeLabel(record), value: formatFee(move.networkFee) },
      ] : []),
    ] : []),
    { label: 'Status', value: isFailed ? 'Failed' : isSuccess ? 'Completed' : 'Processing…' },
    { label: 'Date',   value: new Date(createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) },
    { label: 'Time',   value: new Date(createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) },
    // A recovery is listed when its money landed; this is when the transfer was first tried.
    ...((metadata as any)?.started_at ? [{ label: 'First tried', value: new Date((metadata as any).started_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) }] : []),
    ...(txHash && !isRecoveredClaim ? [{ label: sourceHashLabel, value: txHash.slice(0,6) + '…' + txHash.slice(-6), copy: txHash }] : []),
    ...((isClaim || isTransfer) && destinationTxHash ? [{ label: destinationHashLabel, value: destinationTxHash.slice(0,6) + '…' + destinationTxHash.slice(-6), copy: destinationTxHash }] : []),
  ]

  // Tapping a history card reopens the same receipt a live payment ends on
  // (see ReceiptPopup) - incoming records get the receiver version.
  const isIncoming = isClaim || isReceive || isBulkReceived || isP2PCredit
  // Needs recovery reads as in-progress (amber), not as a failure.
  const receiptStatus = isRecovery ? 'pending' : isFailed ? 'failed' : isSuccess ? 'success' : 'pending'
  const doneTitle = isClaim ? ((metadata as any)?.merchant ? 'Payment Received' : 'Funds Arrived')
    : isReceive || isBulkReceived ? 'Payment Received'
    : isSwapType ? 'Swap Successful!'
    : isTransfer ? 'Transfer Complete'
    : type === 'bulk' ? (isPayroll(metadata) ? 'Staff Paid' : 'Bulk Payment Sent')
    : type === 'send' ? 'Paid Successfully'
    : title
  const receiptTitle = isRecovery ? 'Needs recovery'
    : receiptStatus === 'success' ? doneTitle
    : receiptStatus === 'failed' ? (isSwapType ? 'Swap Failed' : isTransfer ? 'Transfer Failed' : isClaim ? 'Claim Failed'
      : type === 'bulk' ? (isPayroll(metadata) ? 'Staff Payment Failed' : 'Bulk Payment Failed') : (isP2PSellOrder || type === 'p2p_refund') ? `${title} Failed`
      : isReceive && (metadata as any)?.receiveKind === 'reward_claim' ? 'Reward Claim Failed' : 'Payment Failed')
    : 'Processing…'
  const amountText = isSwapType
    ? `${metadata.amountIn || formatAmt(amount)} ${metadata.tokenIn || tokenSymbol || 'USDC'} → ${isFailed ? '' : metadata.amountOut ? `${formatAmt(metadata.amountOut)} ` : '? '}${metadata.tokenOut || '?'}`
    : `${amountPrefix}${formatAmt(amount, tokenSymbol)} ${tokenSymbol || 'USDC'}`
  // (A transfer's title already names who it went to, Self included.)
  const receiptSubtitle = cpLabel && (type === 'send' || type === 'receive') && !isSelfTransferDetail
    ? `${title} ${cpLabel}` : title

  const copyRow = (label: string, value: string) => async () => {
    const ok = await copyToClipboard(value)
    setRowCopied(label)
    showToastMessage(ok ? `${label} copied` : `Could not copy ${label.toLowerCase()}`, ok ? 'success' : 'error')
    setTimeout(() => setRowCopied(null), 1500)
  }
  const toReceiptRow = (row: { label: string; value: string; copy?: string }) => ({
    label: row.label,
    value: row.value,
    positive: !isFailed && (row.label === 'From' || row.label === 'To' || (isIncoming && row.label === 'Amount')),
    ...(row.copy ? { onCopy: copyRow(row.label, row.copy), copied: rowCopied === row.label } : {}),
  })
  // The header already shows the amount (a swap's both sides) and, in the
  // subtitle, who it was with; the title says the outcome. So no Amount row,
  // no To/From row repeating the subtitle (the wallet address goes in the
  // details instead), no Status, and no Type that just restates the title.
  const nameInSubtitle = receiptSubtitle !== title || (isTransfer && !!transferToLabel)
  const MAIN_LABELS = new Set(['Order', 'Business', 'Paid to', 'Purpose', 'Recipients', 'You claimed', 'You transferred', 'Receiver got', 'You received', 'Fees paid', 'MeshPort fee', 'Circle fee', 'Gateway fee', sourceHashLabel, ...(nameInSubtitle || isSwapType ? [] : ['From', 'To'])])
  const DROP_LABELS = new Set(['Amount', 'Status', 'Date', 'Time',
    ...(isSwapType || nameInSubtitle ? ['From', 'To'] : []),
    ...((isClaim && isMerchantClaim(record as any)) ? [] : ['Type'])])
  const when = new Date(createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  const mainRows = [
    ...(rows as { label: string; value: string; copy?: string }[]).filter(r => MAIN_LABELS.has(r.label)).map(toReceiptRow),
    { label: 'Time', value: when },
  ]
  const detailRowsList = [
    ...(rows as { label: string; value: string; copy?: string }[]).filter(r => !MAIN_LABELS.has(r.label) && !DROP_LABELS.has(r.label)).map(toReceiptRow),
    // Only when the subtitle shows a username - then the address is new information.
    // (and for a transfer to someone else's address, so it can still be copied)
    ...(nameInSubtitle && (cpUsername || (isTransfer && !isSelfTransferDetail)) && counterparty && !isSwapType
      ? [toReceiptRow({ label: 'Wallet', value: `${counterparty.slice(0, 6)}…${counterparty.slice(-6)}`, copy: counterparty })]
      : []),
    ...(refundDetail?.order ? [toReceiptRow({ label: 'For', value: `Order ${displayOrderNumber(refundDetail.order)}` })] : []),
    ...(refundDetail?.reason ? [toReceiptRow({ label: 'Reason', value: refundDetail.reason })] : []),
    ...(type === 'bulk' && Array.isArray(metadata.recipients)
      ? metadata.recipients.map((r: any, i: number) => ({
          label: r.label?.startsWith('0x') ? `${r.label.slice(0, 6)}…${r.label.slice(-4)}` : (r.label || `Recipient ${i + 1}`),
          value: `-$${formatAmt(r.amount)}`,
        }))
      : []),
  ]
  const receiptLinks = [
    ...(sourceHref && txHash ? [{ title: sourceLinkLabel.replace(/ ↗$/, ''), explorer: isClaim ? (chainLabel(sourceChain) || 'Explorer') : 'ArcScan', hash: txHash, href: sourceHref }] : []),
    ...(destinationHref && destinationTxHash ? [{ title: destinationLinkLabel.replace(/ ↗$/, ''), explorer: isClaim ? 'ArcScan' : (chainLabel(destinationChain) || 'Explorer'), hash: destinationTxHash, href: destinationHref }] : []),
  ]

  return (
    <ReceiptPopup
      onClose={onClose}
      status={receiptStatus}
      title={receiptTitle}
      subtitle={<>
        <span style={{ display: 'block', fontSize: 20, fontWeight: 800, color: amountColor, marginBottom: 4, overflowWrap: 'anywhere' }}>{amountText}</span>
        {receiptSubtitle}
        {/* The full reason - wraps, never overlaps the rows below. */}
        {(isRecovery || failReason) && (
          <span style={{ display: 'block', marginTop: 10, padding: '8px 10px', borderRadius: 10, fontSize: 13, lineHeight: 1.45, textAlign: 'left',
            color: isRecovery ? 'var(--warning-text)' : 'var(--danger-text)',
            background: isRecovery ? 'color-mix(in srgb, var(--warning) 10%, transparent)' : 'color-mix(in srgb, var(--danger) 8%, transparent)' }}>
            {isRecovery
              ? `This move didn't finish on its own${failReason ? ` (${failReason.replace(/[.\s]+$/, '')})` : ''}. Your USDC already left the wallet - open Recover to finish it or bring it back.`
              : failReason}
          </span>
        )}
      </>}
      rows={mainRows}
      detailRows={detailRowsList}
      fullHash={txHash && !isRecoveredClaim ? txHash : undefined}
      links={receiptLinks}
      {...(isRecovery ? { primaryLabel: 'Open Recover', onPrimary: () => { onClose(); navigate('/multichain', { state: { tab: 'recovery' } }) } } : {})}
    />
  )
}

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

/** A rewards claim paid out as USDC (newer rows say so; older ones only carry the sender name). */
function isRewardClaim(r: ActivityRecord): boolean {
  const md: any = (r as any).metadata ?? {}
  return r.activityType === 'receive' && (md.receiveKind === 'reward_claim' || !!SYSTEM_LABELS[md.fromUsername])
}

// ── Filter menu ───────────────────────────────────────────────────────────────
// Floats down from the filter icon next to Search, same look as the Pay /
// Swap token picker (TokenMenu). "All" is the default on load/reset.
const FILTER_ICONS: Record<string, ActionIconName> = {
  all: 'clock', send: 'pay', receive: 'receive', swap: 'swap', bridge: 'hub', bulk: 'bulk', p2p: 'p2p', rewards: 'rewards', merchant: 'insights',
}
function FilterMenu({ anchor, active, onSelect, onClose }: {
  anchor: HTMLElement | null
  active: ActivityTab
  onSelect: (id: ActivityTab) => void
  onClose: () => void
}) {
  const { isMerchant, accountType } = useMerchant()
  // Business accounts (approved merchant or business sign-up) don't earn
  // rewards, so the Rewards filter is hidden for them; Merchant is theirs.
  const isBusiness = isMerchant || accountType === 'business'
  // Portalled over the page at the icon's spot - the search row's collapse
  // wrapper clips anything that overflows it.
  const r = anchor?.getBoundingClientRect()
  if (!r) return null
  return createPortal(
    <div style={{ position: 'fixed', top: r.top, left: r.left, width: r.width, height: r.height, zIndex: 60 }}>
    <TokenMenu width={200} ariaLabel="Filter activity" selected={active} onClose={onClose}
      onSelect={id => onSelect(id as ActivityTab)}
      options={FILTERS.filter(f => (f.id !== 'merchant' || isBusiness) && (f.id !== 'rewards' || !isBusiness)).map(f => ({
        id: f.id, label: f.label,
        icon: (
          <span className="flex items-center justify-center rounded-full flex-shrink-0"
            style={{ width: 30, height: 30, background: f.id === active ? 'rgba(255,255,255,0.2)' : 'color-mix(in srgb, var(--brand) 16%, transparent)' }}>
            <ActionIcon name={FILTER_ICONS[f.id] ?? 'more'} size={17} color={f.id === active ? '#fff' : 'var(--brand-text)'} />
          </span>
        ),
      }))} />
    </div>,
    document.body,
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────────
/** Did this record move `token`? Its own token, or either side of a swap. */
export function recordMovesToken(r: ActivityRecord, token: string): boolean {
  const t = token.toUpperCase()
  if (r.activityType === 'swap') {
    const md: any = r.metadata ?? {}
    return String(md.tokenIn ?? r.tokenSymbol ?? '').toUpperCase() === t || String(md.tokenOut ?? '').toUpperCase() === t
  }
  return (r.tokenSymbol || 'USDC').toUpperCase() === t
}

/** The server query for a tab. A tab preselected from the URL (?filter=…)
 *  is passed to useActivity as its first filter. */
function filterForTab(tab: ActivityTab): ActivityType | undefined {
  // For bridge/p2p tabs: pass a special value; useActivity/fetchActivity will handle it
  if (tab === 'all') return undefined
  if (tab === 'bridge') return 'bridge' as ActivityType  // handled in fetchActivity
  if (tab === 'p2p') return 'p2p' as ActivityType        // handled in fetchActivity
  // 'merchant' isn't an activity_type - fetch everything and narrow client-side (displayed below).
  if (tab === 'merchant') return undefined
  // Rewards claimed to USDC are receives; narrowed client-side below.
  if (tab === 'rewards') return 'receive'
  return tab as ActivityType
}

export function ActivityPage() {
  const navigateAll = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const walletAddress = useAuthStore(s => s.walletAddress)
  const userId = useAuthStore(s => s.user?.id)
  const [activeTab, setActiveTab] = useState<ActivityTab>(
    searchParams.get('filter') === 'bridge' ? 'bridge'
      : searchParams.get('filter') === 'p2p' ? 'p2p'
      : searchParams.get('filter') === 'swap' ? 'swap'
      : searchParams.get('filter') === 'merchant' ? 'merchant'
      : searchParams.get('filter') === 'rewards' ? 'rewards'
      : 'all'
  )
  // Opened from elsewhere (e.g. Home's asset history) with one transaction
  // to show: open its details straight away.
  const [selected, setSelected] = useState<ActivityRecord | null>(() => (location.state as any)?.openActivity ?? null)
  useEffect(() => {
    // Consume it, so Back/refresh doesn't reopen the same transaction.
    if ((location.state as any)?.openActivity) window.history.replaceState({ ...window.history.state, usr: null }, '')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // The transaction whose details were just closed: its row flashes and is
  // kept on screen, so you can see which one you were looking at. Cleared
  // while a detail is open, so the same row flashes again next time.
  const [flashId, setFlashId] = useState<string | null>(null)
  const openDetail = useCallback((item: ActivityRecord) => { setFlashId(null); setSelected(item) }, [])
  const closeDetail = () => { setFlashId(selected?.id ?? null); setSelected(null) }
  useEffect(() => {
    if (flashId) listScrollRef.current?.querySelector(`[data-activity-id="${CSS.escape(flashId)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [flashId])
  const [filterOpen, setFilterOpen] = useState(false)
  // Rewards filter: points earned (point_transactions - not money, never in
  // the activity ledger) or rewards claimed as USDC (activity receives).
  const [rewardsTab, setRewardsTab] = useState<'earned' | 'claimed'>(() => (searchParams.get('rewards') === 'claimed' ? 'claimed' : 'earned'))
  const [earned, setEarned] = useState<{ id: string; points: number; reason: string; created_at: string }[] | null>(null)
  useEffect(() => {
    if (activeTab !== 'rewards' || earned) return
    const uid = rewardsUserId(userId, walletAddress)
    if (!uid) { setEarned([]); return }
    fetchPointHistory(uid, 200).then(rows => setEarned((rows as any[]).filter(p => p.points > 0))).catch(() => setEarned([]))
  }, [activeTab, earned, userId, walletAddress])
  const filterBtnRef = useRef<HTMLDivElement>(null)
  const [searchInput, setSearchInput] = useState('')
  // Search box tucks away while scrolling down the list, back on scroll up.
  const listScrollRef = useRef<HTMLDivElement>(null)
  const isDesktop = useMediaQuery(DESKTOP_QUERY)
  const [searchFocused, setSearchFocused] = useState(false)
  const searchHidden = useHideOnScroll(listScrollRef, searchFocused || !!searchInput)
  const bottomRef = useRef<HTMLDivElement>(null)
  const tokenFilter = new URLSearchParams(location.search).get('token')

  const { records, loading, loadingMore, error, hasMore, setFilter, setSearch, loadMore, refresh } = useActivity(walletAddress, filterForTab(activeTab))
  // The list fades in once, when it replaces the loading cards - not on
  // scroll-loading, a refresh or a new row (the class stays, so the
  // animation never restarts).
  const sawSkeleton = useRef(false)
  const [listFade, setListFade] = useState(false)
  if (loading && records.length === 0) sawSkeleton.current = true
  useEffect(() => {
    if (!listFade && sawSkeleton.current && records.length > 0) setListFade(true)
  }, [listFade, records.length])

  // Debounce the search box → useActivity's `search` state, which re-queries
  // Supabase (see fetchActivity's search clause) rather than only filtering
  // whatever page of records happens to already be loaded - so a hash or
  // username from months ago still surfaces even if it isn't in the first
  // loaded page.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(t)
  }, [searchInput, setSearch])

  // One-time catch-up for P2P history that happened before this feature
  // existed - see backfillP2PActivity's own doc comment for why this is
  // safe to call every time this page mounts (self-deduplicating).
  useEffect(() => {
    if (!userId || !walletAddress) return
    // Reload only when it added rows - reloading every visit swapped the
    // list a second time (and dropped any pages already scrolled in).
    backfillP2PActivity(userId, walletAddress).then(wrote => { if (wrote) refresh() })
  }, [userId, walletAddress])

  const handleTabChange = useCallback((tab: ActivityTab) => {
    setActiveTab(tab)
    setFilter(filterForTab(tab))
  }, [setFilter])

  useEffect(() => {
    const el = bottomRef.current
    if (!el) return
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && hasMore && !loadingMore && !loading && !error && records.length > 0) loadMore()
    }, { threshold: 0.1 })
    obs.observe(el)
    return () => obs.disconnect()
  }, [hasMore, loadingMore, loading, loadMore, error, records.length])

  const showEarned = activeTab === 'rewards' && rewardsTab === 'earned'
  // Filtered, de-duplicated and grouped once per change of the records or
  // filter - not on every render (the search box hiding on scroll re-renders
  // this page mid-scroll).
  const groups = useMemo(() => {
    const displayed = (tokenFilter
      ? records.filter(r => recordMovesToken(r, tokenFilter))
      : records
    ).filter(r => {
      if (r.activityType === 'deposit') return false
      const md: any = (r as any).metadata ?? {}
      // A merchant's other-chain → Arc transfer shows here only once it has landed
      // ("Cross-chain payment received"); while it runs it's in the Cross-chain Transfer.
      if (md.auto_convert && r.status !== 'completed') return false
      if (activeTab === 'merchant') return !!(md.merchant || md.auto_convert || md.merchantOrder || md.merchantPayment) && r.activityType !== 'send'
      if (activeTab === 'all')     return true
      if (activeTab === 'send')    return r.activityType === 'send'
      if (activeTab === 'receive') return r.activityType === 'receive'
      if (activeTab === 'swap')    return r.activityType === 'swap'
      if (activeTab === 'bulk')    return r.activityType === 'bulk'
      if (activeTab === 'bridge')  return r.activityType === 'claim' || r.activityType === 'bridge' || r.activityType === 'withdraw'
      if (activeTab === 'p2p')     return r.activityType === 'p2p_sell_order' || r.activityType === 'p2p_refund' || r.activityType === 'p2p_purchase'
      if (activeTab === 'rewards') return isRewardClaim(r)
      return true
    })

    const deduped = dedupeAndSortActivityRecords(displayed)
    const sorted = deduped
    const groups = groupByDate(sorted)
    return groups
  }, [records, tokenFilter, activeTab])
  const listView = useMemo(() => isDesktop ? (<>
    {!showEarned && !loading && (
            <div className="px-4 lg:max-w-[1100px] lg:mx-auto">
              {groups.map(group => (
                <div key={group.label} className="mb-6">
                  <p className="text-xs font-bold text-text-secondary mb-2 px-1">{group.label}</p>
                  <table style={{ width: '100%', borderCollapse: 'collapse', background: 'var(--surface)', border: '1px solid var(--soft-edge)', boxShadow: 'var(--soft-card)', borderRadius: 16, overflow: 'hidden' }}>
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
                          <tr key={item.id} data-activity-id={item.id} onClick={() => openDetail(item)} className={`desktop-table-row${item.id === flashId ? ' mp-last-opened' : ''}`}
                            style={{ cursor: 'pointer', borderTop: '1px solid color-mix(in srgb, var(--text-primary) 5%, transparent)', background: 'var(--dt-hover-bg, transparent)', transition: 'background-color 150ms ease' }}>
                            <td style={{ padding: '12px 16px', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{row.title}</td>
                            <td style={{ padding: '12px 16px', fontSize: 13, color: 'var(--text-secondary)' }}>{row.subtitle || '-'}</td>
                            <td style={{ padding: '12px 16px', fontSize: 13, color: 'var(--text-secondary)' }}>{row.chain || '-'}</td>
                            <td style={{ padding: '12px 16px', fontSize: 13, fontWeight: 600, color: row.statusColor }}>{row.statusLabel}</td>
                            <td style={{ padding: '12px 16px', fontSize: 13, color: 'var(--text-muted)' }}>{timeAgo(row.createdAt)}</td>
                            <td style={{ padding: '12px 16px', fontSize: 13, fontWeight: 700, color: row.isSwap ? 'var(--success-text)' : row.amountColor, textAlign: 'right' }}>
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
          )}</>
  ) : (
    <div>
            {!showEarned && !loading && groups.map(group => (
              <div key={group.label} className="px-4 mb-4">
                <p className="text-xs font-bold text-text-secondary mb-2 mt-4 px-1">{group.label}</p>
                <div>
                  {group.items.map((item, i, arr) => (
                    <ActivityRow key={item.id} record={item}
                      isFirst={i === 0} isLast={i === arr.length - 1}
                      onSelect={() => openDetail(item)} flash={item.id === flashId} />
                  ))}
                </div>
              </div>
            ))}
          </div>
  ), [isDesktop, groups, flashId, showEarned, loading, openDetail])

  return (
    <div className="flex flex-col h-full overflow-hidden bg-bg">
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>

      {/* Header */}
      <div className="sticky top-0 z-20" style={{ background: 'var(--bg)' }}>
        <div className="header-row px-5 pt-header pb-header justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="text-xl font-bold text-text-primary">Activity</h1>
            {/* Opened from an asset page's "See all": that token only - tap to clear. */}
            {tokenFilter && (
              <button onClick={() => navigateAll('/activity', { replace: true })}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[12px] font-semibold"
                style={{ background: 'color-mix(in srgb, var(--brand) 16%, transparent)', color: 'var(--brand-text)', border: 'none', cursor: 'pointer' }}>
                {tokenFilter} <X className="w-3 h-3" />
              </button>
            )}
          </div>
          <button onClick={refresh} disabled={loading} aria-label="Refresh"
            className="mp-hit mp-hit-sm w-9 h-9 rounded-2xl flex items-center justify-center active:scale-95 disabled:opacity-40"
            style={{ background: 'var(--surface)', border: '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
            <RefreshCw className={cn('w-4 h-4 text-text-secondary', loading && 'animate-spin')} />
          </button>
        </div>
        <div className="px-4 lg:max-w-[1100px] lg:mx-auto" style={{ ...collapseStyle(searchHidden, 72), paddingBottom: searchHidden ? 0 : 12 }}>
          <SearchField value={searchInput} onChange={setSearchInput} ariaLabel="Search username, wallet, or tx hash"
            // Longest first - the box shows the longest that fits beside the Filter chip.
            placeholder={['Search username, wallet, or tx hash', 'Username, wallet or tx hash', 'Username, wallet, tx hash', 'Name, wallet, tx hash', 'Name, wallet, hash', 'Search']}
            onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)}
            trailing={(() => {
              // "≡ Filter" chip; with a filter on it turns teal, names it, and its ✕ clears back to All.
              const on = activeTab !== 'all'
              const label = on ? (FILTERS.find(f => f.id === activeTab)?.label ?? 'Filter') : 'Filter'
              return (
                <div ref={filterBtnRef} className="flex-shrink-0 flex items-center rounded-full"
                  style={{ height: 34, background: on ? 'var(--brand)' : 'color-mix(in srgb, var(--text-primary) 7%, transparent)', color: on ? '#fff' : 'var(--text-primary)' }}>
                  <button type="button" onClick={() => setFilterOpen(o => !o)} aria-label={on ? `Filter: ${label}` : 'Filter'} aria-expanded={filterOpen}
                    className="mp-hit-y h-full flex items-center gap-1.5 active:opacity-70"
                    style={{ padding: on ? '0 4px 0 12px' : '0 13px 0 12px', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
                      <path d="M4 6h16M4 12h11M4 18h6" />
                    </svg>
                    {label}
                  </button>
                  {on && (
                    <button type="button" onClick={() => { setFilterOpen(false); handleTabChange('all') }} aria-label="Clear filter"
                      className="h-full flex items-center active:opacity-70"
                      style={{ padding: '0 11px 0 4px', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', opacity: 0.85 }}>
                      <X className="w-3.5 h-3.5" strokeWidth={2.6} />
                    </button>
                  )}
                </div>
              )
            })()} />
        </div>
      </div>

      {/* Body */}
      <div ref={listScrollRef} className="flex-1 overflow-y-auto pb-6">
        {activeTab === 'rewards' && (
          <div className="px-4 lg:max-w-[1100px] lg:mx-auto" style={{ display: 'flex', gap: 20, borderBottom: '1px solid var(--border)', marginTop: 4 }}>
            {(['earned', 'claimed'] as const).map(t => (
              <button key={t} onClick={() => setRewardsTab(t)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '8px 0 9px', fontSize: 14,
                fontWeight: rewardsTab === t ? 700 : 500, color: rewardsTab === t ? 'var(--text-primary)' : 'var(--text-secondary)',
                borderBottom: `2px solid ${rewardsTab === t ? 'var(--text-primary)' : 'transparent'}`, marginBottom: -1 }}>
                {t === 'earned' ? 'Points earned' : 'Claimed USDC'}
              </button>
            ))}
          </div>
        )}
        {showEarned && (
          <div className="px-4 pt-2 lg:max-w-[1100px] lg:mx-auto">
            {earned === null ? <SkeletonCards className="pt-2" /> : earned.length === 0 ? (
              <p className="text-center text-sm text-text-muted py-16">Points you earn will show here.</p>
            ) : earned.map(p => {
              const t = rewardTaskOf(p.reason)
              return (
                <HistoryRow key={p.id}
                  icon={<HistoryIcon tone="out" icon={t ? t.action : 'rewards'} />}
                  title={t ? t.done : 'Points earned'}
                  meta={<><span style={{ color: 'var(--success-text)', fontWeight: 600 }}>Earned</span> · {timeAgo(p.created_at)}</>}
                  right={<div style={{ fontSize: 14, fontWeight: 700, color: 'var(--brand-text)' }}>+{p.points} pts</div>} />
              )
            })}
          </div>
        )}
        {loading && records.length === 0 && <SkeletonCards className="px-4 pt-4" />}

        {error && !loading && (
          <div className="mx-4 mt-4 p-4 rounded-2xl lg:max-w-[1068px] lg:mx-auto" style={{ background: 'color-mix(in srgb, var(--danger) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--danger) 20%, transparent)' }}>
            <p className="text-sm text-danger">{error}</p>
            <button onClick={refresh} className="mp-hit mt-2 text-xs text-danger underline">Try again</button>
          </div>
        )}

        {!showEarned && !loading && !error && groups.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-2">
            <p className="text-text-secondary font-semibold">No activity yet</p>
            <p className="text-sm text-text-muted text-center px-8">Your transactions will appear here.</p>
          </div>
        )}

        {/* Phone: grouped rows. Desktop: a table, from the same `groups` and
            onSelect. Only the one on screen is rendered (both used to be,
            one hidden by CSS - every row twice on a phone), and it's built
            once per change of the list, so a re-render mid-scroll is cheap. */}
        <div className={listFade ? 'mp-fade-in' : undefined}>{listView}</div>

        <div ref={bottomRef} className="py-2 flex justify-center">
          {loadingMore && <Loader2 className="w-5 h-5 text-text-muted animate-spin" />}
        </div>

        {!showEarned && !loading && records.length > 0 && (
          <p className="text-center text-[11px] text-text-muted pb-2">{records.length} records</p>
        )}
      </div>

      <AnimatePresence>
        {filterOpen && <FilterMenu key="filter" anchor={filterBtnRef.current} active={activeTab} onSelect={handleTabChange} onClose={() => setFilterOpen(false)} />}
      </AnimatePresence>
      <AnimatePresence>
        {selected && <DetailSheet key="detail" record={selected} onClose={closeDetail} />}
      </AnimatePresence>
    </div>
  )
}
