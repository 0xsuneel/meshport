// supabase/functions/ledger-interpret/liveRepository.ts
//
// First real implementation of LedgerRepository (repository.ts's header
// explicitly documented that none existed yet: "No implementation of this
// interface is provided in this phase"). Built now because Swap needs a
// live caller to ever produce a real SWAP_DEBIT/SWAP_CREDIT row -- see
// types.ts's own header: "SWAP_DEBIT (and correlated SWAP_CREDIT) cannot
// actually be produced [against live data] until a future, explicitly
// out-of-scope phase migrates Swap's UI to create real intents." This is
// that phase, for Swap. Generic across every feature the interpreter
// already dispatches on (Pay/BulkPay included) because interpreter.ts's
// dispatch logic is already feature-aware and correct for all three -- a
// Swap-only repository would need to reinvent the same generic reads
// anyway. Running this against Pay/BulkPay's own confirmed data changes
// NOTHING about how Pay/BulkPay behave; it only starts populating the
// previously-empty ledger_events table for them too, which is additive by
// construction (idempotent inserts, no existing row ever mutated or
// deleted).

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import type { LedgerRepository } from './repository.ts'
import type { ChainEventInput, AttemptContext, IntentContext, LedgerEventDraft, InsertOutcome } from './types.ts'

export function makeLiveLedgerRepository(supabase: SupabaseClient): LedgerRepository {
  return {
    async getChainEvent(id: string): Promise<ChainEventInput | null> {
      const { data, error } = await supabase
        .from('chain_events')
        .select('id, chain_id, tx_hash, wallet_address, event_type, status, log_index, block_number, contract_address, assets, metadata')
        .eq('id', id)
        .maybeSingle()
      if (error || !data) return null
      const row = data as Record<string, unknown>
      const assets = (row.assets as string[] | null) ?? null
      return {
        id: row.id as string,
        chain_id: row.chain_id as string,
        tx_hash: (row.tx_hash as string | null) ?? null,
        wallet_address: (row.wallet_address as string | null) ?? null,
        event_type: row.event_type as string,
        status: row.status as string,
        log_index: (row.log_index as number | null) ?? null,
        block_number: (row.block_number as number | null) ?? null,
        token_address: row.event_type === 'transfer_detected' ? ((row.contract_address as string | null) ?? null) : null,
        token_symbol: assets && assets.length > 0 ? assets[0] : null,
        decimals: null,
        metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      }
    },

    async findAttemptByTxHash(chainId: string, txHash: string): Promise<AttemptContext | null> {
      const { data, error } = await supabase
        .from('transaction_attempts')
        .select('id, intent_id, chain_id, tx_hash, status, block_number')
        .eq('chain_id', chainId)
        .eq('tx_hash', txHash.toLowerCase())
        .maybeSingle()
      if (error || !data) return null
      const row = data as Record<string, unknown>
      return {
        id: row.id as string,
        intent_id: row.intent_id as string,
        chain_id: row.chain_id as string,
        tx_hash: (row.tx_hash as string | null) ?? null,
        status: row.status as string,
        block_number: (row.block_number as number | null) ?? null,
      }
    },

    async getIntent(intentId: string): Promise<IntentContext | null> {
      const { data, error } = await supabase
        .from('transaction_intents')
        .select('id, wallet_address, feature, amount_atomic, decimals, token_address, token_symbol')
        .eq('id', intentId)
        .maybeSingle()
      if (error || !data) return null
      const row = data as Record<string, unknown>
      return {
        id: row.id as string,
        wallet_address: row.wallet_address as string,
        feature: row.feature as string,
        amount_atomic: String(row.amount_atomic),
        decimals: row.decimals as number,
        token_address: (row.token_address as string | null) ?? null,
        token_symbol: (row.token_symbol as string | null) ?? null,
        is_native: row.token_address == null,
      }
    },

    async findLedgerEventByRawMovement(
      chainId: string,
      txHash: string,
      logIndex: number | null,
      walletAddress: string,
    ): Promise<{ id: string; event_type: string } | null> {
      let query = supabase
        .from('ledger_events')
        .select('id, event_type')
        .eq('chain_id', chainId)
        .eq('tx_hash', txHash.toLowerCase())
        .eq('wallet_address', walletAddress.toLowerCase())
      query = logIndex === null ? query.is('log_index', null) : query.eq('log_index', logIndex)
      const { data, error } = await query.maybeSingle()
      if (error || !data) return null
      return { id: data.id as string, event_type: data.event_type as string }
    },

    async insertLedgerEvent(draft: LedgerEventDraft): Promise<InsertOutcome> {
      const { data, error } = await supabase
        .from('ledger_events')
        .insert({
          transaction_intent_id: draft.transaction_intent_id,
          transaction_attempt_id: draft.transaction_attempt_id,
          wallet_address: draft.wallet_address,
          chain_id: draft.chain_id,
          event_type: draft.event_type,
          direction: draft.direction,
          token_address: draft.token_address,
          token_symbol: draft.token_symbol,
          decimals: draft.decimals,
          amount_atomic: draft.amount_atomic,
          tx_hash: draft.tx_hash,
          block_number: draft.block_number,
          log_index: draft.log_index,
          event_key: draft.event_key,
          settlement_status: 'POSTED',
          metadata: draft.metadata,
        })
        .select('id')
        .single()
      if (error) {
        if (error.code === '23505') {
          const { data: existing } = await supabase
            .from('ledger_events')
            .select('id')
            .eq('event_key', draft.event_key)
            .maybeSingle()
          if (existing) return { outcome: 'already_posted', id: existing.id as string }
        }
        throw error
      }
      return { outcome: 'inserted', id: data!.id as string }
    },
  }
}
