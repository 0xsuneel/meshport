// MeshPort personal payment links - `<app>/paylink/<username>` with an
// optional `?amount=` (Receive / "Collect USDC" share). Chat turns these into
// a card. Links shared before the rename (`<app>/pay/<username>`) still parse.
// Merchant links (`/paylink/r/<code>`) are handled by merchantPay.codeFromLink.

// The links a QR / share carries - one builder, so Home, Receive and Business
// give the same link (and so the same QR) for the same thing:
//   personal  /paylink/<name>             a person; a business's Personal link adds ?personal=1
//                                         (its plain link is its Shop QR)
//   shop      /paylink/<name>?store=<id>  a business's Shop QR for one store
export const PAY_LINK_ORIGIN = 'https://meshport.xyz'
const clean = (u: string) => u.replace(/\.arc$/i, '')
export const personalPayLink = (username: string, business = false) =>
  `${PAY_LINK_ORIGIN}/paylink/${clean(username)}${business ? '?personal=1' : ''}`
export const shopPayLink = (username: string, storeId?: string | null) =>
  `${PAY_LINK_ORIGIN}/paylink/${clean(username)}${storeId ? `?store=${storeId}` : ''}`

// token: EURC / cirBTC when the link asks for that token (?token=), else USDC.
export type PersonalPayLink = { username: string; amount: string | null; url: string; token?: 'USDC' | 'EURC' | 'cirBTC' }

/** Chat → pay a personal payment link in-chat (ChatPage listens). */
export const PAY_LINK_EVENT = 'meshport:pay-link'

function isMeshPortHost(host: string): boolean {
  const h = host.toLowerCase()
  const own = typeof window !== 'undefined' ? window.location.host.toLowerCase() : ''
  return (!!own && h === own) || h === 'meshport.xyz' || h === 'www.meshport.xyz'
}

export function parsePersonalPayLink(text: string): PersonalPayLink | null {
  const re = /https?:\/\/([^\s/]+)\/pay(?:link)?\/([a-z0-9_.-]{2,40})(?:\?([^\s]*))?/gi
  for (const m of text.matchAll(re)) {
    const [url, host, rawUser, query] = m
    const username = rawUser.toLowerCase().replace(/\.arc$/, '')
    if (username === 'r' || !isMeshPortHost(host)) continue
    let amount: string | null = null
    let token: PersonalPayLink['token'] = 'USDC'
    if (query) {
      const q = new URLSearchParams(query)
      const t = q.get('token')
      if (t === 'EURC' || t === 'cirBTC') token = t
      const a = q.get('amount')
      // cirBTC has 8 decimals, USDC / EURC 6.
      const re = token === 'cirBTC' ? /^\d+(\.\d{1,8})?$/ : /^\d+(\.\d{1,6})?$/
      if (a && re.test(a) && Number(a) > 0) amount = a
    }
    return { username, amount, url, token }
  }
  return null
}
