// qrLogo.ts — draws the MeshPort mark centered on an already-rendered QR
// canvas, styled to read as part of the code rather than a pasted sticker.
//
// Approved treatment (previewed and confirmed before implementing):
//   - mark size: 16% of the QR's width
//   - halo: rounded-square, white, with a thin brand-color ring around it
//   - the mark itself is clipped to a perfect circle — its source image is
//     a rounded square with its own baked-in corner radius, which looked
//     rough/mismatched against any halo shape; a circle clip is what
//     actually makes it read as one object instead of a sticker with
//     square-ish corners poking out.
//
// Callers MUST generate the QR with errorCorrectionLevel 'H' before calling
// this — covering the center removes real data modules, and level 'H'
// (~30% recovery) is what keeps the code scannable regardless.
const LOGO_SRC = '/apple-touch-icon.png'
const MARK_PCT = 0.16
const HALO_RATIO = 0.32 // white halo padding, relative to mark size
const RING_PAD = 3 // px the brand ring extends past the white halo
const CORNER_RATIO = 0.24 // rounded-square corner radius, relative to box size

let cachedLogo: Promise<HTMLImageElement | null> | null = null

function loadLogo(): Promise<HTMLImageElement | null> {
  if (!cachedLogo) {
    cachedLogo = new Promise((resolve) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => resolve(null)
      img.src = LOGO_SRC
    })
  }
  return cachedLogo
}

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/**
 * Draws the mark onto `canvas` in place. Call this AFTER QRCode.toCanvas
 * has finished rendering — it overlays on top of whatever is already
 * painted there. No-ops (leaves the QR untouched) if the logo fails to load.
 */
export async function drawQrLogo(canvas: HTMLCanvasElement): Promise<void> {
  const logo = await loadLogo()
  if (!logo) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const size = canvas.width
  const logoSize = size * MARK_PCT
  const halo = logoSize * HALO_RATIO
  const boxSize = logoSize + halo
  const cx = size / 2
  const cy = size / 2

  // Read the live theme's brand color rather than hardcoding either
  // light/dark hex — this stays correct if the token ever changes and
  // matches whichever theme is currently active.
  const brand = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() || '#0F5C57'

  ctx.save()
  drawRoundedRect(ctx, cx - boxSize / 2 - RING_PAD, cy - boxSize / 2 - RING_PAD, boxSize + RING_PAD * 2, boxSize + RING_PAD * 2, (boxSize + RING_PAD * 2) * CORNER_RATIO)
  ctx.fillStyle = brand
  ctx.fill()
  drawRoundedRect(ctx, cx - boxSize / 2, cy - boxSize / 2, boxSize, boxSize, boxSize * CORNER_RATIO)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.restore()

  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, logoSize / 2, 0, Math.PI * 2)
  ctx.closePath()
  ctx.clip()
  ctx.drawImage(logo, cx - logoSize / 2, cy - logoSize / 2, logoSize, logoSize)
  ctx.restore()
}
