import { useEffect, useState } from 'react'
import { SettingsCard } from '@/components/admin/SettingsCard'
import { useSettingsStore } from '@/store/settingsStore'
import { updateSetting } from '@/lib/adminSupabase'
import type { AppSetting } from '@/lib/adminSupabase'

interface Section {
  title: string
  category: string
}

interface CategoryTogglePageProps {
  sections: Section[]
}

export function CategoryTogglePage({ sections }: CategoryTogglePageProps) {
  const { settings, loaded, load, refresh } = useSettingsStore()
  const [pending, setPending] = useState<Record<string, boolean>>({})

  useEffect(() => { load() }, [])

  const handleToggle = async (row: AppSetting, next: boolean) => {
    setPending((p) => ({ ...p, [row.feature]: true }))
    // optimistic UI
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, [row.feature]: { ...row, enabled: next } },
    }))
    const { error } = await updateSetting(row.feature, next)
    if (error) await refresh() // revert on failure
    setPending((p) => ({ ...p, [row.feature]: false }))
  }

  if (!loaded) {
    return <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading settings…</p>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {sections.map((section) => {
        const rows = Object.values(settings)
          .filter((r) => r.category === section.category)
          .sort((a, b) => (a.label || a.feature).localeCompare(b.label || b.feature))

        if (rows.length === 0) {
          return (
            <div key={section.category}>
              <h2 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.6, margin: '0 0 10px 4px' }}>
                {section.title}
              </h2>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, padding: '14px 16px', background: 'var(--surface)', border: '1px dashed var(--border)', borderRadius: 20 }}>
                No settings found for "{section.category}" — this section's rows haven't been seeded in app_settings yet. Run the matching SQL migration in Supabase, then reload.
              </p>
            </div>
          )
        }

        return (
          <div key={section.category}>
            <h2 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.6, margin: '0 0 10px 4px' }}>
              {section.title}
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {rows.map((row) => (
                <SettingsCard
                  key={row.feature}
                  label={row.label || row.feature}
                  checked={row.enabled}
                  disabled={!!pending[row.feature]}
                  onChange={(next) => handleToggle(row, next)}
                  badge={row.enabled ? 'ON' : 'OFF'}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
