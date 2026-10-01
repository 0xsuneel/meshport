#!/usr/bin/env bash
# =============================================================================
# collect-shadow-metrics.sh — gather MEASURED shadow-validation evidence
#
# Reads only what the deployed system actually recorded. It computes nothing
# it cannot observe, and it will NOT report a passing gate on an empty window:
# "zero mismatches across zero events" is not evidence, and this script says so
# explicitly rather than printing a green result.
#
# Usage:
#   export SUPABASE_URL=https://<ref>.supabase.co
#   export SUPABASE_SERVICE_ROLE_KEY=eyJ...
#   ./scripts/collect-shadow-metrics.sh              # one snapshot
#   ./scripts/collect-shadow-metrics.sh --compare    # force a fresh comparison first
#   ./scripts/collect-shadow-metrics.sh --json       # machine-readable
# =============================================================================
set -euo pipefail

: "${SUPABASE_URL:?set SUPABASE_URL}"
: "${SUPABASE_SERVICE_ROLE_KEY:?set SUPABASE_SERVICE_ROLE_KEY}"

FORCE_COMPARE=false; AS_JSON=false
for a in "$@"; do
  [[ "$a" == "--compare" ]] && FORCE_COMPARE=true
  [[ "$a" == "--json"    ]] && AS_JSON=true
done

AUTH=(-H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}")
REST="${SUPABASE_URL}/rest/v1"
FN="${SUPABASE_URL}/functions/v1"

q() { curl -sS "${AUTH[@]}" "$@"; }

# ── Optionally run a fresh comparison so the numbers are current ────────────
if [[ "$FORCE_COMPARE" == true ]]; then
  echo "Running comparison (60m window)..." >&2
  q -X POST "${FN}/blockchain-indexer" \
    -H "Content-Type: application/json" \
    -d '{"mode":"compare","windowMinutes":60}' >/dev/null || true
fi

METRICS=$(q -X POST "${FN}/blockchain-indexer" -H "Content-Type: application/json" -d '{"mode":"metrics"}')
CURSORS=$(q "${REST}/chain_cursors?select=*")
REPORTS=$(q "${REST}/indexer_shadow_reports?select=*&order=generated_at.desc&limit=50")
EVENTS=$(q "${REST}/chain_events?select=status,event_type&limit=10000")

if [[ "$AS_JSON" == true ]]; then
  echo "{\"metrics\":${METRICS},\"cursors\":${CURSORS},\"reports\":${REPORTS}}"
  exit 0
fi

node - "$CURSORS" "$REPORTS" "$EVENTS" "$METRICS" <<'NODE'
const [,, cursorsRaw, reportsRaw, eventsRaw, metricsRaw] = process.argv
const j = s => { try { return JSON.parse(s) } catch { return null } }
const cursors = j(cursorsRaw) || []
const reports = j(reportsRaw) || []
const events  = j(eventsRaw)  || []
const metrics = j(metricsRaw) || {}

const line = (c='─') => console.log(c.repeat(74))
const pad = (s,n) => String(s).padEnd(n)

console.log('\nMESHPORT SHADOW VALIDATION — MEASURED EVIDENCE')
console.log(new Date().toISOString())
line('=')

// ── Event volume ───────────────────────────────────────────────────────────
const byStatus = {}, byType = {}
for (const e of events) {
  byStatus[e.status] = (byStatus[e.status] ?? 0) + 1
  byType[e.event_type] = (byType[e.event_type] ?? 0) + 1
}
console.log('\n1. EVENTS OBSERVED')
console.log(`   total (sampled): ${events.length}`)
console.log(`   by status: ${JSON.stringify(byStatus)}`)
console.log(`   by type:   ${JSON.stringify(byType)}`)

// ── Comparison ─────────────────────────────────────────────────────────────
console.log('\n2. EVENT COMPARISON (indexer vs legacy workers)')
if (reports.length === 0) {
  console.log('   NO COMPARISON REPORTS YET — run with --compare, or wait for the cron.')
} else {
  console.log(`   ${pad('scope',12)}${pad('matched',10)}${pad('worker_only',13)}${pad('indexer_only',14)}recall`)
  line()
  for (const r of reports.slice(0, 10)) {
    const recall = r.recall_pct === null ? 'n/a (no data)' : `${r.recall_pct}%`
    console.log(`   ${pad(r.scope,12)}${pad(r.matched,10)}${pad(r.worker_only,13)}${pad(r.indexer_only,14)}${recall}`)
  }
}

