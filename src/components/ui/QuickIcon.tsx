// A quick action, four across like a payments app's: the icon on the page in
// its colour, one short name under it - no card, no subtitle. Home's Quick
// Actions and a token's actions (AssetPage).

import { ActionIcon, type ActionIconName } from './ActionIcon'
import { LockBadge } from '@/components/LockedFeature'

export function QuickIcon({ icon, label, color, onClick, dot, dim, locked, ariaLabel }: {
  icon: ActionIconName; label: string; color: string; onClick: () => void
  dot?: boolean; dim?: boolean; locked?: boolean; ariaLabel?: string
}) {
  return (
    <button type="button" onClick={onClick} aria-label={ariaLabel} className="mp-press"
      style={{ minWidth: 0, background: 'none', border: 'none', padding: '4px 0', cursor: 'pointer', font: 'inherit',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, opacity: dim ? 0.45 : 1 }}>
      <span style={{ position: 'relative', height: 40, display: 'grid', placeItems: 'center' }}>
        <ActionIcon name={icon} size={36} color={color} />
        {dot && <span aria-label="Open P2P trade" style={{ position: 'absolute', top: -2, right: -4, width: 11, height: 11, borderRadius: '50%', background: 'var(--danger)', border: '2px solid var(--bg)' }} />}
        {locked && <LockBadge />}
      </span>
      <span style={{ maxWidth: '100%', fontSize: 12.5, fontWeight: 500, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
    </button>
  )
}
