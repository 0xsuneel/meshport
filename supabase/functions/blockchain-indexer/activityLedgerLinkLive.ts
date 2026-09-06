// supabase/functions/blockchain-indexer/activityLedgerLinkLive.ts
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import type { ActivityLinkUpdateRepository, CanonicalLedgerEventLookup, UnlinkedActivityRow } from './activityLedgerLink.ts'

export async function findUnlinkedSwapActivityRows(supabase: SupabaseClient): Promise<UnlinkedActivityRow[]> {
  const { data, error } = await supabase
    .from('activity')
    .select('id, tx_hash, wallet_address')
    .eq('activity_type', 'swap')
    .is('ledger_event_id', null)
    .not('tx_hash', 'is', null)
    .not('wallet_address', 'is', null)
    .limit(200)
  if (error) {
    console.error('[activity-ledger-link] findUnlinkedSwapActivityRows failed:', error.message)
    return []
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map(r => ({
    id: r.id as string,
    txHash: r.tx_hash as string,
    walletAddress: r.wallet_address as string,
  }))
}

export function makeLiveCanonicalLedgerEventLookup(supabase: SupabaseClient): CanonicalLedgerEventLookup {
  return {
    async findSwapDebitLedgerEventId(txHash, walletAddress) {
      const { data, error } = await supabase
        .from('ledger_events')
        .select('id')
        .eq('tx_hash', txHash.toLowerCase())
        .eq('wallet_address', walletAddress.toLowerCase())
        .eq('event_type', 'SWAP_DEBIT')
        .limit(1)
        .maybeSingle()
      if (error) {
        console.error('[activity-ledger-link] findSwapDebitLedgerEventId failed:', error.message)
        return null
      }
      return (data as { id: string } | null)?.id ?? null
    },
  }
}

export function makeLiveActivityLinkUpdateRepository(supabase: SupabaseClient): ActivityLinkUpdateRepository {
  return {
    async linkLedgerEvent(activityId, ledgerEventId) {
      // WHERE-guarded on ledger_event_id IS NULL: a concurrent run, or this
      // same sweep firing twice, safely no-ops the second time rather than
      // overwriting an already-correct link.
      const { error } = await supabase
        .from('activity')
        .update({ ledger_event_id: ledgerEventId })
        .eq('id', activityId)
        .is('ledger_event_id', null)
      if (error) console.error('[activity-ledger-link] linkLedgerEvent failed:', error.message)
    },
  }
}
