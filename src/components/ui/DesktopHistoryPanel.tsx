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
