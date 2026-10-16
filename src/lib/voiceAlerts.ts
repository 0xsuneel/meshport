// src/lib/voiceAlerts.ts
//
// Merchant voice alerts: the phone says "Received 24 dollars on MeshPort"
// for every merchant payment, like a shop soundbox but with no device.
// Uses the browser's own speech (no network). Settings are per device.

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

/** Speaks a received amount if alerts are on (or always, for a test). */
export function speakPayment(amount: number, opts: { test?: boolean } = {}) {
  if (!voiceSupported() || (!settings.enabled && !opts.test)) return
  const lang = VOICE_LANGS.find(l => l.id === settings.lang) ?? VOICE_LANGS[0]
  const text = lang.say(amount.toFixed(2).replace(/\.00$/, ''))
  try {
    const u = new SpeechSynthesisUtterance(text)
    u.lang = lang.bcp47
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(u)
  } catch { /* speech unavailable */ }
}
