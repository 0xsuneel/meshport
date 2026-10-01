// src/lib/adminRecovery.ts
//
// Admin side of stuck-funds recovery (Admin Panel → Stuck Funds). Everything
// goes through the cctp-recovery Edge Function, which checks the caller is in
// admin_users and logs every action to admin_recovery_log.
//
// Every call takes a row id and nothing else — no address, chain or amount
// is ever sent, so an admin cannot change where funds go.

import { supabase } from './supabase'
import { describeFunctionsError } from './describeFunctionsError'
import type { CctpDiagnosis } from './cctpRecovery'

export type StuckKind = 'claim' | 'transfer' | 'ub_transfer' | 'ub_claim' | 'ub_withdrawal'

export type StuckItem = {
  kind: StuckKind
  id: string
  wallet: string
  username: string | null
  route: 'CCTP' | 'UB'
  from: string
  to: string
  destinationAddress: string | null
  amount: number
  status: string
  error: string | null
  txHash: string | null
  attempts?: number
  readyAt?: string | null
  createdAt: string
}

export type AdminActionResult = Omit<Partial<CctpDiagnosis>, 'state'> & { state?: string; error?: string; detail?: string }

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('cctp-recovery', { body })
  if (error) throw new Error(await describeFunctionsError(error, 'Admin recovery request failed'))
  return data as T
}

export function adminListStuck(): Promise<{ items: StuckItem[]; relayerConfigured: boolean }> {
  return call({ action: 'admin-list' })
}
export function adminInspect(kind: 'claim' | 'transfer', id: string): Promise<AdminActionResult> {
  return call({ action: 'inspect', kind, id })
}
export function adminFinishClaim(id: string): Promise<AdminActionResult> {
  return call({ action: 'retry-relay', id })
}
export function adminReattest(kind: 'claim' | 'transfer', id: string): Promise<AdminActionResult> {
  return call({ action: 'reattest', kind, id })
}
export function adminRelayTransfer(id: string): Promise<AdminActionResult> {
  return call({ action: 'admin-relay-transfer', id })
}
export function adminRequeueUbClaim(id: string): Promise<AdminActionResult> {
  return call({ action: 'admin-requeue-ub-intent', id })
}
export function adminNotifyUser(kind: StuckKind, id: string): Promise<AdminActionResult> {
  return call({ action: 'admin-notify', kind, id })
}

export type RecoveryLogRow = {
  id: string; admin_email: string | null; action: string; target_kind: string; target_id: string
  result: Record<string, unknown>; created_at: string
}
export async function fetchRecoveryLog(limit = 25): Promise<RecoveryLogRow[]> {
  const { data } = await supabase.from('admin_recovery_log').select('*').order('created_at', { ascending: false }).limit(limit)
  return (data ?? []) as RecoveryLogRow[]
}