// Aggregate across ALL reports — a single clean window proves little.
const agg = {}
for (const r of reports) {
  const a = agg[r.scope] ??= { matched:0, worker_only:0, indexer_only:0, windows:0, withData:0 }
  a.matched += r.matched; a.worker_only += r.worker_only; a.indexer_only += r.indexer_only
  a.windows++; if (r.matched + r.worker_only + r.indexer_only > 0) a.withData++
}

console.log('\n3. AGGREGATE ACROSS ALL WINDOWS')
if (Object.keys(agg).length === 0) console.log('   none')
for (const [scope, a] of Object.entries(agg)) {
  console.log(`   ${scope}: matched=${a.matched} worker_only=${a.worker_only} indexer_only=${a.indexer_only}`)
  console.log(`     windows=${a.windows}, of which non-empty=${a.withData}`)
}

// ── Cursors ────────────────────────────────────────────────────────────────
console.log('\n4. CURSOR STATE')
if (cursors.length === 0) {
  console.log('   NO CURSOR ROWS — the indexer has never completed a pass.')
} else {
  for (const c of cursors) {
    const lag = c.latest_observed_block && c.last_indexed_block
      ? Number(c.latest_observed_block) - Number(c.last_indexed_block) : 'n/a'
    console.log(`   ${c.chain_id}: block=${c.last_indexed_block} lag=${lag} state=${c.sync_state}`)
    console.log(`     reorgs=${c.reorg_count} failures=${c.consecutive_failures} last_success=${c.last_success_at ?? 'never'}`)
    if (c.last_error) console.log(`     last_error: ${c.last_error}`)
  }
}

// ── Gate ───────────────────────────────────────────────────────────────────
line('=')
console.log('\nCUTOVER GATE')
const checks = []
const totalCompared = Object.values(agg).reduce((s,a)=>s+a.matched+a.worker_only+a.indexer_only,0)
const totalWorkerOnly = Object.values(agg).reduce((s,a)=>s+a.worker_only,0)
const totalIndexerOnly = Object.values(agg).reduce((s,a)=>s+a.indexer_only,0)
const nonEmpty = Object.values(agg).reduce((s,a)=>s+a.withData,0)

// The most important guard in this script: a gate that passes on no data is
// worse than a gate that fails, because it looks like success.
checks.push(['meaningful traffic observed', totalCompared > 0,
  totalCompared === 0 ? 'ZERO events compared — gate cannot pass on an empty window' : `${totalCompared} events compared`])
checks.push(['multiple non-empty windows', nonEmpty >= 2,
  `${nonEmpty} window(s) contained data`])
checks.push(['worker_only = 0', totalCompared > 0 && totalWorkerOnly === 0,
  `${totalWorkerOnly} (events the indexer MISSED)`])
checks.push(['indexer_only = 0', totalCompared > 0 && totalIndexerOnly === 0,
  `${totalIndexerOnly} (events legacy did not record)`])
checks.push(['cursor initialised', cursors.length > 0, `${cursors.length} chain(s)`])
checks.push(['no chain in error state', cursors.length > 0 && cursors.every(c => c.sync_state !== 'error'),
  cursors.map(c=>`${c.chain_id}=${c.sync_state}`).join(' ') || 'n/a'])
checks.push(['native USDC deposits seen', (byType['deposit_detected'] ?? 0) > 0,
  `${byType['deposit_detected'] ?? 0} deposit_detected events`])

for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${pad(name,34)} ${detail}`)
}

const passed = checks.every(c => c[1])
line('=')
console.log(passed
  ? '\nAll automated gate conditions met.\nSTILL REQUIRED MANUALLY: restart recovery, reorg observation.\n'
  : '\nGATE NOT MET — do not cut over.\n')
NODE
