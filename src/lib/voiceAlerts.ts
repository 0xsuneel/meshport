// src/lib/voiceAlerts.ts
//
// Merchant voice alerts: the phone plays the MeshPort chime, then says
// "Received, twenty four dollars and fifty cents, on Mesport." for every
// merchant payment, like a shop soundbox. English only. Settings are per device.
//
// The voice is our own recording (public/voice/emma2/, Kokoro v1.0 voice
// bf_emma, Apache 2.0 - scripts/gen_voice_clips.py): each alert joins a few
// short recorded phrases ("Received," + "twenty four dollars and" + "fifty
// cents, on Mesport."), whole phrases rather than single words so each keeps
// its natural rhythm, and it sounds the same on every phone - 410 small clips
// instead of one per amount. Only the phrases a payment needs are fetched,
// while the chime plays; the service worker keeps them after the first time.
// Amounts the clips don't cover ($100,000+), or a phone where they can't
// load, fall back to the device's own speech.
//
// Works across browsers by:
//  - unlocking sound on the first tap anywhere: iOS Safari and Chrome on
//    Android drop audio that no tap started, and a payment never comes from a
//    tap. After one tap on the page, later alerts play.
//  - a vibration with every alert, for phones on silent.
//  - queueing alerts one after another, so two payments arriving together
//    are both said in full.

import { useSyncExternalStore } from 'react'

type Settings = {
  enabled: boolean
  /** Buzz with every alert, for a phone on silent. */
  vibrate: boolean
  /** Payments below this only chime (0: every payment is said). */
  minAmount: number
  /** The "Payment received" card over the app (off: voice and buzz only). */
  bigCard: boolean
}
const KEY = 'meshport_voice_alerts'
const DEFAULTS: Settings = { enabled: true, vibrate: true, minAmount: 0, bigCard: true }
/** The choices offered for "Only say payments above". */
export const MIN_AMOUNTS = [0, 1, 5, 10] as const

function read(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}')
    const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
    return {
      enabled: bool(s.enabled, DEFAULTS.enabled),
      vibrate: bool(s.vibrate, DEFAULTS.vibrate),
      minAmount: typeof s.minAmount === 'number' && s.minAmount >= 0 ? s.minAmount : DEFAULTS.minAmount,
      bigCard: bool(s.bigCard, DEFAULTS.bigCard),
    }
  } catch { return DEFAULTS }
}
let settings = read()
const listeners = new Set<() => void>()

/** Whether this payment is said out loud (else it only chimes). */
export function isSpoken(amount: number): boolean {
  return settings.enabled && amount >= settings.minAmount
}

export function setVoiceAlerts(patch: Partial<Settings>) {
  settings = { ...settings, ...patch }
  try { localStorage.setItem(KEY, JSON.stringify(settings)) } catch { /* storage unavailable */ }
  listeners.forEach(l => l())
}

export function useVoiceAlerts(): Settings {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => settings)
}

export const voiceSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window

// ── Phrases ─────────────────────────────────────────────────────────────────
// A new folder for each new recording: the service worker keeps clips by URL,
// so reusing the old names would keep playing the old voice.
const VOICE_DIR = '/voice/emma2/'

/**
 * The recorded phrases that say an amount, in order, or null when the clips
 * don't cover it. Clip names (scripts/gen_voice_clips.py):
 *   received "Received,"  ·  t1-t99 "… thousand"  ·  h1-h9 "… hundred"
 *   da1-da99 "… dollars and"  ·  do1-do99 "… dollars, on Mesport."
 *   one_dollar_and / one_dollar_on (exactly $1)  ·  c1-c99 "… cents, on Mesport."
 *   dollars_and / dollars_on (after "… hundred" or "… thousand" with no tens)
 * $24.50 → received, da24, c50
 * $1,250 → received, t1, h2, do50
 */
export function phrasesFor(amount: number): string[] | null {
  const cents = Math.round(amount * 100)
  if (!Number.isFinite(cents) || cents <= 0) return null
  const dollars = Math.floor(cents / 100)
  const c = cents % 100
  if (dollars >= 100_000) return null
  const out = ['received']
  if (dollars === 1) out.push(c ? 'one_dollar_and' : 'one_dollar_on')
  else if (dollars > 0) {
    const k = Math.floor(dollars / 1000), h = Math.floor((dollars % 1000) / 100), t = dollars % 100
    if (k) out.push(`t${k}`)
    if (h) out.push(`h${h}`)
    out.push(t ? `${c ? 'da' : 'do'}${t}` : (c ? 'dollars_and' : 'dollars_on'))
  }
  if (c) out.push(`c${c}`)
  return out
}

/** Every clip in the voice folder (scripts/gen_voice_clips.py), chime included. */
export const VOICE_CLIPS: readonly string[] = (() => {
  const out = ['chime', 'received', 'dollars_and', 'dollars_on', 'one_dollar_and', 'one_dollar_on']
  for (let n = 1; n < 100; n++) out.push(`t${n}`, `da${n}`, `do${n}`, `c${n}`)
  for (let n = 1; n < 10; n++) out.push(`h${n}`)
  return out
})()

