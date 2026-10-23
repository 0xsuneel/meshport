// The words on every fingerprint / Face ID step, in one place so the lock
// screen and every approval sheet say the same thing.
//   Idle (prompt cancelled or not opened yet): "Unlock with Face ID",
//   "Pay with fingerprint", "Confirm with Touch ID".
//   Prompt open: "Waiting for Face ID…".
// `label` is biometricLabel(): 'Face ID' | 'Touch ID' | 'Fingerprint' |
// 'Windows Hello' | 'Biometric'.

// One verb per flow, so each says what it does: "Swap with Face ID",
// "Transfer with fingerprint", "Claim with fingerprint"...
export type BiometricVerb =
  | 'Unlock' | 'Pay' | 'Swap' | 'Transfer' | 'Claim' | 'Refund' | 'Settle'
  | 'Release' | 'Post' | 'Buy' | 'Sell' | 'Save' | 'Top up' | 'Confirm'

/** How the method reads inside a sentence ("with fingerprint", "with Face ID"). */
export function biometricNoun(label: string): string {
  if (label === 'Fingerprint') return 'fingerprint'
  if (label === 'Biometric') return 'biometrics'
  return label
}

export function biometricAction(verb: BiometricVerb, label: string): string {
  return `${verb} with ${biometricNoun(label)}`
}

export function biometricWaiting(label: string): string {
  return `Waiting for ${biometricNoun(label)}…`
}
