// The QR card as an image file - what Download / Share QR save: the same card
// as on screen (QrCard), always the light version so it reads anywhere and
// prints well: teal MeshPort header, who's paid, the amount (requests), the
// QR on white, what to do and the wallets that scan it.
import { drawMeshportQr, drawMark } from './qrLogo'

const TEAL = '#0F5C57'
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

export type QrCardImage = {
  data: string
  title?: string
  subtitle?: string
  /** Requests / orders: "$25.00 USDC". */
  amount?: string
  caption?: string
  tag?: string
}

/** Fits `text` into `max` px by trimming it with "…". */
function fit(g: CanvasRenderingContext2D, text: string, max: number): string {
  if (g.measureText(text).width <= max) return text
  let t = text
  while (t.length > 1 && g.measureText(t + '…').width > max) t = t.slice(0, -1)
  return t + '…'
}

export async function drawQrCardImage(o: QrCardImage): Promise<HTMLCanvasElement> {
  const W = 720, PAD = 36, CW = W - PAD * 2, HEAD = 100
  const qr = document.createElement('canvas')
  await drawMeshportQr(qr, o.data, 460, 1)
  const Q = qr.width
  // Heights of each block, top to bottom.
  const nameH = (o.title ? 50 : 0) + (o.subtitle ? 34 : 0)
  const amountH = o.amount ? 76 : 0
  const tile = Q + 40
  const H = PAD + HEAD + 34 + nameH + amountH + (nameH || amountH ? 20 : 0) + tile + 30 + 26 + 40 + 40 + 40 + PAD

  const c = document.createElement('canvas'); c.width = W; c.height = H
  const g = c.getContext('2d')
  if (!g) throw new Error('No 2D canvas')
  g.fillStyle = '#EEF3F3'; g.fillRect(0, 0, W, H)

  // Card
  g.save()
  g.shadowColor = 'rgba(0,0,0,0.10)'; g.shadowBlur = 24; g.shadowOffsetY = 6
  g.fillStyle = '#ffffff'; g.beginPath(); g.roundRect(PAD, PAD, CW, H - PAD * 2, 36); g.fill()
  g.restore()
  g.save(); g.beginPath(); g.roundRect(PAD, PAD, CW, H - PAD * 2, 36); g.clip()
  g.fillStyle = TEAL; g.fillRect(PAD, PAD, CW, HEAD)
  g.restore()

  // Header: badge, MeshPort, tag
  const by = PAD + HEAD / 2
  g.fillStyle = '#ffffff'; g.beginPath(); g.arc(PAD + 30 + 22, by, 22, 0, Math.PI * 2); g.fill()
  drawMark(g, PAD + 30 + 22 - 15, by - 15, 30, TEAL, '#ffffff')
  g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillStyle = '#ffffff'
  g.font = `800 32px ${FONT}`; g.fillText('MeshPort', PAD + 88, by + 1)
  if (o.tag) { g.textAlign = 'right'; g.globalAlpha = 0.88; g.font = `600 22px ${FONT}`; g.fillText(o.tag, PAD + CW - 30, by + 1); g.globalAlpha = 1 }

  // Who's paid, amount
  g.textAlign = 'center'; g.textBaseline = 'alphabetic'
  let y = PAD + HEAD + 34
  if (o.title) { g.fillStyle = '#111111'; g.font = `800 38px ${FONT}`; y += 38; g.fillText(fit(g, o.title, CW - 60), W / 2, y); y += 12 }
  if (o.subtitle) { g.fillStyle = '#5B6168'; g.font = `500 25px ${FONT}`; y += 30; g.fillText(fit(g, o.subtitle, CW - 60), W / 2, y); y += 4 }
  if (o.amount) { g.fillStyle = '#111111'; g.font = `800 60px ${FONT}`; y += 70; g.fillText(o.amount, W / 2, y); y += 6 }
  if (nameH || amountH) y += 20

  // QR on its white tile (a light ring marks the tile's edge)
  const tx = (W - tile) / 2
  g.strokeStyle = '#E3E8E8'; g.lineWidth = 2; g.beginPath(); g.roundRect(tx, y, tile, tile, 28); g.stroke()
  g.drawImage(qr, tx + 20, y + 20)
  y += tile + 30

  // What to do, wallets, site
  g.fillStyle = '#2B3035'; g.font = `600 26px ${FONT}`; y += 26
  g.fillText(fit(g, o.caption ?? 'Scan to pay with MeshPort or any wallet', CW - 60), W / 2, y)
  g.fillStyle = '#7A8087'; g.font = `500 21px ${FONT}`; y += 40
  g.fillText('MeshPort · MetaMask · OKX · Trust · Coinbase', W / 2, y)
  g.fillStyle = TEAL; g.font = `700 21px ${FONT}`; y += 40
  g.fillText('meshport.xyz', W / 2, y)
  return c
}

/** The card as a PNG file (Download / Share QR). */
export async function qrCardFile(o: QrCardImage, name: string): Promise<File | null> {
  const c = await drawQrCardImage(o)
  const blob: Blob | null = await new Promise(r => c.toBlob(b => r(b), 'image/png'))
  return blob ? new File([blob], name, { type: 'image/png' }) : null
}
