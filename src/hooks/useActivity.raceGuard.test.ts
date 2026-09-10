// src/hooks/useActivity.raceGuard.test.ts
//
// Regression test for the request-race fix in useActivity.ts's load():
// filter/search/wallet changes (or two overlapping loadMore calls) can
// start a second request before the first one resolves. Without a guard,
// whichever RESPONSE arrives last wins — not whichever REQUEST was started
// last — so a slow "all" response landing after a fast "swap" filter
// switch would silently overwrite the newer, correct results with stale
// ones. useActivity.ts fixes this with a monotonically-increasing
// requestIdRef: each load() captures the id at call time (before the
// await) and only applies its result if that id still matches the ref's
// current value when it resolves.
//
// The hook itself can't be mounted here — this repo's vitest config is
// deliberately Node-only (no jsdom/@testing-library/react, see
// vitest.config.ts's own comment) — so, matching the existing convention
// for mergeOnchainIntoRecords (useActivity.test.ts), this pins the exact
// counter algorithm in isolation: a tiny harness that mirrors
// requestIdRef's increment-before-await / compare-after-await shape,
// driven by mock fetches that resolve in a controlled, out-of-order
// sequence.

import { describe, it, expect } from 'vitest'

/** Mirrors useActivity.ts's requestIdRef guard exactly, decoupled from React. */
function makeRaceGuardedLoader<T>(fetcher: (arg: string) => Promise<T>) {
  let requestId = 0
  let applied: T | null = null
  let applyCount = 0

  async function load(arg: string) {
    const myRequestId = ++requestId
    const data = await fetcher(arg)
    if (myRequestId !== requestId) return // stale — a newer load() started since
    applied = data
    applyCount++
  }

  return { load, getApplied: () => applied, getApplyCount: () => applyCount }
}

describe('useActivity request race guard', () => {
  it('a slow first response does not overwrite a fast second response', async () => {
    // request A ("all") is slow; request B ("swap", started right after A)
    // resolves first. A resolving later must be ignored.
    const resolvers: Record<string, (v: string) => void> = {}
    const fetcher = (arg: string) => new Promise<string>(resolve => { resolvers[arg] = resolve })
    const { load, getApplied, getApplyCount } = makeRaceGuardedLoader(fetcher)

    const pA = load('all')   // requestId 1
    const pB = load('swap')  // requestId 2 — supersedes A before A resolves

    resolvers['swap']('swap-result') // B resolves first
    await pB
    expect(getApplied()).toBe('swap-result')

    resolvers['all']('all-result')   // A resolves late, after B already applied
    await pA
    // A must NOT have overwritten B's result — this is the exact bug.
    expect(getApplied()).toBe('swap-result')
    expect(getApplyCount()).toBe(1)
  })

  it('two consecutive loads that resolve in order both apply normally', async () => {
    const fetcher = async (arg: string) => `${arg}-result`
    const { load, getApplied, getApplyCount } = makeRaceGuardedLoader(fetcher)

    await load('all')
    expect(getApplied()).toBe('all-result')

    await load('receive')
    expect(getApplied()).toBe('receive-result')
    expect(getApplyCount()).toBe(2)
  })

  it('three overlapping requests: only the last-started one ever applies', async () => {
    const resolvers: Record<string, (v: string) => void> = {}
    const fetcher = (arg: string) => new Promise<string>(resolve => { resolvers[arg] = resolve })
    const { load, getApplied, getApplyCount } = makeRaceGuardedLoader(fetcher)

    const p1 = load('all')
    const p2 = load('swap')
    const p3 = load('receive') // the true "most recent" request

    // Resolve out of order: 2nd-started first, then 1st-started, then 3rd.
    resolvers['swap']('swap-result')
    await p2
    resolvers['all']('all-result')
    await p1
    resolvers['receive']('receive-result')
    await p3

    expect(getApplied()).toBe('receive-result')
    expect(getApplyCount()).toBe(1)
  })
})
