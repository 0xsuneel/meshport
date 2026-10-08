import { MeshLoader } from './MeshLoader'

/**
 * Full-screen loading state — the animated MeshPort logo (Pulse).
 *
 * Used wherever the app would otherwise briefly render nothing (e.g. while
 * waiting on an auth/profile check on refresh). Uses CSS vars (--bg,
 * --brand) so it matches whichever theme is active.
 */
export function LoadingDots() {
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg)',
        zIndex: 9999,
      }}
    >
      <MeshLoader size={52} />
    </div>
  )
}
