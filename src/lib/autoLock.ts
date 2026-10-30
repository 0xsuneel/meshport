// The auto-lock policy: how long MeshPort stays unlocked without use - on
// screen and untouched (App.tsx idle lock), or in the background (App.tsx on
// return, main.tsx on a reload of a discarded tab). One setting for both,
// chosen in Settings → Security. Locking drops the open wallet (store
// lock()), so a longer time keeps payments instant for longer; the passcode
// / biometric still approves every payment either way.

export const AUTO_LOCK_OPTIONS = [1, 5, 15, 30] as const
export type AutoLockMinutes = typeof AUTO_LOCK_OPTIONS[number]
export const DEFAULT_AUTO_LOCK_MINUTES: AutoLockMinutes = 15

/** A stored value, or the default when it's missing / not one of the options. */
export function normalizeAutoLockMinutes(m: unknown): AutoLockMinutes {
  return (AUTO_LOCK_OPTIONS as readonly unknown[]).includes(m) ? m as AutoLockMinutes : DEFAULT_AUTO_LOCK_MINUTES
}

export function autoLockMs(m: unknown): number {
  return normalizeAutoLockMinutes(m) * 60_000
}

/** Whether time away (hidden since `hiddenAt`) has passed the auto-lock time. */
export function awayPastAutoLock(hiddenAt: number, now: number, m: unknown): boolean {
  return hiddenAt > 0 && now - hiddenAt > autoLockMs(m)
}

export function autoLockLabel(m: AutoLockMinutes): string {
  return m === 1 ? '1 min' : `${m} min`
}
