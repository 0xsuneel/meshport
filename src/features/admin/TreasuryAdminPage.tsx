import { useEffect, useState } from 'react'
import { Landmark } from 'lucide-react'
import { StatCard } from '@/components/admin/StatCard'
import { SettingsCard } from '@/components/admin/SettingsCard'
import { AdminCard } from '@/components/admin/AdminCard'
import { useSettingsStore } from '@/store/settingsStore'
import { updateSetting } from '@/lib/adminSupabase'
import { getTreasuryBalance } from '@/lib/rewards'

export function TreasuryAdminPage() {
  const { settings, loaded, load, refresh } = useSettingsStore()
  const [balance, setBalance] = useState<number | null>(null)
  const [loadingBalance, setLoadingBalance] = useState(true)

  useEffect(() => { load() }, [])
  useEffect(() => {
    getTreasuryBalance()
      .then(setBalance)
      .catch(() => setBalance(null))
      .finally(() => setLoadingBalance(false))
  }, [])

  const treasuryRow = settings['treasury_enabled']
  const stakingRow = settings['staking_enabled']
  const rewardsRow = settings['rewards_enabled']

  const toggle = async (feature: string, next: boolean) => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, [feature]: { ...s.settings[feature], enabled: next } },
    }))
    const { error } = await updateSetting(feature, next)
    if (error) await refresh()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <StatCard
        label="Treasury Balance"
        value={loadingBalance ? '…' : balance !== null ? `${balance.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC` : 'Unavailable'}
        icon={Landmark}
        accent="var(--success)"
        hint="Live on-chain reward treasury balance"
      />

      {!loaded ? (
        <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading settings…</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {treasuryRow && (
            <SettingsCard
              label="Treasury"
              description="Show the Treasury screen and balances to users"
              checked={treasuryRow.enabled}
              onChange={(next) => toggle('treasury_enabled', next)}
              badge={treasuryRow.enabled ? 'ON' : 'OFF'}
            />
          )}
          {stakingRow && (
            <SettingsCard
              label="Staking"
              description="Allow users to stake balances for rewards"
              checked={stakingRow.enabled}
              onChange={(next) => toggle('staking_enabled', next)}
              badge={stakingRow.enabled ? 'ON' : 'OFF'}
            />
          )}
          {rewardsRow && (
            <SettingsCard
              label="Rewards Program"
              description="Enable point-earning and reward claims"
              checked={rewardsRow.enabled}
              onChange={(next) => toggle('rewards_enabled', next)}
              badge={rewardsRow.enabled ? 'ON' : 'OFF'}
            />
          )}
        </div>
      )}

      <AdminCard>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
          Treasury funds are managed on-chain via the MeshPortRewards contract. Use{' '}
          <code style={{ color: 'var(--text-primary)' }}>npm run treasury:fund</code> to top it up.
        </p>
      </AdminCard>
    </div>
  )
}
