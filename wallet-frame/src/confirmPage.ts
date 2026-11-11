// wallet-frame/src/confirmPage.ts
//
// The visible confirm step (confirm.html#t=<ticket>): what is being approved,
// and the passcode keypad - inside the wallet's origin. The app embeds this
// page as an iframe and sees only its pixels: the passcode typed here goes to
// the hidden wallet frame over a same-origin BroadcastChannel, never to the
// app. What the card shows comes from the frame too (for a payment it decoded
// the transaction itself - intent.ts), never from this page's URL.
//
// The page only accepts the passcode while the browser reports it fully
// visible (IntersectionObserver v2, where supported), so a page that lays
// other content over it can't make the person approve what they don't see.

import { CONFIRM_CHANNEL, parseOrigins, type ConfirmBiometric, type ConfirmSummary } from '@/wallet/protocol'
import type { IntentView } from './intent'

const PARENTS = parseOrigins(import.meta.env.VITE_WALLET_PARENT_ORIGINS as string | undefined
  ?? (import.meta.env.DEV ? 'http://localhost:5173,http://127.0.0.1:5173' : ''))
const LENGTH = 6
// The biometric record's key (src/lib/biometric.ts prfKey - same derivation).
const PRF_INFO = new TextEncoder().encode('meshport-biometric-prf-v3')

const params = new URLSearchParams(location.hash.slice(1))
const ticket = params.get('t') ?? ''
history.replaceState(null, '', location.pathname)
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark'
const root = document.getElementById('root')!

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text // never innerHTML
  return n
}
const show = (...nodes: Node[]) => { root.replaceChildren(...nodes); tellSize() }

// The app only learns that something happened (to size / close its sheet) -
// never the passcode. Sent only to the app origins.
function tellApp(msg: Record<string, unknown>) {
  if (parent === window) return
  for (const origin of PARENTS) { try { parent.postMessage({ type: 'mp-confirm', ...msg }, origin) } catch { /* */ } }
}
function tellSize() { requestAnimationFrame(() => tellApp({ state: 'size', height: Math.ceil(document.documentElement.scrollHeight) })) }
try { new ResizeObserver(tellSize).observe(document.body) } catch { /* sized once per draw */ }

// ── Visibility ──────────────────────────────────────────────────────────────
let visible = true
function watchVisibility(onChange: () => void) {
  const IO = window.IntersectionObserver as unknown as (new (cb: (entries: Array<IntersectionObserverEntry & { isVisible?: boolean }>) => void, o: object) => IntersectionObserver) | undefined
  if (!IO) return
  try {
    const io = new IO(entries => {
      const last = entries[entries.length - 1]
      if (!last || last.isVisible === undefined) return // v1 only: nothing to tell
      visible = last.isVisible
      onChange()
    }, { threshold: [1], trackVisibility: true, delay: 100 })
    if (!('trackVisibility' in io)) { io.disconnect(); return } // not v2
    visible = false // until the browser says so
    io.observe(document.body)
  } catch { /* not supported: keep accepting */ }
}

// ── The card ────────────────────────────────────────────────────────────────
function row(label: string, value: string) {
  const r = el('div', 'row'); r.append(el('span', undefined, label), el('span', undefined, value)); return r
}
function amountNode(amount: string, unit?: string) {
  const a = el('div', 'card-amount', amount)
  if (unit) a.append(el('span', 'unit', unit))
  return a
}
function card(view: IntentView | null, summary: ConfirmSummary | null): HTMLElement {
  const c = el('section', 'card')
  if (view) {
    const head = el('div', 'card-head')
    head.append(el('span', 'card-label', view.action === 'Send' ? 'Paying' : view.action), amountNode(view.amount, view.token))
    c.append(head)
    if (summary?.name) c.append(el('div', 'to-name', summary.name))
    c.append(el('div', 'to-address', view.to))
    for (const r of view.rows) c.append(row(r.label, r.value))
    for (const w of view.warnings) c.append(el('p', 'warn', w))
    c.append(el('p', 'source', view.source
      ? (summary?.name ? `${view.source} The name is from MeshPort.` : view.source)
      : summary?.name
        ? 'Amount and address read from the transaction by your wallet. The name is from MeshPort.'
        : 'Read from the transaction by your wallet.'))
  } else if (summary) {
    const head = el('div', 'card-head')
    head.append(el('span', 'card-label', summary.label), amountNode(summary.amount ?? '', summary.unit))
    c.append(head, el('div', 'to-name', summary.name))
    if (summary.detail) c.append(el('div', 'muted', summary.detail))
    c.append(el('p', 'source', 'Details from the MeshPort app.'))
  }
  return c
}

