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

import { REVEAL_CHANNEL, parseOrigins } from '@/wallet/protocol'

// The app origins allowed to embed this page (same list as main.ts).
const PARENTS = parseOrigins(import.meta.env.VITE_WALLET_PARENT_ORIGINS as string | undefined
  ?? (import.meta.env.DEV ? 'http://localhost:5173,http://127.0.0.1:5173' : ''))

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
// secret in it - only that something is on screen. Sent only to the app
// origins (frame-ancestors also limits who can embed this page).
function drawn() {
  requestAnimationFrame(() => {
    if (parent === window) return
    for (const origin of PARENTS) { try { parent.postMessage({ type: 'mp-reveal' }, origin) } catch { /* */ } }
  })
}

function showError(message: string) {
  root.replaceChildren(el('p', 'error', message))
  drawn()
}

function copyButton(secret: string, label: string) {
  const b = el('button', 'copy outline', label)
  b.type = 'button'
  b.onclick = async () => {
    try {
      await navigator.clipboard.writeText(secret)
      b.textContent = 'Copied'
      // Clear the clipboard after a minute. This page usually can't: as a
      // cross-origin iframe it may not read the clipboard (to check the secret
      // is still there), and may only write while it has focus - gone once
      // the person switches away to paste. So the app clears it (it's told
      // only THAT a secret was copied - lib/secretClipboard.ts), and this page
      // still tries itself in case it has focus then.
      tellApp({ type: 'mp-secret-copied' })
      setTimeout(async () => {
        let still = true
        try { still = (await navigator.clipboard.readText()) === secret } catch { /* can't read: clear anyway */ }
        if (still) { try { await navigator.clipboard.writeText('') } catch { /* no focus: the app clears it */ } }
      }, 60_000)
    } catch { b.textContent = 'Copy blocked - write it down' }
    setTimeout(() => { b.textContent = label }, 2000)
  }
  return b
}

// The round eye mark on the cover (built as DOM - no innerHTML, no images).
function eyeBadge(): HTMLElement {
  const badge = el('span', 'cover-eye')
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  for (const [k, v] of [['viewBox', '0 0 24 24'], ['width', '17'], ['height', '17'], ['fill', 'none'], ['stroke', 'currentColor'],
    ['stroke-width', '2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']]) svg.setAttribute(k, v)
  const path = document.createElementNS(NS, 'path'); path.setAttribute('d', 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z')
  const dot = document.createElementNS(NS, 'circle'); dot.setAttribute('cx', '12'); dot.setAttribute('cy', '12'); dot.setAttribute('r', '3')
  svg.append(path, dot)
  badge.append(svg)
  return badge
}

// Blurred until tapped (OKX-style), so the secret isn't on screen by
// accident when the page opens. Copy works only once it's shown.
function blurred(content: HTMLElement, copy: HTMLButtonElement, what: 'mnemonic' | 'privateKey') {
  const box = el('div', 'secret hidden')
  content.setAttribute('aria-hidden', 'true')
  const cover = el('button', 'cover')
  cover.type = 'button'
  cover.setAttribute('aria-label', what === 'mnemonic' ? 'Tap to view your recovery phrase' : 'Tap to view your private key')
  cover.append(eyeBadge(), el('span', 'cover-title', 'Tap to view'), el('span', 'cover-sub', 'Make sure nobody can see your screen'))
  copy.disabled = true
  cover.onclick = () => {
    box.classList.remove('hidden')
    content.removeAttribute('aria-hidden')
    cover.remove()
    copy.disabled = false
  }
  box.append(content, cover)
  return box
}

// ── Backup check (what = 'verify'), like Rabby / OKX ─────────────────────────
// Three word positions at random; for each, four word chips - the right word
// and other words from the same phrase - in random order. Everything happens
// in this page: the app is told only that the check passed (or the person
// gave up), never the words, so it can't learn the phrase from this.
function tellApp(msg: Record<string, unknown>) {
  if (parent === window) return
  for (const origin of PARENTS) { try { parent.postMessage(msg, origin) } catch { /* */ } }
}
function randomInt(n: number): number {
  const r = new Uint32Array(1); crypto.getRandomValues(r); return r[0] % n
}
function shuffled<T>(xs: T[]): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]] }
  return a
}
function renderQuiz(words: string[], note?: string) {
  const positions = new Set<number>()
  while (positions.size < Math.min(3, words.length)) positions.add(randomInt(words.length))
  const asked = [...positions].sort((a, b) => a - b)
  const picked = new Map<number, string>()
  const form = el('div', 'quiz')
  if (note) form.append(el('p', 'error', note))
  const confirm = el('button', 'copy', 'Confirm')
  confirm.type = 'button'
  confirm.disabled = true
  for (const pos of asked) {
    const right = words[pos]
    const others = shuffled([...new Set(words.filter(w => w !== right))]).slice(0, 3)
    const row = el('div', 'quiz-row')
    row.append(el('span', 'quiz-n', `Word #${pos + 1}`))
    const chips = el('div', 'chips')
    for (const w of shuffled([right, ...others])) {
      const b = el('button', 'chip', w)
      b.type = 'button'
      b.setAttribute('aria-pressed', 'false')
      b.onclick = () => {
        picked.set(pos, w)
        for (const c of chips.querySelectorAll('button')) c.setAttribute('aria-pressed', String(c === b))
        confirm.disabled = picked.size < asked.length
      }
      chips.append(b)
    }
    row.append(chips)
    form.append(row)
  }
  confirm.onclick = () => {
    const ok = asked.every(p => picked.get(p) === words[p])
    if (!ok) { renderQuiz(words, "That's not right. Check your written recovery phrase and try again."); return }
    root.replaceChildren(el('p', 'quiz-done', '✓ Backup checked - your recovery phrase is written down correctly.'))
    tellApp({ type: 'mp-verify', ok: true })
    drawn()
  }
  form.append(confirm)
  root.replaceChildren(form)
  drawn()
}

function render(what: 'mnemonic' | 'privateKey' | 'verify', secret: string) {
  if (what === 'verify') { renderQuiz(secret.split(' ')); return }
  if (what === 'mnemonic') {
    const grid = el('ol', 'words')
    secret.split(' ').forEach((w, i) => {
      const li = el('li')
      li.append(el('span', 'n', String(i + 1)), el('span', 'w', w))
      grid.append(li)
    })
    const copy = copyButton(secret, 'Copy phrase')
    root.replaceChildren(blurred(grid, copy, what), copy)
  } else {
    const copy = copyButton(secret, 'Copy key')
    root.replaceChildren(blurred(el('code', 'key', secret), copy, what), copy)
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
