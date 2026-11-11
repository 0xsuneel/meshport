// ── Scanner prewarm ─────────────────────────────────────────────────────────
// Opening the camera takes a few hundred ms on most phones. Starting it on
// the tap that opens the scanner (instead of after the scanner page has
// loaded and rendered) lets the live picture show up right away, and
// preloading the scanner's code on idle means the page itself opens at once.

// 1080p: a small or far-away QR keeps enough pixels per square to read
// (720p lost them). `ideal`, so a camera that can't gives what it has.
const CAMERA_CONSTRAINTS: MediaStreamConstraints[] = [
  { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } },
  { video: true },
]

let pending: Promise<MediaStream | null> | null = null
let expiry: ReturnType<typeof setTimeout> | null = null

/** Keep refocusing as the phone moves (a QR held close stays sharp).
 *  Cameras / browsers without focus control ignore it. */
function keepFocusing(stream: MediaStream): void {
  const track = stream.getVideoTracks()[0]
  const caps = (track?.getCapabilities?.() ?? {}) as { focusMode?: string[] }
  if (!caps.focusMode?.includes('continuous')) return
  track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => {})
}

export async function openCameraStream(): Promise<{ stream: MediaStream | null; error: unknown }> {
  let lastErr: unknown = null
  for (const c of CAMERA_CONSTRAINTS) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(c)
      try { keepFocusing(stream) } catch { /* no capabilities API */ }
      return { stream, error: null }
    }
    catch (err) { lastErr = err }
  }
  return { stream: null, error: lastErr }
}

/** Start the camera now (call from the tap that opens the scanner). */
export function prewarmCamera(): void {
  if (pending || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return
  preloadScanner()
  const p = openCameraStream().then(r => r.stream)
  pending = p
  // Nobody claimed it (navigation cancelled) - turn the camera back off.
  expiry = setTimeout(() => {
    if (pending !== p) return
    pending = null
    p.then(s => s?.getTracks().forEach(t => t.stop()))
  }, 6000)
}

/** The stream started by prewarmCamera(), if any. Each call hands it out once. */
export function takePrewarmedCamera(): Promise<MediaStream | null> | null {
  const p = pending
  pending = null
  if (expiry) { clearTimeout(expiry); expiry = null }
  return p
}

let preloaded = false
/** Fetch the scanner page's code ahead of time. */
export function preloadScanner(): void {
  if (preloaded) return
  preloaded = true
  import('@/features/scanner/ScannerPage').catch(() => { preloaded = false })
}
