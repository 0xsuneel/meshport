/**
 * A random, non-sensitive, app-generated identifier for THIS browser/
 * device, persisted in localStorage. Used ONLY to correlate rows in
 * wallet_audit_log (see supabase/functions/wallet-key) — it carries no
 * authorization weight whatsoever and is never used in any cryptographic
 * derivation. Losing it (cleared storage, new device) just means a new
 * one is generated; nothing breaks.
 */
const DEVICE_ID_KEY = 'arcpay_device_id'

export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY)
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem(DEVICE_ID_KEY, id)
    }
    return id
  } catch {
    // localStorage unavailable (private browsing edge cases, etc.) —
    // audit correlation is best-effort, never worth failing a login over.
    return 'unknown'
  }
}
