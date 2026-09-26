import { useEffect, useState } from 'react'
import { useRouteError } from 'react-router-dom'
import { isChunkLoadError, recoverFromStaleBuild } from '@/lib/lazyRetry'

// Replaces React Router's default "Unexpected Application Error!" screen.
// A stale-build error (app updated while this tab was open) reloads onto the
// new version automatically; anything else gets a calm screen with a Reload
// button instead of a raw stack trace.
export function RouteErrorPage() {
  const error = useRouteError()
  const stale = isChunkLoadError(error)
  const [reloading, setReloading] = useState(stale)

  useEffect(() => {
    if (!stale) return
    recoverFromStaleBuild().then(ok => { if (!ok) setReloading(false) })
  }, [stale])

  useEffect(() => { console.error('[route error]', error) }, [error])

  return (
    <div style={{
      minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 14, padding: 24, textAlign: 'center', background: 'var(--bg, #0b0b0f)', color: 'var(--text-primary, #fff)',
    }}>
      {reloading ? (
        <>
          <div style={{ width: 28, height: 28, borderRadius: '50%', border: '3px solid var(--brand, #6d5dfc)', borderTopColor: 'transparent', animation: 'mp-spin 0.8s linear infinite' }} />
          <p style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Updating MeshPort…</p>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary, #9a9aa5)' }}>A new version is available. Loading it now.</p>
        </>
      ) : (
        <>
          <p style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{stale ? 'MeshPort was updated' : 'Something went wrong'}</p>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary, #9a9aa5)', maxWidth: 320 }}>
            {stale
              ? 'Reload to get the latest version. Your wallet and funds are not affected.'
              : 'Reload the app to continue. Your wallet and funds are not affected.'}
          </p>
          <button
            onClick={() => { setReloading(true); recoverFromStaleBuild(true) }}
            style={{ marginTop: 6, padding: '11px 26px', borderRadius: 12, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 700, color: '#fff', background: 'var(--brand, #6d5dfc)' }}>
            Reload
          </button>
        </>
      )}
      <style>{'@keyframes mp-spin{to{transform:rotate(360deg)}}'}</style>
    </div>
  )
}
