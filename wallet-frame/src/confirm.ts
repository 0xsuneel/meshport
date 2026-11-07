// wallet-frame/src/confirm.ts
//
// The passcode keypad for approvals, INSIDE the wallet origin
// (docs/SECURE-APPROVALS.md). The app embeds this page as a visible iframe
// with a one-time ticket from 'confirm:open'; this page asks the hidden
// wallet frame (same origin, BroadcastChannel) what is being approved, shows
// it, takes the passcode and hands it to the frame to check. The app never
// sees the digits - only "approved" (or "cancelled") with the ticket.
//
// URL: confirm.html#t=<ticket>&theme=dark|light[&bio=1][&short=1]
// bio: the fingerprint key in the bottom-left cell (the app runs the scan).

import { CONFIRM_CHANNEL } from '@/wallet/protocol'

const params = new URLSearchParams(location.hash.slice(1))
const ticket = params.get('t') ?? ''
history.replaceState(null, '', location.pathname) // the ticket leaves the URL
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark'
const root = document.getElementById('root')!

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text // never innerHTML
  return n
}
const tell = (msg: Record<string, unknown>) => { try { parent.postMessage({ type: 'mp-confirm', ticket, ...msg }, '*') } catch { /* not embedded */ } }

// Taps count only while this page is really visible - not covered or faded by
// the page around it (IntersectionObserver v2, where the browser has it).
let visible = true
try {
  const io = new IntersectionObserver(entries => {
    const e = entries[entries.length - 1] as IntersectionObserverEntry & { isVisible?: boolean }
    if (typeof e.isVisible === 'boolean') visible = e.isVisible
  }, { threshold: [1], trackVisibility: true, delay: 100 } as IntersectionObserverInit)
  io.observe(document.body)
} catch { /* older browser: no visibility tracking */ }

function showError(message: string) {
  root.replaceChildren(el('p', 'error', message))
  tell({ drawn: true })
}

const SVG_NS = 'http://www.w3.org/2000/svg'
function icon(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  for (const [k, v] of Object.entries({ width: '22', height: '22', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(k, v)
  for (const d of paths) { const p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('d', d); svg.append(p) }
  return svg
}
const DEL_ICON = ['M21 4H8l-7 8 7 8h13a2 2 0 002-2V6a2 2 0 00-2-2z', 'M18 9l-6 6', 'M12 9l6 6']
const BIO_ICON = ['M2 12C2 6.5 6.5 2 12 2a10 10 0 0 1 8 4', 'M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2', 'M17.29 21.02c.12-.6.43-2.3.5-3.02', 'M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4', 'M8.65 22c.21-.66.45-1.32.57-2', 'M14 13.12c0 2.38 0 6.38-1 8.88', 'M2 16h.01', 'M21.8 16c.2-2 .131-5.354 0-6', 'M9 6.8a6 6 0 0 1 9 5.2c0 .47 0 1.17-.02 2']

// The keypad only: what is being paid is on the app's card right above it.
function render(channel: BroadcastChannel) {
  if (params.get('short') === '1') document.body.classList.add('short')
  const dots = el('div', 'dots')
  const dotEls = Array.from({ length: 6 }, () => el('span'))
  dots.append(...dotEls)
  const msg = el('p', 'msg', '')
  let pin = ''
  let busy = false
  const paint = () => dotEls.forEach((d, i) => d.classList.toggle('on', i < pin.length))
  const keys = el('div', 'keys')
  const press = (k: string) => {
    if (busy || !visible) return
    dots.classList.remove('bad'); msg.textContent = ''
    if (k === 'del') pin = pin.slice(0, -1)
    else if (pin.length < 6) pin += k
    paint()
    if (pin.length === 6) submit()
  }
  const bio = params.get('bio') === '1'
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'bio', '0', 'del']) {
    const b = el('button', k === 'del' ? 'del' : k === 'bio' ? (bio ? 'bio' : 'blank') : undefined)
    b.type = 'button'
    if (k === 'del') { b.append(icon(DEL_ICON)); b.setAttribute('aria-label', 'Delete') }
    else if (k === 'bio') { if (bio) { b.append(icon(BIO_ICON)); b.setAttribute('aria-label', 'Use fingerprint') } else b.tabIndex = -1 }
    else b.textContent = k
    b.onclick = () => (k === 'bio' ? (bio && !busy && visible && tell({ biometric: true })) : press(k))
    keys.append(b)
  }
  document.addEventListener('keydown', e => {
    if (/^\d$/.test(e.key)) press(e.key)
    else if (e.key === 'Backspace') press('del')
  })
  function submit() {
    busy = true
    channel.postMessage({ type: 'confirm:pin', ticket, pin })
  }
  channel.onmessage = (e) => {
    const d = e.data ?? {}
    if (d.type !== 'confirm:result' || d.ticket !== ticket) return
    busy = false
    if (d.ok) { tell({ approved: true }); return }
    dots.classList.add('bad')
    msg.textContent = d.error === 'rate-limited'
      ? `Too many tries - wait ${Math.ceil((d.lockedForMs || 30_000) / 1000)} s`
      : d.error === 'bad-passcode' ? 'Incorrect passcode. Try again.' : "Couldn't check it - try again"
    dots.classList.remove('shake'); void dots.offsetWidth; dots.classList.add('shake')
    setTimeout(() => { pin = ''; paint(); dots.classList.remove('bad') }, 450)
    tell({ wrong: true })
  }
  root.replaceChildren(dots, msg, keys)
  tell({ drawn: true })
}

if (!/^0x[0-9a-f]{32}$/.test(ticket)) {
  showError('This approval has expired. Close it and try again.')
} else {
  let channel: BroadcastChannel | null = null
  try { channel = new BroadcastChannel(CONFIRM_CHANNEL) } catch { showError("This browser can't confirm here.") }
  if (channel) {
    const timer = setTimeout(() => showError('The wallet is not open. Close this and try again.'), 5000)
    channel.onmessage = (e) => {
      const d = e.data ?? {}
      if (d.type !== 'confirm:show' || d.ticket !== ticket) return
      clearTimeout(timer)
      if (d.error || !d.display) showError('This approval has expired. Close it and try again.')
      else render(channel!)
    }
    channel.postMessage({ type: 'confirm:hello', ticket })
  }
}
