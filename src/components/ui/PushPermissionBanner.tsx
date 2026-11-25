import { useEffect } from 'react'
import { useAuthStore } from '@/store'
import { enablePushNotifications, getNotificationPermission, isPushSupported } from '@/lib/pushNotifications'

// No in-app banner: notification permission is asked with the device's own
// system dialog (Android / iOS / desktop browser), like any other app.
// Browsers only show that dialog in response to a user gesture - Chrome on
// Android and Safari on iOS ignore a request made on app start - so this arms
// a one-shot listener and asks on the user's first tap after sign-in.
// If they dismiss the system dialog it isn't asked again for a few days; if
// they block it, it's never asked again (their choice, changeable in settings).
const SNOOZE_KEY = 'mp_push_prompt_snooze'
const SNOOZE_MS = 3 * 24 * 3600_000
const ARM_DELAY_MS = 1500

export function PushPermissionBanner() {
  const userId = useAuthStore(s => s.user?.id)

  useEffect(() => {
    if (!userId || !isPushSupported()) return
    const perm = getNotificationPermission()
    if (perm === 'denied' || perm === 'unsupported') return

    let cancelled = false

    if (perm === 'granted') {
      // Permission already given - make sure this device really has a
      // subscription (dropped by the push service, site data cleared...) and
      // quietly re-subscribe if not. No prompt needed.
      const t = setTimeout(() => {
        navigator.serviceWorker.ready.then(reg => reg.pushManager.getSubscription()).then(sub => {
          if (!sub && !cancelled) enablePushNotifications(userId).catch(() => {})
        }).catch(() => {})
      }, 5000)
      return () => { cancelled = true; clearTimeout(t) }
    }

    // perm === 'default': ask with the native dialog on the first tap.
    try { if (Date.now() - Number(localStorage.getItem(SNOOZE_KEY) || 0) < SNOOZE_MS) return } catch { /* ignore */ }

    const onGesture = () => {
      remove()
      if (cancelled || getNotificationPermission() !== 'default') return
      // Must be called synchronously inside the gesture: enablePushNotifications
      // calls Notification.requestPermission() before any await.
      enablePushNotifications(userId, { fresh: true }).then(r => {
        if (!r.ok && getNotificationPermission() === 'default') {
          try { localStorage.setItem(SNOOZE_KEY, String(Date.now())) } catch { /* ignore */ }
        }
      }).catch(() => {})
    }
    const remove = () => {
      document.removeEventListener('click', onGesture, true)
      document.removeEventListener('keydown', onGesture, true)
    }
    const armT = setTimeout(() => {
      if (cancelled) return
      document.addEventListener('click', onGesture, true)
      document.addEventListener('keydown', onGesture, true)
    }, ARM_DELAY_MS)
    return () => { cancelled = true; clearTimeout(armT); remove() }
  }, [userId])

  return null
}
