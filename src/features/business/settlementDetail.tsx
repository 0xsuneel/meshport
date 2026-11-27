// A settlement from Business → Settlements as the app's history card
// (19 Nov 2026): the same card Activity shows for it.
import type { TxDetail } from '@/components/ui/TxDetailPage'
import { ownAccountName } from '@/lib/ownName'
import type { Claim } from '@/lib/claimService'
import { arcExplorerTxUrl, explorerTxUrl } from '@/lib/chainExplorers'
import { chainLabel } from './settlement'

/** The exact amount (up to 6 decimals, no trailing zeros). */
const exact = (n: number) => String(Number(n.toFixed(6)))

export function settlementDetail(c: Claim, me: { handle?: string; address?: string }): TxDetail {
  const ok = c.status === 'completed'
  const failed = c.status === 'failed'
  const other = chainLabel(c.sourceChain) || 'the other chain'
  const amount = c.arrivedAmount ?? c.amount
  const at = new Date(c.completedAt || c.createdAt)
  const when = `${at.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}, ${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
  const sourceHash = c.bridgeTxHash || c.txHash || null
  const sourceHref = sourceHash ? explorerTxUrl(c.sourceChain, sourceHash) : null
  const arcHref = c.destinationTxHash ? arcExplorerTxUrl(c.destinationTxHash) : null
  const fee = c.arrivedAmount != null && c.amount > c.arrivedAmount ? c.amount - c.arrivedAmount : null
  return {
    title: 'Settlement details', status: ok ? 'success' : failed ? 'failed' : 'pending',
    amountLabel: 'Amount settled', amount: `+$${exact(amount)}`, unit: 'USDC',
    pill: { icon: 'hub', text: ok ? 'Settled to Arc' : failed ? 'Settlement' : 'Settling to Arc' },
    parties: [
      { label: 'From', name: ownAccountName(), address: c.walletAddress || undefined, chain: other },
      { label: 'To', name: 'You', you: true, handle: me.handle, address: me.address, chain: 'Arc' },
    ],
    steps: ['Settlement approved', <>Sent on <b>{other}</b></>, <>Confirmed by <b>Circle</b></>, <>Delivered on <b>Arc</b></>],
    whenLabel: 'Settled at', when,
    hashes: [
      ...(sourceHash ? [{ label: `Sent on ${other}`, hash: sourceHash }] : []),
      ...(c.destinationTxHash ? [{ label: 'Received on Arc', hash: c.destinationTxHash }] : []),
    ],
    detailsTitle: 'Settlement details',
    details: [
      { label: 'Status', value: ok ? 'Completed' : failed ? 'Failed' : 'Processing', tone: ok ? 'ok' : failed ? 'bad' : undefined },
      { label: 'Sent', value: `$${exact(c.amount)} USDC` },
      ...(c.arrivedAmount != null ? [{ label: 'Received', value: `$${exact(c.arrivedAmount)} USDC` }] : []),
      ...(fee && fee > 0 ? [{ label: 'Fees paid', value: `$${exact(fee)} USDC` }] : []),
      ...(c.meshportFee ? [{ label: 'MeshPort fee', value: `$${exact(c.meshportFee)} USDC` }] : []),
      ...(sourceHref ? [{ label: 'Source explorer', value: `View on ${other} explorer`, href: sourceHref }] : []),
      ...(arcHref ? [{ label: 'Arc explorer', value: 'View on ArcScan', href: arcHref }] : []),
    ],
    promo: false,
  }
}
