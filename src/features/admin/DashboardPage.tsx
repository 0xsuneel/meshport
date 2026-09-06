import { useEffect, useState } from 'react'
import { ToggleLeft, Link2, Coins as CoinsIcon, TrendingUp, Landmark } from 'lucide-react'
import { StatCard } from '@/components/admin/StatCard'
import { AdminCard } from '@/components/admin/AdminCard'
import { useSettingsStore } from '@/store/settingsStore'
import { fetchAdminAnalytics, type AdminAnalytics } from '@/lib/adminSupabase'

export function DashboardPage() {
  const { settings, loaded, load } = useSettingsStore()
  const [analytics, setAnalytics] = useState<AdminAnalytics | null>(null)
  const [treasuryBalance, setTreasuryBalance] = useState<number | null>(null)

  useEffect(() => { load() }, [])
  useEffect(() => { fetchAdminAnalytics().then(setAnalytics) }, [])
  useEffect(() => {
    // fetchAdminAnalytics() deliberately always returns 0 for treasuryBalance
    // (see its own comment) — the real on-chain balance has to be fetched
    // separately, same as AnalyticsPage does. Without this, the card below
    // always showed "$0" regardless of the actual treasury.
    import('@/lib/rewards').then(({ getTreasuryBalance }) =>
      getTreasuryBalance().then(setTreasuryBalance).catch(() => setTreasuryBalance(null))
    )
  }, [])

  const rows = Object.values(settings)
  // Real chain-toggle categories are 'chains_transfer' and 'chains_claim' —
  // the old combined 'chains' category from an earlier migration is unused
  // dead data that may still linger in the DB (see
  // supabase-chains-transfer-claim-split.sql). Excluding all three keeps
  // per-chain toggles out of the feature count entirely, matching what
  // FeaturesPage actually treats as a "feature".
  const NON_FEATURE_CATEGORIES = ['coins', 'chains', 'chains_transfer', 'chains_claim', 'maintenance']
  const activeFeatures = rows.filter((r) => !NON_FEATURE_CATEGORIES.includes(r.category) && r.enabled).length
  const totalFeatures = rows.filter((r) => !NON_FEATURE_CATEGORIES.includes(r.category)).length
  const coinsOn = rows.filter((r) => r.category === 'coins' && r.enabled).length
  const totalCoins = rows.filter((r) => r.category === 'coins').length
  // "Supported Chains" reflects Multichain Transfer's 21 chains (the
  // primary send flow) — Claim has its own independent toggle set on the
  // Chains admin page for anyone who needs that breakdown separately.
  const chainsOn = rows.filter((r) => r.category === 'chains_transfer' && r.enabled).length
  const totalChains = rows.filter((r) => r.category === 'chains_transfer').length
  const maintenanceOn = settings['maintenance_mode']?.enabled

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {maintenanceOn && (
        <AdminCard style={{ background: 'color-mix(in srgb, var(--warning) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)' }}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--warning)', fontWeight: 600 }}>
            ⚠ Maintenance Mode is currently ON — the app shows a maintenance screen to all users.
          </p>
        </AdminCard>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
        <StatCard label="Active Features" value={loaded ? `${activeFeatures}/${totalFeatures}` : '—'} icon={ToggleLeft} accent="var(--brand)" />
        <StatCard label="Supported Chains" value={loaded ? `${chainsOn}/${totalChains}` : '—'} icon={Link2} accent="var(--success)" />
        <StatCard label="Supported Coins" value={loaded ? `${coinsOn}/${totalCoins}` : '—'} icon={CoinsIcon} accent="var(--warning)" />
        <StatCard label="Swap Volume Today" value={analytics ? `$${analytics.swapVolumeToday.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'} icon={TrendingUp} accent="var(--brand)" />
      </div>

      <StatCard label="Treasury Balance" value={treasuryBalance !== null ? `${treasuryBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC` : '—'} icon={Landmark} accent="var(--success)" hint="Live on-chain balance" />

      <AdminCard>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
          Toggle any feature, coin, or chain from the menu — changes apply instantly to every
          connected MeshPort user, no redeploy required.
        </p>
      </AdminCard>
    </div>
  )
}

