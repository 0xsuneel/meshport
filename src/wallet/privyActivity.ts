// src/wallet/privyActivity.ts
//
// Is Privy making progress? What this page last heard: from Privy (an answer to one of its requests, its
// iframe loading, a message from the iframe) and from anything else. A request
// that hangs never finishes, so it never shows up - Privy "quiet" while other
// requests finish means Privy is stuck, not that the connection is slow.
const heard = { privy: 0, other: 0 }
const onHeard = new Set<() => void>()
const isPrivyHost = (url: string) => { try { return /(^|\.)privy\.io$/.test(new URL(url).hostname) } catch { return false } }
export function noteHeard(privy: boolean, at: number) {
  if (privy) heard.privy = Math.max(heard.privy, at)
  else heard.other = Math.max(heard.other, at)
  for (const f of [...onHeard]) f()
}
if (typeof window !== 'undefined') {
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) noteHeard(isPrivyHost(e.name), e.startTime + e.duration)
    }).observe({ type: 'resource', buffered: true })
  } catch { /* no Resource Timing: the watchdogs below never fire */ }
  window.addEventListener('message', e => { if (isPrivyHost(e.origin)) noteHeard(true, performance.now()) })
}

/** Calls `stuck` once Privy has been quiet for `quietMs` (counted from `since`
 *  at the earliest) while something else was answered. Returns a cancel. */
export function whenPrivyQuiet(since: number, quietMs: number, stuck: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let done = false
  const check = () => {
    if (done) return
    clearTimeout(timer)
    const quietFrom = Math.max(since, heard.privy)
    const left = quietFrom + quietMs - performance.now()
    if (left > 0) { timer = setTimeout(check, left); return }
    // Nothing answered at all: the connection is down - a new Privy wouldn't load either.
    if (heard.other <= quietFrom) return
    done = true
    stuck()
  }
  onHeard.add(check)
  check()
  return () => { done = true; clearTimeout(timer); onHeard.delete(check) }
}

// Privy rebuilds (PrivyRoot): the first two at once, then 20 s, 40 s, and
// every 60 s after the previous one - never given up for the session.
const QUICK_REBUILDS = 2
const LATER_REBUILD_GAP_MS = [20_000, 40_000, 60_000]
/** How long after the previous rebuild the next may start, given how many were done. Pure. */
export function rebuildGapMs(done: number): number {
  if (done < QUICK_REBUILDS) return 0
  return LATER_REBUILD_GAP_MS[Math.min(done - QUICK_REBUILDS, LATER_REBUILD_GAP_MS.length - 1)]
}

/** Test hook. */
export function resetPrivyActivity(): void { heard.privy = 0; heard.other = 0; onHeard.clear() }

/**
 * Does privy.io answer this phone right now? One plain request to Privy's
 * public app endpoint, outside Privy's SDK. Any HTTP answer (even an error
 * status) means the network to Privy works - then a hang is inside Privy's
 * SDK / iframe on this page; no answer means Privy can't be reached at all,
 * and no rebuild or reload could help. For the hang / rebuild reports only.
 */
export async function probePrivyReachable(appId: string, timeoutMs = 8_000): Promise<string> {
  if (typeof fetch === 'undefined' || !appId) return 'probe n/a'
  const started = performance.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`https://auth.privy.io/api/v1/apps/${encodeURIComponent(appId)}`, {
      headers: { 'privy-app-id': appId }, cache: 'no-store', signal: ctrl.signal,
    })
    return `privy.io answered ${res.status} in ${Math.round(performance.now() - started)} ms`
  } catch (e) {
    return ctrl.signal.aborted
      ? `privy.io no answer in ${(timeoutMs / 1000).toFixed(0)} s`
      : `privy.io unreachable (${e instanceof Error ? e.message.slice(0, 60) : 'error'}) after ${Math.round(performance.now() - started)} ms`
  } finally {
    clearTimeout(timer)
  }
}
