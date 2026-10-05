import { supabase } from './supabase'

// ─── Types ────────────────────────────────────────────────────────────────────
export interface AppSetting {
  id: string
  feature: string
  enabled: boolean
  category: string
  label: string | null
  value: string | null
  updated_at: string
}

export interface SettingsLog {
  id: string
  feature: string
  old_value: string | null
  new_value: string | null
  changed_by: string | null
  created_at: string
}

export type SettingsMap = Record<string, AppSetting>

// ─── Fetch all settings, keyed by `feature` ──────────────────────────────────
export async function fetchAllSettings(): Promise<SettingsMap> {
  const { data, error } = await supabase.from('app_settings').select('*').order('category')
  if (error) { console.error('[adminSupabase] fetchAllSettings:', error.message); return {} }
  const map: SettingsMap = {}
  for (const row of (data || []) as AppSetting[]) map[row.feature] = row
  return map
}

export async function fetchSettingsByCategory(category: string): Promise<AppSetting[]> {
  const { data, error } = await supabase
    .from('app_settings').select('*').eq('category', category).order('label')
  if (error) { console.error('[adminSupabase] fetchSettingsByCategory:', error.message); return [] }
  return (data || []) as AppSetting[]
}

// ─── Update a single feature toggle ──────────────────────────────────────────
export async function updateSetting(feature: string, enabled: boolean): Promise<{ error: string | null }> {
  const { error } = await supabase.from('app_settings').update({ enabled }).eq('feature', feature)
  if (error) { console.error('[adminSupabase] updateSetting:', error.message); return { error: error.message } }
  return { error: null }
}

// ─── Update the maintenance message text ─────────────────────────────────────
export async function updateSettingValue(feature: string, value: string): Promise<{ error: string | null }> {
  const { error } = await supabase.from('app_settings').update({ value }).eq('feature', feature)
  if (error) return { error: error.message }
  return { error: null }
}

// ─── Realtime subscription — pushes live toggle changes to every client ─────
export function subscribeToSettings(onChange: () => void) {
  const channel = supabase
    .channel('app_settings_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings' }, onChange)
    .subscribe()
  return () => { supabase.removeChannel(channel) }
}

// ─── Admin auth ───────────────────────────────────────────────────────────────
export async function isAdminUser(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('admin_users').select('id').eq('id', userId).maybeSingle()
  if (error) return false
  return !!data
}

export async function adminSignIn(email: string, password: string): Promise<{ error: string | null }> {
  const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
  if (error) return { error: error.message }
  if (!data.user) return { error: 'Login failed' }
  const admin = await isAdminUser(data.user.id)
  if (!admin) {
    await supabase.auth.signOut()
    return { error: 'This account does not have admin access.' }
  }
  return { error: null }
}

export async function adminSignOut(): Promise<void> {
  await supabase.auth.signOut()
}

export async function getCurrentAdminEmail(): Promise<string | null> {
  const { data } = await supabase.auth.getUser()
  if (!data.user) return null
  const admin = await isAdminUser(data.user.id)
  return admin ? (data.user.email ?? null) : null
}

// ─── Change password (email OTP verified) ────────────────────────────────────
// Three-step flow, all requiring the admin to already be signed in (this is
// a "change my own password" feature, not an account-recovery one):
//   1. sendAdminPasswordChangeOtp — emails a 6-digit code to the admin's own
//      address on file (never a user-supplied address, so this can't be used
//      to send a code anywhere but the account's own verified inbox).
//   2. verifyAdminPasswordChangeOtp — confirms that code. Supabase treats a
//      correct verifyOtp call as re-proof-of-identity and refreshes the
//      session, which is what makes step 3 allowed to proceed.
//   3. updateAdminPassword — only callable after step 2 succeeded in this
//      session; sets the new password via supabase.auth.updateUser.
export async function sendAdminPasswordChangeOtp(): Promise<{ error: string | null }> {
  const email = await getCurrentAdminEmail()
  if (!email) return { error: 'You must be signed in as an admin to change your password.' }
  // shouldCreateUser: false — this must be an existing admin account, never
  // silently creates a new auth user from an email typed elsewhere.
  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } })
  if (error) return { error: error.message }
  return { error: null }
}

