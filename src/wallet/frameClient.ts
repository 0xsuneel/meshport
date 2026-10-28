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
  constructor(public code: WalletErrorCode | 'timeout' | 'unavailable', message: string, public lockedForMs = 0) { super(message) }
}

const READY_TIMEOUT_MS = 15_000
const DEFAULT_TIMEOUT_MS = 30_000
// PBKDF2(600k) runs in the frame; give those calls room on slow phones.
const SLOW_METHODS = new Set<WalletMethod>(['create', 'import', 'adopt', 'unlock', 'set-passcode', 'reveal:grant', 'passkey:begin'])

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
  if (msg.error) p.reject(new WalletFrameError(msg.error.code, msg.error.message, msg.error.lockedForMs ?? 0))
  else p.resolve(msg.result)
}

function mount(): HTMLIFrameElement {
  if (frame?.isConnected) return frame
  window.addEventListener('message', onMessage)
  const f = document.createElement('iframe')
  f.src = `${walletOrigin()}/`
  f.title = 'MeshPort wallet'
  f.setAttribute('aria-hidden', 'true')
  f.tabIndex = -1
  f.style.cssText = 'position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none'
  // Same-site subdomain frame: first-party storage, no third-party cookie rules.
  f.referrerPolicy = 'no-referrer'
  // Loaded: ping now rather than when the previous (dropped) ping times out.
  f.addEventListener('load', () => frameSaidReady?.())
  document.body.appendChild(f)
  void import('@/lib/perfTrace').then(m => m.markStartup('provider')).catch(() => {})
  frame = f
  return f
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
    // A ping sent before the frame's page has loaded is dropped by the
    // browser (wrong target origin), so keep pinging until one is answered -
    // and ping again the moment the frame loads / says it's ready, instead of
    // waiting out the dropped ping's 1 s timeout.
    try {
      while (Date.now() < deadline) {
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
    throw new WalletFrameError('unavailable', "Couldn't open the wallet on this device")
  })()
  readyPromise.catch(() => { readyPromise = null })
  return readyPromise
}

export async function callWallet<M extends WalletMethod>(method: M, params: WalletParams<M>): Promise<WalletResult<M>> {
  await walletReady()
  return post(method, params, SLOW_METHODS.has(method) ? 120_000 : DEFAULT_TIMEOUT_MS)
}

/** Test hook: tear the frame down. */
export function resetWalletFrame() {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new WalletFrameError('unavailable', 'Wallet frame reset')) }
  pending.clear()
  window.removeEventListener('message', onMessage)
  frame?.remove(); frame = null; readyPromise = null
}
