/**
 * bridgeTracker.ts — claim/bridge notification helpers
 *
 * IMPORTANT — audit note: this file used to also contain an entire second,
 * independent claim-tracking system built on a separate `bridge_sessions`
 * table: saveBridgeSession/updateBridgeSession (writes), startBridgePoller
 * (an active setInterval loop hitting Circle's attestation API directly),
 * checkAttestation, notifyClaimStarted, and a STATUS_META label map for its
 * own separate status enum ('burning'/'attesting'/'minting'/'arrived'/...).
 *
 * None of the writer/poller functions were called from anywhere in the app
 * — confirmed via a full-codebase audit — but they still shipped in the
 * bundle, including a hardcoded Supabase service_role key (bypasses RLS)
 * used only by those dead functions. That's a real credential exposure
 * regardless of whether the code calling it ever ran, since anyone can read
 * a shipped JS bundle. All of it has been removed.
 *
 * The one thing that WAS live here — notifyClaimArrived — is kept. It's
 * called from exactly one place (MultichainClaimPage.tsx's Realtime
 * claims.status subscription effect), only after claims.status has
 * genuinely reached 'completed'. claims.status is the single source of
 * truth for claim progress end-to-end; this file no longer has (or should
 * ever regain) any competing notion of "done".
 */
import { useNotificationStore } from '@/store'
import { formatAmount } from './utils'

// ── Push notification helpers ─────────────────────────────────────────────────
export function notifyClaimArrived(amount: number, sourceChain: string, timeTakenMs?: number, createdAt?: string, claimId?: string) {
  const chainLabel = sourceChain.replace(/_Sepolia|_Testnet|_Fuji/g, '').replace(/_/g, ' ')
  const timeStr = timeTakenMs ? ` in ${Math.round(timeTakenMs / 1000)}s` : ''
  useNotificationStore.getState().addNotification({
    // Stable, claim-derived id — same convention notifyPaymentReceived
    // already uses. addNotification dedupes by id (both against the live
    // list and its permanent seen-ids ledger), so even if some future
    // caller re-invokes this for the same claim, the store itself refuses
    // to show it twice instead of relying solely on the caller to have
    // gotten its own guard right.
    id:      claimId ? `claim_${claimId}` : undefined,
    type:    'payment_received',
    // "Claimed from {chain}" — matches ActivityPage.tsx's label for the
    // same claim row (deriveActivityRow / DetailSheet), not the old
    // generic "Funds Arrived!".
    title:   `Claimed from ${chainLabel}`,
    body:    `${formatAmount(amount)} USDC arrived on Arc from ${chainLabel}${timeStr}`,
    isRead:  false,
    timestamp: createdAt,
  })
  fireWebPush('Funds Arrived on Arc!', `${formatAmount(amount)} USDC from ${chainLabel}${timeStr} is in your wallet`)
}

// formatAmount is now imported from ./utils (fixed there to trim trailing
// zeros, e.g. 1.1 -> "1.1" not "1.10") instead of this file keeping its own
// separate, slightly-different local copy (which only special-cased exact
// whole numbers and still padded e.g. 1.1 to "1.10").

// ── Web Push API (shows OS notification even when app is backgrounded) ─────
export async function requestPushPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  const result = await Notification.requestPermission()
  return result === 'granted'
}

function fireWebPush(title: string, body: string) {
  try {
    if (typeof window === 'undefined') return
    if (!('Notification' in window)) return
    if (Notification.permission !== 'granted') return
    new Notification(title, {
      body,
      icon: '/pwa-192x192.png',
      badge: '/pwa-192x192.png',
      tag: 'meshport-bridge',
    })
  } catch {}
}
