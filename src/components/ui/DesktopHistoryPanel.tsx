// DesktopHistoryPanel.tsx
// Desktop-only right-column card shell shared by Send/Swap/Multichain
// Transfer/Multichain Claim/P2P - each of those pages gets a 2-column
// desktop layout (existing flow on the left, unchanged; a real history list
// on the right, see each page's own fetch). This component is only the
// chrome (title row + "View all" link + a scrollable body) so the 5 call
// sites don't each reinvent the same card styling - matches the surface/
// border/radius/shadow language already used throughout Home's desktop
// cards. The body's `overflowY: auto` (not `hidden`) is what makes the
// history list scroll independently of the flow column next to it, and
// keeps it reachable if the user zooms their browser in past 100%.
import { type ReactNode } from 'react'
import { TxDetailPage } from './TxDetailPage'

export function DesktopHistoryPanel({ title, onViewAll, viewAllLabel = 'View all', children }: {
  title: string
  onViewAll?: () => void
  viewAllLabel?: string
  children: ReactNode
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
      background: 'var(--surface)', border: '1px solid var(--soft-edge)', boxShadow: 'var(--soft-card)', borderRadius: 18,
      overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>
        {onViewAll && (
          <span onClick={onViewAll} style={{ fontSize: 13, color: 'var(--brand-text)', fontWeight: 600, cursor: 'pointer' }}>
            {viewAllLabel}
          </span>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
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
        <div key={i} className="mp-skel" style={{ height: 44, borderRadius: 12, background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)' }} />
      ))}
    </div>
  )
}

// Row-tap detail popup shared by Pay/Multichain Claim/Multichain Transfer's
// desktop history panels - tapping a row opens this instead of navigating
// away (matches Swap's own HistoryDetail popup); "View all" at the top of
// the panel is the only thing that still navigates anywhere.
//
// Opens the same Payment details card as Activity (TxDetailPage, 18 Nov
// 2026) in its centred popup. Status comes from the row labelled 'Status'.
export function DesktopHistoryDetail({ onClose, title, amountLabel, rows, explorerLinks }: {
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
  // The same Payment details card as Activity (18 Nov 2026), in its popup.
  const text = (v: ReactNode) => typeof v === 'string' || typeof v === 'number' ? String(v) : ''
  const timeRow = rows.find(r => /^(time|date)$/i.test(r.label))
  const hashRows = rows.filter(r => /hash|tx\b/i.test(r.label) && /^0x[0-9a-f]{8,}/i.test(text(r.value)))
  return (
    <TxDetailPage onClose={onClose} detail={{
      title: title.replace(/ Details$/, ' details'), status, amountLabel: 'Amount', amount: amountLabel,
      steps: [], whenLabel: timeRow?.label ?? 'Time', when: timeRow ? text(timeRow.value) : '',
      hashes: hashRows.map(r => ({ label: r.label, hash: text(r.value) })),
      detailsTitle: 'Details',
      details: [
        { label: 'Status', value: status === 'success' ? 'Completed' : status === 'failed' ? 'Failed' : 'Processing', tone: status === 'success' ? 'ok' : status === 'failed' ? 'bad' : undefined },
        ...rows.filter(r => r.label !== 'Status' && r !== timeRow && !hashRows.includes(r)).map(r => ({ label: r.label, value: r.value })),
        ...(explorerLinks ?? []).map(l => ({ label: 'Explorer', value: l.label, href: l.href })),
      ],
    }} />
  )
}
