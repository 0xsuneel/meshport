// ── Is Arc itself slow right now? ───────────────────────────────────────────
// Arc normally makes a block about every 0.5 s, so a payment lands in about a
// second. When the network stalls (field 13 Nov 2026: gaps of 4, 10, 16 and
// 24 s between blocks for hours), nothing the app does can make a payment land
// faster - but the person should be told it is the network, not the app.
//
// Detected from what this device itself sees, so a wrong phone clock cannot
// cause a false alarm: the newest block's number has not changed for a few
// seconds of OUR looking (the block's own timestamp only speeds that up), OR
// over the last ~12 s or more of our looking, blocks came on average more than
// 1 s apart. The second rule is what catches the 13 Nov 09:47+ pattern
// (gaps of 10 s, 5 s, then a few quick blocks): the head moves between every
// 8 s look, so "same number twice" alone never fired.
//
// One cheap read every 8 s while the app is visible (every 2 s while the head
// looks stuck, to tell a stall from a quiet moment). Reads go through
// arcRpcJson like every other Arc read.

import { useSyncExternalStore } from 'react'

export interface HeadSample { number: number; timestampSec: number }
export interface HealthState {
  /** Newest block number seen, and when (this device's clock) that number first appeared. */
  number: number | null
  changedAt: number
  slow: boolean
  /** When the head was last seen stuck (this device's clock); 0 = never. */
  stuckAt: number
  /** Recent looks (this device's clock, block number), oldest first, for the block rate. */
  seen: { at: number; number: number }[]
}

/** The head has not moved for this long on our own clock: a stall. */
export const STUCK_MS = 4_000
/** With the block's timestamp also old, a shorter wait is enough. */
export const STUCK_WITH_OLD_BLOCK_MS = 2_000
export const OLD_BLOCK_MS = 6_000
export const POLL_MS = 8_000
export const POLL_STUCK_MS = 2_000
/** Once slow, it stays slow until the chain has moved normally this long. A
 *  stalled Arc runs in cycles (13 Nov: a 24 s gap, then 16, 10 and 10 s, then
 *  ~15 s of normal blocks); clearing on the first new block made the pill
 *  blink on and off every few seconds. */
export const CLEAR_AFTER_MS = 20_000
/** The block rate is judged over at least this much of our own looking... */
export const RATE_WINDOW_MS = 12_000
/** ...and looks older than this are dropped. */
export const RATE_KEEP_MS = 30_000
/** Blocks this far apart on average is slow: twice a healthy Arc's ~510 ms
 *  (13 Nov 10:04: a stalled spell averaging 1.3 s slipped under 1.5 s). */
export const SLOW_BLOCK_MS = 1_000

export const INITIAL_HEALTH: HealthState = { number: null, changedAt: 0, slow: false, stuckAt: 0, seen: [] }

/** Pure: the next state after reading the head at `now` (ms, this device's clock). */
export function nextHealth(prev: HealthState, sample: HeadSample, now: number): HealthState {
  // A number lower than one already seen is a node a beat behind: not a new look at the head.
  const seen = [...prev.seen.filter(x => now - x.at <= RATE_KEEP_MS && x.number <= sample.number), { at: now, number: sample.number }]
  const oldest = seen[0]
  const span = now - oldest.at
  const slowRate = span >= RATE_WINDOW_MS && span / Math.max(1, sample.number - oldest.number) >= SLOW_BLOCK_MS

  const moved = sample.number !== prev.number
  const stuckMs = moved ? 0 : now - prev.changedAt
  const blockAgeMs = now - sample.timestampSec * 1000
  const stuckHead = !moved && (stuckMs >= STUCK_MS || (stuckMs >= STUCK_WITH_OLD_BLOCK_MS && blockAgeMs >= OLD_BLOCK_MS))

  const base = { number: sample.number, changedAt: moved ? now : prev.changedAt, seen }
  if (stuckHead || slowRate) return { ...base, slow: true, stuckAt: now }
  // Still slow while the last slow look was recent (no blinking through a stall cycle).
  return { ...base, slow: prev.slow && now - prev.stuckAt < CLEAR_AFTER_MS, stuckAt: prev.stuckAt }
}

let state: HealthState = INITIAL_HEALTH
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | null = null
let running = false

export function isArcSlow(): boolean { return state.slow }

function emit(before: boolean) { if (state.slow !== before) listeners.forEach(l => l()) }

async function readHead(): Promise<HeadSample | null> {
  const { arcRpcJson } = await import('./arc')
  const json = await arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }, 4000)
  const n = Number.parseInt(json?.result?.number ?? '', 16)
  const ts = Number.parseInt(json?.result?.timestamp ?? '', 16)
  return Number.isFinite(n) && Number.isFinite(ts) ? { number: n, timestampSec: ts } : null
}

async function tick() {
  timer = null
  if (!running) return
  let delay = POLL_MS
  if (typeof document === 'undefined' || document.visibilityState === 'visible') {
    try {
      const sample = await readHead()
      if (sample) {
        const before = state.slow
        const prevNumber = state.number
        state = nextHealth(state, sample, Date.now())
        emit(before)
        if (sample.number === prevNumber) delay = POLL_STUCK_MS
      }
    } catch { /* a failed read says nothing about Arc: keep the last answer */ }
  }
  if (running) timer = setTimeout(tick, delay)
}

/** Start watching (idempotent). Returns a stop function. */
export function startArcHealth(): () => void {
  if (running) return () => {}
  running = true
  void tick()
  return () => {
    running = false
    if (timer) clearTimeout(timer)
    timer = null
    const before = state.slow
    state = INITIAL_HEALTH
    emit(before)
  }
}

export function useArcSlow(): boolean {
  return useSyncExternalStore(
    l => { listeners.add(l); return () => { listeners.delete(l) } },
    () => state.slow,
    () => false,
  )
}
