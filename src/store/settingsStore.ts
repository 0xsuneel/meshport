import { create } from 'zustand'
import { fetchAllSettings, subscribeToSettings, type SettingsMap } from '@/lib/adminSupabase'

interface SettingsStore {
  settings: SettingsMap
  loaded: boolean
  loading: boolean
  load: () => Promise<void>
  refresh: () => Promise<void>
  startRealtime: () => () => void
  isEnabled: (feature: string, fallback?: boolean) => boolean
  getValue: (feature: string) => string | null
}

let realtimeStarted = false

export const useSettingsStore = create<SettingsStore>()((set, get) => ({
  settings: {},
  loaded: false,
  loading: false,

  load: async () => {
    if (get().loaded || get().loading) return
    set({ loading: true })
    const settings = await fetchAllSettings()
    set({ settings, loaded: true, loading: false })
  },

  refresh: async () => {
    const settings = await fetchAllSettings()
    set({ settings, loaded: true })
  },

  // Subscribes once for the lifetime of the app — every admin toggle change
  // is reflected live across every connected client, no redeploy needed.
  startRealtime: () => {
    if (realtimeStarted) return () => {}
    realtimeStarted = true
    const unsub = subscribeToSettings(() => { get().refresh() })
    return () => { unsub(); realtimeStarted = false }
  },

  // Feature defaults to ON if the row doesn't exist yet (so the app never
  // breaks before the migration / seed has been run).
  isEnabled: (feature, fallback = true) => {
    const row = get().settings[feature]
    if (!row) return fallback
    return row.enabled
  },

  getValue: (feature) => get().settings[feature]?.value ?? null,
}))

// ─── Convenience hook ─────────────────────────────────────────────────────────
// Usage: const swapOn = useFeatureEnabled('swap_enabled')
export function useFeatureEnabled(feature: string, fallback = true): boolean {
  return useSettingsStore((s) => s.isEnabled(feature, fallback))
}

export function useMaintenanceMode(): { enabled: boolean; message: string } {
  return useSettingsStore((s) => ({
    enabled: s.isEnabled('maintenance_mode', false),
    message: s.getValue('maintenance_message') || 'MeshPort is under maintenance.',
  }))
}
