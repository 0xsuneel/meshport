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

// The last settings that loaded, kept on the device: on a slow or missing
// connection the app opens with the admin's real switches instead of every
// feature's default, and a failed load (an empty answer) never wipes them.
const CACHE_KEY = 'mp_settings_cache'
function readCache(): SettingsMap | null {
  try { const v = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); return v && typeof v === 'object' ? v : null } catch { return null }
}
function writeCache(settings: SettingsMap) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(settings)) } catch { /* storage full / private mode */ }
}
const cached = readCache()
// Set once a load has really come back from the server.
let fetched = false

export const useSettingsStore = create<SettingsStore>()((set, get) => ({
  settings: cached ?? {},
  loaded: !!cached,
  loading: false,

  load: async () => {
    if (fetched || get().loading) return
    set({ loading: true })
    const settings = await fetchAllSettings()
    const ok = Object.keys(settings).length > 0
    if (ok) { fetched = true; writeCache(settings) }
    set(ok ? { settings, loaded: true, loading: false } : { loaded: true, loading: false })
  },

  refresh: async () => {
    const settings = await fetchAllSettings()
    if (Object.keys(settings).length === 0) return // failed — keep what we have
    fetched = true
    writeCache(settings)
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
