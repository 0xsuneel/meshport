// Home → business account setup (business accounts that aren't approved yet).
// A business can use MeshPort from sign-up; this card asks it to complete the
// merchant application (why it needs a business account) so MeshPort can
// review it, then shows where that review stands. Renders nothing for
// personal accounts and approved merchants.
import { useNavigate } from 'react-router-dom'
import { Store, Clock, XCircle, ChevronRight } from 'lucide-react'
import { useMerchant } from '@/lib/merchant'

export function BusinessSetupCard() {
  const navigate = useNavigate()
  const { loaded, accountType, status, storeName, application } = useMerchant()
  if (!loaded || accountType !== 'business' || status === 'approved') return null

  const name = storeName || application?.businessName || 'your business'
  const view = status === 'pending'
    ? { icon: <Clock size={20} />, tone: 'var(--warning)', title: 'Business account under review',
        text: `We're reviewing ${name}. You'll get a notification when it's approved.`, action: 'View' }
    : status === 'rejected' || status === 'revoked'
      ? { icon: <XCircle size={20} />, tone: 'var(--danger)', title: status === 'revoked' ? 'Merchant access removed' : 'Business account not approved',
          text: application?.reviewNote || 'Check the details and send it again.', action: 'Apply again' }
      : { icon: <Store size={20} />, tone: 'var(--brand-text)', title: `Complete your business account`,
          text: `Tell us why ${name} needs a business account. MeshPort reviews it, then merchant tools turn on.`, action: 'Complete' }

  return (
    <button onClick={() => navigate('/merchant')}
      style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', cursor: 'pointer', padding: 14, borderRadius: 20,
        background: 'var(--surface)', border: `1px solid color-mix(in srgb, ${view.tone} 40%, var(--border))`, color: 'var(--text-primary)' }}>
      <span aria-hidden="true" style={{ width: 40, height: 40, borderRadius: 12, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: `color-mix(in srgb, ${view.tone} 14%, transparent)`, color: view.tone }}>
        {view.icon}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <b style={{ display: 'block', fontSize: 14.5 }}>{view.title}</b>
        <span style={{ display: 'block', fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.4 }}>{view.text}</span>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 13, fontWeight: 700, color: view.tone, flexShrink: 0 }}>
        {view.action} <ChevronRight size={16} />
      </span>
    </button>
  )
}
