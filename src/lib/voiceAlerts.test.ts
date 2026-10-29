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
  it('joins recorded words for each part of the amount', async () => {
    const { phrasesFor } = await load()
    expect(phrasesFor(7)).toEqual(['received', 'n7', 'dollars_on'])
    expect(phrasesFor(1)).toEqual(['received', 'n1', 'dollar_on'])
    expect(phrasesFor(24.5)).toEqual(['received', 'n24', 'dollars_and', 'n50', 'cents_on'])
    expect(phrasesFor(312.05)).toEqual(['received', 'n3', 'hundred', 'n12', 'dollars_and', 'n5', 'cents_on'])
    expect(phrasesFor(1250)).toEqual(['received', 'n1', 'thousand', 'n2', 'hundred', 'n50', 'dollars_on'])
    expect(phrasesFor(1000)).toEqual(['received', 'n1', 'thousand', 'dollars_on'])
    expect(phrasesFor(99_999.99)).toEqual(['received', 'n99', 'thousand', 'n9', 'hundred', 'n99', 'dollars_and', 'n99', 'cents_on'])
    expect(phrasesFor(0.5)).toEqual(['received', 'n50', 'cents_on'])
    expect(phrasesFor(0.01)).toEqual(['received', 'n1', 'cent_on'])
  })

  it('rounds to cents', async () => {
    const { phrasesFor } = await load()
    expect(phrasesFor(24.499)).toEqual(['received', 'n24', 'dollars_and', 'n50', 'cents_on'])
    expect(phrasesFor(0.999)).toEqual(['received', 'n1', 'dollar_on'])
  })

  it('every clip it names exists', async () => {
    const { phrasesFor } = await load()
    const { readdirSync } = await import('node:fs')
    const have = new Set(readdirSync('public/voice/emma').map(f => f.replace(/\.mp3$/, '')))
    for (const amt of [0.01, 0.99, 1, 7, 19.19, 20, 99.5, 100, 101.01, 999.99, 1000, 1001, 12345.67, 99999.99]) {
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