const PACK_KEY = 'meshport_voice_pack'
let packRun: Promise<void> | null = null
/**
 * Downloads the whole voice pack ahead (~4.7 MB, once per device per voice),
 * like a soundbox's language pack: the service worker keeps every clip, so a
 * payment alert never waits on the network for its words. Four at a time, in
 * the background; skipped on Data Saver. A clip that fails is simply fetched
 * again when a payment needs it.
 */
export function prefetchVoicePack(): Promise<void> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return Promise.resolve()
  try { if (localStorage.getItem(PACK_KEY) === VOICE_DIR) return Promise.resolve() } catch { /* storage unavailable */ }
  if ((navigator as unknown as { connection?: { saveData?: boolean } }).connection?.saveData) return Promise.resolve()
  if (packRun) return packRun
  packRun = (async () => {
    const todo = [...VOICE_CLIPS]
    let failed = 0
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let name = todo.shift(); name; name = todo.shift()) {
        try { const r = await fetch(`${VOICE_DIR}${name}.mp3`); if (!r.ok) failed++; else await r.arrayBuffer() } catch { failed++ }
      }
    }))
    if (!failed) { try { localStorage.setItem(PACK_KEY, VOICE_DIR) } catch { /* storage unavailable */ } }
  })().finally(() => { packRun = null })
  return packRun
}

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
const word = (n: number) => n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : '')
const ON = 'on MeshPort.'
/** One clip's words (scripts/gen_voice_clips.py), the brand written as it's spelled. */
function clipWords(name: string): string {
  const m = /^(t|h|da|do|c)(\d+)$/.exec(name)
  if (m) {
    const n = Number(m[2]), w = word(n)
    if (m[1] === 't') return `${w} thousand`
    if (m[1] === 'h') return `${w} hundred`
    if (m[1] === 'da') return `${w} dollars and`
    if (m[1] === 'do') return `${w} dollars, ${ON}`
    return `${w} ${n === 1 ? 'cent' : 'cents'}, ${ON}`
  }
  return ({
    received: 'Received,', dollars_and: 'dollars and', dollars_on: `dollars, ${ON}`,
    one_dollar_and: 'one dollar and', one_dollar_on: `one dollar, ${ON}`,
  } as Record<string, string>)[name] ?? ''
}
/**
 * The words the voice says for an amount, written out - shown on the alert
 * card ("Received, twenty four dollars and fifty cents, on MeshPort.").
 * Built from the same clip list, so it is exactly what plays.
 */
export function spokenLine(amount: number): string {
  const names = phrasesFor(amount)
  if (!names) {
    const amt = amount.toFixed(2).replace(/\.00$/, '')
    return `Received, ${amt} ${amt === '1' ? 'dollar' : 'dollars'}, ${ON}`
  }
  return names.map(clipWords).join(' ')
}

/** What the device's own speech says when the clips can't play. */
export function spokenText(amount: number) {
  const amt = amount.toFixed(2).replace(/\.00$/, '')
  return `Received ${amt} ${amt === '1' ? 'dollar' : 'dollars'} on Mesport`
}

// ── Sound unlock ────────────────────────────────────────────────────────────
let audio: AudioContext | null = null
function audioContext(): AudioContext | null {
  if (audio) return audio
  const Ctx = typeof window !== 'undefined' ? (window.AudioContext ?? (window as any).webkitAudioContext) : undefined
  if (!Ctx) return null
  try { audio = new Ctx() } catch { audio = null }
  return audio
}

let unlocked = false
function unlock() {
  // Every tap: iOS suspends the context again after a call or Siri. Only
  // resumed here - the context is made while the page is idle (below), as
  // making it inside a tap held that tap up.
  const ctx = audio
  if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => {})
  if (!ctx) return // not made yet: the next tap unlocks
  if (unlocked) return
  unlocked = true
  // Ready the chime and the most common ending before the first payment.
  if (settings.enabled) { void clip('chime'); void clip('received') }
  if (voiceSupported()) {
    try {
      // A silent utterance started by this tap lets later ones play.
      const u = new SpeechSynthesisUtterance(' ')
      u.volume = 0
      window.speechSynthesis.speak(u)
    } catch { /* speech unavailable */ }
  }
}
if (typeof window !== 'undefined') {
  const warm = () => { audioContext() }
  // Called on window itself: Safari throws when it's called detached.
  const w = window as unknown as { requestIdleCallback?: (cb: () => void) => number }
  if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(warm); else setTimeout(warm, 3000)
  const opts = { capture: true, passive: true } as const
  for (const ev of ['pointerdown', 'touchend', 'keydown'] as const) window.addEventListener(ev, unlock, opts)
  // Coming back to the tab: a context the browser suspended is woken again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && audio?.state === 'suspended') void audio.resume().catch(() => {})
  })
}

