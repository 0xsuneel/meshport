// src/wallet/frameClient.ts
//
// The app's side of the wallet frame: mounts the hidden iframe on
// VITE_WALLET_ORIGIN and sends it requests (protocol.ts). Messages are
// accepted only from that exact origin and that exact iframe window.

import {
  WALLET_MESSAGE_TAG, WALLET_PROTOCOL_VERSION, isWalletMessage,
  type WalletMethod, type WalletParams, type WalletResult, type WalletResponse, type WalletErrorCode,
} from './protocol'

const DEV_ORIGIN = 'http://localhost:5174'

export function walletOrigin(): string {
  const configured = import.meta.env.VITE_WALLET_ORIGIN as string | undefined
  return new URL(configured || (import.meta.env.DEV ? DEV_ORIGIN : 'https://wallet.meshport.xyz')).origin
}

export class WalletFrameError extends Error {
  /** approval-required: why the frame's spend limit didn't cover it (protocol.ts). */
  reason?: string
  constructor(public code: WalletErrorCode | 'timeout' | 'unavailable', message: string, public lockedForMs = 0) { super(message) }
}

const READY_TIMEOUT_MS = 15_000
// The frame's page loaded (its scripts run before `load`) but answers no ping
// for this long: it is a browser error page or a broken load, and waiting out
// READY_TIMEOUT_MS on it cannot help - load a fresh one.
const LOADED_SILENT_MS = 3_000
// At most this many fresh loads inside one walletReady() call.
const MAX_RELOADS_PER_WAIT = 2
const DEFAULT_TIMEOUT_MS = 30_000
// PBKDF2(600k) runs in the frame; give those calls room on slow phones.
const SLOW_METHODS = new Set<WalletMethod>(['create', 'import', 'adopt', 'unlock', 'set-passcode', 'passcode:check', 'reveal:grant', 'passkey:begin'])

let frame: HTMLIFrameElement | null = null
let readyPromise: Promise<void> | null = null
// The frame says "ready" itself once it's listening (wallet-frame/src/main.ts);
// the ready loop below wakes on that instead of waiting out a dropped ping.
let frameSaidReady: (() => void) | null = null
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }>()

function onMessage(e: MessageEvent) {
  if (e.origin !== walletOrigin()) return
  if (!frame || e.source !== frame.contentWindow) return
  if (!isWalletMessage(e.data)) return
  const msg = e.data as WalletResponse
  if (msg.id === 'ready') { frameSaidReady?.(); return }
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  clearTimeout(p.timer)
  if (msg.error) {
    const err = new WalletFrameError(msg.error.code, msg.error.message, msg.error.lockedForMs ?? 0)
    if (typeof msg.error.reason === 'string') err.reason = msg.error.reason.slice(0, 24)
    p.reject(err)
  }
  else p.resolve(msg.result)
}

// When the current frame's page finished loading (its `load` event). The
// event fires for a browser error page too (a request to the wallet host that
// failed on a weak connection), so "loaded but never answers" means this
// frame is dead - see walletReady.
let frameLoadedAt: number | null = null

function mount(): HTMLIFrameElement {
  if (frame?.isConnected) return frame
  window.addEventListener('message', onMessage)
  const f = document.createElement('iframe')
  // The wallet's pages are kept by the browser for 10 minutes
  // (wallet-frame/vercel.json), so opening one doesn't wait on the network -
  // a connection to the wallet host that had gone stale cost ~10 s each time.
  // A frame being loaded AGAIN because the last one didn't answer gets a
  // one-off address instead, which always fetches a fresh copy: a kept page
  // that is broken must not be loaded a second time.
  f.src = frameReloads > 0 ? `${walletOrigin()}/?r=${frameReloads}-${Date.now().toString(36)}` : `${walletOrigin()}/`
  f.title = 'MeshPort wallet'
  f.setAttribute('aria-hidden', 'true')
  f.tabIndex = -1
  f.style.cssText = 'position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none'
  // Same-site subdomain frame: first-party storage, no third-party cookie rules.
  f.referrerPolicy = 'no-referrer'
  frameLoadedAt = null
  // Loaded: ping now rather than when the previous (dropped) ping times out.
  f.addEventListener('load', () => {
    if (frame !== f) return // a replaced frame
    frameLoadedAt = Date.now()
    const at = typeof performance !== 'undefined' ? performance.now() : undefined
    void import('@/lib/perfTrace').then(m => m.markStartup('frameLoaded', at)).catch(() => {})
    frameSaidReady?.()
  })
  document.body.appendChild(f)
  void import('@/lib/perfTrace').then(m => m.markStartup('provider')).catch(() => {})
  frame = f
  return f
}

// Drop the current frame so the next mount() loads the wallet page afresh.
// Only ever done when it isn't answering at all: a frame that never answered
// a ping holds no open wallet, so nothing is lost. (Requests in flight to it
// fail now instead of at their own timeout.)
let frameReloads = 0
function replaceFrame(reason: string): void {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new WalletFrameError('unavailable', 'Wallet frame reloaded')) }
  pending.clear()
  frame?.remove(); frame = null; frameLoadedAt = null
  frameReloads++
  void import('@/lib/perfTrace').then(m => m.noteStartupDetail('frameReloads', `${frameReloads}:${reason}`, true)).catch(() => {})
}

