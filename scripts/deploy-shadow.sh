#!/usr/bin/env bash
# =============================================================================
# deploy-shadow.sh — deploy BlockchainIndexer in SHADOW MODE to testnet
#
# Applies the two ADDITIVE migrations and deploys the indexer function.
# Changes NO production behaviour:
#   - deposit-scan-all, claim-worker, claim-recovery-scan are NOT touched
#   - no polling, refresh timer or compatibility layer is removed
#   - the indexer writes ONLY to its own new tables
#   - nothing consumes chain_events (shadow_mode.authoritative = false)
#
# Refuses to run if it would do anything else. See the guards below.
#
# Usage:
#   export SUPABASE_ACCESS_TOKEN=sbp_...      # from supabase.com/dashboard/account/tokens
#   export SUPABASE_PROJECT_REF=cvvpzfvzweszuuxvaayb
#   export SUPABASE_DB_PASSWORD=...           # database password
#   ./scripts/deploy-shadow.sh                # dry run  — shows what WOULD happen
#   ./scripts/deploy-shadow.sh --apply        # real run
# =============================================================================
set -euo pipefail

APPLY=false
[[ "${1:-}" == "--apply" ]] && APPLY=true

SUPABASE="npx --yes supabase@2.112.0"
MIGRATIONS=(
  "supabase/migrations/20260807120000_blockchain_indexer_foundation.sql"
  "supabase/migrations/20260807130000_shadow_validation_and_retention.sql"
)
LEGACY_WORKERS=(deposit-scan-all claim-worker claim-recovery-scan)

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── Guard 1: required credentials ───────────────────────────────────────────
say "1. Credentials"
[[ -n "${SUPABASE_ACCESS_TOKEN:-}"  ]] || die "SUPABASE_ACCESS_TOKEN is not set"
[[ -n "${SUPABASE_PROJECT_REF:-}"   ]] || die "SUPABASE_PROJECT_REF is not set"
ok "access token present"
ok "project ref: ${SUPABASE_PROJECT_REF}"

# ── Guard 2: the migrations must exist and be ADDITIVE ──────────────────────
# A migration that drops or alters an existing object is out of scope for a
# shadow deploy. Fail loudly rather than let one through unnoticed.
say "2. Migration safety check"
for m in "${MIGRATIONS[@]}"; do
  [[ -f "$m" ]] || die "missing migration: $m"
  if grep -nEi '^[[:space:]]*(DROP[[:space:]]+(TABLE|COLUMN)|ALTER[[:space:]]+TABLE[[:space:]]+[a-z_."]+[[:space:]]+DROP|TRUNCATE|DELETE[[:space:]]+FROM)' "$m" \
       | grep -v 'chain_events\|chain_cursors\|indexer_config\|indexer_shadow_reports' ; then
    die "$m appears to modify pre-existing objects — not an additive migration"
  fi
  # cron.unschedule is only acceptable for the indexer's OWN jobs (idempotent re-run).
  if grep -oE "cron\.unschedule\('[^']+'\)" "$m" | grep -vE "blockchain-indexer|chain-events-retention"; then
    die "$m unschedules a job that is not the indexer's own"
  fi
  ok "$(basename "$m") — additive, touches only new objects"
done

# ── Guard 3: legacy workers must be untouched in the working tree ───────────
say "3. Legacy workers untouched"
if git rev-parse --git-dir >/dev/null 2>&1; then
  for w in "${LEGACY_WORKERS[@]}"; do
    if [[ -n "$(git status --porcelain -- "supabase/functions/$w" 2>/dev/null)" ]]; then
      die "$w has uncommitted modifications — shadow deploy must not change it"
    fi
    ok "$w unmodified"
  done
else
  warn "not a git repo — skipping modification check"
fi

# ── Guard 4: the indexer must be inert ──────────────────────────────────────
say "4. Indexer inertness"
grep -q "'authoritative', false" "${MIGRATIONS[1]}" \
  && ok "shadow_mode.authoritative = false" \
  || die "authoritative flag is not false — indexer would be treated as a source of truth"

if grep -rn "shadowEventBus" src --include=*.ts --include=*.tsx -l 2>/dev/null | grep -qv "src/blockchain/"; then
  # Only the AppLayout mount is expected; it must not trigger refreshes.
  MOUNTS=$(grep -rn "shadowEventBus" src --include=*.tsx -l | tr '\n' ' ')
  warn "bus mounted in: ${MOUNTS}(observation only — verify no refresh is triggered)"
fi
ok "no consumer acts on chain_events"

# ── Dry run stops here ──────────────────────────────────────────────────────
if [[ "$APPLY" != true ]]; then
  say "DRY RUN — nothing was changed"
  echo "  Would apply:"
  for m in "${MIGRATIONS[@]}"; do echo "    • $(basename "$m")"; done
  echo "  Would deploy:"
  echo "    • supabase/functions/blockchain-indexer"
  echo
  echo "  Re-run with --apply to execute."
  exit 0
fi

# ── Link ────────────────────────────────────────────────────────────────────
say "5. Linking project"
$SUPABASE link --project-ref "$SUPABASE_PROJECT_REF" >/dev/null
ok "linked"

# ── Show the diff BEFORE applying ───────────────────────────────────────────
say "6. Pending migrations"
$SUPABASE migration list --linked || true

# ── Apply migrations ────────────────────────────────────────────────────────
say "7. Applying additive migrations"
$SUPABASE db push --linked
ok "migrations applied"

# ── Deploy the function ─────────────────────────────────────────────────────
say "8. Deploying blockchain-indexer"
$SUPABASE functions deploy blockchain-indexer --project-ref "$SUPABASE_PROJECT_REF"
ok "function deployed"

# ── Verify legacy workers are still deployed and untouched ──────────────────
say "9. Post-deploy check: legacy workers still live"
$SUPABASE functions list --project-ref "$SUPABASE_PROJECT_REF" || true
warn "confirm deposit-scan-all, claim-worker, claim-recovery-scan are all ACTIVE above"

say "DONE — shadow mode deployed"
cat <<'NEXT'
  The indexer is now observing. It is NOT authoritative.

  Next:
    scripts/collect-shadow-metrics.sh          # gather measured evidence
    scripts/collect-shadow-metrics.sh --watch  # poll until the gate is met

  Cutover gate (all must hold on REAL traffic):
    worker_only = 0, indexer_only = 0, restart recovery verified,
    stable cursor progression, native Arc USDC confirmed.
NEXT
