import { ActionIcon, type ActionIconName } from './ActionIcon'
import { NavIcon, type NavIconName } from '@/components/layout/navIcons'

// The icon a search result (Services) shows: the app's own shared icons -
// Home's action icons (ActionIcon) and the tab bar / sidebar icons (NavIcon) -
// the same one the app shows for that screen elsewhere.
const ACTION: Record<string, ActionIconName> = {
  '/pay': 'pay', '/receive': 'receive', '/receive/requests': 'list', '/swap': 'swap', '/bulk-payout': 'bulk',
  '/rewards': 'rewards', '/multichain': 'hub', '/insights': 'insights', '/p2p': 'p2p', '/news': 'list',
  '/notifications': 'list',
  '/business?tab=payments': 'list', '/business?tab=settlements': 'wallet', '/business?screen=receive': 'receive',
  '/business?screen=qr': 'qr', '/business?screen=customers': 'bulk', '/business?screen=reports': 'insights',
  '/business?screen=payouts': 'pay', '/business?screen=cashout': 'wallet', '/business?screen=team': 'clock',
}
const NAV: Record<string, NavIconName> = {
  '/scanner': 'scan', '/chat': 'chat', '/activity': 'activity', '/business?screen=activity': 'activity',
}

export function ServiceIcon({ path, size = 17, color = 'var(--brand-text)' }: { path: string; size?: number; color?: string }) {
  const action = ACTION[path]
  if (action) return <ActionIcon name={action} size={size} color={color} />
  // Profile, settings and help screens: the Settings icon, as in the sidebar.
  return <NavIcon name={NAV[path] ?? 'settings'} size={size} color={color} />
}
