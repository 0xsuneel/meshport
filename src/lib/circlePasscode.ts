// ── The passcode of Google / email (Circle) wallets, kept in the wallet frame ─
// The frame (wallet-frame/src/fastPayGate.ts) holds the only check of it -
// one per device, like the app's passcode - and checks it for unlocking AND
// for every Fast Pay payment. So there is nothing to keep in step: changing
// the passcode, logging out or in, all go through that one check.
//
//   adopt   a passcode the app just verified against its old hash becomes
//           the frame's check, and the hash is dropped (store passcode =
//           FRAME_PASSCODE, as for create / import wallets). Runs on the
//           first verified passcode after this update, and after a new
//           passcode is set (sign-in on a new device, or a fresh one).
//   check   unlocking: security.ts verifyPasscode → walletApproval → here.
//   change  Security → Change passcode: the frame changes its check only
//           with the current passcode.
//   lost    the frame has no check any more (its storage was cleared): the
//           app signs out; signing in with Google / email again sets a new
//           passcode - as on a new device.

import { useAuthStore } from '@/store'
import { FRAME_PASSCODE, WALLET_UNAVAILABLE, onPasscodeVerified } from './security'

const code = (e: unknown) => (e as { code?: string })?.code

export function isCircleWallet(): boolean {
  const { walletSource, walletAddress } = useAuthStore.getState()
  return walletSource === 'circle' && !!walletAddress
}

async function frame() { return (await import('@/wallet/frameClient')).callWallet }

/** Unlocking: is this the passcode? Throws WALLET_UNAVAILABLE when the frame can't be reached. */
export async function checkCirclePasscode(passcode: string): Promise<boolean> {
  const callWallet = await frame()
  try {
    await callWallet('circle-passcode:check', { passcode })
    return true
  } catch (e) {
    const c = code(e)
    if (c === 'bad-passcode' || c === 'rate-limited') return false
    if (c === 'not-found') {
      // Its check is gone (the frame's storage was cleared). Never "no
      // passcode" here - the lock screen would let anyone continue. Sign
      // out instead: signing in with Google / email again sets a new one,
      // as on a new device.
      const st = useAuthStore.getState()
      st.setPasscode('')
      st.logout()
      return false
    }
    throw new Error(WALLET_UNAVAILABLE)
  }
}

/**
 * Make `passcode` - already verified by the app - the frame's check. A check
 * left from an earlier passcode (this device, before a new sign-in) is
 * replaced: the app's verified hash is the authority until this runs.
 * True once the frame holds it.
 */
export async function adoptCirclePasscode(passcode: string): Promise<boolean> {
  try {
    const callWallet = await frame()
    try {
      await callWallet('circle-passcode:set', { passcode, oldPasscode: passcode })
    } catch (e) {
      const c = code(e)
      if (c !== 'bad-passcode' && c !== 'rate-limited') throw e
      await callWallet('circle-passcode:forget', {})
      await callWallet('circle-passcode:set', { passcode })
    }
    return true
  } catch {
    return false // frame unreachable or its storage blocked: the hash stays, try again next time
  }
}

/**
 * Change passcode. With the frame already holding the check, it changes only
 * with the current passcode, and a failure throws (nothing is changed).
 * Returns true when the frame holds the new one (store FRAME_PASSCODE).
 */
export async function changeCirclePasscode(oldPasscode: string | null, passcode: string): Promise<boolean> {
  if (useAuthStore.getState().passcode === FRAME_PASSCODE) {
    if (!oldPasscode) throw new Error('Enter your current passcode')
    const callWallet = await frame()
    try { await callWallet('circle-passcode:set', { passcode, oldPasscode }) } catch (e) {
      throw new Error(code(e) === 'bad-passcode' ? 'Current passcode is incorrect' : "Couldn't reach your wallet - try again")
    }
    return true
  }
  return adoptCirclePasscode(passcode)
}

// A Google / email wallet's passcode verified against the app's hash: move it to the frame.
onPasscodeVerified(async passcode => {
  if (!isCircleWallet()) return
  const stored = useAuthStore.getState().passcode
  if (!stored || stored === FRAME_PASSCODE) return
  if (await adoptCirclePasscode(passcode)) {
    // Only if nothing changed meanwhile (a passcode change in flight).
    if (useAuthStore.getState().passcode === stored) useAuthStore.getState().setPasscode(FRAME_PASSCODE)
  }
})
