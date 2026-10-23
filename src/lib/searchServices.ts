import { isLockedPath } from './accountLockRule'

// Shared "Services" list for people+services search - used by both Home's
// own mobile search overlay and DesktopHeader's search dropdown, so the two
// surfaces can never drift apart on which real routes are searchable.
// Real routes that actually exist in this app (see src/App.tsx) - Services
// results only ever point to real screens, nothing invented.
export type Service = { label: string; path: string; keywords: string[] }

export const SERVICES: Service[] = [
  { label: 'Pay',              path: '/pay',            keywords: ['pay', 'send', 'transfer', 'pay someone'] },
  { label: 'Receive',          path: '/receive',        keywords: ['receive', 'request money', 'my qr', 'wallet address', 'deposit'] },
  { label: 'Payment requests', path: '/receive/requests', keywords: ['requests', 'payment requests', 'my requests'] },
  { label: 'Swap',             path: '/swap',           keywords: ['swap', 'exchange', 'convert', 'usdc', 'eurc', 'cirbtc'] },
  { label: 'Bulk Pay',        path: '/bulk-payout',      keywords: ['bulk', 'bulk pay', 'payout', 'mass payment'] },
  { label: 'Rewards',         path: '/rewards',          keywords: ['rewards', 'claim rewards', 'points'] },
  { label: 'Scan QR',         path: '/scanner',          keywords: ['scan', 'qr', 'scanner', 'scan qr'] },
  { label: 'Chats',           path: '/chat',             keywords: ['chat', 'chats', 'messages', 'message'] },
  { label: 'Activity',        path: '/activity',         keywords: ['activity', 'history', 'transactions'] },
  { label: 'Notifications',   path: '/notifications',    keywords: ['notifications', 'alerts'] },
  { label: 'Multichain Hub',  path: '/multichain',       keywords: ['multichain', 'hub', 'bridge', 'transfer funds', 'bring funds', 'claim', 'multichain send', 'multichain claim'] },
  { label: 'Insights',        path: '/insights',         keywords: ['insights', 'analytics', 'spending'] },
  { label: 'P2P',             path: '/p2p',              keywords: ['p2p', 'marketplace', 'buy usdc', 'sell usdc', 'peer to peer'] },
  { label: 'News',            path: '/news',             keywords: ['news', 'updates'] },
  { label: 'Profile',         path: '/profile',          keywords: ['profile', 'account', 'settings'] },
  { label: 'Edit profile',    path: '/edit-profile',     keywords: ['edit profile', 'name', 'photo', 'avatar', 'username'] },
  { label: 'Security',        path: '/security',         keywords: ['security', 'passcode', 'fingerprint', 'face id', 'biometric', 'lock'] },
  { label: 'Backup',          path: '/backup',           keywords: ['backup', 'recovery', 'private key', 'export key'] },
  { label: 'Appearance',      path: '/appearance',       keywords: ['appearance', 'theme', 'dark mode', 'light mode'] },
  { label: 'Help & support',  path: '/help-support',     keywords: ['help', 'support', 'contact us', 'faq'] },
  { label: 'Feature guide',   path: '/feature-guide',    keywords: ['guide', 'how to', 'features', 'tutorial'] },
]

// A business account's own screens (Business tab), opened by link.
const BUSINESS_SERVICES: Service[] = [
  { label: 'Manage orders',     path: '/business?tab=payments',       keywords: ['orders', 'manage orders', 'payments', 'sales', 'bills', 'requests'] },
  { label: 'Manage money',      path: '/business?tab=settlements',    keywords: ['money', 'manage money', 'settle', 'settlements', 'balance', 'other chains'] },
  { label: 'Collect payment',   path: '/business?screen=receive',     keywords: ['collect', 'collect payment', 'request payment', 'bill', 'invoice', 'charge'] },
  { label: 'Shop QR',           path: '/business?screen=qr',          keywords: ['shop qr', 'qr', 'store qr', 'payment qr'] },
  { label: 'Guests & customers', path: '/business?screen=customers',  keywords: ['guests', 'customers', 'clients', 'patients', 'students'] },
  { label: 'Business Insights', path: '/business?screen=reports',     keywords: ['insights', 'reports', 'analytics', 'sales report', 'revenue'] },
  { label: 'Pay staff',         path: '/business?screen=payouts',     keywords: ['pay staff', 'salary', 'payroll', 'payouts'] },
  { label: 'Cash out',          path: '/business?screen=cashout',     keywords: ['cash out', 'withdraw', 'sell usdc', 'to bank'] },
  { label: 'Stores & staff',    path: '/business?screen=team',        keywords: ['stores', 'staff', 'team', 'branches', 'outlets'] },
  { label: 'Business tools',    path: '/business?screen=tools',       keywords: ['tools', 'business tools', 'settings'] },
  { label: 'Business profile',  path: '/business?screen=profile',     keywords: ['business profile', 'store name', 'apply', 'approval'] },
  { label: 'Activity log',      path: '/business?screen=activity',    keywords: ['activity log', 'audit', 'log'] },
  { label: 'Help & disputes',   path: '/business?screen=help',        keywords: ['help', 'disputes', 'refund help'] },
]
// Open to a business that isn't approved yet (the rest unlock on approval).
const OPEN_WHILE_LOCKED = new Set(['/business?screen=profile', '/business?screen=help'])

// Business accounts see the Multichain Hub as "Cross-chain Transfer" (same
// /multichain page, lib/merchant.ts hubLabel).
const CROSS_CHAIN_KEYWORDS = ['cross-chain', 'cross chain', 'cross-chain transfer', 'other chains']

/** `locked`: a business account that isn't approved yet - its locked
 *  features (lib/accountLock.ts) are left out of the results. */
export function filterServices(query: string, isMerchant = false, locked = false, business = false): Service[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  // Rewards and the personal Insights page are for personal accounts; a
  // business gets its own screens instead (Business Insights, orders, ...).
  const base = SERVICES.filter(s => !(locked && isLockedPath(s.path)) && !(business && (s.path === '/rewards' || s.path === '/insights')))
  const list = isMerchant
    ? base.map(s => s.path === '/multichain' ? { ...s, label: 'Cross-chain Transfer', keywords: [...s.keywords, ...CROSS_CHAIN_KEYWORDS] }
        : s.path === '/insights' ? { ...s, label: 'Business Insights', keywords: [...s.keywords, 'business insights', 'sales', 'revenue', 'customers'] }
        : s)
    : base
  const all = business ? [...list, ...BUSINESS_SERVICES.filter(s => !locked || OPEN_WHILE_LOCKED.has(s.path))] : list
  // Every word typed must match the name or a keyword ("pay staff", "shop qr").
  const words = q.split(/\s+/)
  return all.filter(s => {
    const hay = [s.label.toLowerCase(), ...s.keywords]
    return words.every(w => hay.some(h => h.includes(w)))
  })
}
