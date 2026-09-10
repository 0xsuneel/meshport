import { useEffect, useState } from 'react'
import { Users, Receipt, Landmark, Gift, Repeat, ArrowLeftRight, UserPlus, Activity, Layers } from 'lucide-react'
import { StatCard } from '@/components/admin/StatCard'
import { fetchAdminAnalytics, type AdminAnalytics } from '@/lib/adminSupabase'
import { getTreasuryBalance } from '@/lib/rewards'

export function AnalyticsPage() {
  const [data, setData] = useState<AdminAnalytics | null>(null)
  const [balance, setBalance] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    const [analytics, treasury] = await Promise.all([
      fetchAdminAnalytics(),
      getTreasuryBalance().catch(() => null),
    ])
    setData(analytics)
    setBalance(treasury)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
        <StatCard label="New Users Today" value={loading ? '…' : data?.newUsersToday ?? 0} icon={UserPlus} accent="var(--success)" />
        <StatCard label="Total Users" value={loading ? '…' : data?.usersCount ?? 0} icon={Users} accent="var(--brand)" />
        <StatCard label="Active Users (30d)" value={loading ? '…' : data?.activeUsersCount ?? 0} icon={Activity} accent="var(--accent)" />
        <StatCard label="Total Transactions" value={loading ? '…' : data?.transactionsCount ?? 0} icon={Receipt} accent="var(--warning)" hint={loading ? undefined : `+${data?.transactionsToday ?? 0} today`} />
        <StatCard label="Multichain Transfers" value={loading ? '…' : data?.totalMultichainTransfers ?? 0} icon={ArrowLeftRight} accent="var(--warning)" hint={loading ? undefined : `+${data?.transfersToday ?? 0} today`} />
        <StatCard label="Multichain Claims" value={loading ? '…' : data?.totalMultichainClaims ?? 0} icon={Gift} accent="var(--brand)" hint={loading ? undefined : `+${data?.claimsToday ?? 0} today`} />
        <StatCard label="Total Swap Volume" value={loading ? '…' : `$${(data?.totalSwapVolume ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`} icon={Repeat} accent="var(--success)" hint={loading ? undefined : `+$${(data?.swapVolumeToday ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} today`} />
        <StatCard label="Bulk Payments" value={loading ? '…' : data?.totalBulkPayments ?? 0} icon={Layers} accent="var(--accent)" hint={loading ? undefined : `+${data?.bulkPaymentsToday ?? 0} today`} />
        <StatCard label="Treasury Balance" value={loading ? '…' : balance !== null ? `${balance.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC` : '—'} icon={Landmark} accent="var(--success)" />
      </div>

      <button
        onClick={load}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: 16,
          borderRadius: 14,
          border: '1px solid var(--border)',
          background: 'transparent',
          fontSize: 14,
          fontWeight: 600,
          color: 'var(--text-primary)',
          marginTop: 8,
          cursor: 'pointer',
        }}
      >
        Refresh
      </button>
    </div>
  )
}
