// src/lib/socialWallet.ts
//
// Self-custodial wallets for Google / email accounts - the pieces shared by
// sign-up, unlock, recovery and the Security page.
//
//   MeshPort account (users.id) ──▶ one wallet address
//        ├─ passkeys (walletPasskey.ts)  - unlock on any device they sync to
//        └─ Recovery QR (recoveryQr.ts) - unlock anywhere with the password
//
// The wallet key is made on the device, inside the wallet frame (src/wallet),
// and never sent to MeshPort. The frame keeps THIS device's copy sealed with
// its own non-extractable device key, so a reload doesn't need Face ID or the
// QR; logout removes it. What's left here is the account's security status.

import { supabase } from './supabase'

const DEVICE_COPY_PREFIX = 'meshport_social_dv_'
const SECURED_PREFIX = 'meshport_social_secured_'

/** Logout: forget the cached status (and any device copy left from before the wallet frame). */
export function clearSocialDeviceState(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k?.startsWith(DEVICE_COPY_PREFIX) || k?.startsWith(SECURED_PREFIX)) localStorage.removeItem(k)
    }
  } catch { /* storage blocked */ }
}

export interface WalletSecurityStatus {
  passkeys: number
  recoveryQrAt: string | null
  secured: boolean
}

/** Passkeys / Recovery QR for this account. null when it couldn't be checked (offline). */
export async function getWalletSecurityStatus(userId: string): Promise<WalletSecurityStatus | null> {
  const [pk, u] = await Promise.all([
    supabase.from('wallet_passkeys').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    supabase.from('users').select('recovery_qr_at').eq('id', userId).maybeSingle(),
  ])
  if (pk.error || u.error) return null
  const passkeys = pk.count ?? 0
  const recoveryQrAt = (u.data?.recovery_qr_at as string | null) ?? null
  const status = { passkeys, recoveryQrAt, secured: passkeys > 0 || !!recoveryQrAt }
  try { if (status.secured) localStorage.setItem(SECURED_PREFIX + userId, '1') } catch { /* */ }
  return status
}

/** Last known "has a passkey or Recovery QR" on this device (no network). */
export function knownSecured(userId: string): boolean {
  try { return localStorage.getItem(SECURED_PREFIX + userId) === '1' } catch { return false }
}

/** Record that a Recovery QR was made (the date only). */
export async function markRecoveryQrCreated(userId: string): Promise<boolean> {
  const { error } = await supabase.from('users').update({ recovery_qr_at: new Date().toISOString() }).eq('id', userId)
  return !error
}

/** Login methods linked to this sign-in (Google, email…), from Supabase Auth. */
export async function linkedLoginMethods(): Promise<Array<{ provider: string; email: string | null }>> {
  const { data } = await supabase.auth.getUser()
  return (data.user?.identities ?? []).map(i => ({
    provider: i.provider,
    email: (i.identity_data as any)?.email ?? null,
  }))
}
