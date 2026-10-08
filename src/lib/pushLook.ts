// Dim and edge shadow for the page-push slide (PageTransition, ScreenPush),
// read from the theme (--push-dim / --push-shadow in index.css) so light
// pages don't turn grey under a dark-theme dim.
export function pushLook(): { dim: number; shadow: string } {
  const css = getComputedStyle(document.documentElement)
  const dim = parseFloat(css.getPropertyValue('--push-dim'))
  const shadow = css.getPropertyValue('--push-shadow').trim()
  return { dim: Number.isFinite(dim) ? dim : 0.22, shadow: shadow || '-10px 0 28px rgba(0,0,0,0.28)' }
}
