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
import { splitAmount, compare, agrees } from './confirmMatch'

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
// Loaded ahead, empty (confirm.html#standby=1): the app keeps one such page
// ready in the background and, when a payment needs it, moves it into its
// passcode sheet (no reload) and tells it the slot and summary by message -
// what it would otherwise have read from this address. So tapping Pay never
// waits for this page to come over the network.
const standby = params.get('standby') === '1'
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
// Now and again on the next frame (after layout settles): the app shows the
// page only once it knows its height, so the first report never waits on a
// frame - a page the browser isn't drawing yet would never send one.
function tellSize() {
  const send = () => tellApp({ state: 'size', height: Math.ceil(document.body.getBoundingClientRect().height) })
  send()
  requestAnimationFrame(send)
}
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
/** An address short ("0xAb12…Cd34"); a contract the wallet names, by its name only. */
const shortAddress = (a: string) => {
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return `${a.slice(0, 6)}…${a.slice(-4)}`
  const named = /^(.+) \((0x[0-9a-fA-F]{40})\)$/.exec(a)
  return named ? named[1] : a
}
// Lines the passcode sheet leaves out: technical details (which network,
// the data's size, the contract's address, how many transfers) and what the
// card already says (the fee cap, the time limit, the order).
const HIDDEN_ROWS = new Set(['Network fee', 'For', 'May also call', 'Network', 'Signing for', 'Data', 'Transfers', 'Size', 'Contract', 'Paid through', 'Order'])
const MAX_ROWS = 2
/** "2.1 EURC" → ["2.1", "EURC"]; anything else (several tokens) stays whole. */
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
function card(view: IntentView | null, summary: ConfirmSummary | null): HTMLElement {
  const wrap = el('div')
  if (view) {
    const { scope, amount, unit, same, limit } = compare(view, summary)
    // An order's reference goes on the card's detail line, not a row of its own.
    const order = view.rows.find(r => r.label === 'Order')?.value
    const label = summary?.label || (view.action === 'Send' ? 'Paying' : view.action)
    // One exact request the app only knows as "this step" (no amount of its
    // own): name it by what the wallet read - "Gateway transfer", "Allow
    // spending", "Sign message" - not the app's generic words.
    const name = (!scope && !summary?.amount && view.action) || summary?.name || view.action
    // Who the wallet will actually pay is always on the card (the name is the
    // app's word for it).
    const detail = scope
      ? (limit ? `Up to ${limit} with fees` : same ? summary?.detail : `Up to ${view.amount} for 2 minutes`)
      : [order ? `Order ${order}` : summary?.detail, view.to ? shortAddress(view.to) : ''].filter(Boolean).join(' · ') || undefined
    // The app's figure, exactly as the app's sheet showed it ("$5"), only
    // when it is what the wallet read - otherwise the wallet's own figure,
    // since that is what gets signed.
    wrap.append(summaryCard(same
      ? { label, name, detail, amount: summary!.amount, unit: summary!.unit ?? unit }
      : { label, name, detail, amount: scope ? view.amount : amount, unit: scope ? '' : unit }))
    // What else the wallet read (an order, a contract, a message) - not the
    // fee, the time limit, or the extra contracts a limit names (MeshPort's
    // routers: they can't move tokens by themselves, and a raw address on
    // the passcode sheet only confused).
    // What's left: a message to sign, or a few fields of a signature the
    // wallet can't read (with its red warning) - at most MAX_ROWS.
    const rows = view.rows.filter(r => !HIDDEN_ROWS.has(r.label)).slice(0, MAX_ROWS)
    if (rows.length) { const box = el('div', 'rows'); for (const r of rows) box.append(row(r.label, r.value)); wrap.append(box) }
    for (const w of view.warnings) wrap.append(el('p', 'warn', w))
  } else if (summary) {
    wrap.append(summaryCard(summary))
  }
  return wrap
}

