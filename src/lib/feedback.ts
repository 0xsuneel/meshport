// Small touch + sound cues, like PhonePe / Google Pay.
// Every call is best-effort: phones or browsers without vibration or audio
// simply do nothing, and nothing here can ever throw into app logic.

function buzz(pattern: number | number[]) {
  try { navigator.vibrate?.(pattern) } catch { /* not supported */ }
}

/** A light tick — long-press, swipe-to-reply threshold. */
export function hapticTap() { buzz(12) }

/** Wrong PIN / failed action — two short knocks. */
export function hapticError() { buzz([35, 45, 35]) }

let ctx: AudioContext | null = null
function audio(): AudioContext | null {
  try {
    if (!ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return null
      ctx = new AC()
    }
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch { return null }
}

/**
 * "MeshPort chime" — the payment-success sound: three soft plucked notes
 * rising quickly (G5 → B5 → E6) and landing on a warm ring. Made on the fly
 * (no audio file to download), dry — no echo — through a gentle compressor.
 */
function pluck(ac: AudioContext, dst: AudioNode, freq: number, at: number, ring: number, bright: number) {
  const t = ac.currentTime + at
  const partials: Array<[number, number, number]> = [
    [1, 1, ring],
    [2, 0.6 * bright, ring * 0.45],
    [3.01, bright, ring * 0.18],
    [5.4, bright * 0.5, 0.05],
  ]
  for (const [mult, amp, decay] of partials) {
    const osc = ac.createOscillator()
    const g = ac.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(freq * mult * 1.012, t)
    osc.frequency.exponentialRampToValueAtTime(freq * mult, t + 0.03)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(amp, t + 0.004)
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay)
    osc.connect(g)
    g.connect(dst)
    osc.start(t)
    osc.stop(t + decay + 0.05)
  }
}

function ding() {
  const ac = audio()
  if (!ac) return
  try {
    const comp = ac.createDynamicsCompressor()
    comp.threshold.value = -16
    comp.ratio.value = 3
    comp.attack.value = 0.002
    comp.release.value = 0.15
    comp.connect(ac.destination)
    const out = ac.createGain()
    out.gain.value = 0.3
    out.connect(comp)
    pluck(ac, out, 784, 0, 0.35, 0.35)
    pluck(ac, out, 988, 0.085, 0.35, 0.35)
    pluck(ac, out, 1318.5, 0.17, 1.1, 0.45)
  } catch { /* audio blocked — stay silent */ }
}

let lastSuccess = 0
/** Payment success: ding + a short happy buzz. Guarded against double-firing. */
export function successFeedback() {
  const t = Date.now()
  if (t - lastSuccess < 1500) return
  lastSuccess = t
  ding()
  buzz([18, 60, 28])
}

// Browsers only allow sound after the person has touched the page. Unlock the
// audio engine on the first touch so the success ding can play later.
if (typeof window !== 'undefined') {
  const unlock = () => { audio(); window.removeEventListener('pointerdown', unlock, true) }
  window.addEventListener('pointerdown', unlock, true)
}
