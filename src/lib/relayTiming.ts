// lib/relayTiming.ts
//
// One line per call MeshPort's relayer submits for the app (CCTP mints,
// Gateway mints and deposits - /api/bridge-relay action 'call'), stored with
// the app's other timings (client_errors, "[perf relay] ..."). Field 2 Nov:
// Arc → Ethereum mints by the relayer took 6-26 s and nothing showed where.
//
//   wait     the app waiting for Circle before it could ask (CCTP: attestation)
//   request  the whole request to the relayer, as the app saw it
//   net      request minus the relayer's own total (connection, cold start
//            before the handler ran, the answer's way back)
//   server   the relayer's steps (api/bridge-relay.ts relayCall): checks,
//            simulate, send, receipt, and `blocks` - from the head it saw to
//            the block the transaction landed in (1 = the next block)
//
// Durations, block counts and the outcome only - never addresses or amounts.

export interface RelayServerTiming {
  fn?: string; cold?: boolean; outcome?: string
  checksMs?: number; simulateMs?: number; sendMs?: number; receiptMs?: number; totalMs?: number
  blocks?: number; tipGwei?: number
}

const s = (ms?: number) => (ms == null || !Number.isFinite(ms) ? '-' : (ms / 1000).toFixed(2))

/** The report line (pure - unit tested). */
export function relayTimingLine(what: string, chain: string, t: { waitMs?: number; requestMs: number; server?: RelayServerTiming | null; ok: boolean }): string {
  const sv = t.server ?? null
  const net = sv?.totalMs != null ? t.requestMs - sv.totalMs : undefined
  const server = sv
    ? `server ${sv.fn ?? '?'} ${sv.outcome ?? '?'}: checks ${s(sv.checksMs)}, simulate ${s(sv.simulateMs)}, send ${s(sv.sendMs)}, receipt ${s(sv.receiptMs)}, blocks ${sv.blocks ?? '-'}, tip ${sv.tipGwei ?? '-'} gwei, cold ${sv.cold ?? '-'}`
    : 'server -'
  return `[perf relay] ${what} ${chain}: wait ${s(t.waitMs)}, request ${s(t.requestMs)}, net ${s(net)} | ${server} (${t.ok ? 'ok' : 'failed'})`
}

/** Store the line (fire-and-forget; reporting never affects the transfer). */
export function reportRelayTiming(what: string, chain: string, t: { waitMs?: number; requestMs: number; server?: RelayServerTiming | null; ok: boolean }): void {
  try {
    const line = relayTimingLine(what, chain, t)
    void import('./errorReport').then(m => m.reportPerf(line)).catch(() => {})
  } catch { /* never breaks a transfer */ }
}