// ── Clips ───────────────────────────────────────────────────────────────────
const clips = new Map<string, Promise<AudioBuffer | null>>()
function clip(name: string): Promise<AudioBuffer | null> {
  const ctx = audioContext()
  if (!ctx) return Promise.resolve(null)
  let p = clips.get(name)
  if (!p) {
    p = fetch(`${VOICE_DIR}${name}.mp3`)
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer() })
      // Callback form: older Safari has no promise-returning decodeAudioData.
      .then(b => new Promise<AudioBuffer>((res, rej) => ctx.decodeAudioData(b, res, rej)))
      .catch(() => { clips.delete(name); return null })
    clips.set(name, p)
  }
  return p
}

const CLIP_WAIT_MS = 3000
// A short breath after "Received,", then the phrases close together (as in the approved sample).
const GAP_S = { afterReceived: 0.08, inner: 0.03 }
// When the last queued alert ends (AudioContext time), so the next one waits.
let queueEnd = 0
let queue: Promise<unknown> = Promise.resolve()

function play(ctx: AudioContext, buf: AudioBuffer, at: number) {
  const src = ctx.createBufferSource()
  src.buffer = buf
  src.connect(ctx.destination)
  src.start(at)
  return at + buf.duration
}

/** Chime + phrases through Web Audio. False when they couldn't play. */
async function playClips(names: string[]): Promise<boolean> {
  const ctx = audioContext()
  if (!ctx) return false
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
  const timeout = new Promise<null>(r => setTimeout(() => r(null), CLIP_WAIT_MS))
  const chime = await Promise.race([clip('chime'), timeout])
  const speech = Promise.race([Promise.all(names.map(clip)), timeout])
  let t = Math.max(ctx.currentTime + 0.02, queueEnd)
  if (chime) t = play(ctx, chime, t) + 0.08
  const bufs = await speech
  if (!bufs || bufs.some(b => !b)) { queueEnd = t; return false }
  // A slow fetch: start after the chime has finished, never over it.
  t = Math.max(t, ctx.currentTime + 0.02)
  bufs.forEach((b, i) => {
    t = play(ctx, b!, t)
    if (i < bufs.length - 1) t += i === 0 ? GAP_S.afterReceived : GAP_S.inner
  })
  queueEnd = t
  return true
}

// ── Device speech (fallback) ────────────────────────────────────────────────
// getVoices() is empty until the browser has loaded them (Chrome: async).
let voices: SpeechSynthesisVoice[] = []
function loadVoices() { try { voices = window.speechSynthesis.getVoices() } catch { voices = [] } }
if (voiceSupported()) {
  loadVoices()
  try { window.speechSynthesis.addEventListener('voiceschanged', loadVoices) } catch { /* old Safari */ }
}
/** A British English voice like ours, else any English one. */
function englishVoice(): SpeechSynthesisVoice | null {
  if (!voices.length) loadVoices()
  const norm = (v: SpeechSynthesisVoice) => v.lang.toLowerCase().replace('_', '-')
  return voices.find(v => norm(v) === 'en-gb') ?? voices.find(v => norm(v).startsWith('en')) ?? null
}

// Utterances are kept until they finish: Chrome can garbage-collect a
// pending one and never say it.
const speaking = new Set<SpeechSynthesisUtterance>()

function say(text: string) {
  const s = window.speechSynthesis
  const voice = englishVoice()
  const u = new SpeechSynthesisUtterance(text)
  u.lang = voice?.lang ?? 'en-GB'
  if (voice) u.voice = voice
  u.rate = 1
  u.volume = 1
  const done = () => { speaking.delete(u) }
  u.onend = done
  u.onerror = done
  speaking.add(u)
  // Chrome sometimes leaves the queue paused (after a tab switch).
  if (s.paused) s.resume()
  // Queued, not cancel() + speak(): that drops the first of two payments.
  s.speak(u)
}

/** Announces a received amount if alerts are on (or always, for a test). */
export function speakPayment(amount: number, opts: { test?: boolean } = {}) {
  if (typeof window === 'undefined' || (!settings.enabled && !opts.test)) return
  if (opts.test) unlock()
  if (settings.vibrate) { try { navigator.vibrate?.([120, 60, 120]) } catch { /* no vibration */ } }
  // Below the chosen amount: the chime alone (a test always speaks).
  if (!opts.test && amount < settings.minAmount) {
    queue = queue.then(() => playClips([])).catch(() => {})
    return
  }
  const names = phrasesFor(amount)
  // One alert is scheduled at a time, so two payments together never overlap.
  queue = queue.then(() => names ? playClips(names) : false).then(ok => {
    if (ok || !voiceSupported()) return
    try { say(spokenText(amount)) } catch { /* speech unavailable */ }
  }, () => {})
}
