/**
 * describeFunctionsError.ts
 *
 * BUG FIX (2026-09-05, traced from a live "Swap Failed — Edge Function
 * returned a non-2xx status code" report): every intent-service call site
 * in this codebase (payIntentService, bulkPayIntentService,
 * swapIntentService, claimService) did
 *
 *   const { data, error } = await supabase.functions.invoke(...)
 *   if (error) return { success: false, error: error.message }
 *
 * but @supabase/functions-js's FunctionsHttpError ALWAYS carries the exact
 * same hardcoded message — 'Edge Function returned a non-2xx status code'
 * (see node_modules/@supabase/functions-js/dist/module/types.js) —
 * regardless of what the edge function itself actually returned. The real,
 * specific reason (a validation failure like "walletAddress required", or
 * whatever the function's own catch block produced, e.g. pay-intent/
 * swap-intent/bulkpay-intent/claim-submit's `{ success: false, error: '...' }`
 * JSON body) is sitting unread in `error.context`, the raw fetch Response —
 * FunctionsClient.js throws immediately on `!response.ok`, before ever
 * calling `.json()` on it, so the body is still there to read. Every
 * validation failure or 500 from ANY of these edge functions was surfacing
 * to the user (and to anyone reading the console) as this same generic,
 * uninformative string, with zero information about what actually failed —
 * exactly what the swap screenshot showed. This is the shared fix: read the
 * real reason out of `error.context` when it's an HTTP error, and only fall
 * back to the SDK's generic message for the cases where there genuinely is
 * no server-side reason to read (FunctionsFetchError — request never
 * reached the function at all; FunctionsRelayError; a non-JSON body).
 */
import { FunctionsHttpError } from '@supabase/supabase-js'

// BUG FIX (2026-09-05, same live report as the reclaim-grace-period fix in
// pay-intent/swap-intent/bulkpay-intent's logic.ts): "could not reserve a
// unique nonce after 5 attempts -- possible high-concurrency contention for
// this wallet" is technically accurate but reads as a hard, permanent
// failure to a user who just fired off a Pay/Swap/BulkPay a few seconds
// after an earlier one didn't broadcast. It isn't permanent -- the server
// now reclaims that dangling reservation once it's 10s old (see
// STALE_ATTEMPT_GRACE_MS), so the very next retry a few seconds later
// normally just works. Rewritten here, in the one shared choke point all
// three call sites already funnel through, rather than three separate
// string checks in PayPage/SwapPage/BulkPayoutPage.
const STALE_NONCE_PATTERN = /could not reserve a unique nonce after \d+ attempts/i
const STALE_NONCE_FRIENDLY_MESSAGE =
  'Still settling your last transaction on this wallet. Try again in a few seconds.'

function toFriendlyMessage(raw: string): string {
  return STALE_NONCE_PATTERN.test(raw) ? STALE_NONCE_FRIENDLY_MESSAGE : raw
}

export async function describeFunctionsError(error: unknown, fallback: string): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body = await error.context.json()
      if (body && typeof body.error === 'string' && body.error) return toFriendlyMessage(body.error)
    } catch {
      // Body wasn't JSON (or the function crashed before producing one) --
      // fall through to the generic message below.
    }
  }
  return toFriendlyMessage((error as any)?.message || fallback)
}
