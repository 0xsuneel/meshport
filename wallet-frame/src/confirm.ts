// wallet-frame/src/confirm.ts
//
// The passcode keypad for approvals, INSIDE the wallet origin
// (docs/SECURE-APPROVALS.md). The app embeds this page as a visible iframe
// with a one-time ticket from 'confirm:open'; this page asks the hidden
// wallet frame (same origin, BroadcastChannel) what is being approved, shows
// it, takes the passcode and hands it to the frame to check. The app never
// sees the digits - only "approved" (or "cancelled") with the ticket.
//
// URL: confirm.html#t=<ticket>&theme=dark|light

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

function render(display: { title: string; lines: string[] }, channel: BroadcastChannel) {
  const badge = el('div', 'badge', 'MeshPort wallet · checked here, not by the app')
  const card = el('div', 'card')
  for (const line of display.lines) card.append(el('div', 'line', line))
  const dots = el('div', 'dots')
  const dotEls = Array.from({ length: 6 }, () => el('span'))
  dots.append(...dotEls)
  const msg = el('p', 'msg', 'Enter your passcode')
  let pin = ''
  let busy = false
  const paint = () => dotEls.forEach((d, i) => d.classList.toggle('on', i < pin.length))
  const keys = el('div', 'keys')
  const press = (k: string) => {
    if (busy || !visible) return
    if (k === 'del') pin = pin.slice(0, -1)
    else if (pin.length < 6) pin += k
    paint()
    if (pin.length === 6) submit()
  }
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'cancel', '0', 'del']) {
    const b = el('button', k === 'cancel' || k === 'del' ? 'ghost' : undefined, k === 'del' ? '⌫' : k === 'cancel' ? 'Cancel' : k)
    b.type = 'button'
    b.onclick = () => (k === 'cancel' ? tell({ cancelled: true }) : press(k))
    keys.append(b)
  }
  document.addEventListener('keydown', e => {
    if (/^\d$/.test(e.key)) press(e.key)
    else if (e.key === 'Backspace') press('del')
    else if (e.key === 'Escape') tell({ cancelled: true })
  })
  function submit() {
    busy = true
    msg.className = 'msg'; msg.textContent = 'Checking…'
    channel.postMessage({ type: 'confirm:pin', ticket, pin })
  }
  channel.onmessage = (e) => {
    const d = e.data ?? {}
    if (d.type !== 'confirm:result' || d.ticket !== ticket) return
    busy = false
    pin = ''; paint()
    if (d.ok) { msg.textContent = 'Approved'; tell({ approved: true }); return }
    msg.className = 'msg error'
    msg.textContent = d.error === 'rate-limited'
      ? `Too many tries - wait ${Math.ceil((d.lockedForMs || 30_000) / 1000)} s`
      : d.error === 'bad-passcode' ? 'Wrong passcode' : "Couldn't check it - try again"
    dots.classList.remove('shake'); void dots.offsetWidth; dots.classList.add('shake')
    tell({ wrong: true })
  }
  root.replaceChildren(badge, el('h1', undefined, display.title), card, dots, msg, keys)
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
      else render(d.display, channel!)
    }
    channel.postMessage({ type: 'confirm:hello', ticket })
  }
}
