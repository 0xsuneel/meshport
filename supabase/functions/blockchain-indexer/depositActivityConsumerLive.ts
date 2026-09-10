// supabase/functions/blockchain-indexer/depositActivityConsumerLive.ts
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { isKnownInternalContract } from '../_shared/knownInternalContracts.ts'
import type {
  DepositActivityRow,
  DepositActivityUpdateRepository,
  DepositCandidateChainEvent,
  DepositEligibilityLookup,
} from './depositActivityConsumer.ts'

// Now importing from _shared/knownInternalContracts.ts (deployed via the
// Supabase CLI, which correctly resolves cross-directory relative imports --
// verified: claim-recovery-scan/index.ts already imports this exact file the
// same way, in production). This closes two real gaps the old compare.ts-only
// import had: (1) compare.ts's own list is missing Multicall3, and (2) it has
// no P2P-escrow-exclusion mechanism at all.
//
// Bug 3 fix: the P2P escrow contract is deployment-specific (rotates across
// redeploys) and therefore cannot be hardcoded like the other known-internal
// addresses. This reads the exact SAME server-side secrets
// p2p-release-reconcile/index.ts already reads (P2P_ESCROW_CONTRACT +
// P2P_ESCROW_CONTRACTS_LEGACY, comma-separated) -- never the client-only
// VITE_P2P_ESCROW_CONTRACT, which does not exist in an Edge Function's
// environment at all. isKnownInternalContract's own `extra` parameter exists
// specifically for this: a caller reads its own env vars and passes the
// resulting address(es) through, so knownInternalContracts.ts itself never
// needs P2P-specific knowledge. See that file's own comment on `extra` for
// the full reasoning (including why the address isn't just hardcoded there).
/**
 * Pure parsing so the escrow-address resolution itself is directly testable
 * without touching real Deno.env state. Mirrors p2p-release-reconcile's own
 * ESCROW_CONTRACTS_LEGACY parsing exactly (comma-separated, trimmed,
 * lowercased, blanks filtered). Re-exported here for callers that already
 * import from this module; the implementation lives in escrowConfig.ts
 * (zero imports, so it's testable without pulling in the jsr:supabase-js
 * type-resolution chain this file itself needs).
 */
export { parseEscrowAddresses } from './escrowConfig.ts'
import { parseEscrowAddresses as parseEscrowAddressesImpl } from './escrowConfig.ts'

const KNOWN_P2P_ESCROWS = parseEscrowAddressesImpl(Deno.env.get('P2P_ESCROW_CONTRACT'), Deno.env.get('P2P_ESCROW_CONTRACTS_LEGACY'))

const TRACKED_FEATURES = ['pay', 'bulkpay', 'swap'] as const

/**
 * Finds candidate incoming chain_events: confirmed deposit_detected/
 * transfer_detected rows for a known wallet, not yet consumed into an
 * Activity row. "Not yet consumed" is checked via a left-anti-join against
 * activity on the same recv_<hash> key this module writes -- reusing the
 * real Activity table as the source of truth rather than adding any new
 * "processed" column/migration to chain_events.
 */
export async function findDepositCandidateChainEvents(
  supabase: SupabaseClient,
  chainId: string,
  sinceIso: string,
): Promise<DepositCandidateChainEvent[]> {
  const { data, error } = await supabase
    .from('chain_events')
    .select('id, chain_id, tx_hash, wallet_address, assets, metadata')
    .eq('chain_id', chainId)
    .eq('status', 'confirmed')
    .in('event_type', ['deposit_detected', 'transfer_detected'])
    .not('wallet_address', 'is', null)
    .not('tx_hash', 'is', null)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: true })
    .limit(200)
  if (error) {
    console.error('[deposit-activity-consumer] findDepositCandidateChainEvents failed:', error.message)
    return []
  }
  const rows = (data ?? []) as Array<Record<string, unknown>>
  if (rows.length === 0) return []

  // Filter out anything already consumed by checking the exact recv_<hash>
  // keys this module would write, in one batched query.
  const candidateKeys = rows.map(r => `recv_${(r.tx_hash as string).toLowerCase()}`)
  const wallets = Array.from(new Set(rows.map(r => (r.wallet_address as string).toLowerCase())))
  const { data: existing, error: existingErr } = await supabase
    .from('activity')
    .select('tx_hash, wallet_address')
    .in('tx_hash', candidateKeys)
    .in('wallet_address', wallets)
  if (existingErr) {
    console.error('[deposit-activity-consumer] existing-activity check failed:', existingErr.message)
    return []
  }
  const existingKeys = new Set(((existing ?? []) as Array<{ tx_hash: string; wallet_address: string }>).map(a => `${a.tx_hash}:${a.wallet_address}`))

  const out: DepositCandidateChainEvent[] = []
  for (const r of rows) {
    const wallet = (r.wallet_address as string).toLowerCase()
    const txHash = (r.tx_hash as string).toLowerCase()
    if (existingKeys.has(`recv_${txHash}:${wallet}`)) continue
    const meta = (r.metadata as Record<string, unknown> | null) ?? {}
    const sender = (meta.sender ?? meta.from) as string | undefined
    const amount = Number(meta.amount)
    const assets = r.assets as string[] | null
    out.push({
      chainEventId: r.id as string,
      chainId: r.chain_id as string,
      txHash,
      walletAddress: wallet,
      senderAddress: sender ? sender.toLowerCase() : null,
      amount,
      tokenSymbol: assets?.[0] ?? 'USDC',
    })
  }
  return out
}

export function makeLiveDepositEligibilityLookup(supabase: SupabaseClient): DepositEligibilityLookup {
  return {
    isKnownInternalContractSender(senderAddress) {
      return Promise.resolve(isKnownInternalContract(senderAddress, KNOWN_P2P_ESCROWS))
    },
    async findCorrelatedTrackedFeature(chainId, txHash) {
      const { data, error } = await supabase
        .from('transaction_attempts')
        .select('transaction_intents!inner(feature)')
        .eq('chain_id', chainId)
        .eq('tx_hash', txHash.toLowerCase())
        .in('transaction_intents.feature', [...TRACKED_FEATURES])
        .limit(1)
        .maybeSingle()
      if (error) {
        console.error('[deposit-activity-consumer] findCorrelatedTrackedFeature failed:', error.message)
        return null
      }
      if (!data) return null
      const intent = (data as Record<string, unknown>).transaction_intents as { feature: string } | { feature: string }[] | null
      const feature = Array.isArray(intent) ? intent[0]?.feature : intent?.feature
      return feature ?? null
    },
  }
}

export function makeLiveDepositActivityUpdateRepository(supabase: SupabaseClient): DepositActivityUpdateRepository {
  return {
    async insertActivityIfAbsent(row: DepositActivityRow) {
      const { data, error } = await supabase
        .from('activity')
        .upsert(row, { onConflict: 'tx_hash,wallet_address', ignoreDuplicates: true })
        .select('id')
      if (error) {
        console.error('[deposit-activity-consumer] insertActivityIfAbsent failed:', error.message)
        return 'already_existed'
      }
      // ignoreDuplicates upserts return no row when the conflict was hit --
      // an empty result means this exact (tx_hash, wallet) already existed.
      return (data && data.length > 0) ? 'inserted' : 'already_existed'
    },
  }
}
