// One shared warm-up of the wallet's passcode page, for the whole app.
//
// The wallet itself (the hidden key frame, wallet/frameClient) loads once at
// start-up on every screen - the unlock screen included - and stays. What a
// payment loads again is the wallet's passcode page (confirm.html), and that
// is where a mobile network's silently dropped idle connection used to cost
// ~10 s ("Opening your wallet…" on Bring / Pay, 12 Nov).
//
// So it is warmed (lib/walletConfirm prewarmWalletConfirm):
//   - as soon as there is a wallet with a passcode - on the unlock screen,
//     right after sign-up sets the passcode, for a returning user - not only
//     once Home has opened;
//   - while the app is in use (on screen and touched in the last 3 min), about
//     every 45 s, so the connection never goes idle long enough to be dropped;
//   - when the app comes back to the front.
// Idle or in the background it stops: nothing is spent when nobody is using
// the app. Each warm-up is a small request; nothing is started or signed.

import { useAuthStore } from '@/store'

const ACTIVE_MS = 3 * 60_000
const BEAT_MS = 45_000

let installed = false
let lastActive = Date.now()

function theme(): 'dark' | 'light' {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
}

/** Warm (or re-warm, at most every 45 s) the passcode page now. */
export function warmWalletNow(): void {
  if (typeof document === 'undefined') return
  const { walletAddress, passcode } = useAuthStore.getState()
  if (!walletAddress || !passcode) return
  import('./walletConfirm').then(m => m.prewarmWalletConfirm(theme(), { refresh: true })).catch(() => {})
}

export function installWalletWarmth(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  const touched = () => { lastActive = Date.now() }
  window.addEventListener('pointerdown', touched, { capture: true, passive: true })
  window.addEventListener('keydown', touched, { capture: true, passive: true })

  // A wallet with a passcode appears (unlock screen, sign-up, sign-in): warm now.
  let had = false
  const check = () => {
    const { walletAddress, passcode } = useAuthStore.getState()
    const has = !!walletAddress && !!passcode
    // A moment after: the screen that just opened draws first.
    if (has && !had) setTimeout(warmWalletNow, 800)
    had = has
  }
  useAuthStore.subscribe(check)
  check()

  // In use: keep the connection alive.
  setInterval(() => {
    if (document.visibilityState !== 'visible') return
    if (Date.now() - lastActive > ACTIVE_MS) return
    warmWalletNow()
  }, BEAT_MS)

  // Back to the front: the connection may have been dropped meanwhile.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    lastActive = Date.now()
    warmWalletNow()
  })
}
