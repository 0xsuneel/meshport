/**
 * swapProxyErrors.ts — client-side connection-failure classification for
 * /api/swap-proxy
 *
 * A dropped connection to swap-proxy (the client's own AbortController
 * firing, or the fetch() itself throwing — e.g. Vercel killing the function
 * mid-request, see vercel.json's maxDuration) can happen AFTER the swap has
 * already broadcast on-chain: kit.swap() inside swap-proxy.js does the
 * approve/permit signature, submits the swap, then waits for confirmation —
 * several sequential steps, any of which finishing fine while just the
 * RESPONSE never makes it back doesn't mean the swap didn't happen.
 *
 * Pulled out as its own pure module (was inlined in SwapPage.tsx, silently
 * dropping the `isUncertain` flag on both branches) so it's testable without
 * dragging in the whole app's store/Supabase graph, and so the message text
 * and the flag can never drift apart again the way they did before: the
 * message already said "it may still complete... to avoid a double spend"
 * while the thrown Error carried no `isUncertain` property at all, so
 * SwapPage's executeSwap catch always treated it as a certain failure —
 * writing a false 'failed' Activity row and showing the hard "Swap Failed"
 * screen for a swap that could easily have already landed.
 *
 * Only 'swap' carries double-spend risk — 'estimate' never broadcasts
 * anything, so a dropped connection there is just a plain retry.
 */
export function classifyProxyConnectionFailure(
  action: 'estimate' | 'swap',
  err: any,
): { message: string; isUncertain: boolean } {
  const isUncertain = action === 'swap'
  if (err?.name === 'AbortError') {
    return {
      message: action === 'swap'
        ? 'The swap took too long to respond. It may still complete — check ArcScan for your wallet address before retrying, to avoid a double spend.'
        : 'Getting a quote took too long. Please try again.',
      isUncertain,
    }
  }
  return {
    message: err?.message || 'Network error — please check your connection and try again.',
    isUncertain,
  }
}
