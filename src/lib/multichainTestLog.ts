/**
 * multichainTestLog.ts — Manual test-data collector for Claim + Send
 *
 * Purpose: while manually testing every chain in MultichainClaimPage /
 * MultichainTransferPage, capture every SDK event, fee estimate, error, and
 * final result to localStorage instead of relying on copy-pasting devtools
 * console output by hand. Not wired into production analytics — this is a
 * throwaway QA tool. Safe to delete once chain-by-chain testing is done.
 *
 * Usage:
 *   - Open either page with ?testlog=1 in the URL to show the floating
 *     panel (see TestLogPanel.tsx).
 *   - Every kit event, fee estimate, and terminal result on both pages is
 *     already wired to call logTestEvent() — no per-test action needed.
 *   - Use the panel's "Copy JSON" / "Download JSON" button to hand the full
 *     run log back for diagnosis, or call exportTestLog() from the console.
 */

export type TestFlow = 'claim' | 'transfer'
export type TestService = 'cctp' | 'ub' | 'unknown'

export interface TestLogEntry {
  ts: number                 // Date.now()
  runId: string              // groups all entries for one claim/send attempt
  flow: TestFlow
  chainId: string
  service: TestService
  kind: string                // 'estimate' | 'sdk-event' | 'result' | 'error' | 'note'
  label: string                // short human label, e.g. 'bridge.burn', 'estimateBridge result', 'FAILED'
  data?: any                   // arbitrary serializable payload (fees, steps, error message, etc.)
}

const STORAGE_KEY = 'arcpay_multichain_test_log'
const MAX_ENTRIES = 2000 // guard against unbounded localStorage growth during a long test session