function fingerprintIcon(): SVGElement {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  for (const [k, v] of [['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.8'],
    ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']]) svg.setAttribute(k, v)
  for (const d of ['M12 11c0 3.5-1 6.5-3 9', 'M8.5 6.7A6 6 0 0 1 18 11c0 2.5-.3 4.8-1 7', 'M6 9.5A6 6 0 0 0 6 11c0 2-.5 3.8-1.5 5.5',
    'M12 7.5A3.5 3.5 0 0 1 15.5 11c0 3-.6 5.6-1.8 8', 'M8.5 11a3.5 3.5 0 0 1 1-2.4']) {
    const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.append(p)
  }
  return svg
}

// ── Fingerprint: the same passkey that sealed the passcode opens it here ────
const fromB64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0))
const fromB64Url = (s: string) => fromB64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
async function passcodeFromFingerprint(b: ConfirmBiometric): Promise<string> {
  const cred = await navigator.credentials.get({
    publicKey: {
      rpId: b.rpId,
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: fromB64Url(b.credentialId) }],
      userVerification: 'required',
      timeout: 30_000,
      extensions: { prf: { eval: { first: fromB64(b.salt) } } } as AuthenticationExtensionsClientInputs,
    },
  }) as PublicKeyCredential | null
  const prf = (cred?.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } } | undefined)?.prf?.results?.first
  if (!prf) throw new Error('no-prf')
  const ikm = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: PRF_INFO }, ikm, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(b.iv) }, key, fromB64(b.ciphertext))
  return new TextDecoder().decode(plain)
}

