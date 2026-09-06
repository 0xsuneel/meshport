// src/lib/resumableOperation.ts
//
// Shared helper for Pay/Send, Swap, Bulk Pay and Multichain Transfer:
// persist a small marker to localStorage the MOMENT a transaction actually
// broadcasts (has a real tx hash), so a refresh mid-flight can resume
// showing "checking your last [payment/swap/...]" instead of silently
// dropping back to the empty starting screen — which is dangerous, not
// just annoying: without any record that a send/swap/payout might have
// already gone through, a confused user is the most likely one to retry
// and accidentally double-spend.
//
// This does NOT invent a new source of financial truth. It only remembers
// "I broadcast tx X for feature Y, here's enough context to re-render the
// screen" — the actual status is always re-derived from the existing
// activity/claim data this app already treats as authoritative (see each
// page's own resume effect for how it looks the tx back up). If that
// lookup fails or times out, the marker is simply cleared and the user
// lands on a normal empty screen, exactly like today — never stuck, and
// never a second source of truth to go stale or drift from the real state.
//
// Mirrors MultichainClaimPage.tsx's own proven pattern (its claim.id
// survives a refresh via the `?claim=` URL param) — this is the same idea
// for the four flows that don't have a claims-style server row keyed by a
// stable id to deep-link back to, using localStorage instead of the URL
// since Pay/Swap/BulkPay/Transfer don't route through a per-operation URL.

export interface ResumableMarker {
  /** The on-chain tx hash this marker is tracking. */
  txHash: string
  /** Wall-clock ms when the marker was written — used to expire stale entries. */
  startedAt: number
  /** Arbitrary per-feature context needed to redraw the processing/success screen. */
  context: Record<string, unknown>
}

// 10 minutes — comfortably longer than any real confirmation should take on
// Arc (seconds) or CCTP (a few minutes), short enough that a marker can
// never plausibly outlive the transaction it describes and mislead a much
// later visit into showing stale "processing" state.
const MAX_AGE_MS = 10 * 60 * 1000

function key(feature: string): string {
  return `meshport_resumable_${feature}`
}

/** Call the moment a transaction actually broadcasts (has a real tx hash). */
export function saveResumableOperation(feature: string, txHash: string, context: Record<string, unknown> = {}): void {
  try {
    const marker: ResumableMarker = { txHash, startedAt: Date.now(), context }
    localStorage.setItem(key(feature), JSON.stringify(marker))
  } catch {
    // Storage can be unavailable (Safari private mode, quota exceeded) —
    // resumability is a nice-to-have, never a hard requirement to send.
  }
}

/**
 * Read back a not-yet-expired marker for this feature, or null. Callers
 * should still verify the tx's real status (activity table, claim row,
 * etc.) before trusting anything from this beyond "there might be one to
 * check" — this function only reports what was locally remembered.
 */
export function getResumableOperation(feature: string): ResumableMarker | null {
  try {
    const raw = localStorage.getItem(key(feature))
    if (!raw) return null
    const marker: ResumableMarker = JSON.parse(raw)
    if (!marker?.txHash || typeof marker.startedAt !== 'number') { clearResumableOperation(feature); return null }
    if (Date.now() - marker.startedAt > MAX_AGE_MS) { clearResumableOperation(feature); return null }
    return marker
  } catch {
    return null
  }
}

/** Call once the operation reaches ANY terminal state (success or failure). */
export function clearResumableOperation(feature: string): void {
  try { localStorage.removeItem(key(feature)) } catch {}
}
