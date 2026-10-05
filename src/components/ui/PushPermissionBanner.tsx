import { useEffect, useState } from 'react'
import { Bell, X } from 'lucide-react'
import { useAuthStore } from '@/store'
import { enablePushNotifications, getNotificationPermission, isPushSupported } from '@/lib/pushNotifications'

// "Turn on notifications" — shown when this device isn't set up to receive
// push. Chrome on Android ignores a permission request that doesn't come
// from a tap, so the automatic attempt on app start never succeeds on a
// fresh install; this gives the user the tap. It also re-subscribes from
// scratch, replacing a subscription the push service has revoked.
const SNOOZE_KEY = 'mp_push_banner_snooze'
const SNOOZE_MS = 3 * 24 * 3600_000

export function PushPermissionBanner() {
  const userId = useAuthStore(s => s.user?.id)
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [denied, setDenied] = useState(false)

  useEffect(() => {
    if (!userId || !isPushSupported()) return
    const perm = getNotificationPermission()
    let snoozed = false
    try { snoozed = Date.now() - Number(localStorage.getItem(SNOOZE_KEY) || 0) < SNOOZE_MS } catch { /* ignore */ }
    if (snoozed) return
    if (perm === 'denied') { setDenied(true); setShow(true); return }
    if (perm !== 'granted') { setShow(true); return }
    // Granted — give the automatic setup (App.tsx) a moment, then make sure
    // this device really ended up with a subscription.
    const t = setTimeout(() => {
      navigator.serviceWorker.ready.then(reg => reg.pushManager.getSubscription()).then(sub => {
        if (!sub) setShow(true)
      }).catch(() => {})
    }, 5000)
    return () => clearTimeout(t)
  }, [userId])

  if (!show) return null

  const enable = async () => {
    if (!userId) return
    setBusy(true)
    const r = await enablePushNotifications(userId, { fresh: true })
    setBusy(false)
    if (r.ok) setShow(false)
    else if (getNotificationPermission() === 'denied') setDenied(true)
  }
  const snooze = () => {
    try { localStorage.setItem(SNOOZE_KEY, String(Date.now())) } catch { /* ignore */ }
    setShow(false)
  }

  return (
    <div role="region" aria-label="Notifications" style={{
      position: 'fixed', left: 12, right: 12, top: 'calc(env(safe-area-inset-top, 0px) + 10px)', zIndex: 60,
      maxWidth: 460, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 12px 12px 14px', borderRadius: 16, background: 'var(--surface)',
      border: '1px solid var(--border)', boxShadow: 'var(--shadow-2)',
    }}>
      <div style={{ width: 34, height: 34, borderRadius: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'color-mix(in srgb, var(--brand) 15%, transparent)', color: 'var(--brand)' }}>
        <Bell size={18} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>
          {denied ? 'Notifications are blocked' : 'Turn on notifications'}
        </p>
        <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.35 }}>
          {denied
            ? 'Allow them for MeshPort in your phone settings → Apps → MeshPort → Notifications.'
            : 'Get alerted when you receive money, even when the app is closed.'}
        </p>
      </div>
      {!denied && (
        <button onClick={enable} disabled={busy}
          style={{ flexShrink: 0, padding: '8px 12px', borderRadius: 10, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 13, fontWeight: 600, opacity: busy ? 0.6 : 1 }}>
          {busy ? '…' : 'Turn on'}
        </button>
      )}
      <button onClick={snooze} aria-label="Not now" style={{ flexShrink: 0, background: 'none', border: 'none', padding: 4, color: 'var(--text-secondary)' }}>
        <X size={16} />
      </button>
    </div>
  )
}
