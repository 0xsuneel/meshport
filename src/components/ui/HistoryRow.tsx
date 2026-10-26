import type { ReactNode } from 'react'
import { ActionIcon, type ActionIconName } from './ActionIcon'
import { pressable } from '@/lib/pressable'

/** `attention`: needs the person (e.g. Recover) - clock, no spinner. */
/** `muted`: ended without moving money (cancelled, expired). */
export type HistoryTone = 'pending' | 'attention' | 'failed' | 'in' | 'out' | 'muted'

const TINT: Record<HistoryTone, string> = {
  pending: 'var(--warning)', attention: 'var(--warning)', failed: 'var(--danger)', in: 'var(--success)', out: 'var(--brand)', muted: 'var(--text-secondary)',
}

/**
 * The round icon in front of a history row - the same one Activity uses
 * (ActivityRow): a tinted circle, a clock with a spinning ring while it's
 * processing, a crossed circle when it failed, otherwise the action's icon
 * (green for money coming in, brand for the rest).
 */
export function HistoryIcon({ tone, icon, size = 38 }: { tone: HistoryTone; icon?: ActionIconName | null; size?: number }) {
  const tint = TINT[tone]
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0, position: 'relative',
      background: `color-mix(in srgb, ${tint} ${tone === 'pending' || tone === 'attention' ? 12 : 10}%, transparent)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {tone === 'pending' || tone === 'attention' ? (
        <ActionIcon name="clock" size={18} color="var(--warning)" />
      ) : tone === 'failed' ? (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label="Failed">
          <circle cx="8" cy="8" r="6.2" stroke="var(--danger)" strokeWidth="1.4" />
          <path d="M6.2 6.2l3.6 3.6M9.8 6.2l-3.6 3.6" stroke="var(--danger)" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      ) : icon ? (
        <ActionIcon name={icon} size={18} color={tone === 'in' ? 'var(--success)' : tone === 'muted' ? 'var(--text-secondary)' : 'var(--brand-text)'} />
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M2 8h12M10 5l3 3-3 3" stroke="var(--brand-text)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {tone === 'pending' && (
        <div style={{
          position: 'absolute', inset: -2, borderRadius: '50%',
          border: '2px solid color-mix(in srgb, var(--warning) 30%, transparent)', borderTop: '2px solid var(--warning)',
          animation: 'spin 0.8s linear infinite',
        }} />
      )}
    </div>
  )
}

const oneLine = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 } as const

/**
 * A history row laid out like Activity's (ActivityRow): no card or divider
 * lines, the round icon, title over a status/meta line, the amount on the
 * right; `flash` = the row you just came back from (mp-last-opened).
 * `inPanel`: inside a desktop history panel (16px sides).
 */
export function HistoryRow({ icon, title, sub, meta, right, onClick, flash, inPanel }: {
  icon: ReactNode
  title: ReactNode
  /** Second line, e.g. counterparty or route. */
  sub?: ReactNode
  /** Status · time line. */
  meta?: ReactNode
  right?: ReactNode
  onClick?: () => void
  flash?: boolean
  inPanel?: boolean
}) {
  return (
    <div {...pressable(onClick)} className={flash ? 'mp-last-opened' : undefined}
      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: inPanel ? '11px 16px' : '11px 4px', cursor: onClick ? 'pointer' : 'default' }}>
      {icon}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', ...oneLine }}>{title}</div>
        {sub ? <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 1, ...oneLine }}>{sub}</div> : null}
        {meta ? <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, ...oneLine }}>{meta}</div> : null}
      </div>
      {right != null && <div style={{ textAlign: 'right', flexShrink: 0, maxWidth: '42%' }}>{right}</div>}
    </div>
  )
}
