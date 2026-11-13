// Voice alerts: which recorded phrases say an amount, and the device-speech
// fallback when the clips can't play.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type Spoken = { text: string; lang: string; voice: unknown; volume: number }

function fakeBrowser(voiceLangs: string[], opts: { speech?: boolean } = {}) {
  const spoken: Spoken[] = []
  const cancel = vi.fn()
  const vibrate = vi.fn()
  const voices = voiceLangs.map(lang => ({ lang, name: lang }))
  class Utterance { text: string; lang = ''; voice: unknown = null; volume = 1; rate = 1; onend: any; onerror: any
    constructor(t: string) { this.text = t } }
  const synth = {
    paused: false, resume: vi.fn(), cancel, getVoices: () => voices, addEventListener: vi.fn(),
    speak: (u: Utterance) => { spoken.push({ text: u.text, lang: u.lang, voice: u.voice, volume: u.volume }) },
  }
  // No AudioContext: the clips can't play, so the device speaks instead.
  const win: any = { addEventListener: vi.fn() }
  if (opts.speech !== false) win.speechSynthesis = synth
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', { addEventListener: vi.fn(), visibilityState: 'visible' })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
  vi.stubGlobal('navigator', { vibrate })
  vi.stubGlobal('SpeechSynthesisUtterance', Utterance)
  return { spoken, cancel, vibrate, win }
}

async function load() {
  vi.resetModules()
  return import('./voiceAlerts')
}

describe('phrasesFor', () => {
  it('joins recorded phrases for each part of the amount', async () => {
    const { phrasesFor } = await load()
    expect(phrasesFor(7)).toEqual(['received', 'do7'])
    expect(phrasesFor(1)).toEqual(['received', 'one_dollar_on'])
    expect(phrasesFor(1.25)).toEqual(['received', 'one_dollar_and', 'c25'])
    expect(phrasesFor(24.5)).toEqual(['received', 'da24', 'c50'])
    expect(phrasesFor(312.05)).toEqual(['received', 'h3', 'da12', 'c5'])
    expect(phrasesFor(1250)).toEqual(['received', 't1', 'h2', 'do50'])
    expect(phrasesFor(1000)).toEqual(['received', 't1', 'dollars_on'])
    expect(phrasesFor(1200.4)).toEqual(['received', 't1', 'h2', 'dollars_and', 'c40'])
    expect(phrasesFor(1001)).toEqual(['received', 't1', 'do1'])
    expect(phrasesFor(99_999.99)).toEqual(['received', 't99', 'h9', 'da99', 'c99'])
    expect(phrasesFor(0.5)).toEqual(['received', 'c50'])
    expect(phrasesFor(0.01)).toEqual(['received', 'c1'])
  })

  it('rounds to cents', async () => {
    const { phrasesFor } = await load()
    expect(phrasesFor(24.499)).toEqual(['received', 'da24', 'c50'])
    expect(phrasesFor(0.999)).toEqual(['received', 'one_dollar_on'])
  })

  it('every clip it names exists', async () => {
    const { phrasesFor } = await load()
    const { readdirSync } = await import('node:fs')
    const have = new Set(readdirSync('public/voice/emma2').map(f => f.replace(/\.mp3$/, '')))
    expect(have.has('chime')).toBe(true)
    for (let cents = 1; cents < 10_000_000; cents += 997) {
      for (const name of phrasesFor(cents / 100)!) expect(have.has(name), name).toBe(true)
    }
    for (const amt of [0.01, 0.99, 1, 1.01, 7, 20, 100, 101.01, 1000, 1001, 1200, 12345.67, 99999.99]) {
      for (const name of phrasesFor(amt)!) expect(have.has(name), name).toBe(true)
    }
  })

  it('leaves amounts the clips do not cover to device speech', async () => {
    const { phrasesFor } = await load()
    expect(phrasesFor(100_000)).toBeNull()
    expect(phrasesFor(0)).toBeNull()
    expect(phrasesFor(Number.NaN)).toBeNull()
  })
})

describe('speakPayment', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  beforeEach(() => { vi.useRealTimers() })
  const flush = () => new Promise(r => setTimeout(r, 0))

  it('falls back to an English device voice, preferring British', async () => {
    const b = fakeBrowser(['en-US', 'en-GB', 'hi-IN'])
    const v = await load()
    v.speakPayment(5.5)
    await flush()
    expect(b.spoken).toEqual([expect.objectContaining({ text: 'Received 5.50 dollars on Mesport', lang: 'en-GB' })])
  })

  it('queues two payments instead of cutting the first off', async () => {
    const b = fakeBrowser(['en-IN'])
    const v = await load()
    v.speakPayment(1)
    v.speakPayment(2)
    await flush()
    expect(b.spoken.map(s => s.text)).toEqual(['Received 1 dollar on Mesport', 'Received 2 dollars on Mesport'])
    expect(b.cancel).not.toHaveBeenCalled()
  })

  it('still vibrates where there is no speech, and stays quiet when off', async () => {
    const b = fakeBrowser([], { speech: false })
    const v = await load()
    v.setVoiceAlerts({ enabled: true })
    v.speakPayment(3)
    expect(b.vibrate).toHaveBeenCalledTimes(1)
    v.setVoiceAlerts({ enabled: false })
    v.speakPayment(3)
    expect(b.vibrate).toHaveBeenCalledTimes(1)
  })

  it('listens for the first tap to unlock sound', async () => {
    const b = fakeBrowser(['en-IN'])
    await load()
    const events = b.win.addEventListener.mock.calls.map((c: unknown[]) => c[0])
    expect(events).toEqual(expect.arrayContaining(['pointerdown', 'touchend', 'keydown']))
  })
})
