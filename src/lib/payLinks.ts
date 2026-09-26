// MeshPort personal payment links — `<app>/pay/<username>` with an optional
// `?amount=` (Receive / "Collect USDC" share). Chat turns these into a card.
// Merchant links (`/pay/r/<code>`) are handled by merchantPay.codeFromLink.

export type PersonalPayLink = { username: string; amount: string | null; url: string }

/** Chat → pay a personal payment link in-chat (ChatPage listens). */
export const PAY_LINK_EVENT = 'meshport:pay-link'

function isMeshPortHost(host: string): boolean {
  const h = host.toLowerCase()
  const own = typeof window !== 'undefined' ? window.location.host.toLowerCase() : ''
  return (!!own && h === own) || h.includes('meshport')
}

export function parsePersonalPayLink(text: string): PersonalPayLink | null {
  const re = /https?:\/\/([^\s/]+)\/pay\/([a-z0-9_.-]{2,40})(?:\?([^\s]*))?/gi
  for (const m of text.matchAll(re)) {
    const [url, host, rawUser, query] = m
    const username = rawUser.toLowerCase().replace(/\.arc$/, '')
    if (username === 'r' || !isMeshPortHost(host)) continue
    let amount: string | null = null
    if (query) {
      const a = new URLSearchParams(query).get('amount')
      if (a && /^\d+(\.\d{1,6})?$/.test(a) && Number(a) > 0) amount = a
    }
    return { username, amount, url }
  }
  return null
}
