// Which way a route change is going, so pages can slide the right way:
//   'forward' → a page opened on top (slide in from the right)
//   'back'    → returned to an earlier page (slide in from the left)
//   'tab'     → switched between bottom-nav tabs (cross-fade, no slide)
//   'none'    → first screen of the session
//
// "Back" isn't only the browser's back button (POP): many screens return with
// their own button (navigate('/p2p'), navigate('/')), which is a PUSH to the
// router — so going UP the hierarchy (to a parent path or to a tab root from
// deeper) also counts as back, the way it reads to the user.
import { useLocation, useNavigationType } from 'react-router-dom'

export type NavKind = 'forward' | 'back' | 'tab' | 'none'

const TAB_ROOTS = new Set(['/', '/chat', '/scanner', '/rewards', '/activity'])
const isAncestor = (a: string, b: string) => a !== '/' && b.startsWith(a.endsWith('/') ? a : a + '/')

let last: { path: string; kind: NavKind } = { path: '', kind: 'none' }

function classify(pathname: string, navType: string): NavKind {
  if (last.path === pathname) return last.kind // same page re-rendering
  const prev = last.path
  let kind: NavKind
  if (!prev) kind = 'none'
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
  const { pathname } = useLocation()
  const navType = useNavigationType()
  return classify(pathname, navType)
}
