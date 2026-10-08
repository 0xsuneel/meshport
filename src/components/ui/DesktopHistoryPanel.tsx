// DesktopHistoryPanel.tsx
// Desktop-only right-column card shell shared by Send/Swap/Multichain
// Transfer/Multichain Claim/P2P — each of those pages gets a 2-column
// desktop layout (existing flow on the left, unchanged; a real history list
// on the right, see each page's own fetch). This component is only the
// chrome (title row + "View all" link + a scrollable body) so the 5 call
// sites don't each reinvent the same card styling — matches the surface/
// border/radius/shadow language already used throughout Home's desktop
// cards. The body's `overflowY: auto` (not `hidden`) is what makes the
// history list scroll independently of the flow column next to it, and
// keeps it reachable if the user zooms their browser in past 100%.
import { type ReactNode } from 'react'
import { ReceiptPopup } from './ReceiptPopup'

export function DesktopHistoryPanel({ title, onViewAll, viewAllLabel = 'View all', children }: {
  title: string
  onViewAll?: () => void
  viewAllLabel?: string
  children: ReactNode
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 18,
      boxShadow: 'var(--shadow-1)', overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>
        {onViewAll && (
          <span onClick={onViewAll} style={{ fontSize: 12.5, color: 'var(--brand-text)', fontWeight: 600, cursor: 'pointer' }}>
            {viewAllLabel}
          </span>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {children}
      </div>
    </div>
  )
}

// ── Shared empty/loading states for the panel body ──────────────────────────
export function DesktopHistoryEmpty({ label }: { label: string }) {
  return (
    <p style={{ fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center', padding: '32px 16px' }}>{label}</p>
  )
}

export function DesktopHistorySkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14 }}>
      {[0, 1, 2, 3, 4].map(i => (
        <div key={i} style={{ height: 44, borderRadius: 12, background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)' }} />
      ))}
    </div>
  )
}

// Row-tap detail popup shared by Pay/Multichain Claim/Multichain Transfer's
// desktop history panels — tapping a row opens this instead of navigating
// away (matches Swap's own HistoryDetail popup); "View all" at the top of
// the panel is the only thing that still navigates anywhere.
//
// Now opens the same receipt a live payment ends on (ReceiptPopup), so a
// history row looks exactly like its success screen. Status comes from the
// row labelled 'Status'; the title follows the kind of detail shown.
const RECEIPT_TITLES: Record<string, { success: string; failed: string }> = {
  'Payment Details':  { success: 'Paid Successfully', failed: 'Payment Failed' },
  'Claim Details':    { success: 'Funds Arrived', failed: 'Claim Failed' },
  'Transfer Details': { success: 'Transfer Complete', failed: 'Transfer Failed' },
}

export function DesktopHistoryDetail({ onClose, title, amountLabel, amountColor, rows, explorerLinks }: {
  onClose: () => void
  title: string
  icon: ReactNode
  iconColor: string
  amountLabel: string
  amountColor: string
  rows: Array<{ label: string; value: ReactNode }>
  explorerLinks?: Array<{ label: string; href: string }>
}) {
  const statusText = String(rows.find(r => r.label === 'Status')?.value ?? '').toLowerCase()
  const status = statusText.startsWith('fail') ? 'failed' : statusText.startsWith('complete') ? 'success' : 'pending'
  const titles = RECEIPT_TITLES[title]
  const receiptTitle = status === 'pending' ? 'Processing…' : titles ? titles[status] : title
  return (
    <ReceiptPopup
      onClose={onClose}
      status={status}
      title={receiptTitle}
      subtitle={<span style={{ display: 'block', fontSize: 20, fontWeight: 800, color: amountColor }}>{amountLabel}</span>}
      rows={rows.filter(r => r.label !== 'Status').map(r => ({ label: r.label, value: r.value, positive: r.label === 'To' || r.label === 'From' }))}
      detailRows={[{ label: 'Status', value: status === 'success' ? 'Confirmed' : status === 'failed' ? 'Failed' : 'Processing', positive: status === 'success' }]}
      links={explorerLinks?.map(l => ({ title: l.label, href: l.href }))}
    />
  )
}
