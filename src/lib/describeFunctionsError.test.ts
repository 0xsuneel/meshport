// src/lib/describeFunctionsError.test.ts
//
// Regression guard for a live bug report: a Swap failed with the error
// banner reading "Edge Function returned a non-2xx status code" — completely
// uninformative, and NOT what swap-intent's own response body actually said.
//
// Root cause: @supabase/functions-js's FunctionsHttpError ALWAYS carries that
// exact hardcoded message (see node_modules/@supabase/functions-js/dist/
// module/types.js) regardless of what the edge function returned in its JSON
// body. Every intent-service call site (payIntentService, bulkPayIntentService,
// swapIntentService, claimService, AutoWalletPage) did `error.message` and
// got this same useless string for every validation failure or 500,
// swallowing the real, specific reason (e.g. "walletAddress required").

import { describe, it, expect } from 'vitest'
import { FunctionsHttpError, FunctionsFetchError, FunctionsRelayError } from '@supabase/supabase-js'
import { describeFunctionsError } from './describeFunctionsError'

describe('describeFunctionsError', () => {
  it('extracts the real reason from an edge function\'s JSON error body (the actual bug)', async () => {
    const response = new Response(JSON.stringify({ success: false, error: 'walletAddress required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
    const error = new FunctionsHttpError(response)
    const message = await describeFunctionsError(error, 'fallback')
    expect(message).toBe('walletAddress required')
  })

  it('sanity check: error.message alone (the pre-fix behavior) really is the useless generic string', () => {
    const response = new Response(JSON.stringify({ success: false, error: 'walletAddress required' }), { status: 400 })
    const error = new FunctionsHttpError(response)
    expect(error.message).toBe('Edge Function returned a non-2xx status code')
  })

  it('falls back to the generic message when the body is not valid JSON', async () => {
    const response = new Response('<html>502 Bad Gateway</html>', { status: 502 })
    const error = new FunctionsHttpError(response)
    const message = await describeFunctionsError(error, 'fallback reason')
    expect(message).toBe('Edge Function returned a non-2xx status code')
  })

  it('falls back to the generic message when the JSON body has no `error` field', async () => {
    const response = new Response(JSON.stringify({ whoops: true }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    })
    const error = new FunctionsHttpError(response)
    const message = await describeFunctionsError(error, 'fallback reason')
    expect(message).toBe('Edge Function returned a non-2xx status code')
  })

  it('uses the plain error.message for a FunctionsFetchError (request never reached the function at all)', async () => {
    const error = new FunctionsFetchError({ requestId: 'abc' })
    const message = await describeFunctionsError(error, 'fallback')
    expect(message).toBe('Failed to send a request to the Edge Function')
  })

  it('uses the plain error.message for a FunctionsRelayError', async () => {
    const error = new FunctionsRelayError({ region: 'us-east-1' })
    const message = await describeFunctionsError(error, 'fallback')
    expect(message).toBe('Relay Error invoking the Edge Function')
  })

  it('falls back to the given fallback for a non-Error, non-Functions* value', async () => {
    const message = await describeFunctionsError(null, 'totally unknown failure')
    expect(message).toBe('totally unknown failure')
  })

  // Regression guard for the 2026-09-05 "could not reserve a unique nonce"
  // live report: this is a transient, self-healing condition (see
  // STALE_ATTEMPT_GRACE_MS in pay-intent/swap-intent/bulkpay-intent's
  // logic.ts), not a hard failure -- the raw message should never reach
  // the user as-is.
  it('rewrites the stale-nonce message into a friendly, retry-soon message', async () => {
    const response = new Response(
      JSON.stringify({ success: false, error: 'could not reserve a unique nonce after 5 attempts -- possible high-concurrency contention for this wallet' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
    const error = new FunctionsHttpError(response)
    const message = await describeFunctionsError(error, 'fallback')
    expect(message).toBe('Still settling your last transaction on this wallet. Try again in a few seconds.')
  })

  it('leaves an unrelated error message untouched', async () => {
    const response = new Response(JSON.stringify({ success: false, error: 'walletAddress required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
    const error = new FunctionsHttpError(response)
    const message = await describeFunctionsError(error, 'fallback')
    expect(message).toBe('walletAddress required')
  })
})
