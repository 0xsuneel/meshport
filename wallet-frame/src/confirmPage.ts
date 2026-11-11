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

// The app's typeface, served from the wallet's own origin (font-src 'self').
import '@fontsource-variable/geist'
import { CONFIRM_CHANNEL, parseOrigins, type ConfirmBiometric, type ConfirmSummary } from '@/wallet/protocol'
import type { IntentView } from './intent'

const PARENTS = parseOrigins(import.meta.env.VITE_WALLET_PARENT_ORIGINS as string | undefined
  ?? (import.meta.env.DEV ? 'http://localhost:5173,http://127.0.0.1:5173' : ''))
const LENGTH = 6
// The biometric record's key (src/lib/biometric.ts prfKey - same derivation).
const PRF_INFO = new TextEncoder().encode('meshport-biometric-prf-v3')

const params = new URLSearchParams(location.hash.slice(1))
// Either the confirmation's ticket (the page opened once it existed), or the
// app's slot name for it (the page opened at once, the request follows -
// confirm:begin with that slot) plus the app's summary to show meanwhile.
const ticketParam = params.get('t') ?? ''
const slotParam = params.get('slot') ?? ''
const summaryParam = params.get('s')
history.replaceState(null, '', location.pathname)
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark'
// A short phone (the app's PinKeypad uses shorter keys there too), so the
// whole step fits in the sheet without scrolling.
if (params.get('short') === '1') document.documentElement.dataset.short = ''
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
// The content's own height: the document's scrollHeight is never less than the
// frame's, so the sheet could grow the frame but never shrink it to fit.
function tellSize() { requestAnimationFrame(() => tellApp({ state: 'size', height: Math.ceil(document.body.getBoundingClientRect().height) })) }
try { new ResizeObserver(tellSize).observe(document.body) } catch { /* sized once per draw */ }

// ── Visibility ──────────────────────────────────────────────────────────────
let visible = true
/** Whether the browser will say if the page is in view (false: input is simply accepted). */
function watchVisibility(onChange: () => void): boolean {
  const IO = window.IntersectionObserver as unknown as (new (cb: (entries: Array<IntersectionObserverEntry & { isVisible?: boolean }>) => void, o: object) => IntersectionObserver) | undefined
  if (!IO) return false
  try {
    const io = new IO(entries => {
      const last = entries[entries.length - 1]
      if (!last || last.isVisible === undefined) return // v1 only: nothing to tell
      visible = last.isVisible
      onChange()
    }, { threshold: [1], trackVisibility: true, delay: 100 })
    if (!('trackVisibility' in io)) { io.disconnect(); return false } // not v2
    visible = false // until the browser says so
    io.observe(document.body)
    return true
  } catch { return false /* not supported: keep accepting */ }
}

