// src/lib/socialWallet.ts
//
// What's left of the older Google / email wallets (walletSource
// 'social-auto'): clearing the per-device state they kept. New Google /
// email accounts use Privy (src/wallet/privy.ts); passkey and Recovery QR
// backups were removed.

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
