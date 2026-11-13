import { describe, it, expect } from 'vitest'
import { nextHealth, INITIAL_HEALTH, STUCK_MS, STUCK_WITH_OLD_BLOCK_MS, CLEAR_AFTER_MS, POLL_MS, RATE_KEEP_MS, type HealthState } from './arcHealth'

const T0 = 1_800_000_000_000
const sample = (number: number, ageMs: number, now: number) => ({ number, timestampSec: Math.floor((now - ageMs) / 1000) })

describe('nextHealth', () => {
  it('is not slow on the first sample, however old the block looks (a wrong phone clock)', () => {
    const s = nextHealth(INITIAL_HEALTH, sample(10, 60_000, T0), T0)
    expect(s.slow).toBe(false)
    expect(s.number).toBe(10)
  })

  it('stays healthy while the head keeps moving', () => {
    let s: HealthState = INITIAL_HEALTH
    for (let i = 0; i < 5; i++) s = nextHealth(s, sample(10 + i * 16, 400, T0 + i * 8000), T0 + i * 8000) // ~0.5 s blocks
    expect(s.slow).toBe(false)
  })

  it('is slow once the same head has been seen for STUCK_MS', () => {
    let s = nextHealth(INITIAL_HEALTH, sample(10, 400, T0), T0)
    s = nextHealth(s, sample(10, 2400, T0 + 2000), T0 + 2000)
    expect(s.slow).toBe(false)
    s = nextHealth(s, sample(10, STUCK_MS + 400, T0 + STUCK_MS), T0 + STUCK_MS)
    expect(s.slow).toBe(true)
  })

  it('is slow sooner when the block is also old by its own timestamp', () => {
    let s = nextHealth(INITIAL_HEALTH, sample(10, 7000, T0), T0)
    s = nextHealth(s, sample(10, 9100, T0 + STUCK_WITH_OLD_BLOCK_MS), T0 + STUCK_WITH_OLD_BLOCK_MS)
    expect(s.slow).toBe(true)
  })

  it('stays slow through a stalled cycle, clears once blocks run normally for CLEAR_AFTER_MS', () => {
    let s = nextHealth(INITIAL_HEALTH, sample(10, 400, T0), T0)
    s = nextHealth(s, sample(10, 9000, T0 + 9000), T0 + 9000)
    expect(s.slow).toBe(true)
    // The block that ends the stall: no blink off.
    s = nextHealth(s, sample(11, 300, T0 + 10_000), T0 + 10_000)
    expect(s.slow).toBe(true)
    // Blocks keep coming every ~0.5 s (sampled every 8 s).
    let n = 12, t = T0 + 10_000
    while (t < T0 + 9000 + CLEAR_AFTER_MS - 1000) { t += 2000; n += 4; s = nextHealth(s, sample(n, 300, t), t) }
    expect(s.slow).toBe(true)
    // Clears once the stall has left the rate window and CLEAR_AFTER_MS has passed since.
    const clearBy = T0 + 9000 + RATE_KEEP_MS + CLEAR_AFTER_MS + 2000
    while (t < clearBy) { t += 2000; n += 4; s = nextHealth(s, sample(n, 300, t), t) }
    expect(s.slow).toBe(false)
  })

  it('a fresh stall during the recovery keeps it on', () => {
    let s = nextHealth(INITIAL_HEALTH, sample(10, 400, T0), T0)
    s = nextHealth(s, sample(10, 5000, T0 + 5000), T0 + 5000)
    s = nextHealth(s, sample(11, 300, T0 + 6000), T0 + 6000)
    s = nextHealth(s, sample(11, 5000, T0 + 11_000), T0 + 11_000) // stuck again
    s = nextHealth(s, sample(12, 300, T0 + 12_000), T0 + 12_000)
    s = nextHealth(s, sample(13, 300, T0 + 5000 + CLEAR_AFTER_MS + 1), T0 + 5000 + CLEAR_AFTER_MS + 1)
    expect(s.slow).toBe(true) // 20 s counts from the LAST stall
  })

  it('slow when blocks come seconds apart even though the head moves between every look (13 Nov 09:47+: gaps of 10 s, 5 s)', () => {
    // Live 10:00-10:01: one look every ~8.5 s, the head moved every time: 12, 4, 2, 2, 4 blocks.
    const steps = [12, 4, 2, 2, 4]
    let s = nextHealth(INITIAL_HEALTH, sample(100, 300, T0), T0)
    let n = 100, t = T0, ever = false
    for (const d of steps) { n += d; t += 8500; s = nextHealth(s, sample(n, 300, t), t); ever ||= s.slow }
    expect(ever).toBe(true)
  })

  it('never slow on a healthy chain (~17 blocks per 8 s look)', () => {
    let s = nextHealth(INITIAL_HEALTH, sample(100, 300, T0), T0)
    let n = 100
    for (let i = 1; i <= 20; i++) { n += 16; s = nextHealth(s, sample(n, 300, T0 + i * POLL_MS), T0 + i * POLL_MS); expect(s.slow).toBe(false) }
  })

  it('a node a beat behind (a lower number) is not counted as the chain moving', () => {
    let s = nextHealth(INITIAL_HEALTH, sample(100, 300, T0), T0)
    s = nextHealth(s, sample(99, 300, T0 + 2000), T0 + 2000)
    expect(s.slow).toBe(false)
    expect(s.seen.every(x => x.number <= 99)).toBe(true)
  })
})
