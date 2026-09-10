/**
 * MeshPort Username Registry
 * Single source of truth: Supabase users table.
 * No mock users. No hardcoded data. No localStorage cache.
 */
import {
  searchUsersDb, resolveUsernameDb, getUserByUsername, isUsernameTakenDb,
  type DbUser,
} from './supabase'

export interface MeshPortUser {
  username: string
  displayName: string
  walletAddress: string
  email?: string
  avatarUrl?: string | null
  createdAt: string
  id?: string
}

function toMeshPortUser(u: DbUser): MeshPortUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    walletAddress: u.wallet_address,
    email: u.email,
    avatarUrl: u.avatar_url,
    createdAt: u.created_at,
  }
}

// ─── Register (called after username claim — actual save is in upsertUserProfile)
export async function registerUsername(params: {
  username: string
  walletAddress: string
  displayName: string
  email?: string
}): Promise<void> {
  // Nothing to do here — upsertUserProfile in ClaimUsernamePage handles Supabase save
}

// ─── Search — always Supabase, no cache ──────────────────────────────────────
export async function searchMeshPortUsersAsync(
  query: string,
  excludeUserId?: string
): Promise<MeshPortUser[]> {
  const results = await searchUsersDb(query, excludeUserId)
  return results.map(toMeshPortUser)
}

// Sync stub — returns empty, async version always used
export function searchMeshPortUsers(_query: string): MeshPortUser[] {
  return []
}

// ─── Resolve username → wallet address ───────────────────────────────────────
export async function resolveUsernameAsync(username: string): Promise<string | null> {
  return resolveUsernameDb(username)
}

export function resolveUsername(_username: string): string | null {
  return null // Always use async version
}

// ─── Lookup full profile ──────────────────────────────────────────────────────
export async function lookupUserAsync(username: string): Promise<MeshPortUser | null> {
  const u = await getUserByUsername(username)
  return u ? toMeshPortUser(u) : null
}

export function lookupUser(_username: string): MeshPortUser | null {
  return null // Always use async version
}

// ─── Check taken ──────────────────────────────────────────────────────────────
export async function isUsernameTakenAsync(username: string): Promise<boolean> {
  return isUsernameTakenDb(username)
}

export function isUsernameTaken(_username: string): boolean {
  return false // Always use async version
}

export async function syncFromCloud(): Promise<void> {
  // No-op: Supabase is always the live source
}