// ── The keypad ──────────────────────────────────────────────────────────────
function run(channel: BroadcastChannel, view: IntentView | null, summary: ConfirmSummary | null, biometric: ConfirmBiometric | null) {
  let digits = ''
  let busy = false
  let lockedUntil = 0
  const dots = el('div', 'dots'); dots.setAttribute('aria-hidden', 'true')
  const say = el('p', 'say', 'Enter your passcode')
  say.setAttribute('role', 'status')
  const keys: HTMLButtonElement[] = []

  const paint = () => {
    dots.replaceChildren(...Array.from({ length: LENGTH }, (_, i) => el('span', i < digits.length ? 'dot on' : 'dot')))
    const blocked = busy || lockedUntil > Date.now() || !visible
    for (const k of keys) k.disabled = blocked
  }
  const sayIt = (text: string, bad = false) => { say.textContent = text; say.className = bad ? 'say error' : 'say' }
  const refreshVisibility = () => {
    if (!visible && !busy) sayIt('Bring this fully into view to continue')
    else if (say.textContent === 'Bring this fully into view to continue') sayIt('Enter your passcode')
    paint()
  }

  const submit = (passcode: string, via: 'passcode' | 'biometric') => {
    busy = true; paint(); sayIt('Checking…')
    channel.postMessage({ type: 'passcode', ticket, passcode, via })
  }
  channel.addEventListener('message', (e) => {
    const d = (e.data ?? {}) as { type?: string; ticket?: string; ok?: boolean; code?: string; message?: string; lockedForMs?: number }
    if (d.type !== 'checked' || d.ticket !== ticket) return
    busy = false
    if (d.ok) {
      show(el('div', 'done', 'Approved'))
      tellApp({ state: 'approved' })
      return
    }
    digits = ''
    dots.classList.remove('shake'); void dots.offsetWidth; dots.classList.add('shake', 'bad')
    setTimeout(() => { dots.classList.remove('bad'); paint() }, 500)
    if (d.code === 'rate-limited') {
      lockedUntil = Date.now() + (d.lockedForMs ?? 30_000)
      sayIt(`Too many tries - wait ${Math.ceil((d.lockedForMs ?? 30_000) / 1000)} s`, true)
      setTimeout(() => { sayIt('Enter your passcode'); paint() }, (d.lockedForMs ?? 30_000) + 50)
    } else if (d.code === 'bad-passcode') sayIt('Incorrect passcode. Try again.', true)
    else if (d.code === 'expired') { sayIt(d.message ?? 'This request has expired', true); busy = true }
    else sayIt(d.message || "Couldn't check the passcode - try again", true)
    tellApp({ state: 'wrong' })
    paint()
  })

  const press = (digit: string) => {
    if (busy || lockedUntil > Date.now() || !visible || digits.length >= LENGTH) return
    digits += digit
    if (say.className === 'say error') sayIt('Enter your passcode')
    paint()
    if (digits.length === LENGTH) { const p = digits; setTimeout(() => submit(p, 'passcode'), 80) }
  }
  const back = () => { if (!busy && digits) { digits = digits.slice(0, -1); paint() } }

  const key = (label: string | Node, onTap: () => void, cls = 'key', aria?: string, onClick = false) => {
    const b = el('button', cls); b.type = 'button'
    if (typeof label === 'string') b.textContent = label; else b.append(label)
    if (aria) b.setAttribute('aria-label', aria)
    if (onClick) b.addEventListener('click', onTap) // WebAuthn needs the tap's activation (a touch pointerdown has none)
    else {
      // Digits respond on press, like a native keypad; click covers keyboard / AT.
      b.addEventListener('pointerdown', (ev) => { if (ev.pointerType !== 'mouse' || ev.button === 0) { ev.preventDefault(); onTap() } })
      b.addEventListener('click', (ev) => { if (ev.detail === 0) onTap() })
    }
    keys.push(b)
    return b
  }

  const pad = el('div', 'pad')
  for (const n of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) pad.append(key(n, () => press(n)))
  const canFingerprint = !!biometric && !!window.PublicKeyCredential
  pad.append(canFingerprint
    ? key(fingerprintIcon(), async () => {
        if (busy || !visible || lockedUntil > Date.now()) return
        busy = true; paint(); sayIt(`Waiting for ${biometric!.label || 'fingerprint'}…`)
        let passcode: string | null = null
        try { passcode = await passcodeFromFingerprint(biometric!) } catch { /* below */ }
        busy = false
        if (passcode) submit(passcode, 'biometric')
        else { sayIt(`${biometric!.label || 'Fingerprint'} didn't work - enter your passcode`, true); paint() }
      }, 'key plain', `Use ${biometric!.label || 'fingerprint'}`, true)
    : Object.assign(el('span'), { ariaHidden: 'true' }))
  pad.append(key('0', () => press('0')), key('⌫', back, 'key plain', 'Delete'))

  document.addEventListener('keydown', (e) => {
    if (/^[0-9]$/.test(e.key)) { press(e.key); e.preventDefault() }
    else if (e.key === 'Backspace') { back(); e.preventDefault() }
  })

  const entry = el('div', 'entry')
  entry.append(dots, say, pad)
  show(card(view, summary), entry, el('p', 'note', 'Checked inside your wallet - MeshPort never sees your passcode.'))
  watchVisibility(refreshVisibility)
  paint()
  tellApp({ state: 'ready' })
}

if (!/^0x[0-9a-f]{32}$/.test(ticket)) {
  show(el('p', 'error center', 'This link has expired. Close it and try again.'))
} else {
  let channel: BroadcastChannel | null = null
  try { channel = new BroadcastChannel(CONFIRM_CHANNEL) } catch { show(el('p', 'error center', "This browser can't confirm here.")) }
  if (channel) {
    const timer = setTimeout(() => show(el('p', 'error center', 'The wallet is not open. Close this and try again.')), 5000)
    const onRequest = (e: MessageEvent) => {
      const d = e.data ?? {}
      if (d.type !== 'request' || d.ticket !== ticket) return
      clearTimeout(timer)
      channel!.removeEventListener('message', onRequest)
      if (d.error || (!d.view && !d.summary)) show(el('p', 'error center', 'This request has expired. Close it and try again.'))
      else run(channel!, d.view ?? null, d.summary ?? null, d.biometric ?? null)
    }
    channel.addEventListener('message', onRequest)
    channel.postMessage({ type: 'claim', ticket })
  }
}
