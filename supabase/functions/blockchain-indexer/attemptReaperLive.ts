// supabase/functions/blockchain-indexer/attemptReaperLive.ts
//
// Real Supabase wiring for attemptReaper.ts. All of the scope-safety lives
// in findStaleCreatedAttempts's query filter and dropAttemptAndFailIntent's
// two WHERE-guarded updates -- see attemptReaper.ts's own header for why
// each constraint is there.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { computeStaleCutoffIso } from './attemptReaper.ts'
import type { AttemptReaperUpdateRepository, StaleCreatedAttempt } from './attemptReaper.ts'

const REAPED_FEATURES = ['pay', 'bulkpay', 'swap'] as const

export async function findStaleCreatedAttempts(
  supabase: SupabaseClient,
  boundHours: number,
): Promise<StaleCreatedAttempt[]> {
  const cutoff = computeStaleCutoffIso(boundHours)
  const { data, error } = await supabase
    .from('transaction_attempts')
    .select('id, intent_id, chain_id, created_at, transaction_intents!inner(feature, status)')
    .eq('status', 'CREATED')
    .is('tx_hash', null)
    .in('transaction_intents.feature', [...REAPED_FEATURES])
    .eq('transaction_intents.status', 'SUBMITTED')
    .lt('created_at', cutoff)
    .limit(100)
  if (error) {
    console.error('[attempt-reaper] findStaleCreatedAttempts failed:', error.message)
    return []
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map(r => {
    const intent = r.transaction_intents as { feature: string } | { feature: string }[]
    const feature = Array.isArray(intent) ? intent[0]?.feature : intent?.feature
    return {
      id: r.id as string,
      intentId: r.intent_id as string,
      chainId: r.chain_id as string,
      createdAt: r.created_at as string,
      feature: feature ?? 'unknown',
    }
  })
}

export function makeLiveAttemptReaperUpdateRepository(supabase: SupabaseClient): AttemptReaperUpdateRepository {
  return {
    async dropAttemptAndFailIntent(attemptId, intentId) {
      const { error: attemptErr, count } = await supabase
        .from('transaction_attempts')
        .update({ status: 'DROPPED' })
        .eq('id', attemptId)
        .eq('status', 'CREATED')
        .is('tx_hash', null)
        .select('id', { count: 'exact', head: true })
      if (attemptErr) {
        console.error('[attempt-reaper] dropAttemptAndFailIntent (attempt) failed:', attemptErr.message)
        return
      }
      // If the guarded update matched nothing, something else already
      // resolved this attempt between the sweep's SELECT and this UPDATE
      // (a real recovery landing, or a concurrent reaper run) -- correctly
      // leave the intent alone in that case rather than failing an intent
      // whose attempt just legitimately succeeded.
      if (count === 0) return
      const { error: intentErr } = await supabase
        .from('transaction_intents')
        .update({ status: 'FAILED', completed_at: new Date().toISOString() })
        .eq('id', intentId)
        .eq('status', 'SUBMITTED')
      if (intentErr) console.error('[attempt-reaper] dropAttemptAndFailIntent (intent) failed:', intentErr.message)
    },
  }
}
