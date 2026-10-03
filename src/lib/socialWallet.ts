// src/lib/socialWallet.ts
//
// Self-custodial wallets for Google / email accounts — the pieces shared by
// sign-up, unlock, recovery and the Security page.
//
//   MeshPort account (users.id) ──▶ one wallet address
//        ├─ passkeys (walletPasskey.ts)  — unlock on any device they sync to
//        └─ Recovery QR (recoveryQr.ts) — unlock anywhere with the password
//
// The wallet key is made on the device and never sent to MeshPort. On THIS
// device a copy is kept sealed with the browser's non-extractable device key
// (security.ts sealForDevice), so a reload doesn't need Face ID or the QR —
// the same layer the chat identity uses. Logout removes it.

import { supabase } from './supabase'

const DEVICE_COPY_PREFIX = 'meshport_social_dv_'
const SECURED_PREFIX = 'meshport_social_secured_'

async function addressOf(privateKey: string): Promise<string> {
  const { privateKeyToAccount } = await import('viem/accounts')
  return privateKeyToAccount(privateKey as `0x${string}`).address
}

/** A brand-new wallet key, made on this device (never by MeshPort's servers). */
export async function createLocalWallet(): Promise<{ address: string; privateKey: string }> {
  const { generatePrivateKey } = await import('viem/accounts')
  const privateKey = generatePrivateKey()
  return { address: await addressOf(privateKey), privateKey }
}

/** Keep this device's sealed copy so a reload opens the wallet directly. */
export async function saveDeviceCopy(walletAddress: string, privateKey: string): Promise<void> {
  try {
    const { sealForDevice } = await import('./security')
    const sealed = await sealForDevice(privateKey)
    if (sealed) localStorage.setItem(DEVICE_COPY_PREFIX + walletAddress.toLowerCase(), sealed)
  } catch { /* storage blocked — the wallet then opens with the passkey / QR */ }
}

/** This device's copy of the wallet key, if it has one and it's this wallet's. */
export async function loadDeviceCopy(walletAddress: string): Promise<string | null> {
  try {
    const sealed = localStorage.getItem(DEVICE_COPY_PREFIX + walletAddress.toLowerCase())
    if (!sealed) return null
    const { openFromDevice } = await import('./security')
    const pk = await openFromDevice(sealed)
    if (!pk) return null
    return (await addressOf(pk)).toLowerCase() === walletAddress.toLowerCase() ? pk : null
  } catch { return null }
}

/** Logout: forget every device copy and cached status. */
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
