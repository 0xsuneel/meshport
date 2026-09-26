// src/lib/amountFontSize.ts
//
// BUG FIX (live report): Swap/PaySend/ChatPay's amount boxes either had no
// shrink logic at all (the desktop live-typing input was a fixed font size
// no matter how many digits were typed) or only a single binary big/small
// step (the mobile tap-to-reveal display) tuned for ~2-decimal USDC/EURC
// amounts. Neither survives an 8-decimal cirBTC amount like "0.00004226"
// (10 characters) or a large integer amount -- the text overflows its
// rounded box instead of shrinking to fit.
//
// This replaces both with one graduated shrink curve, shared so all three
// features behave identically: up to ~7 characters (a typical "123.45"
// USDC/EURC amount) renders at the box's full intended size; every
// character beyond that shrinks the font a little further, down to a floor
// so it never becomes unreadably small. Never overflows -- it starts
// shrinking BEFORE the box would visually overflow, not after.

/**
 * Returns a font size (px) for `value` that keeps it inside its box no
 * matter how long it gets.
 *
 * @param value    the current amount string being typed/displayed (digits
 *                 only is fine -- a leading currency symbol rendered in its
 *                 own separate element, as all three call sites already do,
 *                 shouldn't be included here)
 * @param baseSize the font size used for a short, normal amount
 * @param minSize  the smallest this is ever allowed to shrink to (defaults
 *                 to 40% of baseSize -- always still legible)
 */
export function amountFontSize(value: string, baseSize: number, minSize: number = Math.round(baseSize * 0.4)): number {
  const len = (value || '0').length
  const COMFORTABLE_LENGTH = 7
  if (len <= COMFORTABLE_LENGTH) return baseSize
  const overBy = len - COMFORTABLE_LENGTH
  // ~5.5% smaller per character past the comfortable length -- gradual,
  // not a jarring single jump.
  const shrunk = baseSize - overBy * (baseSize * 0.055)
  return Math.max(minSize, Math.round(shrunk))
}
