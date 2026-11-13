// Product barcodes read back from a barcode drawn to the EAN-13 standard,
// the way the scanner reads a camera frame on phones without a native reader.
import { describe, it, expect } from 'vitest'
import { zxingReader, luminance, centreStrip } from './barcodeDecode'
import { cleanBarcode, itemForBarcode } from './businessItems'

// EAN-13 drawn from the standard: start 101, six left digits (L/G sets by
// the first digit), centre 01010, six right digits (R set), end 101.
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011']
const R = L.map(c => [...c].map(b => (b === '1' ? '0' : '1')).join(''))
const G = R.map(c => [...c].reverse().join(''))
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL']
function ean13Bits(code: string): string {
  const d = [...code].map(Number)
  const left = d.slice(1, 7).map((n, i) => (PARITY[d[0]][i] === 'L' ? L : G)[n]).join('')
  const right = d.slice(7).map(n => R[n]).join('')
  return '101' + left + '01010' + right + '101'
}
/** An RGBA frame: the bars `px` pixels per module, a quiet zone each side. */
function frame(bits: string, px = 3, h = 120) {
  const quiet = 12, W = (bits.length + quiet * 2) * px
  const out = new Uint8ClampedArray(W * h * 4).fill(255)
  for (let y = 0; y < h; y++) for (let x = 0; x < W; x++) {
    const m = Math.floor(x / px) - quiet
    if (m >= 0 && m < bits.length && bits[m] === '1') { const i = (y * W + x) * 4; out[i] = out[i + 1] = out[i + 2] = 0 }
  }
  return { px: out, W, H: h }
}

describe('zxingReader', () => {
  it('reads an EAN-13 product barcode', async () => {
    const z = await zxingReader()
    for (const code of ['5901234123457', '8901030865275', '4006381333931']) {
      const { px, W, H } = frame(ean13Bits(code))
      expect(z.decode(luminance(px), W, H)).toBe(code)
    }
  })

  it('a wrong check digit is refused, not misread', async () => {
    const z = await zxingReader()
    const { px, W, H } = frame(ean13Bits('8901030865278'))
    expect(z.decode(luminance(px), W, H)).toBeNull()
  })

  it('a blank frame reads nothing (no throw)', async () => {
    const z = await zxingReader()
    expect(z.decode(new Uint8ClampedArray(200 * 80).fill(255), 200, 80)).toBeNull()
  })
})

describe('helpers', () => {
  it('centreStrip is a wide band in the middle of the frame', () => {
    const r = centreStrip(1280, 720)
    expect(r.w).toBeGreaterThan(r.h)
    expect(Math.abs(r.x + r.w / 2 - 640)).toBeLessThanOrEqual(1)
    expect(Math.abs(r.y + r.h / 2 - 360)).toBeLessThanOrEqual(1)
  })

  it('cleanBarcode keeps product codes, refuses anything else', () => {
    expect(cleanBarcode(' 8901234567890 ')).toBe('8901234567890')
    expect(cleanBarcode('SKU-2041')).toBe('SKU-2041')
    expect(cleanBarcode('ab')).toBeNull()
    expect(cleanBarcode('https://evil.example/?x=<script>')).toBeNull()
    expect(cleanBarcode('9'.repeat(65))).toBeNull()
  })

  it('itemForBarcode finds the saved product with that code', () => {
    const items = [{ id: '1', name: 'Milk', price: 1.4, barcode: '890' + '1234567890' }, { id: '2', name: 'Tea', price: 2, barcode: null }]
    expect(itemForBarcode(items, '8901234567890')?.name).toBe('Milk')
    expect(itemForBarcode(items, '000')).toBeNull()
  })
})
