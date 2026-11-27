// Which way a route change is going, so pages can slide the right way:
//   'forward' → a page opened on top (slide in from the right)
//   'back'    → returned to an earlier page (slide in from the left)
//   'tab'     → switched between bottom-nav tabs (cross-fade, no slide)
//   'none'    → first screen of the session
//
// "Back" isn't only the browser's back button (POP): many screens return with
// their own button (navigate('/p2p'), navigate('/')), which is a PUSH to the
// router - so going UP the hierarchy (to a parent path or to a tab root from
// deeper) also counts as back, the way it reads to the user, and so does a
// navigate(path, { state: { navBack: true } }) from a screen's back button.
import { useLocation, useNavigationType } from 'react-router-dom'

export type NavKind = 'forward' | 'back' | 'tab' | 'none'

// Every bottom-nav root (merchants see /business where others see /rewards) -
// must match BottomNav's own TAB_ROOTS so switching to/from the Business tab
// cross-fades like every other tab instead of sliding like an opened page.
const TAB_ROOTS = new Set(['/', '/chat', '/scanner', '/rewards', '/business', '/activity', '/biz/payments', '/biz/collect', '/biz/customers', '/biz/account'])
const isAncestor = (a: string, b: string) => a !== '/' && b.startsWith(a.endsWith('/') ? a : a + '/')

let last: { path: string; kind: NavKind } = { path: '', kind: 'none' }

function classify(pathname: string, navType: string, navBack = false): NavKind {
  if (last.path === pathname) return last.kind // same page re-rendering
  const prev = last.path
  let kind: NavKind
  if (!prev) kind = 'none'
  // A screen's own back button that navigates (a PUSH) to where it came from.
  else if (navBack && !(TAB_ROOTS.has(pathname) && TAB_ROOTS.has(prev))) kind = 'back'
  else if (TAB_ROOTS.has(pathname) && TAB_ROOTS.has(prev)) kind = 'tab'
  else if (navType === 'POP') kind = 'back'
  else if (TAB_ROOTS.has(pathname)) kind = 'back'
  else if (TAB_ROOTS.has(prev)) kind = 'forward'
  else if (isAncestor(pathname, prev)) kind = 'back'
  else kind = 'forward'
  last = { path: pathname, kind }
  return kind
}

export function useNavDirection(): NavKind {
  const { pathname, state } = useLocation()
  const navType = useNavigationType()
  return classify(pathname, navType, !!(state as { navBack?: boolean } | null)?.navBack)
}
