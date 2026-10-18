// src/lib/voiceAlerts.ts
//
// Merchant voice alerts: the phone says "Received 24 dollars on MeshPort"
// for every merchant payment, like a shop soundbox but with no device.
// Uses the browser's own speech (no network). Settings are per device.
//
// Works across browsers by:
//  - unlocking sound on the first tap anywhere: iOS Safari and Chrome on
//    Android drop speech and audio that no tap started, and a payment never
//    comes from a tap. After one tap on the page, later alerts play.
//  - a short chime (Web Audio) before every alert, so browsers with no speech
//    (in-app browsers, many Firefox setups) still sound; plus a vibration.
//  - picking an installed voice for the language, and saying it in English
//    when the device has none (otherwise most browsers stay silent).
//  - queueing alerts instead of cancel() + speak(), which Chrome and Safari
//    can drop, and which said only the last of two payments arriving together.

import { useSyncExternalStore } from 'react'

export const VOICE_LANGS = [
  { id: 'en', label: 'English', bcp47: 'en-IN', say: (a: string) => `Received ${a} dollars on MeshPort` },
  { id: 'hi', label: 'हिन्दी',   bcp47: 'hi-IN', say: (a: string) => `MeshPort पर ${a} डॉलर प्राप्त हुए` },
  { id: 'kn', label: 'ಕನ್ನಡ',   bcp47: 'kn-IN', say: (a: string) => `MeshPort ನಲ್ಲಿ ${a} ಡಾಲರ್ ಸ್ವೀಕರಿಸಲಾಗಿದೆ` },
  { id: 'ta', label: 'தமிழ்',   bcp47: 'ta-IN', say: (a: string) => `MeshPort இல் ${a} டாலர் பெறப்பட்டது` },
  { id: 'te', label: 'తెలుగు',  bcp47: 'te-IN', say: (a: string) => `MeshPort లో ${a} డాలర్లు అందాయి` },
  { id: 'mr', label: 'मराठी',   bcp47: 'mr-IN', say: (a: string) => `MeshPort वर ${a} डॉलर मिळाले` },
] as const
export type VoiceLang = typeof VOICE_LANGS[number]['id']

type Settings = { enabled: boolean; lang: VoiceLang }
const KEY = 'meshport_voice_alerts'
const DEFAULTS: Settings = { enabled: true, lang: 'en' }

function read(): Settings {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') } } catch { return DEFAULTS }
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
  // Every tap: iOS suspends the context again after a call or Siri.
  const ctx = audioContext()
  if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => {})
  if (unlocked) return
  unlocked = true
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
  const opts = { capture: true, passive: true } as const
  for (const ev of ['pointerdown', 'touchend', 'keydown'] as const) window.addEventListener(ev, unlock, opts)
  // Coming back to the tab: a context the browser suspended is woken again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && audio?.state === 'suspended') void audio.resume().catch(() => {})
  })
}

/** Two rising tones, ~0.35 s - plays even where there's no speech. */
function chime() {
  const ctx = audioContext()
  if (!ctx) return
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
  try {
    const t = ctx.currentTime + 0.02
    for (const [freq, at] of [[880, 0], [1320, 0.14]] as const) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t + at)
      gain.gain.exponentialRampToValueAtTime(0.35, t + at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.2)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t + at)
      osc.stop(t + at + 0.22)
    }
  } catch { /* audio unavailable */ }
}

// ── Voices ──────────────────────────────────────────────────────────────────
// getVoices() is empty until the browser has loaded them (Chrome: async).
let voices: SpeechSynthesisVoice[] = []
function loadVoices() { try { voices = window.speechSynthesis.getVoices() } catch { voices = [] } }
if (voiceSupported()) {
  loadVoices()
  try { window.speechSynthesis.addEventListener('voiceschanged', loadVoices) } catch { /* old Safari */ }
}
function voiceFor(bcp47: string): SpeechSynthesisVoice | null {
  if (!voices.length) loadVoices()
  const want = bcp47.toLowerCase().replace('_', '-')
  const base = want.split('-')[0]
  const norm = (v: SpeechSynthesisVoice) => v.lang.toLowerCase().replace('_', '-')
  return voices.find(v => norm(v) === want)
    ?? voices.find(v => norm(v).split('-')[0] === base)
    ?? null
}

// Utterances are kept until they finish: Chrome can garbage-collect a
// pending one and never say it.
const speaking = new Set<SpeechSynthesisUtterance>()

function say(text: string, bcp47: string, voice: SpeechSynthesisVoice | null) {
  const s = window.speechSynthesis
  const u = new SpeechSynthesisUtterance(text)
  u.lang = voice?.lang ?? bcp47
  if (voice) u.voice = voice
  u.rate = 1
  u.volume = 1
  const done = () => { speaking.delete(u) }
  u.onend = done
  u.onerror = done
  speaking.add(u)
  // Chrome sometimes leaves the queue paused (after a tab switch).
  if (s.paused) s.resume()
  s.speak(u)
}

/** Announces a received amount if alerts are on (or always, for a test). */
export function speakPayment(amount: number, opts: { test?: boolean } = {}) {
  if (typeof window === 'undefined' || (!settings.enabled && !opts.test)) return
  if (opts.test) unlock()
  chime()
  try { navigator.vibrate?.([120, 60, 120]) } catch { /* no vibration */ }
  if (!voiceSupported()) return
  const amt = amount.toFixed(2).replace(/\.00$/, '')
  const lang = VOICE_LANGS.find(l => l.id === settings.lang) ?? VOICE_LANGS[0]
  const voice = voiceFor(lang.bcp47)
  // No voice for this language on the device (voices known): say it in English.
  const fallback = !voice && voices.length > 0 && lang.id !== 'en'
  const use = fallback ? VOICE_LANGS[0] : lang
  // After the chime.
  setTimeout(() => {
    try { say(use.say(amt), use.bcp47, fallback ? voiceFor(use.bcp47) : voice) } catch { /* speech unavailable */ }
  }, 400)
}
