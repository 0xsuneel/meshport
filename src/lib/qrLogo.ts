// MeshPort logo in the middle of a QR canvas. Drawn into the canvas itself so
// Download / Share QR carry it too; errorCorrectionLevel 'H' covers the patch.
export const QR_LOGO_SRC = '/favicon.svg'

export function drawQrLogo(canvas: HTMLCanvasElement | null, done: () => void) {
  const img = new Image()
  img.onload = () => {
    const g = canvas?.getContext('2d')
    if (g && canvas) {
      const size = canvas.width * 0.22, pad = 4
      const x = (canvas.width - size) / 2, y = (canvas.height - size) / 2
      g.fillStyle = '#ffffff'
      g.beginPath(); g.roundRect(x - pad, y - pad, size + pad * 2, size + pad * 2, (size + pad * 2) * 0.24); g.fill()
      g.drawImage(img, x, y, size, size)
    }
    done()
  }
  img.onerror = () => done()
  img.src = QR_LOGO_SRC
}
