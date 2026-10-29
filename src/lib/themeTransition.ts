import { flushSync } from 'react-dom'
import { useThemeStore, resolveTheme, type ThemeMode } from '@/store/themeStore'

// ── Switching theme with the "curtain" ─────────────────────────────────────
// The new theme drops down from the top over the old one (index.css,
// "Theme curtain"). Uses the browser's View Transitions: the old page is a
// snapshot, the new one is revealed over it. Without them (older browsers),
// with reduce motion, or when the visible theme doesn't change (e.g. System
// while the phone is already light), it just switches.

type ViewTransitionDoc = Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } }

export function switchTheme(mode: ThemeMode) {
  const { mode: current, setMode } = useThemeStore.getState()
  if (mode === current) return
  const doc = document as ViewTransitionDoc
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (resolveTheme(mode) === resolveTheme(current) || !doc.startViewTransition || reduce) {
    setMode(mode)
    return
  }
  const root = document.documentElement
  root.classList.add('mp-theme-curtain')
  try {
    // flushSync: React re-renders inside the callback, so the new snapshot
    // already shows the new selection, not just the new colours.
    doc.startViewTransition(() => { flushSync(() => setMode(mode)) })
      .finished.finally(() => root.classList.remove('mp-theme-curtain'))
  } catch {
    root.classList.remove('mp-theme-curtain')
    setMode(mode)
  }
}
