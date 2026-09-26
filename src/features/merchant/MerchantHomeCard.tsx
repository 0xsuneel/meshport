// Home → merchant card (approved merchants only; renders nothing otherwise).
// Arriving payments (paid on another chain, moving to Arc) + recent payments,
// with a shortcut to Receive payment. Live via Supabase Realtime.
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { QrCode, Clock } from 'lucide-react'
import { useAuthStore } from '@/store'
import { useMerchant } from '@/lib/merchant'
import { formatAmount, timeAgo } from '@/lib/utils'
import { listMyPayments, subscribeMerchantPayments, isArriving, paymentStageLabel, type MerchantPayment } from '@/lib/merchantPay'

const LABEL: Record<string, string> = {
  Arc_Testnet: 'Arc', Ethereum_Sepolia: 'Ethereum', Base_Sepolia: 'Base', Arbitrum_Sepolia: 'Arbitrum', Optimism_Sepolia: 'Optimism',
  Polygon_Sepolia: 'Polygon', Avalanche_Fuji: 'Avalanche', HyperEVM_Testnet: 'HyperEVM', Sei_Testnet: 'Sei', Unichain_Sepolia: 'Unichain',
}

export function MerchantHomeCard() {
  const { isMerchant } = useMerchant()
  const walletAddress = useAuthStore(s => s.walletAddress)
  const navigate = useNavigate()
  const [payments, setPayments] = useState<MerchantPayment[]>([])

  const load = useCallback(async () => { setPayments(await listMyPayments(20)) }, [])
  useEffect(() => { if (isMerchant) void load() }, [isMerchant, load])
  useEffect(() => (isMerchant && walletAddress ? subscribeMerchantPayments(walletAddress, () => { void load() }) : undefined), [isMerchant, walletAddress, load])

  if (!isMerchant) return null
  const arriving = payments.filter(isArriving)
  const recent = payments.filter(p => !isArriving(p)).slice(0, 3)
  const who = (p: MerchantPayment) => p.customerUsername ? `${p.customerUsername}.arc` : `${p.from.slice(0, 6)}…${p.from.slice(-4)}`
  const openLedger = () => navigate('/multichain', { state: { tab: 'bring' } })

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 20, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Payments</span>
        <button onClick={openLedger} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 12, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
          <QrCode size={15} /> Receive
        </button>
      </div>
      {arriving.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Arriving payments</span>
          {arriving.map(p => (
            <div key={p.id} onClick={openLedger} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              <Clock size={16} color="var(--warning)" />
              <span style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)' }}>{who(p)} · {LABEL[p.chain] ?? p.chain} → Arc · {paymentStageLabel(p)}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--warning)' }}>${formatAmount(p.amount)}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Recent payments</span>
        {recent.length === 0 ? (
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>No payments yet — tap Receive to create a payment request.</span>
        ) : recent.map(p => (
          <div key={p.id} onClick={openLedger} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <span style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)' }}>{who(p)} <span style={{ color: 'var(--text-secondary)' }}>· {timeAgo(p.createdAt)}</span></span>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--success)' }}>+${formatAmount(p.amount)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
