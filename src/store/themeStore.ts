import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemeMode = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  return mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode
}

// Same attribute the inline bootstrap script in index.html sets
// synchronously before first paint — this just keeps it correct for the
// lifetime of the app (manual toggle, or the OS theme changing mid-session).
function applyTheme(mode: ThemeMode) {
  if (typeof document === 'undefined') return
  const resolved = resolveTheme(mode)
  document.documentElement.setAttribute('data-theme', resolved)
  document.documentElement.style.colorScheme = resolved
}

interface ThemeStore {
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
}

export const useThemeStore = create<ThemeStore>()(
  persist(
    (set) => ({
      mode: 'system',
      setMode: (mode) => {
        set({ mode })
        applyTheme(mode)
      },
    }),
    { name: 'meshport-theme-v1' }
  )
)

// Apply immediately on module load (covers the case where the persisted
// mode differs from what the pre-paint bootstrap script resolved, e.g. a
// stale system read), then keep following the OS setting live while the
// user hasn't explicitly overridden it.
if (typeof window !== 'undefined') {
  applyTheme(useThemeStore.getState().mode)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (useThemeStore.getState().mode === 'system') applyTheme('system')
  })
}
