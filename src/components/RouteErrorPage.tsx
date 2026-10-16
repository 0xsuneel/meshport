import { useEffect, useState } from 'react'
import { useRouteError } from 'react-router-dom'
import { isChunkLoadError, recoverFromStaleBuild } from '@/lib/lazyRetry'
import { useOnline, useOnReconnect } from '@/lib/connectivity'

// Replaces React Router's default "Unexpected Application Error!" screen.
// A stale-build error (app updated while this tab was open) reloads onto the
// new version automatically; anything else gets a calm screen with a Reload
// button instead of a raw stack trace.
export function RouteErrorPage() {
  const error = useRouteError()
  const online = useOnline()
  const stale = isChunkLoadError(error)
  const [reloading, setReloading] = useState(stale && online)

  useEffect(() => {
    // Offline: a failed load isn't an update - wait for the connection (below).
    if (!stale || !online) return
    recoverFromStaleBuild().then(ok => { if (!ok) setReloading(false) })
  }, [stale, online])

  // Whatever failed while offline is tried again once the connection is back.
  useOnReconnect(wave => { if (wave === 0 && !stale) window.location.reload() })

  useEffect(() => { console.error('[route error]', error) }, [error])

  return (
    <div style={{
      minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 14, padding: 24, textAlign: 'center', background: 'var(--bg, #0b0b0f)', color: 'var(--text-primary, #fff)',
    }}>
      {!online ? (
        <>
          <p style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>No internet connection</p>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary, #9a9aa5)', maxWidth: 320 }}>
            MeshPort will continue by itself as soon as you're back online. Your wallet and funds are not affected.
          </p>
        </>
      ) : reloading ? (
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
          {!stale && <ErrorDetails error={error} />}
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

// The error itself, behind a tap - so a phone user can screenshot what broke
// (there is no console on a phone). Message, where, and the first stack lines.
function ErrorDetails({ error }: { error: unknown }) {
  const [open, setOpen] = useState(false)
  const e = error as { message?: string; stack?: string; status?: number; statusText?: string } | null
  const text = [
    e?.status ? `${e.status} ${e.statusText ?? ''}` : null,
    e?.message ?? String(error),
    window.location.pathname,
    (e?.stack ?? '').split('\n').slice(1, 5).map(l => l.trim()).join('\n'),
  ].filter(Boolean).join('\n')
  return open ? (
    <pre style={{ margin: 0, maxWidth: 340, maxHeight: 220, overflow: 'auto', textAlign: 'left', fontSize: 11, lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      padding: 10, borderRadius: 10, background: 'rgba(127,127,127,0.12)', color: 'var(--text-secondary, #9a9aa5)' }}>{text}</pre>
  ) : (
    <button onClick={() => setOpen(true)} style={{ border: 'none', background: 'none', color: 'var(--text-secondary, #9a9aa5)', fontSize: 12, textDecoration: 'underline', cursor: 'pointer' }}>
      Details
    </button>
  )
}