export async function verifyAdminPasswordChangeOtp(token: string): Promise<{ error: string | null }> {
  const email = await getCurrentAdminEmail()
  if (!email) return { error: 'You must be signed in as an admin to change your password.' }
  const { error } = await supabase.auth.verifyOtp({ email, token: token.trim(), type: 'email' })
  if (error) return { error: error.message }
  return { error: null }
}

export async function updateAdminPassword(newPassword: string): Promise<{ error: string | null }> {
  const { error } = await supabase.auth.updateUser({ password: newPassword })
  if (error) return { error: error.message }
  return { error: null }
}

// ─── Logs ─────────────────────────────────────────────────────────────────────
export async function fetchSettingsLogs(limit = 50): Promise<SettingsLog[]> {
  const { data, error } = await supabase
    .from('settings_logs').select('*').order('created_at', { ascending: false }).limit(limit)
  if (error) { console.error('[adminSupabase] fetchSettingsLogs:', error.message); return [] }
  return (data || []) as SettingsLog[]
}

// ─── Analytics ──────────────────────────────────────────────────────────────
export interface AdminAnalytics {
  usersCount: number
  newUsersToday: number
  transactionsCount: number
  treasuryBalance: number
  totalMultichainTransfers: number
  totalMultichainClaims: number
  totalSwapVolume: number
  activeUsersCount: number
  totalBulkPayments: number
  // kept for anywhere still reading the old today-scoped fields
  claimsToday: number
  transfersToday: number
  swapVolumeToday: number
  transactionsToday: number
  bulkPaymentsToday: number
}

// "Active" = a wallet that sent/received a regular payment or did a
// multichain op (claim/bridge/deposit/swap) in the last 30 days. There's no
// login/session tracking in this app, so on-chain-adjacent activity is the
// only real signal of "still using it" we have.
const ACTIVE_WINDOW_DAYS = 30

export async function fetchAdminAnalytics(): Promise<AdminAnalytics> {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
  const todayIso = todayStart.toISOString()

  const activeSince = new Date(); activeSince.setDate(activeSince.getDate() - ACTIVE_WINDOW_DAYS)
  const activeSinceIso = activeSince.toISOString()

  const [
    usersCount, newUsersToday,
    txCount, bulkCount,
    claimsCount, transfersCount, swapRows,
    claimsToday, transfersToday, swapRowsToday,
    txCountToday, bulkCountToday,
    activeActivityRows, activeClaimsRows,
  ] = await Promise.all([
    supabase.from('users').select('id', { count: 'exact', head: true }),
    supabase.from('users').select('id', { count: 'exact', head: true }).gte('created_at', todayIso),

    // Distinct-transaction count, NOT a raw row count — see the
    // admin_transaction_count() SQL function (migration:
    // admin_transaction_count_dedup) for why a plain count(*) on
    // `activity` overcounts: every in-app peer-to-peer Send writes BOTH a
    // 'send' row and a 'receive' row for the same underlying transfer
    // (see ActivityService.ts's Activity.send/receive — 'send_<hash>' vs
    // 'recv_<hash>'), so a raw count double-counts every such transfer.
    // Confirmed directly against production data: 323 raw rows was
    // actually 280 distinct transactions (43 transfers counted twice).
    supabase.rpc('admin_transaction_count', { since_ts: null }),
    supabase.from('bulk_payments').select('*', { count: 'exact', head: true }),

    // Claims live in their own dedicated table (claims), not activity —
    // see claimService.ts / claim-worker. Counting every attempted claim
    // row here, not just completed ones, to match "Total Multichain
    // Claims" as a genuine activity count rather than a success rate.
    supabase.from('claims').select('*', { count: 'exact', head: true }),
    supabase.from('activity').select('*', { count: 'exact', head: true }).eq('activity_type', 'bridge'),
    supabase.from('activity').select('amount').eq('activity_type', 'swap'),

    // Kept for backward compat with anything still reading *Today fields
    supabase.from('claims').select('*', { count: 'exact', head: true }).gte('created_at', todayIso),
    supabase.from('activity').select('*', { count: 'exact', head: true })
      .eq('activity_type', 'bridge').gte('created_at', todayIso),
    supabase.from('activity').select('amount')
      .eq('activity_type', 'swap').gte('created_at', todayIso),

    // "Today" scope for the two stats that previously had no *Today
    // counterpart at all — Total Transactions and Bulk Payments — so the
    // Analytics screen can show "total + N today" consistently across
    // every card instead of only some of them. Transactions-today uses
    // the same deduped function, scoped by created_at.
    supabase.rpc('admin_transaction_count', { since_ts: todayIso }),
    supabase.from('bulk_payments').select('*', { count: 'exact', head: true }).gte('created_at', todayIso),

    // Active-users source data — every activity row already has both
    // sides of the transfer (wallet_address = this user, counterparty_
    // address = the other party where applicable), and claims has its own
    // wallet_address. Using both keeps this consistent with how "active"
    // was defined before (any on-chain-adjacent activity in the window).
    supabase.from('activity').select('wallet_address, counterparty_address').gte('created_at', activeSinceIso),
    supabase.from('claims').select('wallet_address').gte('created_at', activeSinceIso),
  ])

  const swapVolume      = (swapRows.data || []).reduce((sum: number, r: any) => sum + (parseFloat(r.amount) || 0), 0)
  const swapVolumeToday = (swapRowsToday.data || []).reduce((sum: number, r: any) => sum + (parseFloat(r.amount) || 0), 0)

  const activeAddresses = new Set<string>()
  for (const r of (activeActivityRows.data || []) as any[]) {
    if (r.wallet_address)        activeAddresses.add(r.wallet_address)
    if (r.counterparty_address)  activeAddresses.add(r.counterparty_address)
  }
  for (const r of (activeClaimsRows.data || []) as any[]) {
    if (r.wallet_address) activeAddresses.add(r.wallet_address)
  }

  return {
    usersCount:                usersCount.count ?? 0,
    newUsersToday:              newUsersToday.count ?? 0,
    transactionsCount:         Number(txCount.data ?? 0),
    treasuryBalance:           0, // wired up from on-chain treasury balance on the Treasury screen
    totalMultichainTransfers:  transfersCount.count ?? 0,
    totalMultichainClaims:     claimsCount.count ?? 0,
    totalSwapVolume:           swapVolume,
    activeUsersCount:          activeAddresses.size,
    totalBulkPayments:         bulkCount.count ?? 0,
    claimsToday:               claimsToday.count ?? 0,
    transfersToday:            transfersToday.count ?? 0,
    swapVolumeToday,
    transactionsToday:         Number(txCountToday.data ?? 0),
    bulkPaymentsToday:         bulkCountToday.count ?? 0,
  }
}

