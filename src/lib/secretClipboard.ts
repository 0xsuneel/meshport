// secretClipboard.ts - clears the clipboard after the recovery phrase or a
// private key was copied from the wallet frame's reveal page.
//
// The reveal page (wallet-frame/src/reveal.ts) can't do this reliably on its
// own: it's a cross-origin iframe, so it may not READ the clipboard (to check
// the secret is still there - NotAllowedError, permissions policy), and it may
// only WRITE while the iframe itself has focus - which it has lost by the time
// the person has gone to paste the phrase somewhere. The app page can write
// whenever it has focus. So the frame only says "a secret was copied" (the
// 'mp-secret-copied' message - never the secret), and this module overwrites
// the clipboard SECRET_CLEAR_MS later - or, when the app doesn't have focus at
// that moment, the next time it does (also after a restart: the due time is
// kept in localStorage).
//
// It can't read the clipboard either, so the clear is unconditional. Copying
// anything else in the app first cancels it (copyToClipboard, native
// copy / cut), so a newer copy is never wiped.

export const SECRET_CLEAR_MS = 60_000
const KEY = 'mp_secret_clipboard_clear_at'

let timer: ReturnType<typeof setTimeout> | null = null
let listening = false

function dueAt(): number | null {
  try { const v = Number(localStorage.getItem(KEY)); return v > 0 ? v : null } catch { return null }
}
function setDue(at: number | null) {
  try { if (at) localStorage.setItem(KEY, String(at)); else localStorage.removeItem(KEY) } catch { /* private mode */ }
}

/** Overwrites the clipboard if a clear is due. Resolves true once nothing is pending. */
export async function clearSecretClipboardIfDue(now = Date.now()): Promise<boolean> {
  const due = dueAt()
  if (!due) return true
  if (now < due) return false
  try {
    await navigator.clipboard.writeText('')
    setDue(null)
    stopListening()
    return true
  } catch {
    // No focus right now (the person is in another app): try again on return.
    return false
  }
}

const onReturn = () => { if (document.visibilityState === 'visible') void clearSecretClipboardIfDue() }

function startListening() {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('focus', onReturn)
  document.addEventListener('visibilitychange', onReturn)
  // A tap always carries the user activation a clipboard write may need.
  window.addEventListener('pointerdown', onReturn, true)
}
function stopListening() {
  if (!listening) return
  listening = false
  window.removeEventListener('focus', onReturn)
  document.removeEventListener('visibilitychange', onReturn)
  window.removeEventListener('pointerdown', onReturn, true)
  if (timer) { clearTimeout(timer); timer = null }
}

function arm() {
  const due = dueAt()
  if (!due) return
  startListening()
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { timer = null; void clearSecretClipboardIfDue() }, Math.max(0, due - Date.now()))
}

/** A secret was just copied (the reveal page said so): clear it later. */
export function scheduleSecretClipboardClear(now = Date.now()) {
  setDue(now + SECRET_CLEAR_MS)
  arm()
}

/** Something else was copied in the app: the secret isn't on the clipboard any more. */
export function noteOtherClipboardWrite() {
  if (!dueAt()) return
  setDue(null)
  stopListening()
}

/** App start: resume a clear still pending from before a reload / restart. */
export function initSecretClipboard() {
  if (typeof window === 'undefined') return
  document.addEventListener('copy', noteOtherClipboardWrite, true)
  document.addEventListener('cut', noteOtherClipboardWrite, true)
  arm()
}
