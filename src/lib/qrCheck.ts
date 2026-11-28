// Business → Check a QR (28 Nov, like Paytm's QR check): is the QR at the
// counter really yours? Someone can stick their own QR over a shop's.

export type QrCheck =
  | { verdict: 'yours'; kind: 'shop' | 'counter' | 'link' | 'wallet'; counterId?: string | null; storeId?: string | null; slug?: string | null }
  | { verdict: 'not_yours'; pays: string; kind: 'meshport' | 'wallet' }
  | { verdict: 'unknown'; text: string }

const WALLET = /^(?:ethereum:)?(0x[0-9a-fA-F]{40})(?:@\d+)?(?:[/?].*)?$/

/** What a scanned QR pays: this business (`me`) or someone else. */
export function checkQr(text: string, me: { username: string; wallet?: string | null }): QrCheck {
  const raw = text.trim()
  const mine = me.username.replace(/\.arc$/i, '').toLowerCase()
  const w = WALLET.exec(raw)
  if (w) {
    return me.wallet && w[1].toLowerCase() === me.wallet.toLowerCase()
      ? { verdict: 'yours', kind: 'wallet' }
      : { verdict: 'not_yours', pays: `${w[1].slice(0, 6)}…${w[1].slice(-4)}`, kind: 'wallet' }
  }
  let u: URL
  try { u = new URL(raw) } catch { return { verdict: 'unknown', text: raw.slice(0, 80) } }
  const parts = u.pathname.split('/').filter(Boolean)
  // /paylink/<shop>[?store=&counter=], /pay/<shop> (old), /l/<shop>/<slug>
  let who: string | null = null, slug: string | null = null
  if ((parts[0] === 'paylink' || parts[0] === 'pay') && parts[1] && parts[1] !== 'r') who = parts[1]
  else if (parts[0] === 'l' && parts[1] && parts[2]) { who = parts[1]; slug = parts[2] }
  if (!who) return { verdict: 'unknown', text: raw.slice(0, 80) }
  who = decodeURIComponent(who).replace(/\.arc$/i, '').toLowerCase()
  if (who !== mine) return { verdict: 'not_yours', pays: `${who}.arc`, kind: 'meshport' }
  const counterId = u.searchParams.get('counter'), storeId = u.searchParams.get('store')
  return { verdict: 'yours', kind: slug ? 'link' : counterId ? 'counter' : 'shop', counterId, storeId, slug }
}
