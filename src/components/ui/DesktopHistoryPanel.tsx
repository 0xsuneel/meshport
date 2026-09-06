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
import { X } from 'lucide-react'
import { DesktopDialogFrame } from './DesktopDialogFrame'

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
          <span onClick={onViewAll} style={{ fontSize: 12.5, color: 'var(--brand)', fontWeight: 600, cursor: 'pointer' }}>
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
export function DesktopHistoryDetail({ onClose, title, icon, iconColor, amountLabel, amountColor, rows, explorerLinks }: {
  onClose: () => void
  title: string
  icon: ReactNode
  iconColor: string
  amountLabel: string
  amountColor: string
  rows: Array<{ label: string; value: ReactNode }>
  explorerLinks?: Array<{ label: string; href: string }>
}) {
  return (
    <DesktopDialogFrame onClose={onClose} maxWidth={380}>
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>
          <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: '50%', background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <X className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '8px 0 4px' }}>
          <div style={{ width: 56, height: 56, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: `color-mix(in srgb, ${iconColor} 12%, transparent)` }}>
            {icon}
          </div>
          <span style={{ fontSize: 24, fontWeight: 800, color: amountColor }}>{amountLabel}</span>
        </div>

        <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden' }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 14px', borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{r.label}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{r.value}</span>
            </div>
          ))}
        </div>

        {explorerLinks?.map(l => (
          <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer"
            style={{ width: '100%', boxSizing: 'border-box', padding: 13, borderRadius: 12, border: '1px solid var(--border)', background: 'transparent', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', textAlign: 'center', textDecoration: 'none' }}>
            {l.label} ↗
          </a>
        ))}
      </div>
    </DesktopDialogFrame>
  )
}
