/**
 * Policy parity: the browser sweep and the scheduled server-side reconciler must
 * make the SAME decision about somebody's money, always.
 *
 * Edge functions deploy from supabase/functions/ and cannot import from src/, so
 * the two runtimes physically cannot share one file. That leaves a duplicated
 * rule, and a duplicated money-handling rule that can silently drift is a worse
 * failure mode than either copy simply being wrong — a divergence would show up
 * as "the cron cancelled a trade the browser would have restored".
 *
 * So this file imports BOTH implementations and runs them across the exhaustive
 * input matrix, asserting identical verdicts and identical reasons. Any edit to
 * one copy that is not mirrored in the other fails the build here.
 */

import { describe, it, expect } from 'vitest'
import {
  classifyStuckRelease as clientPolicy,
  STUCK_RELEASE_GRACE_MS as CLIENT_GRACE,
  type StuckReleaseProbe,
} from '@/lib/stuckReleasePolicy'
import {
  classifyStuckRelease as serverPolicy,
  STUCK_RELEASE_GRACE_MS as SERVER_GRACE,
} from '../../supabase/functions/_shared/stuckReleasePolicy'

/** Every meaningful combination, including the boundaries that matter. */
function matrix(): StuckReleaseProbe[] {
  const releasedStates: Array<boolean | null> = [true, false, null]
  const remainingStates: Array<number | null> = [null, 0, 0.000001, 1, 4.999999, 5, 5.000001, 23, 1000]
  const depositedStates = [true, false]
  const amounts = [0.000001, 1, 2, 5, 20, 100]

  const out: StuckReleaseProbe[] = []
  for (const onChainReleased of releasedStates)
    for (const escrowRemaining of remainingStates)
      for (const everDeposited of depositedStates)
        for (const amountUsdc of amounts)
          out.push({ onChainReleased, escrowRemaining, everDeposited, amountUsdc })
  return out
}

describe('stuck-release policy parity — client vs server', () => {
  const cases = matrix()

  it('covers a non-trivial matrix', () => {
    expect(cases.length).toBe(3 * 9 * 2 * 6)   // 324 combinations
  })

  it('returns the IDENTICAL verdict for every input', () => {
    const divergences: string[] = []
    for (const c of cases) {
      const a = clientPolicy(c)
      const b = serverPolicy(c)
      if (a.verdict !== b.verdict) {
        divergences.push(`${JSON.stringify(c)} -> client=${a.verdict} server=${b.verdict}`)
      }
    }
    expect(divergences, `policy divergence:\n${divergences.join('\n')}`).toEqual([])
  })

  it('returns the IDENTICAL reason text for every input', () => {
    // Reasons are surfaced in logs and operator reports; drift there is a
    // quieter but still real divergence.
    const divergences: string[] = []
    for (const c of cases) {
      const a = clientPolicy(c)
      const b = serverPolicy(c)
      if (a.reason !== b.reason) divergences.push(`${JSON.stringify(c)}\n  client: ${a.reason}\n  server: ${b.reason}`)
    }
    expect(divergences, `reason divergence:\n${divergences.join('\n')}`).toEqual([])
  })

  it('shares the same grace window', () => {
    expect(SERVER_GRACE).toBe(CLIENT_GRACE)
  })
})

describe('stuck-release policy — safety invariants hold in BOTH copies', () => {
  const cases = matrix()

  for (const [label, policy] of [['client', clientPolicy], ['server', serverPolicy]] as const) {
    it(`${label}: never cancels while any escrow remains`, () => {
      const bad = cases.filter(c =>
        policy(c).verdict === 'cancel' && (c.escrowRemaining ?? 0) > 0)
      expect(bad, `would cancel with funds present: ${JSON.stringify(bad[0])}`).toEqual([])
    })

    it(`${label}: never cancels when the escrow balance is unknown`, () => {
      const bad = cases.filter(c => c.escrowRemaining === null && policy(c).verdict === 'cancel')
      expect(bad).toEqual([])
    })

    it(`${label}: never cancels when escrow was ever funded`, () => {
      const bad = cases.filter(c => c.everDeposited && policy(c).verdict === 'cancel')
      expect(bad).toEqual([])
    })

    it(`${label}: always investigates when the release flag is unreadable`, () => {
      const wrong = cases.filter(c => c.onChainReleased === null && policy(c).verdict !== 'investigate')
      expect(wrong).toEqual([])
    })

    it(`${label}: always finalizes when the contract proves the release`, () => {
      const wrong = cases.filter(c => c.onChainReleased === true && policy(c).verdict !== 'finalize')
      expect(wrong).toEqual([])
    })

    it(`${label}: never restores unless remaining covers the full amount`, () => {
      const bad = cases.filter(c =>
        policy(c).verdict === 'restore' && !(c.escrowRemaining !== null && c.escrowRemaining >= c.amountUsdc))
      expect(bad).toEqual([])
    })

    it(`${label}: only ever emits the four known verdicts`, () => {
      const seen = new Set(cases.map(c => policy(c).verdict))
      for (const v of seen) expect(['finalize', 'restore', 'cancel', 'investigate']).toContain(v)
    })
  }
})

// ── The two real production trades, as fixtures ──────────────────────────────

describe('stuck-release policy — the two real stuck trades', () => {
  // Verified on Arc: tradeReleased=false, offer 77a75512 holds 23 USDC on
  // P2PMeshportEscrow, deposit 0xe53cee42 exists.
  const trade568baca0: StuckReleaseProbe = {
    onChainReleased: false, escrowRemaining: 23, everDeposited: true, amountUsdc: 5,
  }
  // Verified on Arc: tradeReleased=false, getRemaining=0 on BOTH contracts, and
  // no deposit transaction for offer 3cb51bab exists on either.
  const tradeFb0de45a: StuckReleaseProbe = {
    onChainReleased: false, escrowRemaining: 0, everDeposited: false, amountUsdc: 2,
  }

  it('568baca0 (5 USDC genuinely escrowed) -> restore, in both copies', () => {
    expect(clientPolicy(trade568baca0).verdict).toBe('restore')
    expect(serverPolicy(trade568baca0).verdict).toBe('restore')
  })

  it('fb0de45a (never funded) -> cancel, in both copies', () => {
    expect(clientPolicy(tradeFb0de45a).verdict).toBe('cancel')
    expect(serverPolicy(tradeFb0de45a).verdict).toBe('cancel')
  })

  it('neither becomes cancel if the chain read fails — the funds stay protected', () => {
    for (const t of [trade568baca0, tradeFb0de45a]) {
      const blind = { ...t, onChainReleased: null as boolean | null }
      expect(clientPolicy(blind).verdict).toBe('investigate')
      expect(serverPolicy(blind).verdict).toBe('investigate')
    }
  })
})