// The same icons as the app's own passcode pad (PinKeypad: lucide-react
// Fingerprint, or ScanFace for Face ID), drawn here - this page loads no
// library. Lucide's paths, 24 px, stroke 2.
const FINGERPRINT_PATHS = ['M2 12C2 6.5 6.5 2 12 2a10 10 0 0 1 8 4', 'M5 19.5C5.5 18 6 15 6 12c0-.7.12-1.37.34-2', 'M17.29 21.02c.12-.6.43-2.3.5-3.02', 'M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4', 'M8.65 22c.21-.66.45-1.32.57-2', 'M14 13.12c0 2.38 0 6.38-1 8.88', 'M2 16h.01', 'M21.8 16c.2-2 .131-5.354 0-6', 'M9 6.8a6 6 0 0 1 9 5.2c0 .47 0 1.17-.02 2']
const SCAN_FACE_PATHS = ['M3 7V5a2 2 0 0 1 2-2h2', 'M17 3h2a2 2 0 0 1 2 2v2', 'M21 17v2a2 2 0 0 1-2 2h-2', 'M7 21H5a2 2 0 0 1-2-2v-2', 'M8 14s1.5 2 4 2 4-2 4-2', 'M9 9h.01', 'M15 9h.01']
function fingerprintIcon(label?: string): SVGElement {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  for (const [k, v] of [['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'],
    ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']]) svg.setAttribute(k, v)
  for (const d of /face/i.test(label ?? '') ? SCAN_FACE_PATHS : FINGERPRINT_PATHS) {
    const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.append(p)
  }
  return svg
}

/** PinKeypad's delete key. */
/** The approved tick (drawn in by CSS, .approved). */
function tickIcon(): SVGElement {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  for (const [k, v] of [['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '3'],
    ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']]) svg.setAttribute(k, v)
  const path = document.createElementNS(NS, 'path'); path.setAttribute('d', 'M5 12.5l4.5 4.5L19 7.5'); path.setAttribute('pathLength', '1')
  svg.append(path)
  return svg
}

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
// Plain words, one short line (a second line would change the page's height,
// which Chrome counts as moving it). Shown when the browser says something
// covers or cuts off this page - another app drawing on top, a popup.
const HIDDEN_SAY = 'Close anything covering the screen'

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
  // `oneLine`: never wraps (cut with … if it must) - for the covered-screen
  // warning, which shows while the page must not change height.
  const sayIt = (text: string, bad = false, oneLine = false) => { say.textContent = text; say.className = (bad ? 'say error' : 'say') + (oneLine ? ' one' : '') }

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
  // The app keeps the sheet out of sight while this page gets ready, so being
  // hidden before it was ever shown is expected - said only after that.
  let everVisible = false
  const refreshVisibility = () => {
    visKnown = true
    if (hiddenTimer) { clearTimeout(hiddenTimer); hiddenTimer = null }
    if (!visible) {
      // Typed while something may have covered the page: not used.
      if (!busy && digits) { digits = '' }
      if (!busy && everVisible) hiddenTimer = setTimeout(() => { if (!visible && !busy) sayIt(HIDDEN_SAY, false, true) }, 600)
    } else {
      everVisible = true
      if (earlyTimer) { clearTimeout(earlyTimer); earlyTimer = null }
      if (say.textContent === HIDDEN_SAY) sayIt('')
      trySubmit()
      const w = bioWanted
      if (w && Date.now() < w.until && !busy) { bioWanted = null; const k = bioCell; void runFingerprint(w.biometric, k) }
    }
    paint()
  }

  channel.addEventListener('message', (e) => {
    const d = (e.data ?? {}) as { type?: string; ticket?: string; ok?: boolean; code?: string; message?: string; lockedForMs?: number }
    if (d.type !== 'checked' || !req || d.ticket !== req.ticket) return
    if (d.ok) {
      // The app first: it reads the result now instead of on its next look
      // (it still reads it from the wallet - this message only says "look").
      tellApp({ state: 'approved' })
      // A small tick over the keypad, in place: the page keeps its height,
      // so the sheet doesn't jump, and it leaves with the sheet. Nothing can
      // be typed any more.
      busy = true
      sayIt('')
      const ok = el('div', 'approved')
      ok.setAttribute('role', 'status')
      const tick = el('div', 'tick'); tick.append(tickIcon())
      ok.append(tick, el('p', undefined, 'Approved'))
      entry.classList.add('ok')
      entry.append(ok)
      paint()
      return
    }
    busy = false
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

  // Taps that land the instant the sheet appears, before the browser has
  // said this page is in view (~0.1 s): kept, not lost - but only before the
  // page was ever visible, and only if it is confirmed visible within 0.6 s of
  // the first one (else dropped). Nothing is submitted until it is.
  let earlyTimer: ReturnType<typeof setTimeout> | null = null
  const press = (digit: string) => {
    if (busy || lockedUntil > Date.now() || digits.length >= LENGTH) return
    if (visKnown && !visible) {
      if (everVisible) return
      if (!earlyTimer) earlyTimer = setTimeout(() => { earlyTimer = null; if (!visible && !busy) { digits = ''; paint() } }, 600)
    }
    digits += digit
    if (say.className.startsWith('say error')) sayIt('')
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
  // A tap while the page isn't confirmed visible yet - the sheet still sliding
  // in, the first ~0.6 s - used to do nothing at all. It now waits up to 1 s
  // for the page to be visible, then opens the prompt (the OS prompt itself
  // needs the person's finger or face); still covered, it says so.
  let bioWanted: { biometric: ConfirmBiometric; until: number } | null = null
  const runFingerprint = async (biometric: ConfirmBiometric, keyEl: HTMLElement) => {
    if (busy || lockedUntil > Date.now() || !req) return
    if (!visKnown || !visible) {
      bioWanted = { biometric, until: Date.now() + 1000 }
      setTimeout(() => { if (bioWanted && Date.now() >= bioWanted.until && !busy) { bioWanted = null; sayIt(HIDDEN_SAY, false, true) } }, 1050)
      return
    }
    bioWanted = null
    const name = biometric.label || 'Fingerprint'
    busy = true; keyEl.classList.add('trying'); paint(); sayIt(`Waiting for ${name.toLowerCase() === 'face id' ? name : name.toLowerCase()}…`)
    let passcode: string | null = null
    let cancelled = false
    try { passcode = await passcodeFromFingerprint(biometric) } catch (e) {
      // Cancelled or timed out (NotAllowedError / AbortError): a normal choice - no error, as on the lock screen.
      cancelled = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError')
    }
    busy = false; keyEl.classList.remove('trying')
    if (passcode) submit(passcode, 'biometric')
    else { sayIt(cancelled ? '' : `${name} didn't work - enter your passcode`, !cancelled); paint() }
  }
  const fingerprintKey = (biometric: ConfirmBiometric) => {
    const k = key(fingerprintIcon(biometric.label), () => { void runFingerprint(biometric, k) }, 'key bio', `Use ${biometric.label || 'fingerprint'}`, true)
    return k
  }
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
        else { busy = false; digits = ''; sayIt('Check who gets paid, then enter your passcode', true); paint() }
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

/** Opened by slot (or handed one): the keypad now, the request when the wallet has it. */
function startBySlot(ch: BroadcastChannel, slot: string, summaryRaw: string | null) {
  const page = run(ch, null, appSummaryFrom(summaryRaw))
  let done = false
  const onRequest = (e: MessageEvent) => {
    const d = e.data ?? {}
    if (d.type !== 'request' || d.slot !== slot) return
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
    ch.postMessage({ type: 'claim', slot })
    setTimeout(ask, 150)
  }
  ask()
}

let channel: BroadcastChannel | null = null
try { channel = new BroadcastChannel(CONFIRM_CHANNEL) } catch { /* below */ }
if (!channel) {
  show(el('p', 'error center', "This browser can't confirm here."))
} else if (/^[0-9a-f]{32}$/.test(slotParam)) {
  startBySlot(channel, slotParam, summaryParam)
} else if (standby) {
  // Waits, empty, for the app (only this page's own parent, from an app
  // origin) to hand it its payment: the same slot and summary the address
  // would have carried. Once only - a page is never used for two payments.
  const ch = channel
  let used = false
  window.addEventListener('message', (e: MessageEvent) => {
    if (used || e.source !== parent || parent === window || !PARENTS.includes(e.origin)) return
    const d = (e.data ?? {}) as { type?: string; slot?: unknown; s?: unknown; theme?: unknown; short?: unknown }
    if (d.type !== 'mp-confirm-assign' || typeof d.slot !== 'string' || !/^[0-9a-f]{32}$/.test(d.slot)) return
    used = true
    document.documentElement.dataset.theme = d.theme === 'light' ? 'light' : 'dark'
    if (d.short === true) document.documentElement.dataset.short = ''
    else delete document.documentElement.dataset.short
    startBySlot(ch, d.slot, typeof d.s === 'string' ? d.s : null)
  })
  tellApp({ state: 'standby' })
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