// ─── Support tickets ────────────────────────────────────────────────────────
export interface AdminSupportTicket {
  id:            string
  userId:        string | null
  walletAddress: string | null
  email:         string | null
  username:      string | null
  subject:       string
  message:       string
  status:        'open' | 'in_progress' | 'resolved' | 'closed'
  adminReply:    string | null
  repliedBy:     string | null
  repliedAt:     string | null
  createdAt:     string
}

export async function fetchAllSupportTickets(): Promise<AdminSupportTicket[]> {
  const { data, error } = await supabase
    .from('support_tickets')
    .select('id, user_id, wallet_address, email, username, subject, message, status, admin_reply, replied_by, replied_at, created_at')
    .order('created_at', { ascending: false })
  if (error) { console.error('[adminSupabase] fetchAllSupportTickets:', error.message); return [] }
  return (data ?? []).map((r: any) => ({
    id:            r.id,
    userId:        r.user_id,
    walletAddress: r.wallet_address,
    email:         r.email,
    username:      r.username,
    subject:       r.subject,
    message:       r.message,
    status:        r.status,
    adminReply:    r.admin_reply,
    repliedBy:     r.replied_by,
    repliedAt:     r.replied_at,
    createdAt:     r.created_at,
  }))
}

export async function replyToSupportTicket(params: {
  ticketId:  string
  reply:     string
  status:    'in_progress' | 'resolved' | 'closed'
  repliedBy: string
}): Promise<{ success: boolean; error: string | null }> {
  const { error } = await supabase.from('support_tickets').update({
    admin_reply: params.reply,
    status:      params.status,
    replied_by:  params.repliedBy,
    replied_at:  new Date().toISOString(),
  }).eq('id', params.ticketId)
  if (error) { console.error('[adminSupabase] replyToSupportTicket:', error.message); return { success: false, error: error.message } }
  return { success: true, error: null }
}

export async function updateSupportTicketStatus(ticketId: string, status: AdminSupportTicket['status']): Promise<void> {
  const { error } = await supabase.from('support_tickets').update({ status }).eq('id', ticketId)
  if (error) console.error('[adminSupabase] updateSupportTicketStatus:', error.message)
}
