// src/lib/qrDecode.ts
//
// Reading QR codes from the camera / a picture.
//
// First choice: the browser's own QR reader (BarcodeDetector). On Android
// Chrome - and so in the installed app - it's Google Play services' barcode
// scanner, the same native engine payment apps use: it reads small, far,
// tilted, blurry, glare-hit and damaged codes, at the camera's full
// resolution, off the page's main thread. iPhone and desktop Windows don't
// have it; there jsQR (plain JavaScript) reads them instead.
import jsQR from 'jsqr'

type NativeDetector = { detect(source: ImageBitmapSource): Promise<Array<{ rawValue: string }>> }

let native: Promise<NativeDetector | null> | null = null

/** The browser's QR reader, or null where there is none (asked once). */
export function nativeQrDetector(): Promise<NativeDetector | null> {
  native ??= (async () => {
    try {
      const BD = (globalThis as unknown as { BarcodeDetector?: { new (o: { formats: string[] }): NativeDetector; getSupportedFormats?: () => Promise<string[]> } }).BarcodeDetector
      if (!BD) return null
      const formats = (await BD.getSupportedFormats?.()) ?? []
      return formats.includes('qr_code') ? new BD({ formats: ['qr_code'] }) : null
    } catch { return null }
  })()
  return native
}

/** The first QR's text in `source` from the native reader, or null. */
export async function detectNative(detector: NativeDetector, source: ImageBitmapSource): Promise<string | null> {
  const found = await detector.detect(source)
  return found.find(c => c.rawValue)?.rawValue ?? null
}

/**
 * jsQR on one region of `source` (the whole of it by default), drawn into
 * `ctx`'s canvas no larger than `maxDim` on its long edge.
 */
export function decodeJsqr(
  ctx: CanvasRenderingContext2D, source: CanvasImageSource, srcW: number, srcH: number,
  maxDim: number, region?: { x: number; y: number; w: number; h: number },
): string | null {
  const r = region ?? { x: 0, y: 0, w: srcW, h: srcH }
  const scale = Math.min(1, maxDim / Math.max(r.w, r.h))
  const w = Math.max(1, Math.round(r.w * scale))
  const h = Math.max(1, Math.round(r.h * scale))
  ctx.canvas.width = w
  ctx.canvas.height = h
  // After the resize (it resets these): a smooth shrink keeps a small
  // QR's squares readable.
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, r.x, r.y, r.w, r.h, 0, 0, w, h)
  const d = ctx.getImageData(0, 0, w, h)
  // Both colour passes: light-on-dark codes (dark-mode screens) too.
  return jsQR(d.data, d.width, d.height, { inversionAttempts: 'attemptBoth' })?.data || null
}

/** The square under the viewfinder: the middle of the frame, at full detail. */
export function centreSquare(srcW: number, srcH: number, share = 0.6): { x: number; y: number; w: number; h: number } {
  const side = Math.round(Math.min(srcW, srcH) * share)
  return { x: Math.round((srcW - side) / 2), y: Math.round((srcH - side) / 2), w: side, h: side }
}
