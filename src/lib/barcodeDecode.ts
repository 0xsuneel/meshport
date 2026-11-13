// src/lib/barcodeDecode.ts
//
// Reading product barcodes (EAN-13/8, UPC-A/E, Code 128/39, ITF) from the
// camera, for Business → Bill → Scan.
//
// First choice: the browser's own reader (BarcodeDetector - Google Play
// services' scanner on Android Chrome and the installed app), the same one
// the QR scanner uses (lib/qrDecode.ts). iPhone and desktop Windows don't have
// it; there ZXing (Apache 2.0, plain JavaScript) reads them, loaded only then.

type NativeDetector = { detect(source: ImageBitmapSource): Promise<Array<{ rawValue: string }>> }

const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf']

let native: Promise<NativeDetector | null> | null = null
/** The browser's barcode reader for product codes, or null where there is none. */
export function nativeBarcodeDetector(): Promise<NativeDetector | null> {
  native ??= (async () => {
    try {
      const BD = (globalThis as unknown as { BarcodeDetector?: { new (o: { formats: string[] }): NativeDetector; getSupportedFormats?: () => Promise<string[]> } }).BarcodeDetector
      if (!BD) return null
      const have = (await BD.getSupportedFormats?.()) ?? []
      const formats = NATIVE_FORMATS.filter(f => have.includes(f))
      return formats.length ? new BD({ formats }) : null
    } catch { return null }
  })()
  return native
}

export async function detectNativeBarcode(d: NativeDetector, source: ImageBitmapSource): Promise<string | null> {
  const found = await d.detect(source)
  return found.find(c => c.rawValue)?.rawValue ?? null
}

type Zxing = { decode(lum: Uint8ClampedArray, w: number, h: number): string | null }
let zxing: Promise<Zxing> | null = null
/** ZXing's 1D/2D reader, loaded on first use (only where there is no native reader). */
export function zxingReader(): Promise<Zxing> {
  zxing ??= import('@zxing/library').then(z => {
    const hints = new Map()
    hints.set(z.DecodeHintType.POSSIBLE_FORMATS, [
      z.BarcodeFormat.EAN_13, z.BarcodeFormat.EAN_8, z.BarcodeFormat.UPC_A, z.BarcodeFormat.UPC_E,
      z.BarcodeFormat.CODE_128, z.BarcodeFormat.CODE_39, z.BarcodeFormat.ITF,
    ])
    hints.set(z.DecodeHintType.TRY_HARDER, true)
    const reader = new z.MultiFormatReader()
    reader.setHints(hints)
    return {
      decode(lum, w, h) {
        try {
          const bmp = new z.BinaryBitmap(new z.HybridBinarizer(new z.RGBLuminanceSource(lum, w, h)))
          return reader.decodeWithState(bmp).getText() || null
        } catch { return null } finally { reader.reset() }
      },
    }
  })
  return zxing
}

/** Grey levels of an RGBA frame (what ZXing reads). */
export function luminance(rgba: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length / 4)
  for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000
  return out
}

/** The band under the viewfinder: a barcode is wide, so a wide strip in the middle. */
export function centreStrip(w: number, h: number): { x: number; y: number; w: number; h: number } {
  const sw = Math.round(w * 0.86), sh = Math.round(Math.min(h * 0.42, sw * 0.6))
  return { x: Math.round((w - sw) / 2), y: Math.round((h - sh) / 2), w: sw, h: sh }
}
