// The wallet address of the MeshPort account linked to this request's
// Supabase session (users.auth_uid - linked with a wallet signature by
// bind-session), or null. Edge functions that act on a wallet compare the
// wallet in the request against this, so nobody can act for someone else's.
// deno-lint-ignore no-explicit-any
export async function callerWallet(req: Request, db: any): Promise<string | null> {
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!jwt) return null
  try {
    const { data } = await db.auth.getUser(jwt)
    const uid = data?.user?.id
    if (!uid) return null
    const { data: u } = await db.from('users').select('wallet_address').eq('auth_uid', uid).maybeSingle()
    return u?.wallet_address ? String(u.wallet_address).toLowerCase() : null
  } catch { return null }
}

/** True when the attempt row belongs to `wallet`. */
// deno-lint-ignore no-explicit-any
export async function attemptOwnedBy(db: any, attemptId: string, wallet: string): Promise<boolean> {
  if (!attemptId) return false
  const { data } = await db.from('transaction_attempts').select('wallet_address').eq('id', attemptId).maybeSingle()
  return !!data?.wallet_address && String(data.wallet_address).toLowerCase() === wallet
}

/** Business accounts can't spend until MeshPort approves them. */
export const ACCOUNT_LOCKED_ERROR = 'Available after your business is approved'

/**
 * public.account_can_spend for this request's session: false for a business
 * account without an approved application, true for everyone else, null
 * when it couldn't be checked (callers answer "try again", never proceed).
 */
// deno-lint-ignore no-explicit-any
export async function callerCanSpend(req: Request, db: any): Promise<boolean | null> {
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!jwt) return null
  try {
    const { data } = await db.auth.getUser(jwt)
    const uid = data?.user?.id
    if (!uid) return null
    const { data: ok, error } = await db.rpc('account_can_spend', { p_auth_uid: uid })
    if (error || typeof ok !== 'boolean') return null
    return ok
  } catch { return null }
}
