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

/** Test hook. */
export function resetPrivyActivity(): void { heard.privy = 0; heard.other = 0; onHeard.clear() }