function post<M extends WalletMethod>(method: M, params: WalletParams<M>, timeoutMs: number): Promise<WalletResult<M>> {
  const f = mount()
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new WalletFrameError('timeout', 'The wallet took too long to answer'))
    }, timeoutMs)
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
    f.contentWindow?.postMessage({ tag: WALLET_MESSAGE_TAG, v: WALLET_PROTOCOL_VERSION, id, method, params }, walletOrigin())
  })
}

/** Resolves once the frame answers a ping (it may load before or after us). */
export function walletReady(): Promise<void> {
  if (readyPromise) return readyPromise
  readyPromise = (async () => {
    mount()
    const deadline = Date.now() + READY_TIMEOUT_MS
    let reloads = 0
    // A ping sent before the frame's page has loaded is dropped by the
    // browser (wrong target origin), so keep pinging until one is answered -
    // and ping again the moment the frame loads / says it's ready, instead of
    // waiting out the dropped ping's 1 s timeout.
    //
    // The frame used to be loaded exactly once per page: when that one load
    // failed (field 2 Nov 16:23 - the wallet host unreachable for a moment on
    // 4G while meshport.xyz answered), every retry pinged the same dead frame
    // until "wallet frame unavailable" at 49 s, and only reloading the whole
    // app recovered. Now a frame that loaded but stays silent is replaced
    // within the wait, and one that never answers is dropped when the wait
    // ends, so the caller's retry loads it again.
    try {
      while (Date.now() < deadline) {
        if (frameLoadedAt != null && Date.now() - frameLoadedAt > LOADED_SILENT_MS && reloads < MAX_RELOADS_PER_WAIT) {
          reloads++
          replaceFrame('silent-after-load')
          mount()
        }
        const woken = new Promise<void>(r => { frameSaidReady = r })
        const ping = post('ping', {}, 1000)
        const pingWhenReady = woken.then(() => post('ping', {}, 1000))
        // Whichever loses the race may reject later - not an unhandled error.
        ping.catch(() => {}); pingWhenReady.catch(() => {})
        try {
          await Promise.race([ping, pingWhenReady])
          void import('@/lib/perfTrace').then(m => m.markStartup('frame')).catch(() => {})
          return
        } catch { /* not listening yet */ }
      }
    } finally { frameSaidReady = null }
    replaceFrame('timeout')
    throw new WalletFrameError('unavailable', "Couldn't open the wallet on this device")
  })()
  readyPromise.catch(() => { readyPromise = null })
  return readyPromise
}

// The frame says "locked" to a request for a wallet the app holds as open:
// the frame was loaded afresh meanwhile (it stopped answering and was
// replaced below; another tab locked it) and its memory is empty. A page
// reload would reopen it from this tab's session copy without asking - so do
// exactly that, once, and run the request again, instead of failing a payment
// with "Wallet is locked". No session copy (it was really locked): stays
// locked. At most one try per wallet every few seconds.
const NO_REOPEN = new Set<WalletMethod>(['unlock', 'lock', 'forget', 'status', 'ping', 'create', 'import', 'adopt'])
const REOPEN_EVERY_MS = 5_000
const lastReopen = new Map<string, number>()
async function reopenFromSession(address: string): Promise<boolean> {
  const a = address.toLowerCase()
  if (Date.now() - (lastReopen.get(a) ?? 0) < REOPEN_EVERY_MS) return false
  lastReopen.set(a, Date.now())
  try { return !!(await post('unlock', { address }, 120_000)).unlocked } catch { return false }
}

export async function callWallet<M extends WalletMethod>(method: M, params: WalletParams<M>): Promise<WalletResult<M>> {
  await walletReady()
  const timeoutMs = SLOW_METHODS.has(method) ? 120_000 : DEFAULT_TIMEOUT_MS
  try {
    return await post(method, params, timeoutMs)
  } catch (e) {
    const address = (params as { address?: unknown } | undefined)?.address
    if (e instanceof WalletFrameError && e.code === 'locked' && !NO_REOPEN.has(method) && typeof address === 'string' && await reopenFromSession(address)) {
      void import('@/lib/walletEvents').then(m => m.logWalletEvent({ kind: 'frame', event: 'frame', ok: true, detail: `reopened after locked: ${method}` })).catch(() => {})
      return await post(method, params, timeoutMs)
    }
    // A quick request that never came back: if the frame doesn't answer a
    // ping either (its process was discarded, say), load a fresh one so the
    // next request doesn't hang on a dead frame until the page reloads.
    if (e instanceof WalletFrameError && e.code === 'timeout' && !SLOW_METHODS.has(method)) {
      const alive = await post('ping', {}, 2_000).then(() => true, () => false)
      if (!alive) { replaceFrame('dead-after-timeout'); readyPromise = null }
    }
    throw e
  }
}

/** Test hook: tear the frame down. */
export function resetWalletFrame() {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new WalletFrameError('unavailable', 'Wallet frame reset')) }
  pending.clear()
  window.removeEventListener('message', onMessage)
  frame?.remove(); frame = null; readyPromise = null; frameLoadedAt = null; frameReloads = 0
  lastReopen.clear()
}
