// src/components/wallet/confirmStandby.ts
//
// One passcode page, loaded ahead and kept ready (the "preload" pattern other
// embedded wallets use - Magic loads its wallet iframe at start-up so nothing
// is fetched when the person acts). Every payment used to load a fresh
// wallet-frame/confirm.html at the moment Pay was tapped; on mobile data that
// load sometimes hung 10-13 s (wallet_events confirm_open, 12-13 Nov).
//
// Now one confirm.html#standby=1 sits loaded, out of sight. When a passcode
// step opens (WalletConfirmFrame), it takes this page, moves it into its sheet
// with Node.moveBefore - which keeps an iframe's document alive (no reload) -
// and hands it the slot and summary by message. A new one is then loaded for
// the next payment. Nothing about what the page shows or checks changes: the
// slot / summary are the same values the page would have read from its
// address, from the same parent.
//
// Browsers without moveBefore (moving an iframe there reloads it) never get a
// standby: the page is loaded at Pay, as before.

import { walletOrigin } from '@/wallet/frameClient'

/** A kept page this old is replaced (a newer wallet may have been deployed since). */
const STALE_MS = 10 * 60_000
/** A page that never says it is ready (an older wallet deploy, a failed load) is dropped after this. */
const READY_WITHIN_MS = 20_000
/** After a failed one, wait this long before loading another. */
const RETRY_AFTER_MS = 60_000
/** After one is taken, the next starts loading at once (a small page, from
 *  another host than the payment's own requests): a second payment soon after
 *  the first then finds it ready. */
const NEXT_AFTER_MS = 300

interface Standby { frame: HTMLIFrameElement; holder: HTMLDivElement; ready: boolean; at: number }
let current: Standby | null = null
let failedAt = 0
let listening = false
let last: { theme: 'dark' | 'light'; short: boolean } = { theme: 'dark', short: false }

/** Node.moveBefore: moving an iframe keeps it loaded (Chrome 133+). */
export function canMoveFrames(): boolean {
  return typeof document !== 'undefined' && typeof (document.body as unknown as { moveBefore?: unknown })?.moveBefore === 'function'
}

function onMessage(e: MessageEvent) {
  if (!current || e.origin !== walletOrigin() || e.source !== current.frame.contentWindow) return
  const d = e.data as { type?: string; state?: string } | null
  if (d?.type === 'mp-confirm' && d.state === 'standby') current.ready = true
}

function drop(s: Standby | null) {
  if (!s) return
  s.frame.remove()
  s.holder.remove()
}

/**
 * Keep a passcode page loaded and ready. Cheap to call often: does nothing
 * while a fresh one is there (or loading). `replaceUnready`: a page still not
 * ready (its load may be stuck on a dead connection) is replaced.
 */
export function ensureConfirmStandby(theme: 'dark' | 'light', short: boolean, opts: { replaceUnready?: boolean } = {}): void {
  if (!canMoveFrames()) return
  last = { theme, short }
  const now = Date.now()
  if (current && now - current.at < STALE_MS && (current.ready || !opts.replaceUnready)) return
  if (!current && now - failedAt < RETRY_AFTER_MS) return
  drop(current)
  current = null
  if (!listening) { window.addEventListener('message', onMessage); listening = true }

  // Laid out at a real size (so the page draws and loads its font) but out
  // of sight and untouchable.
  const holder = document.createElement('div')
  holder.setAttribute('aria-hidden', 'true')
  Object.assign(holder.style, { position: 'fixed', left: '-10000px', top: '0', width: '360px', height: '480px', visibility: 'hidden', pointerEvents: 'none' })
  const frame = document.createElement('iframe')
  frame.src = `${walletOrigin()}/confirm.html#standby=1&theme=${theme}${short ? '&short=1' : ''}`
  frame.title = 'Confirm in your wallet'
  frame.tabIndex = -1
  frame.setAttribute('allow', 'publickey-credentials-get') // fingerprint: only set before the page loads
  frame.setAttribute('referrerpolicy', 'no-referrer')
  Object.assign(frame.style, { display: 'block', width: '100%', height: '100%', border: '0', colorScheme: 'normal' })
  holder.appendChild(frame)
  document.body.appendChild(holder)
  const mine: Standby = { frame, holder, ready: false, at: now }
  current = mine
  setTimeout(() => {
    if (current === mine && !mine.ready) { drop(mine); current = null; failedAt = Date.now() }
  }, READY_WITHIN_MS)
}

/**
 * The ready page, taken out of the standby (it is the caller's now: move it
 * into place, hand it its slot, remove it when done). Null when there is none
 * ready - the caller loads one the usual way.
 */
export function takeConfirmStandby(): HTMLIFrameElement | null {
  const s = current
  if (!s?.ready || !canMoveFrames() || Date.now() - s.at > STALE_MS) return null
  current = null
  // The holder goes once the page has been moved out of it (the caller does
  // that in this same frame).
  setTimeout(() => s.holder.remove(), 0)
  setTimeout(() => ensureConfirmStandby(last.theme, last.short), NEXT_AFTER_MS)
  return s.frame
}

/** Tests. */
export function resetConfirmStandby(): void {
  drop(current); current = null; failedAt = 0
}
