import type { PendingBiometricRegistration } from './biometric'

// Hands the just-verified passcode to the "Enable biometric" screen in
// memory only. Router state is written into browser history (and to disk for
// session restore), so a PIN must never travel that way.
let pending: string | null = null
// Or a registration / passcode re-seal that only needs its confirming tap.
let pendingRegistration: PendingBiometricRegistration | null = null

export function handBiometricPending(p: PendingBiometricRegistration): void { pendingRegistration = p }

export function takeBiometricPending(): PendingBiometricRegistration | null {
  const p = pendingRegistration
  pendingRegistration = null
  return p
}

export function handBiometricPasscode(pin: string): void { pending = pin }

export function takeBiometricPasscode(): string { return pending ?? '' }

/** Forget it (the biometric screen calls this when it closes). */
export function clearBiometricPasscode(): void { pending = null; pendingRegistration = null }
