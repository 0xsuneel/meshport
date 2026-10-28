// Admin console client - every call goes to the admin-api edge function,
// which checks the admin's role (and 2FA once required) on the server.
import { supabase } from './supabase'
import { describeFunctionsError } from './describeFunctionsError'

export type AdminRole = 'owner' | 'operations' | 'support' | 'viewer'

async function call<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke('admin-api', { body: { action, ...body } })
  if (error) {
    const msg = await describeFunctionsError(error, 'Admin request failed')
    // Not deployed yet (404) reads better as a plain sentence on the page.
    if (/404|not found/i.test(msg) && !/Unknown action/.test(msg)) throw new Error('The admin-api server function is not deployed yet.')
    throw new Error(msg)
  }
  return data as T
}

// ── Me ──────────────────────────────────────────────────────────────────────
export type AdminMe = { id: string; email: string | null; role: AdminRole; aal: string; mfaRequired: boolean }
export const adminMe = () => call<AdminMe>('me')

// ── Transactions ────────────────────────────────────────────────────────────
export type TxKind = 'pay' | 'receive' | 'swap' | 'crosschain' | 'claim' | 'bulk' | 'p2p' | 'withdraw'
export type TxStatusFilter = 'completed' | 'failed' | 'pending'

export type ActivityRow = {
  id: string
  wallet_address: string
  tx_hash: string
  activity_type: string
  amount: number
  token_symbol: string | null
  source_chain: string | null
  destination_chain: string | null
  counterparty_address: string | null
  status: string
  explorer_url: string | null
  error: string | null
  metadata: Record<string, any> | null
  destination_tx_hash: string | null
  created_at: string
  updated_at?: string | null
}
export type WalletName = { username: string | null; display_name: string | null; user_id: string; auth_uid: string | null }
export type TxListResult = { rows: ActivityRow[]; names: Record<string, WalletName>; next: string | null }

export const adminTxList = (f: { kind?: TxKind | null; status?: TxStatusFilter | null; q?: string; from?: string; to?: string; before?: string | null; limit?: number }) =>
  call<TxListResult>('tx.list', f)

export type TxStats = {
  by_kind: Record<string, { total: number; completed: number; failed: number; pending: number }>
  failure_reasons: { kind: string; code: string; reason: string; count: number }[]
  stuck_intents: Record<string, number>
  attempt_failures: { status: string; code: string; count: number }[]
}
export const adminTxStats = (range: '24h' | '7d' | '30d') => call<TxStats>('tx.stats', { range })

export type TxIntent = {
  id: string; feature: string; operation: string | null; status: string; amount_atomic: string; decimals: number
  token_symbol: string | null; source_chain: string | null; destination_chain: string | null
  recipient_address: string | null; recipient_username: string | null
  failure_code: string | null; failure_message: string | null
  created_at: string; updated_at: string; completed_at: string | null; metadata: Record<string, any>
}
export type TxAttempt = {
  id: string; intent_id: string; chain_id: string; tx_hash: string | null; nonce: number | null; status: string
  submitted_at: string | null; confirmed_at: string | null; block_number: number | null
  gas_used: string | null; gas_price: string | null; failure_code: string | null; failure_message: string | null
  created_at: string; updated_at: string
}
export type TxLedger = { id: string; event_type: string; direction: string; amount_atomic: string; decimals: number; token_symbol: string | null; settlement_status: string; tx_hash: string | null; created_at: string }
export type TxDetail = {
  row: ActivityRow | null
  twin: { id: string; wallet_address: string; status: string; created_at: string } | null
  intents: TxIntent[]
  attempts: TxAttempt[]
  ledger: TxLedger[]
  names: Record<string, WalletName>
  appErrors: { created_at: string; kind: string; path: string | null; message: string | null; build: string | null }[]
  chain: { found: boolean | null; status?: 'success' | 'reverted'; block?: number; gasUsed?: number; from?: string; to?: string } | null
}
export const adminTxDetail = (id: string) => call<TxDetail>('tx.detail', { id })

// ── System: RPC + app errors ────────────────────────────────────────────────
export type RpcEndpointHealth = {
  chain: string; label: string; authenticated: boolean; ok: boolean; latencyMs: number
  chainId?: number; block?: number; lag: number | null; error?: string; rateLimited?: boolean
}
export const adminRpcHealth = () => call<{ checkedAt: string; endpoints: RpcEndpointHealth[] }>('rpc.health')

export type UsageSum = { calls: number; ok: number; errors: number; rate_limited: number; cancelled: number; latency_ms_total: number }
export type RpcUsage = {
  from: string
  totals: { client: UsageSum; upstream: UsageSum }
  byEndpoint: (UsageSum & { key: string })[]
  byMethod: (UsageSum & { key: string })[]
  series: (UsageSum & { key: string })[]
}
export const adminRpcUsage = (range: '1h' | '24h' | '7d') => call<RpcUsage>('rpc.usage', { range })

export type AppErrorGroup = { message: string; kind: string; count: number; users: number; lastAt: string; paths: string[]; builds: string[] }
export const adminAppErrors = (range: '1h' | '24h' | '7d') => call<{ total: number; groups: AppErrorGroup[] }>('errors.list', { range })

// ── Logs ────────────────────────────────────────────────────────────────────
export type LogSource = 'admin' | 'settings' | 'recovery' | 'p2p'
export type LogItem = { at: string; source: LogSource; who: string | null; role?: string | null; action: string; target: string; reason?: string | null; before?: unknown; after?: unknown }
export const adminLogs = (source: LogSource | 'all', before?: string | null) => call<{ items: LogItem[]; next: string | null }>('logs.list', { source, before })

// ── Admins ──────────────────────────────────────────────────────────────────
export type AdminAccount = { id: string; email: string | null; role: AdminRole; lastSignInAt: string | null; twoFactor: boolean }
export const adminList = () => call<{ admins: AdminAccount[] }>('admins.list')
export const adminSetRole = (id: string, role: AdminRole, reason: string) => call<{ ok: boolean }>('admins.setRole', { id, role, reason })
