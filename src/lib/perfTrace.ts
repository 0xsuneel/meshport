// ── Startup and payment timings ─────────────────────────────────────────────
// Where a cold start, a resume and a payment actually spend their time, from
// real devices. performance.mark()/measure() (visible in DevTools) plus one
// compact line per page load / per payment to client_errors (reportPerf -
// its own small budget, never crowding out real errors).
//
// Only durations and outcomes - never addresses, amounts, keys, passcodes or
// tokens.

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

export type StartupMark =
  | 'shell'          // first screen painted (splash removed)
  | 'auth'           // signed-in session known (persisted store read)
  | 'provider'       // wallet provider code running (Privy loaded / wallet frame mounted)
  | 'frame'          // wallet frame answered (create / import / old Google wallets)
  | 'discovered'     // the wallet is known to its provider (Privy lists it)
  | 'signer'         // the wallet can sign
  | 'rpc'            // first Arc RPC answer
  | 'actionReady'    // signer + network: Pay / Swap can start without waiting

const startup = new Map<StartupMark, number>()

function perfMark(name: string): void {
  try { performance.mark(`mp:${name}`) } catch { /* old browser */ }
}

/** First time `name` happened since page load (later calls are ignored). */
export function markStartup(name: StartupMark): void {
  if (startup.has(name)) return
  startup.set(name, now())
  perfMark(name)
  if ((name === 'signer' || name === 'rpc') && startup.has('signer') && startup.has('rpc')) markStartup('actionReady')
  if (name === 'actionReady') scheduleStartupReport()
}

export function startupTimings(): Partial<Record<StartupMark, number>> {
  return Object.fromEntries(startup) as Partial<Record<StartupMark, number>>
}

/** A span (e.g. one payment stage): call the returned function when it ends. */
export function span(name: string): () => number {
  const start = now()
  perfMark(`${name}:start`)
  return () => {
    const ms = now() - start
    try { performance.measure(`mp:${name}`, { start, end: start + ms }) } catch { /* old browser */ }
    return ms
  }
}

const s = (ms?: number) => (ms == null ? '-' : (ms / 1000).toFixed(2))

// One line per page load: once the app is ready for a first action, or after
// 30 s whatever is known (a wallet that never opened says so).
let startupReported = false
let startupTimer: ReturnType<typeof setTimeout> | null = null
function scheduleStartupReport(): void {
  if (startupReported) return
  if (startupTimer) clearTimeout(startupTimer)
  startupTimer = setTimeout(sendStartupReport, 0)
}
export function sendStartupReport(): void {
  if (startupReported) return
  startupReported = true
  const t = startupTimings()
  let kind = 'cold'
  try { kind = sessionStorage.getItem('meshport:perf-loaded') ? 'reload' : 'cold'; sessionStorage.setItem('meshport:perf-loaded', '1') } catch { /* private mode */ }
  const parts = (['shell', 'auth', 'provider', 'frame', 'discovered', 'signer', 'rpc', 'actionReady'] as StartupMark[])
    .filter(k => t[k] != null).map(k => `${k} ${s(t[k])}`)
  void reportPerf(`[perf startup] ${kind}, since page load (s): ${parts.join(', ') || 'nothing'}${t.actionReady == null ? ' - not ready after 30 s' : ''}`)
}
if (typeof window !== 'undefined') {
  setTimeout(() => { if (!startupReported && startup.size) sendStartupReport() }, 30_000)
}

/** Resume from the background: how long until signing works again (only when it had stopped). */
export function reportResume(ms: number, outcome: string): void {
  void reportPerf(`[perf resume] wallet ready again after ${s(ms)} s (${outcome})`)
}

/** A payment's stages, in seconds: prepare (preflight), sign, broadcast → hash, confirmation. */
export function reportPayment(stages: { prepare?: number; sign?: number; broadcast?: number; confirm?: number }, outcome: string): void {
  void reportPerf(`[perf pay] prepare ${s(stages.prepare)}, sign ${s(stages.sign)}, broadcast ${s(stages.broadcast)}, confirm ${s(stages.confirm)} (${outcome})`)
}

async function reportPerf(line: string): Promise<void> {
  try { (await import('./errorReport')).reportPerf(line) } catch { /* reporting must never break the app */ }
}

/** Test hook. */
export function resetPerfTrace(): void {
  startup.clear(); startupReported = false
  if (startupTimer) clearTimeout(startupTimer)
  startupTimer = null
}
