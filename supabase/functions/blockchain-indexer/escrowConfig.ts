// supabase/functions/blockchain-indexer/escrowConfig.ts
//
// Pure parsing for the P2P escrow contract address(es), factored out of
// depositActivityConsumerLive.ts purely so it has zero imports and is
// directly testable without pulling in the `jsr:@supabase/supabase-js`
// type-resolution chain. Mirrors p2p-release-reconcile/index.ts's own
// ESCROW_CONTRACT + ESCROW_CONTRACTS_LEGACY parsing exactly (comma-
// separated, trimmed, lowercased, blanks filtered) -- see
// depositActivityConsumerLive.ts's header comment for why this reads the
// server-side secret, never the client-only VITE_P2P_ESCROW_CONTRACT.
export function parseEscrowAddresses(primaryEnvValue: string | undefined, legacyEnvValue: string | undefined): string[] {
  const primary = (primaryEnvValue ?? '').trim().toLowerCase()
  const legacy = (legacyEnvValue ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  return [primary, ...legacy].filter(Boolean)
}
