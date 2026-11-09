import { useRef } from 'react'

/**
 * One run at a time for an async action that moves money (claim, send,
 * confirm). A `disabled={busy}` flag alone isn't enough when the handler
 * awaits something (a wallet unlock, a passcode derive) BEFORE it sets that
 * flag: a second tap in that gap starts a second run. The lock here is taken
 * synchronously on the first tap, and every later call is ignored (resolves
 * to undefined) until the first run settles - success, error or early return.
 */
export function createSingleFlight() {
  let running = false
  return <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (running) return Promise.resolve(undefined)
    running = true
    let p: Promise<T>
    try { p = fn() } catch (e) { running = false; return Promise.reject(e) }
    return p.finally(() => { running = false })
  }
}

/**
 * Per-component single-flight guard (stable across renders).
 *   const once = useSingleFlight()
 *   const handleClaim = () => once(async () => { ... })
 */
export function useSingleFlight() {
  const ref = useRef<ReturnType<typeof createSingleFlight>>()
  if (!ref.current) ref.current = createSingleFlight()
  return ref.current
}
