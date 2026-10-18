// src/lib/accountRules.ts
//
// Account-type rules for signing in (pure - no I/O, unit tested).
//
// The first auth screen asks two things: Create account or Log in, and
// Personal or Business. An account's type is fixed when it is created
// (users.account_type, guarded server-side), so:
//   - Log in to an account of the other type   → mismatch (offer the right type)
//   - Log in with no MeshPort account yet       → no_account (offer Create account)
//   - Create account with a login/wallet that
//     already has a MeshPort account            → already_exists (offer Log in)
// Only the Create account path may create a new account.

import type { AccountKind } from './onchainNames'

export type AuthMode = 'create' | 'login'

/** What MeshPort has for this login / wallet: no account, or its type. */
export type FoundAccount = 'none' | AccountKind

export type AccessDecision =
  | { kind: 'allow' }
  | { kind: 'mismatch'; existing: AccountKind }
  | { kind: 'no_account' }
  | { kind: 'already_exists'; existing: AccountKind }

/**
 * @param chosen the type picked on the entry screen (null = not chosen, e.g.
 *   an older in-progress sign-in: the found account's own type is used)
 * @param found  the account this login / wallet already has
 * @param mode   Create account or Log in
 */
export function decideAccountAccess(chosen: AccountKind | null, found: FoundAccount, mode: AuthMode): AccessDecision {
  if (mode === 'create') {
    return found === 'none' ? { kind: 'allow' } : { kind: 'already_exists', existing: found }
  }
  if (found === 'none') return { kind: 'no_account' }
  if (chosen && chosen !== found) return { kind: 'mismatch', existing: found }
  return { kind: 'allow' }
}

/**
 * An account exists when there is a users row with a username (a row is only
 * ever written by the claim-username step, with its username). Anything but
 * account_type = 'business' is a personal account.
 */
export function foundAccountOf(user: { username?: string | null; account_type?: string | null } | null | undefined): FoundAccount {
  if (!user || !user.username) return 'none'
  return user.account_type === 'business' ? 'business' : 'personal'
}
