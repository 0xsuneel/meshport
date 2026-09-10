// supabase/functions/_shared/knownInternalContracts.ts
//
// Canonical list of Arc testnet contracts whose outbound Transfer is a
// MeshPort-internal transaction leg (a swap's output, a BulkPay/Multicall3
// payout, a P2P escrow release/refund, CCTP infrastructure) rather than a
// genuine external payment. A Transfer FROM one of these addresses should
// never be classified as a generic "external deposit" by any recovery/
// detection worker — it is already accounted for by that flow's own,
// purpose-built Activity write.
//
// ── Provenance ───────────────────────────────────────────────────────────
// 8 of the 9 addresses below are copied EXACTLY from
// supabase/functions/blockchain-indexer/compare.ts's KNOWN_INTERNAL_CONTRACTS
// (used there to correctly classify shadow-comparison mismatches — see
// docs/PHASE_3_REAL_STATE_AUDIT.md §7/§8), which itself already documents
// mirroring deposit-scan-all/index.ts's own copy, and api/relay-rpc.js's
// CIRCLE_CONTRACTS before that.
//
// The 9th — Multicall3 (0xcA11bde05977b3631167028862be2A173976CA11) — is
// NOT currently in compare.ts's list (verified directly against the live
// source before writing this file). It is added here because this task
// explicitly requires excluding Multicall3/BulkPay senders, and because a
// real Multicall3-sent transaction was independently traced against LIVE
// production chain_events data during the Phase 3 forensic audit
// (docs/PHASE_3_REAL_STATE_AUDIT.md §8, tx `0x435d804c…`), confirming this
// is the genuine sender address for BulkPay payouts on Arc, not a guess.
// compare.ts's own list has a real, pre-existing gap here — its BulkPay
// exclusion currently works a different way (matching the `bulk` activity_type
// after the fact in compare.ts's ACCOUNTED_FOR_OTHER_ACTIVITY classification,
// not via KNOWN_INTERNAL_CONTRACTS at all). This file does not silently
// invent a fourth unrelated list — 8/9 entries are an exact, verified copy;
// the 9th is a deliberate, evidenced addition, called out here rather than
// left unstated.
//
// ── Why this file exists instead of importing compare.ts directly ─────────
// blockchain-indexer/compare.ts is explicitly out of scope for this change
// (see docs/CLAIM_RECOVERY_SENDER_CLASSIFICATION_FIX.md — "Do NOT change the
// indexer"), so compare.ts's own copy is NOT migrated to import from here in
// this pass. Kept in sync manually for now — the same "kept in sync
// manually" relationship compare.ts's own comment already describes having
// with deposit-scan-all's copy. A future, indexer-scoped change should
// update compare.ts to (a) import from here instead of maintaining its own
// copy, and (b) decide whether to fold Multicall3 into its own
// KNOWN_INTERNAL_CONTRACTS the same way — not decided here, since that is
// squarely an indexer-scoped decision this change must not make.
//
// ── Runtime safety ──────────────────────────────────────────────────────
// Pure data, zero imports, zero Deno-specific or Node-specific APIs — safe
// to import from any Edge Function in this project (Deno) without pulling in
// anything browser/Vite-only. Contains no secrets: every address here is a
// public, already-deployed testnet contract address, the same kind of
// public information already committed in plain text in compare.ts,
// deposit-scan-all/index.ts, and api/relay-rpc.js.
export const KNOWN_INTERNAL_CONTRACTS: ReadonlySet<string> = new Set([
  '0x0077777d7eba4688bdef3e311b846f25870a19b9',
  '0x9f3b8679c73c2fef8b59b4f3444d4e156fb70aa5',
  '0x7865fafc2db2093669d92c0f33aeef291086befd',
  '0xacf1ceef35caac005e15888ddb8a3515c41b4872',
  '0xc5567a5e3370d4dbfb0540025078e283e36a363d', // Kit Bridge Contract testnet
  '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b', // Kit Adapter Contract testnet — swaps route through this
  '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa', // CCTP V2 TokenMessenger
  '0xe737e5cebeeba77efe34d4aa090756590b1ce275', // CCTP V2 MessageTransmitter
  '0xca11bde05977b3631167028862be2a173976ca11', // Multicall3 — BulkPay routes through this (lowercased; canonical checksum is 0xcA11bde05977b3631167028862be2A173976CA11)
])

/**
 * Case-insensitive membership check against the static list above, PLUS any
 * caller-supplied supplemental addresses (`extra`).
 *
 * `extra` exists specifically for P2P's escrow contract. Its deployed
 * address was NOT found in `.env.example` or any migration during the
 * Phase 0/3 audits (`docs/PHASE_3_EVENT_COVERAGE_MATRIX.md`'s P2P rows note
 * this explicitly — `p2pProviders.ts` even has an
 * `HonorSystemFallbackEscrowProvider` implying it may not be configured in
 * every environment). Hardcoding a P2P escrow address here would mean
 * guessing one — exactly the kind of unverified addition this module's own
 * provenance comments elsewhere are careful to avoid. Instead, this mirrors
 * `supabase/functions/p2p-release-reconcile/index.ts`'s own already-
 * established pattern (`Deno.env.get('P2P_ESCROW_CONTRACT')` +
 * `P2P_ESCROW_CONTRACTS_LEGACY`, comma-separated) — a caller that reads
 * those same env vars can pass the resulting address(es) via `extra`
 * without this shared module needing any P2P-specific knowledge at all.
 */
export function isKnownInternalContract(address: string | null | undefined, extra?: Iterable<string>): boolean {
  if (!address) return false
  const a = address.trim().toLowerCase()
  if (KNOWN_INTERNAL_CONTRACTS.has(a)) return true
  if (extra) {
    for (const e of extra) {
      if (e && e.trim().toLowerCase() === a) return true
    }
  }
  return false
}
