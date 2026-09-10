import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { AdminCard } from '@/components/admin/AdminCard'
import { AdminToggle } from '@/components/admin/AdminToggle'
import { useSettingsStore } from '@/store/settingsStore'
import { updateSetting, updateSettingValue } from '@/lib/adminSupabase'

export function MaintenancePage() {
  const { settings, loaded, load, refresh } = useSettingsStore()
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => { load() }, [])
  useEffect(() => {
    const v = settings['maintenance_message']?.value
    if (v !== undefined && v !== null) setMessage(v)
  }, [settings['maintenance_message']?.value])

  const enabled = settings['maintenance_mode']?.enabled ?? false

  const toggleMaintenance = async (next: boolean) => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, maintenance_mode: { ...s.settings['maintenance_mode'], enabled: next } as any },
    }))
    const { error } = await updateSetting('maintenance_mode', next)
    if (error) await refresh()
  }

  const handleSave = async () => {
    setSaving(true)
    await updateSettingValue('maintenance_message', message)
    await refresh()
    setSaving(false)
    setSavedAt(Date.now())
  }

  if (!loaded) return <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading…</p>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <AdminCard>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 12, background: enabled ? 'color-mix(in srgb, var(--warning) 15%, transparent)' : 'color-mix(in srgb, var(--text-secondary) 10%, transparent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <AlertTriangle size={20} color={enabled ? 'var(--warning)' : 'var(--text-secondary)'} />
            </div>
            <div>
              <p style={{ margin: 0, fontWeight: 700, color: 'var(--text-primary)', fontSize: 15 }}>Maintenance Mode</p>
              <p style={{ margin: '2px 0 0', fontSize: 12, color: enabled ? 'var(--warning)' : 'var(--text-secondary)', fontWeight: 600 }}>
                {enabled ? 'ON — app is locked for all users' : 'OFF — app is live'}
              </p>
            </div>
          </div>
          <AdminToggle checked={enabled} onChange={toggleMaintenance} />
        </div>
      </AdminCard>

      <AdminCard>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Custom Message</label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={4}
          placeholder="MeshPort is under maintenance."
          style={{
            width: '100%', marginTop: 8, background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 14, padding: 12, color: 'var(--text-primary)', fontSize: 14, resize: 'vertical', fontFamily: 'inherit',
          }}
        />
        <button
          onClick={handleSave}
          disabled={saving}
          className="btn-primary"
          style={{ marginTop: 12, width: '100%', padding: 16, borderRadius: 14, border: '1px solid color-mix(in srgb, black 12%, transparent)', fontSize: 15, opacity: saving ? 0.6 : 1 }}
        >
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
        {savedAt && <p style={{ fontSize: 11, color: 'var(--success)', marginTop: 8 }}>Saved ✓</p>}
      </AdminCard>

      <AdminCard style={{ background: 'var(--surface)' }}>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Preview</p>
        <p style={{ margin: '8px 0 0', fontSize: 14, color: 'var(--text-primary)' }}>{message || 'MeshPort is under maintenance.'}</p>
      </AdminCard>
    </div>
  )
}
