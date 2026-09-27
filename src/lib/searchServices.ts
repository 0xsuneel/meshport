// Shared "Services" list for people+services search — used by both Home's
// own mobile search overlay and DesktopHeader's search dropdown, so the two
// surfaces can never drift apart on which real routes are searchable.
// Real routes that actually exist in this app (see src/App.tsx) — Services
// results only ever point to real screens, nothing invented.
export const SERVICES = [
  { label: 'Pay',              path: '/pay-send',            keywords: ['pay', 'send', 'transfer', 'pay someone'] },
  { label: 'Bulk Payout',     path: '/bulk-payout',      keywords: ['bulk', 'payout', 'mass payment'] },
  { label: 'Rewards',         path: '/rewards',          keywords: ['rewards', 'points'] },
  { label: 'Scanner',         path: '/scanner',          keywords: ['scan', 'qr', 'scanner'] },
  { label: 'Activity',        path: '/activity',         keywords: ['activity', 'history', 'transactions'] },
  { label: 'Multichain Hub',  path: '/multichain',       keywords: ['multichain', 'hub', 'bridge', 'transfer funds', 'bring funds', 'claim', 'multichain send', 'multichain claim'] },
  { label: 'Insights',        path: '/insights',         keywords: ['insights', 'analytics', 'spending'] },
  { label: 'P2P Marketplace', path: '/p2p',              keywords: ['p2p', 'marketplace', 'buy usdc', 'sell usdc', 'peer to peer'] },
]

// Merchants see the Multichain Hub as "Merchant Hub" (same /multichain page),
// findable by its name and the merchant things inside it.
const MERCHANT_HUB_KEYWORDS = ['merchant', 'merchant hub', 'ledger', 'payment requests', 'requests', 'customers', 'orders', 'bills', 'auto convert', 'auto-convert']

export function filterServices(query: string, isMerchant = false) {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const list = isMerchant
    ? SERVICES.map(s => s.path === '/multichain' ? { ...s, label: 'Merchant Hub', keywords: [...s.keywords, ...MERCHANT_HUB_KEYWORDS] } : s)
    : SERVICES
  return list.filter(s =>
    s.label.toLowerCase().includes(q) ||
    s.keywords.some(k => k.includes(q))
  )
}
