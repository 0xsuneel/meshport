/**
 * Full-screen "blinking dots" loading state.
 *
 * Used wherever the app would otherwise briefly render nothing (e.g. while
 * waiting on an auth/profile check on refresh). Uses CSS vars (--bg,
 * --brand) so it automatically matches whichever theme is active instead
 * of a single hardcoded look.
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
      <div style={{ display: 'flex', gap: 8 }}>
        {[0, 1, 2].map(i => (
          <span
            key={i}
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: 'var(--brand)',
              animation: 'arc-splash-blink 1.1s ease-in-out infinite',
              animationDelay: `${i * 0.15}s`,
            }}
          />
        ))}
      </div>
      <style>{`
        @keyframes arc-splash-blink {
          0%, 80%, 100% { opacity: 0.25; transform: scale(0.85); }
          40% { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  )
}