// ── The card ────────────────────────────────────────────────────────────────
// Drawn like the app's passcode sheet (PinSheet's SummaryCard): a letter
// badge, what it is and who / what for, the amount on the right. The amount,
// token and address come from the wallet's own reading of the request
// (`view`); the name and label are the app's words.
function row(label: string, value: string) {
  const r = el('div', 'row'); r.append(el('span', undefined, label), el('span', undefined, value)); return r
}
const shortAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a
/** "2.1 EURC" → ["2.1", "EURC"]; anything else (several tokens) stays whole. */
function splitAmount(amount: string, token: string): [string, string] {
  if (token) return [amount, token]
  const m = /^([0-9][0-9.,]*) ([A-Za-z]+)$/.exec(amount.trim())
  return m ? [m[1], m[2]] : [amount, '']
}
function summaryCard(o: { label: string; name: string; detail?: string; amount?: string; unit?: string }): HTMLElement {
  const c = el('section', 'card')
  c.append(el('div', 'badge', o.name.trim().charAt(0).toUpperCase() || '?'))
  const mid = el('div', 'card-mid')
  mid.append(el('p', 'label', o.label), el('p', 'name', o.name))
  if (o.detail) mid.append(el('p', 'detail', o.detail))
  c.append(mid)
  if (o.amount) {
    const end = el('div', 'card-end')
    end.append(el('p', o.amount.length > 9 ? 'amount long' : 'amount', o.amount))
    if (o.unit) end.append(el('p', 'unit', o.unit))
    c.append(end)
  }
  return c
}
const num = (s: string | undefined) => { const n = parseFloat(String(s ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : NaN }
/**
 * The wallet's reading next to the app's words: the amount and token the
 * wallet read, and whether the app's figure is that same amount (a spend
 * limit counts as the same when it covers it with up to 10% for fees).
 * Several tokens at once ("2 USDC + 1 EURC") never count as the app's one figure.
 */
function compare(view: IntentView, summary: ConfirmSummary | null) {
  const scope = view.to === 'may leave your wallet'
  const [amount, unit] = splitAmount(view.amount, view.token)
  const appN = num(summary?.amount), walletN = num(amount)
  const single = !!unit || !/\+/.test(view.amount)
  const sameUnit = !summary?.unit || !unit || summary.unit === unit
  const same = single && sameUnit && Number.isFinite(appN) && Number.isFinite(walletN)
    && (scope ? walletN >= appN && walletN <= appN * 1.1 + 1e-9 : Math.abs(walletN - appN) < 1e-9)
  return { scope, amount, unit, same }
}
/** A passcode typed before the wallet's reading arrived may go ahead: it is what the card showed. */
function agrees(view: IntentView | null, appSummary: ConfirmSummary | null): boolean {
  if (!view) return true // nothing read (an app summary on its own) - as shown
  return !view.warnings.length && compare(view, appSummary).same
}
function card(view: IntentView | null, summary: ConfirmSummary | null): HTMLElement {
  const wrap = el('div')
  if (view) {
    const { scope, amount, unit, same } = compare(view, summary)
    const label = summary?.label || (view.action === 'Send' ? 'Paying' : view.action)
    const name = summary?.name || view.action
    // Who the wallet will actually pay is always on the card (the name is the
    // app's word for it).
    const detail = scope
      ? (same ? summary?.detail : `Up to ${view.amount} for 2 minutes`)
      : [summary?.detail, view.to ? shortAddress(view.to) : ''].filter(Boolean).join(' · ') || undefined
    // The app's figure, exactly as the app's sheet showed it ("$5"), only
    // when it is what the wallet read - otherwise the wallet's own figure,
    // since that is what gets signed.
    wrap.append(summaryCard(same
      ? { label, name, detail, amount: summary!.amount, unit: summary!.unit ?? unit }
      : { label, name, detail, amount: scope ? view.amount : amount, unit: scope ? '' : unit }))
    // What else the wallet read (an order, a contract, a message) - not the
    // fee or the time limit.
    const rows = view.rows.filter(r => r.label !== 'Network fee' && r.label !== 'For')
    if (rows.length) { const box = el('div', 'rows'); for (const r of rows) box.append(row(r.label, r.value)); wrap.append(box) }
    for (const w of view.warnings) wrap.append(el('p', 'warn', w))
  } else if (summary) {
    wrap.append(summaryCard(summary))
  }
  return wrap
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

/** PinKeypad's delete key. */
function deleteIcon(): SVGElement {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  for (const [k, v] of [['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.8'],
    ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']]) svg.setAttribute(k, v)
  const path = document.createElementNS(NS, 'path'); path.setAttribute('d', 'M21 4H8l-7 8 7 8h13a2 2 0 002-2V6a2 2 0 00-2-2z')
  svg.append(path)
  for (const [x1, y1, x2, y2] of [['18', '9', '12', '15'], ['12', '9', '18', '15']]) {
    const l = document.createElementNS(NS, 'line'); l.setAttribute('x1', x1); l.setAttribute('y1', y1); l.setAttribute('x2', x2); l.setAttribute('y2', y2); svg.append(l)
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
// Live from the first frame. Opened by slot, the page shows the app's summary
// and takes digits while the wallet is still making the request; a passcode
// finished before it arrives waits, and goes ahead only if the wallet's
// reading agrees with what the card showed - otherwise the person checks the
// new card and types it again. Before the browser has said the page is in
// view, digits are kept, and dropped if it turns out not to be.
interface Req { ticket: string; view: IntentView | null; summary: ConfirmSummary | null; biometric: ConfirmBiometric | null }
const HIDDEN_SAY = 'Bring this fully into view to continue'

function run(channel: BroadcastChannel, first: Req | null, appSummary: ConfirmSummary | null) {
  let req: Req | null = first
  let digits = ''
  let busy = false
  let lockedUntil = 0
  // A passcode finished before the request arrived.
  let held: { passcode: string; via: 'passcode' | 'biometric' } | null = null
  let visKnown = true
  const dots = el('div', 'dots'); dots.setAttribute('aria-hidden', 'true')
  // Status / errors only, like the app's keypad (nothing under the dots normally).
  const say = el('p', 'say', '')
  say.setAttribute('role', 'status')
  const keys: HTMLButtonElement[] = []
  const cardBox = el('div')
  cardBox.append(card(req?.view ?? null, req?.summary ?? appSummary))

  const paint = () => {
    dots.replaceChildren(...Array.from({ length: LENGTH }, (_, i) => el('span', i < digits.length ? 'dot on' : 'dot')))
    // Greyed only while checking or locked out - never while the browser is
    // still confirming the page is in view, so nothing flickers.
    const blocked = busy || lockedUntil > Date.now()
    for (const k of keys) k.disabled = blocked
  }
  const sayIt = (text: string, bad = false) => { say.textContent = text; say.className = bad ? 'say error' : 'say' }

  const send = (passcode: string, via: 'passcode' | 'biometric') => {
    channel.postMessage({ type: 'passcode', ticket: req!.ticket, passcode, via })
  }
  const submit = (passcode: string, via: 'passcode' | 'biometric') => {
    busy = true; paint(); sayIt('Checking…')
    if (req) send(passcode, via)
    else held = { passcode, via } // goes when the request arrives
  }
  // Six digits in: on their way once the page is known to be in view.
  const trySubmit = () => {
    if (busy || digits.length !== LENGTH || !visKnown || !visible) return
    submit(digits, 'passcode')
  }

  let hiddenTimer: ReturnType<typeof setTimeout> | null = null
  const refreshVisibility = () => {
    visKnown = true
    if (hiddenTimer) { clearTimeout(hiddenTimer); hiddenTimer = null }
    if (!visible) {
      // Typed while something may have covered the page: not used.
      if (!busy && digits) { digits = '' }
      if (!busy) hiddenTimer = setTimeout(() => { if (!visible && !busy) sayIt(HIDDEN_SAY) }, 600)
    } else {
      if (say.textContent === HIDDEN_SAY) sayIt('')
      trySubmit()
    }
    paint()
  }

  channel.addEventListener('message', (e) => {
    const d = (e.data ?? {}) as { type?: string; ticket?: string; ok?: boolean; code?: string; message?: string; lockedForMs?: number }
    if (d.type !== 'checked' || !req || d.ticket !== req.ticket) return
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
      setTimeout(() => { sayIt(''); paint() }, (d.lockedForMs ?? 30_000) + 50)
    } else if (d.code === 'bad-passcode') sayIt('Incorrect passcode. Try again.', true)
    else if (d.code === 'expired') { sayIt(d.message ?? 'This request has expired', true); busy = true }
    else sayIt(d.message || "Couldn't check the passcode - try again", true)
    tellApp({ state: 'wrong' })
    paint()
  })

  const press = (digit: string) => {
    if (busy || lockedUntil > Date.now() || digits.length >= LENGTH) return
    if (visKnown && !visible) return
    digits += digit
    if (say.className === 'say error') sayIt('')
    paint()
    if (digits.length === LENGTH) setTimeout(trySubmit, 80)
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

  // The fingerprint key: once the request (and with it the sealed passcode) is here.
  const fingerprintKey = (biometric: ConfirmBiometric) => key(fingerprintIcon(), async () => {
    if (busy || !visKnown || !visible || lockedUntil > Date.now() || !req) return
    busy = true; paint(); sayIt(`Waiting for ${biometric.label || 'fingerprint'}…`)
    let passcode: string | null = null
    try { passcode = await passcodeFromFingerprint(biometric) } catch { /* below */ }
    busy = false
    if (passcode) submit(passcode, 'biometric')
    else { sayIt(`${biometric.label || 'Fingerprint'} didn't work - enter your passcode`, true); paint() }
  }, 'key bio', `Use ${biometric.label || 'fingerprint'}`, true)
  const canFingerprint = (b: ConfirmBiometric | null): b is ConfirmBiometric => !!b && !!window.PublicKeyCredential

  const pad = el('div', 'pad')
  for (const n of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) pad.append(key(n, () => press(n)))
  let bioCell: HTMLElement = canFingerprint(req?.biometric ?? null) ? fingerprintKey(req!.biometric!) : Object.assign(el('span'), { ariaHidden: 'true' })
  pad.append(bioCell, key('0', () => press('0')), key(deleteIcon(), back, 'key del', 'Delete'))

  document.addEventListener('keydown', (e) => {
    if (/^[0-9]$/.test(e.key)) { press(e.key); e.preventDefault() }
    else if (e.key === 'Backspace') { back(); e.preventDefault() }
  })

  const entry = el('div', 'entry')
  entry.append(dots, say, pad)
  show(cardBox, entry)
  visKnown = !watchVisibility(refreshVisibility)
  paint()
  tellApp({ state: 'ready' })

  // The request, for a page opened by slot.
  return {
    arrived(next: Req) {
      req = next
      cardBox.replaceChildren(card(next.view, next.summary ?? appSummary))
      if (canFingerprint(next.biometric)) { const k = fingerprintKey(next.biometric); bioCell.replaceWith(k); bioCell = k }
      tellSize()
      if (held) {
        const h = held; held = null
        if (agrees(next.view, appSummary)) send(h.passcode, h.via)
        else { busy = false; digits = ''; sayIt('Check the details, then enter your passcode', true); paint() }
      }
      paint()
    },
    failed(text: string) { show(el('p', 'error center', text)) },
  }
}

/** The app's summary from the URL (its own words, kept short - as the frame does). */
function appSummaryFrom(raw: string | null): ConfirmSummary | null {
  try {
    const r = JSON.parse(raw ?? 'null') as Record<string, unknown> | null
    if (!r || typeof r !== 'object') return null
    const clip = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined)
    const label = clip(r.label, 40), name = clip(r.name, 80)
    if (!label || !name) return null
    return { label, name, detail: clip(r.detail, 80), amount: clip(r.amount, 32), unit: clip(r.unit, 16) }
  } catch { return null }
}

let channel: BroadcastChannel | null = null
try { channel = new BroadcastChannel(CONFIRM_CHANNEL) } catch { /* below */ }
if (!channel) {
  show(el('p', 'error center', "This browser can't confirm here."))
} else if (/^[0-9a-f]{32}$/.test(slotParam)) {
  // Opened at once: the keypad now, the request when the wallet has it.
  const ch = channel
  const page = run(ch, null, appSummaryFrom(summaryParam))
  let done = false
  const onRequest = (e: MessageEvent) => {
    const d = e.data ?? {}
    if (d.type !== 'request' || d.slot !== slotParam) return
    done = true
    ch.removeEventListener('message', onRequest)
    if (d.error || typeof d.ticket !== 'string' || (!d.view && !d.summary)) page.failed('This request has expired. Close it and try again.')
    else page.arrived({ ticket: d.ticket, view: d.view ?? null, summary: d.summary ?? null, biometric: d.biometric ?? null })
  }
  ch.addEventListener('message', onRequest)
  const started = Date.now()
  const ask = () => {
    if (done) return
    if (Date.now() - started > 15_000) { page.failed('The wallet is not open. Close this and try again.'); return }
    ch.postMessage({ type: 'claim', slot: slotParam })
    setTimeout(ask, 150)
  }
  ask()
} else if (/^0x[0-9a-f]{32}$/.test(ticketParam)) {
  const ch = channel
  const timer = setTimeout(() => show(el('p', 'error center', 'The wallet is not open. Close this and try again.')), 5000)
  const onRequest = (e: MessageEvent) => {
    const d = e.data ?? {}
    if (d.type !== 'request' || d.ticket !== ticketParam) return
    clearTimeout(timer)
    ch.removeEventListener('message', onRequest)
    if (d.error || (!d.view && !d.summary)) show(el('p', 'error center', 'This request has expired. Close it and try again.'))
    else run(ch, { ticket: ticketParam, view: d.view ?? null, summary: d.summary ?? null, biometric: d.biometric ?? null }, null)
  }
  ch.addEventListener('message', onRequest)
  ch.postMessage({ type: 'claim', ticket: ticketParam })
} else {
  show(el('p', 'error center', 'This link has expired. Close it and try again.'))
}
