// Shared "locked until your business is approved" screen, route guard and
// small lock badge for entry points. See lib/accountLock.ts for the rule.

import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Lock } from 'lucide-react'
import { useAccountLock, ACCOUNT_LOCKED_MESSAGE } from '@/lib/accountLock'
import { useMerchant } from '@/lib/merchant'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { LoadingDots } from '@/components/ui/LoadingDots'

export const APPLY_PATH = '/business?apply=1'

/** Status-aware copy for the lock. */
export function lockCopy(status: string, reviewNote: string | null | undefined) {
  if (status === 'pending') return {
    text: "Your business application is under review. You'll get a notification as soon as it's approved.",
    action: 'View application',
  }
  if (status === 'rejected' || status === 'revoked') return {
    text: reviewNote?.trim() || (status === 'revoked'
      ? 'Merchant access was removed from this account. Check your details and apply again.'
      : "Your business application wasn't approved. Check your details and apply again."),
    action: 'Apply again',
  }
  return {
    text: 'Payments and every other feature turn on once MeshPort approves your business. You can still see your balance and activity.',
    action: 'Apply for approval',
  }
}

/** Full-screen locked state - used by the route guard. */
export function LockedFeature({ title, showBack = true }: { title?: string; showBack?: boolean }) {
  const navigate = useNavigate()
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const { status, application } = useMerchant()
  const c = lockCopy(status, application?.reviewNote)
  const back = () => { if (window.history.length > 1) navigate(-1); else navigate('/', { replace: true }) }
  return (
    <div data-locked-feature="" style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      {showBack && !isDesktop && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px 0' }}>
          <button type="button" onClick={back} aria-label="Back" className="back-btn">
            <ArrowLeft className="w-5 h-5 text-text-primary" />
          </button>
          {title && <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>}
        </div>
      )}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px 96px' }}>
        <div style={{ width: '100%', maxWidth: 420, textAlign: 'center', padding: '28px 20px', borderRadius: 24,
          background: 'var(--surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-1)' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', margin: '0 auto 16px',
            background: 'color-mix(in srgb, var(--brand) 14%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Lock size={28} strokeWidth={2} color="var(--brand-text)" />
          </div>
          <div role="heading" aria-level={1} style={{ fontSize: 19, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.2px' }}>
            {ACCOUNT_LOCKED_MESSAGE}
          </div>
          {status === 'pending' && (
            <div style={{ display: 'inline-block', marginTop: 10, padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700,
              color: 'var(--warning)', background: 'color-mix(in srgb, var(--warning) 14%, transparent)' }}>Under review</div>
          )}
          {(status === 'rejected' || status === 'revoked') && (
            <div style={{ display: 'inline-block', marginTop: 10, padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700,
              color: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 14%, transparent)' }}>
              {status === 'revoked' ? 'Access removed' : 'Not approved'}
            </div>
          )}
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.5, margin: '12px 0 20px' }}>{c.text}</p>
          <button type="button" onClick={() => navigate(APPLY_PATH)}
            style={{ width: '100%', minHeight: 48, borderRadius: 14, border: 'none', background: 'var(--brand)', color: '#fff',
              fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>
            {c.action}
          </button>
          <button type="button" onClick={() => navigate('/', { replace: true })}
            style={{ width: '100%', minHeight: 44, marginTop: 8, borderRadius: 14, border: 'none', background: 'transparent',
              color: 'var(--brand-text)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
            Back to Home
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Route guard: a business account that isn't approved sees LockedFeature
 * instead of the page (deep links included). While the status isn't known
 * yet on this device the page waits instead of rendering.
 */
export function RequireUnlockedAccount({ children, title }: { children: ReactNode; title?: string }) {
  const lock = useAccountLock()
  if (lock.locked) return <LockedFeature title={title} />
  if (lock.unknown) return <LoadingDots />
  return <>{children}</>
}

/** Small lock mark for an entry point (top-right of an icon). */
export function LockBadge({ size = 18 }: { size?: number }) {
  return (
    <span aria-label="Locked" style={{ position: 'absolute', top: -3, right: -3, width: size, height: size, borderRadius: '50%',
      background: 'var(--surface)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Lock size={Math.round(size * 0.55)} strokeWidth={2.4} color="var(--text-secondary)" />
    </span>
  )
}
