/**
 * Home's QR reveal at scroll progress p (0 = the card's top just reached the
 * bottom of the screen, 1 = all of it is in view). The CSS keyframes
 * (.mp-qr-* in index.css) are this same curve, for browsers that run it
 * with the scroll.
 */
export function qrRevealPose(p: number) {
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  p = clamp(p)
  // The scan runs from just above the code (-7%) to just below it (107%).
  const line = clamp((p - 0.08) / 0.92) * 1.14 - 0.07
  return {
    scale: 0.4 + 0.6 * p,
    opacity: Math.min(1, p * 6),
    line,
    printed: clamp(line),
    lineOpacity: p <= 0 ? 0 : clamp((1.06 - line) / 0.1),
  }
}
