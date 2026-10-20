// MeshPort QR - every QR in the app (Home, Receive, requests, bills, Shop QR,
// the order list, the counter sticker): drawn module by module from the QR
// matrix so every module is a whole number of device pixels (crisp and even
// on any screen). Like payment apps' codes it stays black square modules on
// white, so any wallet's scanner reads it; the brand is in the three corner
// "eyes" (teal, rounded) and the MeshPort mark in a teal ring on a cleared
// centre. Drawn into the canvas itself so Download / Share QR carry it too.
// errorCorrectionLevel 'H' (30%) covers the cleared centre (~7% of the code);
// checked with a QR decoder at 120px-703px for pay links and wallet URIs.

const TEAL = '#0F5C57'

/** The MeshPort mark (public/favicon.svg geometry) as vectors, centred in a
 *  `size` box: `color` lines and dots, the dots filled with `bg`. */
function drawMark(g: CanvasRenderingContext2D, x: number, y: number, size: number, color = '#ffffff', bg = TEAL) {
  // Outline of the mark in favicon.svg units (circles + stroke): x 33..164, y 40..165.
  const s = size / 132, ox = x + size / 2 - 98.5 * s, oy = y + size / 2 - 102.5 * s
  g.strokeStyle = color
  g.lineCap = 'round'
  g.lineWidth = 10 * s
  for (const [x2, y2] of [[62, 64], [146, 58], [150, 118], [108, 152], [54, 142]]) {
    g.beginPath(); g.moveTo(ox + 100 * s, oy + 100 * s); g.lineTo(ox + x2 * s, oy + y2 * s); g.stroke()
  }
  g.fillStyle = bg
  for (const [cx, cy, r] of [[62, 64, 12], [146, 58, 13], [150, 118, 9], [108, 152, 8], [54, 142, 16], [100, 100, 22]]) {
    g.beginPath(); g.arc(ox + cx * s, oy + cy * s, r * s, 0, Math.PI * 2); g.fill(); g.stroke()
  }
}

/** The MeshPort mark on a disc (`fg` lines on `bg`) - for headers beside the QR. */
export { drawMark }

export function drawMeshportBadge(canvas: HTMLCanvasElement, cssSize: number, bg = '#ffffff', fg = TEAL) {
  const dpr = Math.max(1, Math.min(4, window.devicePixelRatio || 1))
  const px = Math.round(cssSize * dpr)
  canvas.width = px; canvas.height = px
  canvas.style.width = `${cssSize}px`; canvas.style.height = `${cssSize}px`
  const g = canvas.getContext('2d')
  if (!g) return
  g.fillStyle = bg
  g.beginPath(); g.arc(px / 2, px / 2, px / 2, 0, Math.PI * 2); g.fill()
  drawMark(g, px * 0.15, px * 0.15, px * 0.7, fg, bg)
}

const roundRect = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  g.beginPath(); g.roundRect(x, y, w, h, r); g.fill()
}

/**
 * Draws `data` as a MeshPort QR into `canvas`, shown at `cssSize` px. The
 * bitmap is cssSize × devicePixelRatio rounded down to whole pixels per module;
 * the canvas's CSS size is set to match, so nothing is resampled.
 */
export async function drawMeshportQr(canvas: HTMLCanvasElement, data: string, cssSize = 236, pixelRatio?: number): Promise<void> {
  const QRCode = await import('qrcode')
  const qr = QRCode.create(data, { errorCorrectionLevel: 'H' })
  const n = qr.modules.size
  const margin = 1 // the QR frame around the canvas is light too, so 1 module of quiet zone is enough
  const total = n + margin * 2
  // pixelRatio: an image file's own scale (1 = cssSize pixels), not the screen's.
  const dpr = pixelRatio ?? Math.max(1, Math.min(4, window.devicePixelRatio || 1))
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

  // The corner eyes are drawn on their own (below); the centre is cleared
  // for the mark.
  const isEye = (r: number, c: number) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7)
  const ctr = n / 2
  const rMark = Math.max(3, n * 0.135) - 0.35
  const rClear = rMark + 0.95
  g.fillStyle = '#000000'
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.modules.get(r, c) || isEye(r, c) || Math.hypot(r + 0.5 - ctr, c + 0.5 - ctr) < rClear) continue
      g.fillRect((c + margin) * ms, (r + margin) * ms, ms, ms)
    }
  }

  // Eyes: a teal rounded ring around a black rounded centre.
  for (const [er, ec] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    const x = (ec + margin) * ms, y = (er + margin) * ms, S = 7 * ms
    g.fillStyle = TEAL; roundRect(g, x, y, S, S, ms * 2)
    g.fillStyle = '#ffffff'; roundRect(g, x + ms, y + ms, S - 2 * ms, S - 2 * ms, ms * 1.3)
    g.fillStyle = '#000000'; roundRect(g, x + 2 * ms, y + 2 * ms, 3 * ms, 3 * ms, ms)
  }

  // Centre: the teal mark in a teal ring.
  const cx = (ctr + margin) * ms
  const rDisc = rMark * ms
  g.strokeStyle = TEAL
  g.lineWidth = ms * 0.5
  g.beginPath(); g.arc(cx, cx, rDisc, 0, Math.PI * 2); g.stroke()
  const markSize = rDisc * 1.2
  drawMark(g, cx - markSize / 2, cx - markSize / 2, markSize, TEAL, '#ffffff')
}