function safeParse(raw: string | null): TestLogEntry[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function safeStringify(value: any): any {
  // Strip non-serializable / huge fields (adapters, kit instances, BigInt) so
  // JSON.stringify never throws and the log stays readable.
  try {
    return JSON.parse(JSON.stringify(value, (_key, v) => {
      if (typeof v === 'bigint') return v.toString() + 'n'
      if (typeof v === 'function') return undefined
      if (v && typeof v === 'object' && (v.constructor?.name === 'AppKit' || v.constructor?.name?.includes('Adapter'))) {
        return `[${v.constructor.name}]`
      }
      return v
    }))
  } catch (e: any) {
    return { __unserializable: true, error: e?.message }
  }
}

export function newRunId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// The claim flow's internal chainId for Polygon really is 'Polygon_Sepolia'
// (see CIRCLE_SDK_CHAIN_ID in MultichainClaimPage.tsx — it's translated to
// the real SDK chain 'Polygon_Amoy_Testnet' right before every SDK call).
// That's intentional and correct, but printing it raw in a log made it look
// like the wrong network was being tested — easy to misread as "this is
// hitting Sepolia" when it's actually Amoy. Friendly labels below are
// purely a display fix; nothing about chain resolution changes.
export function friendlyChainLabel(flow: TestFlow, chainId: string): string {
  const table = flow === 'claim' ? CLAIM_TEST_CHAINS : SEND_TEST_CHAINS
  return table.find(c => c.id === chainId)?.label ?? chainId
}

export function logTestEvent(entry: Omit<TestLogEntry, 'ts'>) {
  try {
    const log = safeParse(localStorage.getItem(STORAGE_KEY))
    log.push({ ts: Date.now(), ...entry, data: entry.data !== undefined ? safeStringify(entry.data) : undefined })
    const trimmed = log.length > MAX_ENTRIES ? log.slice(log.length - MAX_ENTRIES) : log
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
    // Mirror to console too, so devtools still shows a live stream while
    // testing without needing the panel open.
    console.log(`[TestLog][${entry.flow}][${friendlyChainLabel(entry.flow, entry.chainId)}][${entry.service}] ${entry.kind}: ${entry.label}`, entry.data)
  } catch (e) {
    console.warn('[TestLog] failed to write entry', e)
  }
}

export function getTestLog(): TestLogEntry[] {
  return safeParse(localStorage.getItem(STORAGE_KEY))
}

export function clearTestLog() {
  localStorage.removeItem(STORAGE_KEY)
}

export function exportTestLogJson(): string {
  return JSON.stringify(getTestLog(), null, 2)
}

/** Groups entries by runId — one group per claim/send attempt, in order. */
export function getTestLogGroupedByRun(): { runId: string; flow: TestFlow; chainId: string; service: TestService; entries: TestLogEntry[] }[] {
  const log = getTestLog()
  const order: string[] = []
  const groups = new Map<string, TestLogEntry[]>()
  for (const e of log) {
    if (!groups.has(e.runId)) { groups.set(e.runId, []); order.push(e.runId) }
    groups.get(e.runId)!.push(e)
  }
  return order.map(runId => {
    const entries = groups.get(runId)!
    return { runId, flow: entries[0].flow, chainId: entries[0].chainId, service: entries[0].service, entries }
  })
}

// ── Coverage matrix ──────────────────────────────────────────────────────────
// Fixed reference lists (independent of what's been tested so far) so the
// panel can show "not tested yet" for chains with zero runs, not just
// summarize whatever happens to already be in the log. Keep these in sync
// with CHAIN_META (MultichainClaimPage.tsx) and CHAINS (MultichainTransferPage.tsx)
// if a chain is ever added/removed.
export const CLAIM_TEST_CHAINS: { id: string; label: string }[] = [
  { id: 'Ethereum_Sepolia',    label: 'Ethereum' },
  { id: 'Base_Sepolia',        label: 'Base' },
  { id: 'Arbitrum_Sepolia',    label: 'Arbitrum' },
  { id: 'Optimism_Sepolia',    label: 'OP Sepolia' },
  { id: 'Polygon_Sepolia',     label: 'Polygon Amoy' },
  { id: 'Avalanche_Fuji',      label: 'Avalanche' },
  { id: 'HyperEVM_Testnet',    label: 'HyperEVM' },
  { id: 'Sei_Testnet',         label: 'Sei' },
  { id: 'Sonic_Testnet',       label: 'Sonic' },
  { id: 'Unichain_Sepolia',    label: 'Unichain' },
  { id: 'World_Chain_Sepolia', label: 'World Chain' },
  { id: 'Linea_Sepolia',       label: 'Linea' },
  { id: 'Ink_Testnet',         label: 'Ink' },
  { id: 'Monad_Testnet',       label: 'Monad' },
  { id: 'Morph_Testnet',       label: 'Morph' },
  { id: 'Pharos_Testnet',      label: 'Pharos' },
  { id: 'Plume_Testnet',       label: 'Plume' },
  { id: 'XDC_Apothem',         label: 'XDC' },
  { id: 'Codex_Testnet',       label: 'Codex' },
  { id: 'Edge_Testnet',        label: 'EDGE' },
  { id: 'Injective_Testnet',   label: 'Injective' },
]

export const SEND_TEST_CHAINS: { id: string; label: string; service: TestService }[] = [
  { id: 'eth',       label: 'Ethereum',    service: 'ub' },
  { id: 'base',      label: 'Base',        service: 'ub' },
  { id: 'arb',       label: 'Arbitrum',    service: 'ub' },
  { id: 'pol',       label: 'Polygon',     service: 'ub' },
  { id: 'op',        label: 'Optimism',    service: 'ub' },
  { id: 'avax',      label: 'Avalanche',   service: 'ub' },
  { id: 'hyperevm',  label: 'HyperEVM',    service: 'ub' },
  { id: 'sei',       label: 'Sei',         service: 'ub' },
  { id: 'sonic',     label: 'Sonic',       service: 'ub' },
  { id: 'unichain',  label: 'Unichain',    service: 'ub' },
  { id: 'world',     label: 'World Chain', service: 'ub' },
  { id: 'linea',     label: 'Linea',       service: 'cctp' },
  { id: 'ink',       label: 'Ink',         service: 'cctp' },
  { id: 'monad',     label: 'Monad',       service: 'cctp' },
  { id: 'morph',     label: 'Morph',       service: 'cctp' },
  { id: 'pharos',    label: 'Pharos',      service: 'cctp' },
  { id: 'plume',     label: 'Plume',       service: 'cctp' },
  { id: 'xdc',       label: 'XDC',         service: 'cctp' },
  { id: 'codex',     label: 'Codex',       service: 'cctp' },
  { id: 'edge',      label: 'EDGE',        service: 'cctp' },
  { id: 'injective', label: 'Injective',   service: 'cctp' },
]

export type CoverageStatus = 'untested' | 'pending' | 'pass' | 'fail'

export interface CoverageRow {
  id: string
  label: string
  service: TestService
  status: CoverageStatus
  attempts: number
  lastError?: string
  lastRunId?: string
}

/**
 * Maps every known chain in a flow onto its most recent logged run (if any).
 * A chain that's never appeared in the log shows as 'untested' rather than
 * being silently omitted — that's the whole point of using a fixed list
 * instead of just deriving rows from getTestLogGroupedByRun().
 */
export function getCoverage(flow: TestFlow): CoverageRow[] {
  const groups = getTestLogGroupedByRun().filter(g => g.flow === flow)
  const reference = flow === 'claim' ? CLAIM_TEST_CHAINS : SEND_TEST_CHAINS

  return reference.map(ref => {
    const runsForChain = groups.filter(g => g.chainId === ref.id)
    const service: TestService = 'service' in ref ? (ref as any).service : 'cctp'
    if (runsForChain.length === 0) {
      return { id: ref.id, label: ref.label, service, status: 'untested', attempts: 0 }
    }
    // Most recent attempt = last one that appears in insertion order.
    const latest = runsForChain[runsForChain.length - 1]
    const hasSuccess = latest.entries.some(e => e.kind === 'result' && e.label === 'SUCCESS')
    const errorEntry = latest.entries.find(e => e.kind === 'error')
    const status: CoverageStatus = hasSuccess ? 'pass' : errorEntry ? 'fail' : 'pending'
    return {
      id: ref.id,
      label: ref.label,
      service,
      status,
      attempts: runsForChain.length,
      lastError: errorEntry?.data?.message,
      lastRunId: latest.runId,
    }
  })
}

export function downloadTestLog() {
  const blob = new Blob([exportTestLogJson()], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `arcpay-multichain-test-log-${Date.now()}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
