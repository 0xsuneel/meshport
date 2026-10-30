// The auto-lock policy, like UPI apps (Google Pay, PhonePe, Paytm):
//  - a fresh open (app / browser closed, phone restarted) always locks
//    (main.tsx: no session flag);
//  - coming back after more than BACKGROUND_LOCK_MS in the background
//    (switched app, screen off) locks - App.tsx on return, main.tsx on a
//    reload of a tab the phone discarded meanwhile;
//  - on screen it never locks by itself: the phone's own screen timeout
//    turns the screen off, which counts as the background.
// The lock is an app lock only (store lock()); every payment still needs
// the passcode / biometric, like the UPI PIN.

export const BACKGROUND_LOCK_MS = 5 * 60_000

/** Whether time away (hidden since `hiddenAt`) has passed the background lock time. */
export function awayPastAutoLock(hiddenAt: number, now: number): boolean {
  return hiddenAt > 0 && now - hiddenAt > BACKGROUND_LOCK_MS
}
