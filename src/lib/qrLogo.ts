// MeshPort QR (Home → My QR and Receive): drawn module by module from the QR
// matrix so every module is a whole number of device pixels (crisp and even
// on any screen), with a round MeshPort badge in the centre - a teal disc with
// the white mark and a thin white ring, sitting on the modules like a
// payment-app badge. Drawn into the canvas itself so Download / Share QR carry
// it too. errorCorrectionLevel 'H' (30%) covers the badge (~6% of the code);
// checked with a QR decoder at 120px-703px for pay links and wallet URIs.

const TEAL = '#0F5C57'

/** The MeshPort mark (public/favicon.svg geometry) as vectors, centred in a `size` box. */
function drawMark(g: CanvasRenderingContext2D, x: number, y: number, size: number) {
  // Outline of the mark in favicon.svg units (circles + stroke): x 33..164, y 40..165.
  const s = size / 132, ox = x + size / 2 - 98.5 * s, oy = y + size / 2 - 102.5 * s
  g.strokeStyle = '#ffffff'
  g.lineCap = 'round'
  g.lineWidth = 10 * s
  for (const [x2, y2] of [[62, 64], [146, 58], [150, 118], [108, 152], [54, 142]]) {
    g.beginPath(); g.moveTo(ox + 100 * s, oy + 100 * s); g.lineTo(ox + x2 * s, oy + y2 * s); g.stroke()
  }
  g.fillStyle = TEAL
  for (const [cx, cy, r] of [[62, 64, 12], [146, 58, 13], [150, 118, 9], [108, 152, 8], [54, 142, 16], [100, 100, 22]]) {
    g.beginPath(); g.arc(ox + cx * s, oy + cy * s, r * s, 0, Math.PI * 2); g.fill(); g.stroke()
  }
}

/**
 * Draws `data` as a MeshPort QR into `canvas`, shown at `cssSize` px. The
 * bitmap is cssSize × devicePixelRatio rounded down to whole pixels per module;
 * the canvas's CSS size is set to match, so nothing is resampled.
 */
export async function drawMeshportQr(canvas: HTMLCanvasElement, data: string, cssSize = 236): Promise<void> {
  const QRCode = await import('qrcode')
  const qr = QRCode.create(data, { errorCorrectionLevel: 'H' })
  const n = qr.modules.size
  const margin = 1 // the QR frame around the canvas is light too, so 1 module of quiet zone is enough
  const total = n + margin * 2
  const dpr = Math.max(1, Math.min(4, window.devicePixelRatio || 1))
  const ms = Math.max(1, Math.floor((cssSize * dpr) / total))
  const px = ms * total
  canvas.width = px
  canvas.height = px
  canvas.style.width = `${px / dpr}px`
  canvas.style.height = `${px / dpr}px`

  const g = canvas.getContext('2d')
  if (!g) throw new Error('No 2D canvas')
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, px, px)
  g.fillStyle = '#000000'
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) g.fillRect((c + margin) * ms, (r + margin) * ms, ms, ms)
    }
  }

  // Badge: white ring, teal disc, white mark - ~27% of the code across.
  const cx = (n / 2 + margin) * ms
  const rDisc = (Math.max(3, n * 0.135) - 0.35) * ms
  g.fillStyle = '#ffffff'
  g.beginPath(); g.arc(cx, cx, rDisc + ms * 0.45, 0, Math.PI * 2); g.fill()
  g.fillStyle = TEAL
  g.beginPath(); g.arc(cx, cx, rDisc, 0, Math.PI * 2); g.fill()
  const markSize = rDisc * 1.25
  drawMark(g, cx - markSize / 2, cx - markSize / 2, markSize)
}
