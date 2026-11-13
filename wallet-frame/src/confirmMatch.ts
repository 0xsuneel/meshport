// wallet-frame/src/confirmMatch.ts
//
// Whether what the person approves is what the wallet will sign (the
// passcode page, confirmPage.ts). Pure - no page, no DOM - so it is tested.
//
// The app's summary ("Paying ravi.arc $5") is the app's own words and can't
// be trusted on its own: the wallet runs on its own origin exactly so a
// compromised app can't get a payment signed that the person never saw. The
// wallet's reading of the transaction (IntentView) is what gets signed.

import type { ConfirmSummary } from '@/wallet/protocol'
import type { IntentView } from './intent'

export function splitAmount(amount: string, token: string): [string, string] {
  if (token) return [amount, token]
  const m = /^([0-9][0-9.,]*) ([A-Za-z]+)$/.exec(amount.trim())
  return m ? [m[1], m[2]] : [amount, '']
}

const num = (s: string | undefined) => { const n = parseFloat(String(s ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : NaN }
/**
 * The wallet's reading next to the app's words: the amount and token the
 * wallet read, and whether the app's figure is that same amount (a spend
 * limit counts as the same when it covers it with up to 10% for fees).
 * Several tokens at once ("2 USDC + 1 EURC") never count as the app's one figure.
 */
export function compare(view: IntentView, summary: ConfirmSummary | null) {
  const scope = view.to === 'may leave your wallet'
  const [amount, unit] = splitAmount(view.amount, view.token)
  const appN = num(summary?.amount), walletN = num(amount)
  const single = !!unit || !/\+/.test(view.amount)
  const sameUnit = !summary?.unit || !unit || summary.unit === unit
  // A spend limit may sit above the amount by the route's fees: up to 10% plus
  // 1 more (a cross-chain send's fee and margin). Larger than that, the card
  // shows the wallet's own figure.
  const same = single && sameUnit && Number.isFinite(appN) && Number.isFinite(walletN)
    && (scope ? walletN >= appN && walletN <= appN * 1.1 + 1 + 1e-9 : Math.abs(walletN - appN) < 1e-9)
  // The limit itself, when it is more than the amount: rounded UP to cents, never shown less than it is.
  const limit = scope && same && walletN > appN + 1e-9 ? `${(Math.ceil(walletN * 100 - 1e-6) / 100).toString()} ${unit}` : null
  return { scope, amount, unit, same, limit }
}
/** An address the wallet read as who gets paid (not a spend limit's "may leave your wallet"). */
const PAYS_ADDRESS = /^0x[0-9a-fA-F]{40}$/

/**
 * Whether a passcode typed BEFORE the wallet's reading arrived may go ahead.
 * Until then the card showed only the app's words. The amount can be checked
 * against them; the recipient can't - the app names a person ("ravi.arc"),
 * the wallet reads an address, and a compromised app would simply say the
 * same thing as the transaction it slipped in. So when the wallet reads a
 * payment to an address, the person must see the wallet's own card first:
 * no early passcode goes through (audit 13 Nov: an early passcode used to
 * pay on a matching amount alone, the recipient never shown).
 * A spend limit (scope) names no recipient - the limit is what the wallet
 * enforces - so it may still go ahead when the amount matches.
 */
export function agrees(view: IntentView | null, appSummary: ConfirmSummary | null): boolean {
  if (!view) return true // nothing read (an app summary on its own) - as shown
  if (PAYS_ADDRESS.test(view.to)) return false
  return !view.warnings.length && compare(view, appSummary).same
}
