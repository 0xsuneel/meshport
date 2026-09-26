import { useEffect, useState } from 'react'
import { SettingsCard } from '@/components/admin/SettingsCard'
import { useSettingsStore } from '@/store/settingsStore'
import { updateSetting, updateSettingValue } from '@/lib/adminSupabase'
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
  // Per-chain reason text for the `chains_claim` category — shown in the
  // Multichain Claim page (see disabledClaimChains in MultichainClaimPage)
  // in place of a balance whenever that chain is switched off here. Kept as
  // its own local draft (keyed by feature) so typing doesn't fight the
  // settings store on every keystroke; only written back on blur.
  const [reasonDraft, setReasonDraft] = useState<Record<string, string>>({})
  const [savingReason, setSavingReason] = useState<Record<string, boolean>>({})

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

  const reasonFor = (row: AppSetting) => reasonDraft[row.feature] ?? row.value ?? ''

  const saveReason = async (row: AppSetting) => {
    const next = reasonDraft[row.feature]
    // Nothing typed, or unchanged from what's already saved — skip the
    // round-trip entirely (also avoids overwriting a real value with '' if
    // this row's draft was never actually touched).
    if (next === undefined || next === (row.value ?? '')) return
    setSavingReason((p) => ({ ...p, [row.feature]: true }))
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, [row.feature]: { ...row, value: next } },
    }))
    await updateSettingValue(row.feature, next)
    setSavingReason((p) => ({ ...p, [row.feature]: false }))
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
                <div key={row.feature}>
                  <SettingsCard
                    label={row.label || row.feature}
                    checked={row.enabled}
                    disabled={!!pending[row.feature]}
                    onChange={(next) => handleToggle(row, next)}
                    badge={row.enabled ? 'ON' : 'OFF'}
                  />
                  {section.category === 'chains_claim' && !row.enabled && (
                    <div style={{ margin: '6px 4px 0', padding: '10px 12px', background: 'var(--surface)', border: '1px dashed var(--border)', borderRadius: 14 }}>
                      <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>
                        Reason shown to users (optional — defaults to "Upgrading — coming soon")
                      </label>
                      <input
                        type="text"
                        value={reasonFor(row)}
                        onChange={(e) => setReasonDraft((d) => ({ ...d, [row.feature]: e.target.value }))}
                        onBlur={() => saveReason(row)}
                        placeholder="e.g. Bridge upgrading — back Thursday"
                        style={{
                          width: '100%', marginTop: 6, background: 'var(--bg)', border: '1px solid var(--border)',
                          borderRadius: 10, padding: '8px 10px', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit',
                        }}
                      />
                      {savingReason[row.feature] && (
                        <p style={{ fontSize: 10, color: 'var(--text-secondary)', margin: '4px 0 0' }}>Saving…</p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
