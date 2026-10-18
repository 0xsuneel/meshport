// Voice alerts: language fallback, queueing, and the silent-browser chime path.
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

describe('speakPayment', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('speaks in the chosen language with a matching voice', async () => {
    const b = fakeBrowser(['en-US', 'hi-IN'])
    const v = await load()
    v.setVoiceAlerts({ lang: 'hi' })
    v.speakPayment(24)
    vi.advanceTimersByTime(500)
    expect(b.spoken).toEqual([expect.objectContaining({ text: 'MeshPort पर 24 डॉलर प्राप्त हुए', lang: 'hi-IN' })])
  })

  it('falls back to English when the device has no voice for the language', async () => {
    const b = fakeBrowser(['en-GB'])
    const v = await load()
    v.setVoiceAlerts({ lang: 'kn' })
    v.speakPayment(5.5)
    vi.advanceTimersByTime(500)
    expect(b.spoken).toEqual([expect.objectContaining({ text: 'Received 5.50 dollars on MeshPort', lang: 'en-GB' })])
  })

  it('queues two payments instead of cutting the first off', async () => {
    const b = fakeBrowser(['en-IN'])
    const v = await load()
    v.setVoiceAlerts({ lang: 'en' })
    v.speakPayment(1)
    v.speakPayment(2)
    vi.advanceTimersByTime(500)
    expect(b.spoken.map(s => s.text)).toEqual(['Received 1 dollars on MeshPort', 'Received 2 dollars on MeshPort'])
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
