/**
 * shadowEventMap.ts — pure mapping/statistics for shadow-mode chain events.
 *
 * Deliberately imports NOTHING. Kept separate from shadowEventBus.ts (which
 * pulls in the Supabase client, and with it `import.meta.env`) so this logic
 * is testable under plain node/tsx without Vite's env shim or credentials.
 *
 * The column contract with the Phase 3 `chain_events` migration is exactly
 * what can silently drift — a mis-mapped column would make every latency
 * reading wrong rather than obviously broken — so it lives here and is
 * asserted in scripts/verify-phase4-bus.ts.
 */

export interface ShadowEvent {
  id: number
  chainId: string
  eventType: string
  walletAddress: string | null
  txHash: string | null
  blockNumber: number | null
  status: string
  createdAt: string
  /**
   * ms between the row's created_at (server insert) and the client receiving
   * it. -1 when created_at is missing/unparseable — NOT 0, because 0 would
   * read as "instant delivery" and quietly drag every percentile toward zero.
   */
  deliveryLatencyMs: number
}

/**
 * Map a raw `chain_events` Realtime row to a ShadowEvent.
 * @param now injectable clock, so latency assertions are deterministic.
 */
export function mapChainEventRow(row: Record<string, unknown>, now = Date.now()): ShadowEvent {
  const createdAt = String(row.created_at ?? '')
  const created = createdAt ? Date.parse(createdAt) : NaN
  return {
    id: Number(row.id ?? 0),
    chainId: String(row.chain_id ?? ''),
    eventType: String(row.event_type ?? ''),
    walletAddress: (row.wallet_address as string) ?? null,
    txHash: (row.tx_hash as string) ?? null,
    blockNumber: row.block_number == null ? null : Number(row.block_number),
    status: String(row.status ?? ''),
    createdAt,
    deliveryLatencyMs: Number.isFinite(created) ? now - created : -1,
  }
}

/**
 * Latency percentiles over observed events. Returns null when there is
 * nothing valid to measure, so a quiet period is distinguishable from
 * genuinely zero latency.
 */
export function latencyStats(events: ShadowEvent[]): {
  min: number; median: number; p95: number; max: number
} | null {
  const lats = events.map(e => e.deliveryLatencyMs).filter(n => n >= 0).sort((a, b) => a - b)
  if (lats.length === 0) return null
  // Nearest-rank percentile: index = ceil(p * n) - 1, the convention monitoring
  // tools use for p95/p99. An earlier floor(p * n) here was inconsistent — it
  // returned the UPPER median for even-length samples (400 rather than 300 over
  // [100,200,300,400,1000,5000]), so p50 and p95 disagreed about what a
  // percentile meant and the reported median ran optimistically high.
  const at = (p: number) => lats[Math.min(lats.length - 1, Math.max(0, Math.ceil(p * lats.length) - 1))]
  return { min: lats[0], median: at(0.5), p95: at(0.95), max: lats[lats.length - 1] }
}
