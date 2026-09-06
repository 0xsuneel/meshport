/**
 * Activation-boundary and capability tests for the stuck-release reconciler.
 *
 * WHY AN ACTIVATION BOUNDARY EXISTS
 * When this was written two trades had already been stuck for weeks — 568baca0
 * holding 5 USDC of real escrow, fb0de45a never funded — and both were under
 * human review. A reconciler that swept "everything currently stuck" on its
 * first run would have restored one and cancelled the other before anyone
 * approved it. So eligibility is gated on an explicit activation timestamp that
 * FAILS CLOSED, plus an independent per-trade skip list.
 *
 * The tests below pin the boundary itself, and separately assert from the edge
 * function's own source that it is structurally incapable of moving money.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  parseActivationCutoff, isEligibleForReconcile, classifyStuckRelease,
  STUCK_RELEASE_GRACE_MS,
} from '@/lib/stuckReleasePolicy'
import {
  parseActivationCutoff as srvParseCutoff,
  isEligibleForReconcile as srvIsEligible,
} from '../../supabase/functions/_shared/stuckReleasePolicy'

// The two real quarantined trades.
const T_568 = '568baca0-9f25-4138-8a70-af28055e35d3'   // 5 USDC, real escrow
const T_FB0 = 'fb0de45a-6b46-4f0b-9bf8-9c1ac89c8d89'   // 2 USDC, never funded
const CREATED_568 = '2026-08-07T02:13:51.102Z'
const CREATED_FB0 = '2026-07-29T09:35:24.165Z'

const ACTIVATION = '2026-08-22T12:00:00.000Z'          // a hypothetical activation moment
const NOW = Date.parse('2026-08-23T00:00:00.000Z')     // well past it

const gate = (over: Partial<Parameters<typeof isEligibleForReconcile>[0]> = {}) =>
  isEligibleForReconcile({
    tradeId: 'trade-x', createdAtIso: '2026-08-22T13:00:00.000Z',
    cutoffMs: Date.parse(ACTIVATION), graceMs: STUCK_RELEASE_GRACE_MS, nowMs: NOW,
    ...over,
  })

// ── Fail-closed default ─────────────────────────────────────────────────────

describe('activation cutoff parsing — fails closed', () => {
  it('treats missing / blank / garbage as DORMANT (null)', () => {
    for (const raw of [undefined, null, '', '   ', 'not-a-date', 'yesterday']) {
      expect(parseActivationCutoff(raw as any), String(raw)).toBeNull()
      expect(srvParseCutoff(raw as any), String(raw)).toBeNull()
    }
  })

  it('parses a valid ISO timestamp identically in both copies', () => {
    expect(parseActivationCutoff(ACTIVATION)).toBe(Date.parse(ACTIVATION))
    expect(srvParseCutoff(ACTIVATION)).toBe(Date.parse(ACTIVATION))
  })

  it('with no cutoff configured NOTHING is eligible', () => {
    const r = gate({ cutoffMs: null })
    expect(r.eligible).toBe(false)
    expect(r.reason).toMatch(/dormant/i)
  })
})

// ── The two historical trades must be ignored ───────────────────────────────

describe('activation boundary — the two real stuck trades are NOT processed', () => {
  it('568baca0 (Aug 7, 5 USDC real escrow) is ignored by the timestamp gate', () => {
    const r = gate({ tradeId: T_568, createdAtIso: CREATED_568 })
    expect(r.eligible).toBe(false)
    expect(r.reason).toMatch(/predates the activation cutoff/i)
  })

  it('fb0de45a (Jul 29, never funded) is ignored by the timestamp gate', () => {
    const r = gate({ tradeId: T_FB0, createdAtIso: CREATED_FB0 })
    expect(r.eligible).toBe(false)
    expect(r.reason).toMatch(/predates the activation cutoff/i)
  })

  it('the skip list blocks them INDEPENDENTLY, even if the cutoff is set wrong', () => {
    // Belt and braces: a cutoff mistakenly set before both trades.
    const badCutoff = Date.parse('2026-01-01T00:00:00.000Z')
    for (const [id, created] of [[T_568, CREATED_568], [T_FB0, CREATED_FB0]] as const) {
      const r = gate({ tradeId: id, createdAtIso: created, cutoffMs: badCutoff, skipTradeIds: [T_568, T_FB0] })
      expect(r.eligible, id).toBe(false)
      expect(r.reason).toMatch(/skip list/i)
    }
  })

  it('without the skip list a wrong cutoff WOULD expose them — so both guards matter', () => {
    const badCutoff = Date.parse('2026-01-01T00:00:00.000Z')
    expect(gate({ tradeId: T_568, createdAtIso: CREATED_568, cutoffMs: badCutoff }).eligible).toBe(true)
  })
})

// ── New trades after activation are still reconciled ────────────────────────

describe('activation boundary — new trades ARE processed', () => {
  it('a trade created after activation and past the grace window is eligible', () => {
    const r = gate({ createdAtIso: '2026-08-22T13:00:00.000Z' })
    expect(r.eligible).toBe(true)
  })

  it('a trade created after activation but still inside the grace window is not yet eligible', () => {
    const justNow = new Date(NOW - 60_000).toISOString()   // 1 min ago, grace is 5
    const r = gate({ createdAtIso: justNow })
    expect(r.eligible).toBe(false)
    expect(r.reason).toMatch(/grace window/i)
  })

  it('an unparseable created_at is refused rather than assumed', () => {
    const r = gate({ createdAtIso: 'nonsense' })
    expect(r.eligible).toBe(false)
    expect(r.reason).toMatch(/unparseable/i)
  })
})

// ── Exact boundary semantics ────────────────────────────────────────────────

describe('activation boundary — exact cutoff instant', () => {
  const cutoffMs = Date.parse(ACTIVATION)

  it('a trade created EXACTLY at the cutoff is treated as historical (not eligible)', () => {
    // Strictly-after is the fail-safe direction: at the boundary, do not touch.
    const r = gate({ createdAtIso: ACTIVATION, cutoffMs })
    expect(r.eligible).toBe(false)
    expect(r.reason).toMatch(/predates the activation cutoff/i)
  })

  it('one millisecond before the cutoff is not eligible', () => {
    expect(gate({ createdAtIso: new Date(cutoffMs - 1).toISOString(), cutoffMs }).eligible).toBe(false)
  })

  it('one millisecond after the cutoff IS eligible', () => {
    expect(gate({ createdAtIso: new Date(cutoffMs + 1).toISOString(), cutoffMs }).eligible).toBe(true)
  })

  it('client and server agree on the boundary, to the millisecond', () => {
    for (const delta of [-2, -1, 0, 1, 2]) {
      const input = {
        tradeId: 'b', createdAtIso: new Date(cutoffMs + delta).toISOString(),
        cutoffMs, graceMs: STUCK_RELEASE_GRACE_MS, nowMs: NOW,
      }
      expect(srvIsEligible(input).eligible, `delta=${delta}`).toBe(isEligibleForReconcile(input).eligible)
    }
  })
})

// ── Verdict safety, restated at the boundary layer ──────────────────────────

describe('verdicts for the scenarios required before activation', () => {
  it('RPC failure -> investigate (never assumes 0)', () => {
    expect(classifyStuckRelease({ onChainReleased: null, escrowRemaining: null, everDeposited: true, amountUsdc: 5 }).verdict)
      .toBe('investigate')
  })

  it('legacy-contract funds -> restore, never cancel', () => {
    // The reconciler sums getRemaining across BOTH escrow contracts. An old
    // trade whose funds sit in the legacy contract must never be cancelled just
    // because the current contract reads 0.
    expect(classifyStuckRelease({ onChainReleased: false, escrowRemaining: 23, everDeposited: true, amountUsdc: 5 }).verdict)
      .toBe('restore')
  })

  it('partial escrow -> investigate', () => {
    expect(classifyStuckRelease({ onChainReleased: false, escrowRemaining: 3, everDeposited: true, amountUsdc: 5 }).verdict)
      .toBe('investigate')
  })

  it('tradeReleased=true -> finalize', () => {
    expect(classifyStuckRelease({ onChainReleased: true, escrowRemaining: 0, everDeposited: true, amountUsdc: 5 }).verdict)
      .toBe('finalize')
  })

  it('no escrow ever existed -> cancel', () => {
    expect(classifyStuckRelease({ onChainReleased: false, escrowRemaining: 0, everDeposited: false, amountUsdc: 2 }).verdict)
      .toBe('cancel')
  })
})

// ── Capability assertions against the edge function's own source ────────────

describe('p2p-release-reconcile — structurally cannot move funds', () => {
  const src = readFileSync(
    resolve(process.cwd(), 'supabase/functions/p2p-release-reconcile/index.ts'), 'utf8')

  it('performs ONLY read-only eth_call — no transaction-sending RPC methods', () => {
    expect(src).toContain("'eth_call'")
    for (const forbidden of [
      'eth_sendTransaction', 'eth_sendRawTransaction', 'eth_signTransaction',
      'personal_sign', 'eth_sign',
    ]) {
      expect(src, `must not use ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('never touches a private key or a wallet client', () => {
    for (const forbidden of [
      'privateKey', 'PRIVATE_KEY', 'privateKeyToAccount', 'createWalletClient',
      'sendTransaction', 'signTransaction', 'mnemonic',
    ]) {
      expect(src, `must not reference ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('never encodes a release() or withdrawRemaining() call', () => {
    // Only the two view selectors may appear.
    expect(src).toContain('0x8deade26')   // tradeReleased(bytes32)
    expect(src).toContain('0x9cb589ac')   // getRemaining(bytes32)
    for (const writeSelector of [
      '0x85a9549a',   // release(bytes32,bytes32,address,uint256)
      '0xdafa9af3',   // withdrawRemaining(bytes32)
      '0xb214faa5',   // deposit(bytes32)
    ]) {
      expect(src, `must not embed write selector ${writeSelector}`).not.toContain(writeSelector)
    }
  })

  it('only writes the allowed columns on the allowed tables', () => {
    // p2p_trades: status / released_at / completed_at / cancel_reason
    // p2p_offers: locked_by_trade_id
    const updates = src.match(/\.update\(\{[^}]*\}\)/g) ?? []
    expect(updates.length).toBeGreaterThan(0)
    const allowed = ['status', 'released_at', 'completed_at', 'cancel_reason', 'locked_by_trade_id']
    for (const u of updates) {
      const keys = [...u.matchAll(/([a-z_]+)\s*:/g)].map(m => m[1])
      for (const k of keys) expect(allowed, `unexpected column written: ${k} in ${u}`).toContain(k)
    }
  })

  it('never writes to the activity table (no fabricated rows)', () => {
    expect(src).not.toContain("from('activity')")
  })

  it('is dormant unless P2P_RECONCILE_AFTER is configured', () => {
    expect(src).toContain('P2P_RECONCILE_AFTER')
    expect(src).toMatch(/cutoffMs === null/)
    expect(src).toMatch(/dormant/i)
  })

  it('honours an independent skip list', () => {
    expect(src).toContain('P2P_RECONCILE_SKIP_TRADE_IDS')
    expect(src).toMatch(/skipTradeIds/)
  })

  it('checks both escrow contracts, so legacy funds are never missed', () => {
    expect(src).toContain('P2P_ESCROW_CONTRACT')
    expect(src).toContain('P2P_ESCROW_CONTRACTS_LEGACY')
    expect(src).toMatch(/ALL_ESCROWS/)
  })

  it('returns null rather than 0 when no contract could be read', () => {
    expect(src).toMatch(/anyAnswered \? false : null/)
    expect(src).toMatch(/anyAnswered \? total : null/)
  })

  it('reads credentials only from the environment — none embedded', () => {
    expect(src).toContain("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')")
    // No JWT-looking literal and no long hex secret pasted into source.
    expect(src).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/)
    expect(src).not.toMatch(/sb_secret_[A-Za-z0-9]/)
  })
})
