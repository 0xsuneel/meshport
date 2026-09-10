// Shared "Services" list for people+services search — used by both Home's
// own mobile search overlay and DesktopHeader's search dropdown, so the two
// surfaces can never drift apart on which real routes are searchable.
// Real routes that actually exist in this app (see src/App.tsx) — Services
// results only ever point to real screens, nothing invented.
export const SERVICES = [
  { label: 'Pay',              path: '/pay-send',            keywords: ['pay', 'send', 'transfer', 'pay someone'] },
  { label: 'Claim Funds',     path: '/multichain-claim', keywords: ['claim', 'multichain claim'] },
  { label: 'Transfer Funds',  path: '/multichain-transfer',  keywords: ['transfer funds', 'bridge', 'multichain send'] },
  { label: 'Bulk Payout',     path: '/bulk-payout',      keywords: ['bulk', 'payout', 'mass payment'] },
  { label: 'Rewards',         path: '/rewards',          keywords: ['rewards', 'points'] },
  { label: 'Scanner',         path: '/scanner',          keywords: ['scan', 'qr', 'scanner'] },
  { label: 'Activity',        path: '/activity',         keywords: ['activity', 'history', 'transactions'] },
  { label: 'Multichain Hub',  path: '/multichain',       keywords: ['multichain', 'hub', 'bridge'] },
  { label: 'Insights',        path: '/insights',         keywords: ['insights', 'analytics', 'spending'] },
  { label: 'P2P Marketplace', path: '/p2p',              keywords: ['p2p', 'marketplace', 'buy usdc', 'sell usdc', 'peer to peer'] },
]

export function filterServices(query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return SERVICES.filter(s =>
    s.label.toLowerCase().includes(q) ||
    s.keywords.some(k => k.includes(q))
  )
}
