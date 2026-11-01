// How long fee quotes take on real phones (Transfer, Bring, Swap). Reported to
// client_errors when slow, so a "fees take long" report is answered from
// numbers, not guesses: "[quote slow] transfer ub Base_Sepolia: 4.2 s (ok)".

export const QUOTE_SLOW_MS = 3_000

/** Times `run`; reports it when it took QUOTE_SLOW_MS or more. Returns run's result. */
export async function timeQuote<T>(what: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now()
  let outcome = 'ok'
  try {
    const out = await run()
    if (out == null) outcome = 'none'
    return out
  } catch (e) {
    outcome = `error: ${e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)}`
    throw e
  } finally {
    const ms = performance.now() - started
    if (ms >= QUOTE_SLOW_MS) {
      void import('./errorReport').then(r => r.reportClientError('rejection', new Error(
        `[quote slow] ${what}: ${(ms / 1000).toFixed(1)} s (${outcome})`,
      ))).catch(() => {})
    }
  }
}
