// supabase/functions/_shared/trackedFeatureCorrelation.test.ts
//
// Run with: deno test supabase/functions/_shared/trackedFeatureCorrelation.test.ts
//
// findCorrelatedTrackedFeature is a thin, deliberately narrow wrapper around
// one Supabase query -- there is no separate pure/impure split to test here
// (unlike blockchain-indexer's decide.ts-style modules), so these tests mock
// only the exact fluent-builder chain the function actually calls
// (.from().select().eq().eq().in().limit().maybeSingle()), matching this
// repo's existing convention of exercising real logic against a minimal fake
// rather than a full Supabase client mock.
import { findCorrelatedTrackedFeature } from './trackedFeatureCorrelation.ts'

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed${msg ? `: ${msg}` : ''}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`)
  }
}

/** Minimal fake reproducing only the chain findCorrelatedTrackedFeature calls. */
function fakeSupabase(result: { data: unknown; error: { message: string } | null }) {
  const chain = {
    from: (_table: string) => chain,
    select: (_cols: string) => chain,
    eq: (_col: string, _val: unknown) => chain,
    in: (_col: string, _vals: unknown[]) => chain,
    limit: (_n: number) => chain,
    maybeSingle: async () => result,
  }
  return chain as any
}

Deno.test('A. a tx_hash correlated to a swap attempt returns "swap"', async () => {
  const supabase = fakeSupabase({ data: { transaction_intents: { feature: 'swap' } }, error: null })
  const result = await findCorrelatedTrackedFeature(supabase, 'arc', '0xABC123')
  assertEquals(result, 'swap')
})

Deno.test('B. a tx_hash correlated to a pay attempt returns "pay"', async () => {
  const supabase = fakeSupabase({ data: { transaction_intents: { feature: 'pay' } }, error: null })
  const result = await findCorrelatedTrackedFeature(supabase, 'arc', '0xdef456')
  assertEquals(result, 'pay')
})

Deno.test('C. array-shaped transaction_intents (join returning an array) is handled the same as a single object', () => {
  return (async () => {
    const supabase = fakeSupabase({ data: { transaction_intents: [{ feature: 'bulkpay' }] }, error: null })
    const result = await findCorrelatedTrackedFeature(supabase, 'arc', '0x789')
    assertEquals(result, 'bulkpay')
  })()
})

Deno.test('D. no matching row returns null (genuine external deposit, not correlated)', async () => {
  const supabase = fakeSupabase({ data: null, error: null })
  const result = await findCorrelatedTrackedFeature(supabase, 'arc', '0xfeed')
  assertEquals(result, null)
})

Deno.test('E. a query error fails CLOSED -- returns null (never blocks a genuine deposit, never throws)', async () => {
  const supabase = fakeSupabase({ data: null, error: { message: 'connection reset' } })
  const result = await findCorrelatedTrackedFeature(supabase, 'arc', '0xerr')
  assertEquals(result, null)
})

Deno.test('F. txHash is lowercased before querying (case-insensitive correlation)', async () => {
  let seenValue: unknown
  const chain = {
    from: (_t: string) => chain,
    select: (_c: string) => chain,
    eq: (col: string, val: unknown) => { if (col === 'tx_hash') seenValue = val; return chain },
    in: (_c: string, _v: unknown[]) => chain,
    limit: (_n: number) => chain,
    maybeSingle: async () => ({ data: null, error: null }),
  } as any
  await findCorrelatedTrackedFeature(chain, 'arc', '0xABCDEF')
  assertEquals(seenValue, '0xabcdef')
})
