// wallet-frame/src/reveal.ts
//
// Shows a recovery phrase or private key INSIDE the wallet origin. The app
// embeds this page as a visible iframe with a one-time ticket (from
// 'reveal:grant'); this page redeems it from the hidden wallet frame over a
// same-origin BroadcastChannel. The app's origin never receives the secret -
// it only sees this page's pixels, like any cross-origin iframe.
//
// URL: reveal.html#t=<ticket>&theme=dark|light
// The ticket rides in the fragment, which is never sent to a server.

import { REVEAL_CHANNEL } from '@/wallet/protocol'

const params = new URLSearchParams(location.hash.slice(1))
const ticket = params.get('t') ?? ''
history.replaceState(null, '', location.pathname) // drop the ticket from the URL
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark'

const root = document.getElementById('root')!

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text // never innerHTML
  return n
}

// Tells the app embedding this page that it has drawn (the secret or an
// error), so it can fade the frame in instead of showing it half-drawn. No
// secret in it - only that something is on screen. frame-ancestors limits who
// can embed this page.
function drawn() {
  requestAnimationFrame(() => { try { parent.postMessage({ type: 'mp-reveal' }, '*') } catch { /* not embedded */ } })
}

function showError(message: string) {
  root.replaceChildren(el('p', 'error', message))
  drawn()
}

function copyButton(secret: string, label: string) {
  const b = el('button', 'copy', label)
  b.type = 'button'
  b.onclick = async () => {
    try {
      await navigator.clipboard.writeText(secret)
      b.textContent = 'Copied'
      // Clear the clipboard after a minute if it still holds the secret.
      setTimeout(async () => {
        try { if ((await navigator.clipboard.readText()) === secret) await navigator.clipboard.writeText('') } catch { /* */ }
      }, 60_000)
    } catch { b.textContent = 'Copy blocked - write it down' }
    setTimeout(() => { b.textContent = label }, 2000)
  }
  return b
}

function render(what: 'mnemonic' | 'privateKey', secret: string) {
  if (what === 'mnemonic') {
    const grid = el('ol', 'words')
    secret.split(' ').forEach((w, i) => {
      const li = el('li')
      li.append(el('span', 'n', String(i + 1)), el('span', 'w', w))
      grid.append(li)
    })
    root.replaceChildren(grid, copyButton(secret, 'Copy phrase'))
  } else {
    root.replaceChildren(el('code', 'key', secret), copyButton(secret, 'Copy key'))
  }
  drawn()
}

if (!/^0x[0-9a-f]{32}$/.test(ticket)) {
  showError('This link has expired. Close it and try again.')
} else {
  let channel: BroadcastChannel | null = null
  try { channel = new BroadcastChannel(REVEAL_CHANNEL) } catch { showError("This browser can't show it here.") }
  if (channel) {
    const timer = setTimeout(() => showError('The wallet is not open. Close this and try again.'), 5000)
    channel.onmessage = (e) => {
      const d = e.data ?? {}
      if (d.type !== 'redeemed' || d.ticket !== ticket) return
      clearTimeout(timer)
      channel!.close()
      if (d.error || typeof d.secret !== 'string') showError('This link has expired. Close it and try again.')
      else render(d.what, d.secret)
    }
    channel.postMessage({ type: 'redeem', ticket })
  }
}
