// useMediaQuery.ts
// Reactive matchMedia hook — foundation for the desktop layout branch
// (AppLayout, DesktopSidebar/Header, keypad desktop inputs, Chat split view).
// Same idiom already used ad hoc in themeStore.ts (prefers-color-scheme) and
// ModeToggle.tsx (resize listener) — just given a single reusable shape.
import { useEffect, useState } from 'react'

export function useMediaQuery(query: string): boolean {
  // Default false on first render — correct for this CSR-only app (no SSR
  // hydration mismatch to worry about) and means anything gated on desktop
  // renders as mobile until the effect below confirms otherwise, which is
  // the safe direction to default in for a mobile-first app.
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false
  )

  useEffect(() => {
    const mql = window.matchMedia(query)
    setMatches(mql.matches)
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}
