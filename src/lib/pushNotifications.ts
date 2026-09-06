// VAPID public key — safe to expose client-side (this is the whole point of
// the public/private VAPID key pair). Must match VAPID_PUBLIC_KEY on the server.
const VAPID_PUBLIC_KEY = 'BGX7gXwCvsz7vw_FZHCiZVrSIHLye0Pem6gPEKnU6Mj7PfYYGFDltfiE3eYLjiS6M6LfPW-CyWg-sFUspWfohIM'

/**
 * Push a notification to the CURRENT device's own account — /api/push?action=send
 * requires the caller to prove (via their own Supabase session token) that
 * they're pushing to themselves, so this attaches it. ensureAnonSession()
 * covers wallet-only accounts, which never do email/OTP login but still get
 * a real session via anonymous sign-in — see src/lib/supabase.ts.
 * Best-effort: failures here should never block the payment/swap/reward
 * flow that triggered the notification, so this only logs and swallows.
 */
export async function sendPushToSelf(userId: string, payload: { title: string; body: string; url?: string; tag?: string; data?: Record<string, any> }): Promise<void> {
  if (!userId) return
  try {
    const { supabase, ensureAnonSession } = await import('./supabase')
    await ensureAnonSession()
    const { data: { session } } = await supabase.auth.getSession()
    const accessToken = session?.access_token
    if (!accessToken) return // no session yet — nothing to authorize the push with
    await fetch('/api/push?action=send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify({ userId, ...payload }),
    })
  } catch (e: any) {
    console.warn('[push] sendPushToSelf failed:', e?.message)
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)))
}

export function isPushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window
}

export function getNotificationPermission(): NotificationPermission | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

/**
 * Requests notification permission (if not already decided) and subscribes
 * this device to Web Push, saving the subscription against `userId`.
 * Safe to call repeatedly — no-ops if already subscribed or unsupported.
 */
export async function enablePushNotifications(userId: string): Promise<{ ok: boolean; reason?: string }> {
  if (!userId) return { ok: false, reason: 'no-user' }
  if (!isPushSupported()) return { ok: false, reason: 'unsupported' }

  try {
    if (Notification.permission === 'denied') return { ok: false, reason: 'denied' }
    if (Notification.permission === 'default') {
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') return { ok: false, reason: perm }
    }

    const registration = await navigator.serviceWorker.ready
    let subscription = await registration.pushManager.getSubscription()
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY).buffer as ArrayBuffer,
      })
    }

    await fetch('/api/push?action=subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, subscription: subscription.toJSON() }),
    })

    return { ok: true }
  } catch (e: any) {
    console.error('[push] enable failed:', e?.message)
    return { ok: false, reason: e?.message || 'error' }
  }
}
