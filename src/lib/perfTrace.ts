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
  | 'provider'       // wallet provider code running (Circle SDK loaded / wallet frame mounted)
  | 'frameLoaded'    // the wallet frame's page finished loading (iframe load event - also fires for an error page)
  | 'frame'          // wallet frame answered (create / import / old Google wallets)
  | 'discovered'     // the wallet is known to its provider (Circle session found)
  | 'signer'         // the wallet can sign
  | 'rpcSent'        // first Arc RPC request sent (rpc minus this = network time; this itself = app scheduling)
  | 'rpc'            // first Arc RPC answer
  | 'actionReady'    // signer + network: Pay / Swap can start without waiting

const startup = new Map<StartupMark, number>()
// Short facts about this page load that aren't times (e.g. how the first
// direct Arc read ended, how many times the wallet frame was reloaded).
const startupDetail = new Map<string, string>()

function perfMark(name: string): void {
  try { performance.mark(`mp:${name}`) } catch { /* old browser */ }
}

/** First time `name` happened since page load (later calls are ignored). */
export function markStartup(name: StartupMark, at: number = now()): void {
  if (startup.has(name)) return
  startup.set(name, at)
  perfMark(name)
  if ((name === 'signer' || name === 'rpc') && startup.has('signer') && startup.has('rpc')) markStartup('actionReady')
  if (name === 'actionReady') scheduleStartupReport()
}

/** `now()` on the same clock as the marks - for a caller that records a mark later (after a lazy import). */
export const perfNow = now

/** A non-time fact about this page load; the first value per key is kept, unless `overwrite`. */
export function noteStartupDetail(key: string, value: string, overwrite = false): void {
  if (!overwrite && startupDetail.has(key)) return
  startupDetail.set(key, value.replace(/[^\w .:/-]/g, '').slice(0, 40))
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
  const parts = (['shell', 'auth', 'provider', 'frameLoaded', 'frame', 'discovered', 'signer', 'rpcSent', 'rpc', 'actionReady'] as StartupMark[])
    .filter(k => t[k] != null).map(k => `${k} ${s(t[k])}`)
  const facts = [...startupDetail].map(([k, v]) => `${k}=${v}`).join(' ')
  void reportPerf(`[perf startup] ${kind}, since page load (s): ${parts.join(', ') || 'nothing'}${t.actionReady == null ? ' - not ready after 30 s' : ''}${facts ? ` [${facts}]` : ''}`)
  void import('./walletEvents').then(m => m.logWalletEvent({
    event: 'startup', ok: t.signer != null, ms: t.signer ?? t.actionReady, steps: t as Record<string, number>, detail: `${kind} ${pageLoadInfo()}${facts ? ` ${facts}` : ''}`,
    error: t.signer == null ? 'wallet not able to sign 30 s after page load' : undefined,
  })).catch(() => {})
}
if (typeof window !== 'undefined') {
  setTimeout(() => { if (!startupReported && startup.size) sendStartupReport() }, 30_000)
}

// Which page load this is, for wallet_events: the browser's own navigation
// type (navigate / reload / back_forward), whether Chrome had unloaded the tab
// to save memory and is loading it again (wasDiscarded), installed app vs a
// browser tab, and an id for this page (two rows with different ids at the
// same moment are two tabs, not one page reloading).
const PAGE_ID = Math.random().toString(36).slice(2, 8)
export function pageLoadInfo(): string {
  try {
    const nav = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type ?? '?'
    const discarded = (document as Document & { wasDiscarded?: boolean }).wasDiscarded === true
    const standalone = typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches
    return `nav=${nav} discarded=${discarded} ${standalone ? 'app' : 'tab'} page=${PAGE_ID}`
  } catch { return `page=${PAGE_ID}` }
}

/** Resume from the background: how long until signing works again (only when it had stopped). */
export function reportResume(ms: number, outcome: string): void {
  void reportPerf(`[perf resume] wallet ready again after ${s(ms)} s (${outcome})`)
  void import('./walletEvents').then(m => m.logWalletEvent({ event: 'resume', ok: true, ms, detail: outcome })).catch(() => {})
}

// What a payment does between the PIN / fingerprint and the send itself
// (passcode check, recipient check, opening the wallet) - timed by the screen.
let payBefore: { at: number; last: number; steps: string[] } | null = null
/** The PIN / fingerprint was accepted input: a payment's own clock starts. */
export function payStepStart(): void { payBefore = { at: now(), last: now(), steps: [] } }
/** One step before the send finished (`name` took the time since the last step). */
export function payStep(name: string): void {
  if (!payBefore) return
  const t = now()
  payBefore.steps.push(`${name} ${s(t - payBefore.last)}`)
  payBefore.last = t
}

/** A payment's stages, in seconds: before the send, prepare (preflight), sign, broadcast → hash, confirmation. */
export function reportPayment(stages: { prepare?: number; sign?: number; broadcast?: number; confirm?: number }, outcome: string): void {
  // Only this payment's own steps (a screen that gave up earlier left old ones).
  const before = payBefore && now() - payBefore.at < 120_000 && payBefore.steps.length ? `before ${payBefore.steps.join(' ')}, ` : ''
  payBefore = null
  void reportPerf(`[perf pay] ${before}prepare ${s(stages.prepare)}, sign ${s(stages.sign)}, broadcast ${s(stages.broadcast)}, confirm ${s(stages.confirm)} (${outcome})`)
}

/** A swap, in seconds: until the swap transaction went out (quote, approval, signing), then until Arc confirmed it. */
export function reportSwap(beforeSend: number | undefined, confirm: number | undefined, outcome: string): void {
  void reportPerf(`[perf swap] before send ${s(beforeSend)}, confirm ${s(confirm)} (${outcome})`)
}

async function reportPerf(line: string): Promise<void> {
  try { (await import('./errorReport')).reportPerf(line) } catch { /* reporting must never break the app */ }
}

/** Test hook. */
export function resetPerfTrace(): void {
  startup.clear(); startupDetail.clear(); startupReported = false; payBefore = null
  if (startupTimer) clearTimeout(startupTimer)
  startupTimer = null
}
