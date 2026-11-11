// The passcode sheet's stand-in for a passcode the wallet frame checked on
// its own page (lib/walletConfirm). No imports: security.ts and
// restoreWallet.ts read it.

const TOKEN = 'wallet-confirmed:'
const TOKEN_MS = 2 * 60_000
const issued = new Map<string, number>()

export function isWalletConfirmToken(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(TOKEN)
}

/** Issued by this page in the last 2 minutes (a token can't be made up). */
export function walletConfirmTokenValid(value: string): boolean {
  const at = issued.get(value)
  return at != null && Date.now() - at < TOKEN_MS
}

/** The wallet's ticket inside a valid token (an exact-request confirmation). */
export function walletConfirmTicket(value: string): string | null {
  return isWalletConfirmToken(value) && walletConfirmTokenValid(value) ? value.slice(TOKEN.length) : null
}

export function issueWalletConfirmToken(ticket: string): string {
  const now = Date.now()
  for (const [t, at] of issued) if (now - at >= TOKEN_MS) issued.delete(t)
  const token = TOKEN + ticket
  issued.set(token, now)
  return token
}
