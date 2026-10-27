// src/lib/voiceAlerts.ts
//
// Merchant voice alerts: the phone plays the MeshPort chime, then says
// "Received 24 dollars and 50 cents, on Mesport" for every merchant payment,
// like a shop soundbox. English only. Settings are per device.
//
// The voice is our own recording (public/voice/emma/, Kokoro TTS, Apache 2.0):
// each alert joins two or three whole phrases ("Received twenty four dollars"
// + "and fifty cents, on Mesport."), so it sounds the same on every phone and
// flows like a person talking. Only the phrases a payment needs are fetched,
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

type Settings = { enabled: boolean }
const KEY = 'meshport_voice_alerts'
const DEFAULTS: Settings = { enabled: true }

function read(): Settings {
  try { return { enabled: JSON.parse(localStorage.getItem(KEY) || '{}').enabled ?? DEFAULTS.enabled } } catch { return DEFAULTS }
}
let settings = read()
const listeners = new Set<() => void>()

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
const VOICE_DIR = '/voice/emma/'

/**
 * The recorded phrases that say an amount, in order, or null when the clips
 * don't cover it. Clip names: r<n> "Received n dollars", rk<k> "Received k
 * thousand", d<n> "n dollars" (d0 "dollars"), t<c> "and c cents, on Mesport."
 * (t0 "on Mesport."), rc<c> "Received c cents, on Mesport.".
 */
export function phrasesFor(amount: number): string[] | null {
  const cents = Math.round(amount * 100)
  if (!Number.isFinite(cents) || cents <= 0) return null
  const dollars = Math.floor(cents / 100)
  const c = cents % 100
  if (dollars === 0) return [`rc${c}`]
  if (dollars >= 100_000) return null
  const k = Math.floor(dollars / 1000)
  const head = k ? [`rk${k}`, `d${dollars % 1000}`] : [`r${dollars}`]
  return [...head, `t${c}`]
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
  if (settings.enabled) { void clip('chime'); void clip('t0') }
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
const GAP_S = { inner: 0.05, beforeTail: 0.1 }
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
    if (i < bufs.length - 1) t += i === bufs.length - 2 ? GAP_S.beforeTail : GAP_S.inner
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
  try { navigator.vibrate?.([120, 60, 120]) } catch { /* no vibration */ }
  const names = phrasesFor(amount)
  // One alert is scheduled at a time, so two payments together never overlap.
  queue = queue.then(() => names ? playClips(names) : false).then(ok => {
    if (ok || !voiceSupported()) return
    try { say(spokenText(amount)) } catch { /* speech unavailable */ }
  }, () => {})
}
