// Crashes on people's devices (the "Something went wrong" screen and uncaught
// errors) are saved to client_errors, so they can be diagnosed without asking
// for a screenshot. Each distinct error once per session, at most a few per
// session; a stale build (handled by its own reload) and offline failures are
// skipped. Never throws.
import { supabase } from './supabase'
import { isChunkLoadError } from './lazyRetry'

type Kind = 'route' | 'uncaught' | 'rejection'
// Real failures get their own budget. Routine timing lines ("[privy
// timeline]", "slow: …", "[transfer stage]", "[quote slow]") used to share a
// budget of 5 with them, and a phone that said it was offline sent nothing:
// field 1 Nov 06:34, a Transfer failed with "Your wallet didn't open" and its
// own "[transfer no signer]" report never arrived - the cause couldn't be read.
const MAX_PER_SESSION = 20
const sent = new Set<string>()
const ROUTINE = /^\[(privy timeline|privy warm-up\] slow|privy heartbeat\] slow|privy [a-zA-Z]+\] slow|transfer stage|quote slow|perf )/

const build = () => {
  try {
    if (typeof __MP_BUILD__ === 'string' && __MP_BUILD__) return __MP_BUILD__.slice(0, 80)
  } catch { /* not defined in tests */ }
  try {
    const src = document.querySelector('script[type="module"][src*="/assets/index-"]')?.getAttribute('src') ?? ''
    return src.split('/').pop()?.slice(0, 80) ?? ''
  } catch { return '' }
}

type Row = { kind: Kind; path: string; message: string; stack: string; user_agent: string; build: string }
// Written while the phone says it's offline (or the write fails): kept and
// sent when the connection is back, not dropped.
const pending: Row[] = []
let flushHooked = false
function insert(row: Row): void {
  void supabase.from('client_errors').insert(row).then(
    (r: { error?: unknown } | null) => { if (r && (r as any).error) hold(row) },
    () => hold(row),
  )
}
function hold(row: Row): void {
  if (pending.length < 20) pending.push(row)
  if (flushHooked || typeof window === 'undefined') return
  flushHooked = true
  window.addEventListener('online', () => { for (const r of pending.splice(0)) insert(r) })
}

export function reportClientError(kind: Kind, error: unknown): void {
  try {
    if (isChunkLoadError(error)) return
    const e = error as { message?: string; stack?: string; status?: number; statusText?: string } | null
    const message = (e?.status ? `${e.status} ${e.statusText ?? ''} ` : '') + (e?.message ?? String(error))
    // Routine lines use the timings budget below - never a failure's.
    if (ROUTINE.test(message)) { reportPerf(message); return }
    const key = `${kind}:${message}`
    if (sent.has(key) || sent.size >= MAX_PER_SESSION) return
    sent.add(key)
    const row: Row = {
      kind,
      path: window.location.pathname.slice(0, 300),
      message: message.slice(0, 1000),
      stack: (e?.stack ?? '').slice(0, 4000),
      user_agent: navigator.userAgent.slice(0, 400),
      build: build(),
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) hold(row)
    else insert(row)
  } catch { /* reporting must never break the app */ }
}

// Timings (lib/perfTrace.ts): their own small budget, so they never use up
// the one real errors get. Same table, a "[perf …]" message.
const MAX_PERF_PER_SESSION = 30 // startup, payments, and the routine Privy / transfer / quote lines
let perfSent = 0
export function reportPerf(line: string): void {
  try {
    if (perfSent >= MAX_PERF_PER_SESSION || (typeof navigator !== 'undefined' && navigator.onLine === false)) return
    perfSent++
    void supabase.from('client_errors').insert({
      kind: 'rejection',
      path: window.location.pathname.slice(0, 300),
      message: line.slice(0, 1000),
      stack: '',
      user_agent: navigator.userAgent.slice(0, 400),
      build: build(),
    }).then(() => {}, () => {})
  } catch { /* reporting must never break the app */ }
}
